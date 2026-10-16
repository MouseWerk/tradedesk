// HTTP: API, SSE-Stream, Web-App. Nur 127.0.0.1, nur mit dem eigenen Host (Host-Header) und Port.
// Zwei Arten Aufrufer: du im Browser (angemeldet mit PIN: Sitzungs-Cookie, bei Änderungen zusätzlich der Origin des
// Desks) und cli/desk.py der Agenten (ohne Cookie). Freigeben, Ablehnen, Bestätigen, Stornieren, Not-Aus, Grenzen,
// Trades, Cash, Import, Abgleich, Watchlist und Alarme gehen nur mit deiner Sitzung. Lesen dürfen auch die Agenten.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ChartRange } from "@desk/shared";
import { ChartRangeSchema } from "@desk/shared";
import { AuthError, SESSION_HEADER } from "./auth.ts";
import { DeskError, type Desk, type Origin } from "./desk.ts";

export const VERSION = 1;
const DEV_WEB_PORT = 5175; // Vite im Entwicklungsmodus (npm run dev:web), leitet /api weiter
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
// style-src mit 'unsafe-inline': Radix setzt beim offenen Dialog ein <style> für die Scroll-Sperre; Skripte bleiben streng.

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
	".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

/** Datei unterhalb von base oder null (kein Traversal, keine Ordner). */
export function inside(base: string, rel: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(rel);
	} catch {
		return null;
	}
	if (decoded.includes("\0")) return null;
	const b = path.resolve(base);
	const p = path.resolve(b, decoded);
	if (!p.startsWith(b + path.sep)) return null;
	try {
		return statSync(p).isFile() ? p : null;
	} catch {
		return null;
	}
}

function sendFile(c: Context, file: string | null, cache = "no-cache") {
	if (!file) return c.text("not found", 404);
	return c.body(readFileSync(file), 200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": cache, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": CSP });
}

const int = (v: string | undefined, d: number, lo: number, hi: number) => {
	const n = Number(v);
	return v !== undefined && v !== "" && Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.trunc(n))) : d;
};

/** Hosts, unter denen der Desk antwortet: nur die eigene Adresse mit dem eigenen Port (gegen DNS-Rebinding). */
export function localHosts(port: number, dev = false, extra: string[] = []): Set<string> {
	const ports = dev ? [port, DEV_WEB_PORT] : [port];
	return new Set([...ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]), ...extra.map((a) => `${a}:${port}`)]);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Absender der Verbindung; im Test (app.request ohne Socket) gilt sie als lokal. */
function remoteAddress(c: Context): string {
	const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
	return env?.incoming?.socket?.remoteAddress ?? "127.0.0.1";
}

type Env = { Variables: { origin: Origin; session: string | null } };

export function createApp(desk: Desk) {
	const app = new Hono<Env>();
	const cfg = desk.cfg;
	const auth = desk.auth;
	const hosts = localHosts(cfg.port, cfg.dev, cfg.listen);
	const origins = new Set([...hosts].map((h) => `http://${h}`));

	// jede Anfrage, auch die Web-App: nur mit dem Host des Desks – eine fremde Seite, deren Name auf 127.0.0.1 zeigt, liest nichts
	app.use("*", async (c, next) => {
		const host = (c.req.header("Host") ?? new URL(c.req.url).host).toLowerCase();
		if (!hosts.has(host)) return c.text("forbidden host", 403);
		await next();
	});

	// Größe begrenzen, bevor gelesen wird: der CSV-Import darf 2,5 MB, alles andere 64 KB
	const tooLarge = (c: Context) => c.json({ ok: false, msg: "Anfrage zu groß." }, 413);
	const importLimit = bodyLimit({ maxSize: 2_600_000, onError: tooLarge });
	const apiLimit = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
	app.use("/api/*", (c, next) => (/^\/api\/accounts\/[^/]+\/import$/.test(c.req.path) ? importLimit(c, next) : apiLimit(c, next)));

	app.use("/api/*", async (c, next) => {
		const origin = c.req.header("Origin") ?? "";
		const write = c.req.method !== "GET" && c.req.method !== "HEAD";
		if (write) {
			// jede Webseite darf an 127.0.0.1 posten: nur JSON (erzwingt den Preflight) und nur der Origin des Desks
			const json = (c.req.header("Content-Type") ?? "").startsWith("application/json");
			if (!json || (origin && !origins.has(origin))) return c.json({ ok: false, msg: "forbidden" }, 403);
		}
		// EventSource kann keine Header setzen: nur für den Live-Stream (nur lesen) darf das Token in der Adresse stehen
		const token = c.req.header(SESSION_HEADER) ?? (c.req.path === "/api/stream" ? c.req.query("session") : undefined);
		const session = auth.verify(token) ? token! : null;
		c.set("session", session);
		// von einem anderen Gerät (Tailscale, z. B. dein Handy): ohne Sitzung gar nichts, auch nicht lesen – die CLI der
		// Agenten läuft nur auf diesem Computer
		if (!LOOPBACK.has(remoteAddress(c)) && !session && !c.req.path.startsWith("/api/auth"))
			return c.json({ ok: false, msg: "Nicht angemeldet – mit deiner PIN anmelden.", code: "auth" }, 401);
		// du: gültige Sitzung, bei Änderungen zusätzlich ein Origin des Desks; ein Abruf von einer fremden Seite zählt nie
		const site = c.req.header("Sec-Fetch-Site");
		const owner = !!session && (write ? !!origin : !site || site === "same-origin" || site === "none");
		if (write && origin && !session && !c.req.path.startsWith("/api/auth")) return c.json({ ok: false, msg: "Nicht angemeldet – im Browser mit deiner PIN anmelden.", code: "auth" }, 401);
		c.set("origin", owner ? "web" : "cli");
		await next();
	});

	app.onError((e, c) => {
		if (e instanceof DeskError) return c.json({ ok: false, msg: e.message, data: e.data ?? null }, e.status as 400);
		if (e instanceof AuthError) {
			if (e.retryAfterSec) c.header("Retry-After", String(e.retryAfterSec));
			return c.json({ ok: false, msg: e.message, code: "auth" }, e.status as 400);
		}
		console.error(e);
		return c.json({ ok: false, msg: `Serverfehler: ${e.message}` }, 500);
	});

	const userOnly = (c: Context<Env>) => {
		if (c.get("origin") !== "web") throw new DeskError("Nur im Browser mit deiner Anmeldung – das entscheidet der Mensch, nicht ein Agent.", 403);
	};
	/** JSON-Objekt aus dem Body; leer ist {}, kaputtes JSON ein 400 (nicht still {}). */
	const body = async (c: Context) => {
		const text = await c.req.text();
		if (!text.trim()) return {} as Record<string, unknown>;
		let v: unknown;
		try {
			v = JSON.parse(text);
		} catch {
			throw new DeskError("Ungültiges JSON.");
		}
		if (!v || typeof v !== "object" || Array.isArray(v)) throw new DeskError("JSON-Objekt erwartet.");
		return v as Record<string, unknown>;
	};
	const browser = (c: Context) => {
		if (!c.req.header("Origin")) throw new AuthError("Anmelden nur im Browser.", 403);
	};

	/* Anmeldung: PIN einmal mit dem Einrichtungscode aus der Konsole setzen, dann mit der PIN anmelden */
	app.get("/api/auth", (c) => c.json({ pinSet: auth.pinSet, authenticated: c.get("session") !== null }));
	app.post("/api/auth/setup", async (c) => {
		browser(c);
		const b = await body(c);
		const token = auth.setup(b.code, b.pin);
		desk.event("auth.setup", cfg.user, "PIN eingerichtet");
		return c.json({ ok: true, pinSet: true, authenticated: true, token });
	});
	app.post("/api/auth/login", async (c) => {
		browser(c);
		return c.json({ ok: true, pinSet: true, authenticated: true, token: auth.login((await body(c)).pin) });
	});
	app.post("/api/auth/logout", (c) => {
		auth.logout(c.get("session") ?? undefined);
		return c.json({ ok: true, pinSet: auth.pinSet, authenticated: false });
	});
	const id = (c: Context) => {
		const n = Number(c.req.param("id"));
		if (!Number.isInteger(n) || n <= 0) throw new DeskError("Ungültige ID.");
		return n;
	};

	app.get("/api/ping", (c) => c.json({ ok: true, version: VERSION, user: cfg.user, agents: cfg.agents, accounts: cfg.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, owner: a.owner })), ticks: desk.ticks }));

	/* Depots */
	app.get("/api/overview", (c) => c.json(desk.overview()));
	app.get("/api/accounts/:id", (c) => c.json(desk.detail(c.req.param("id"))));
	app.post("/api/accounts/:id/trades", async (c) => {
		userOnly(c);
		return c.json({ ok: true, trade: await desk.recordTrade(c.req.param("id"), await body(c)) });
	});
	app.delete("/api/accounts/:acc/trades/:id", (c) => {
		userOnly(c);
		desk.deleteTrade(c.req.param("acc"), id(c));
		return c.json({ ok: true });
	});
	app.post("/api/accounts/:acc/trades/:id/restore", (c) => {
		userOnly(c);
		desk.deleteTrade(c.req.param("acc"), id(c), true);
		return c.json({ ok: true });
	});
	app.post("/api/accounts/:id/cash", async (c) => {
		userOnly(c);
		return c.json({ ok: true, move: desk.cashMove(c.req.param("id"), await body(c)) });
	});
	app.post("/api/accounts/:id/import", async (c) => {
		userOnly(c);
		return c.json({ ok: true, result: await desk.importCsv(c.req.param("id"), (await body(c)).csv) });
	});

	/* Markt */
	app.get("/api/market/watchlist", (c) => c.json(desk.watchlist()));
	app.post("/api/market/watchlist", async (c) => {
		userOnly(c);
		return c.json({ ok: true, watchlist: await desk.addWatch((await body(c)).symbol, cfg.user) });
	});
	app.delete("/api/market/watchlist/:symbol", (c) => {
		userOnly(c);
		return c.json({ ok: true, watchlist: desk.removeWatch(c.req.param("symbol"), cfg.user) });
	});
	app.get("/api/market/search", async (c) => c.json(await desk.search(c.req.query("q") ?? "")));
	app.get("/api/market/chart/:symbol", async (c) => {
		const r = ChartRangeSchema.safeParse(c.req.query("range") ?? "6mo");
		if (!r.success) throw new DeskError("range: 1d, 1mo, 3mo, 6mo, 1y oder 5y");
		return c.json(await desk.chart(c.req.param("symbol"), r.data as ChartRange));
	});
	app.get("/api/market/quote/:symbol", async (c) => {
		const symbol = desk.normalizeSymbol(c.req.param("symbol"));
		if (!desk.priced(symbol)) await desk.refresh([symbol]);
		const p = desk.priced(symbol);
		if (!p) throw new DeskError(`Kein Kurs für ${symbol}.`, 404);
		const i = desk.instrument(symbol)!;
		return c.json({ symbol, name: i.name, currency: p.currency, price: p.price, fx: p.fx, priceEur: p.price * p.fx, prevClose: p.prevClose, marketTime: p.marketTime, watched: desk.watchlist().some((w) => w.symbol === symbol && w.watched) });
	});
	app.post("/api/market/alerts", async (c) => {
		userOnly(c);
		return c.json({ ok: true, watchlist: desk.addAlert(await body(c), cfg.user) });
	});
	app.delete("/api/market/alerts/:id", (c) => {
		userOnly(c);
		return c.json({ ok: true, watchlist: desk.removeAlert(id(c)) });
	});

	/* Vorschläge und Orders */
	app.get("/api/proposals", (c) => c.json(desk.proposals({ status: c.req.query("status"), author: c.req.query("author"), limit: int(c.req.query("limit"), 300, 1, 1000) })));
	app.get("/api/proposals/:id", (c) => c.json(desk.proposal(id(c))));
	app.post("/api/proposals", async (c) => {
		const res = await desk.submit(await body(c), c.get("origin"), { dryRun: c.req.query("dryRun") === "1" });
		return c.json(res.ok ? { ...res } : { ...res, msg: res.check.violations.join(" ") }, res.ok ? 200 : 422);
	});
	app.post("/api/proposals/:id/approve", async (c) => {
		userOnly(c);
		const p = await desk.approve(id(c), await body(c));
		const ok = p.status === "filled" || p.status === "open" || p.status === "placed";
		return c.json({ ok, proposal: p, msg: ok ? undefined : p.reason }, ok ? 200 : 409);
	});
	app.post("/api/proposals/:id/reject", async (c) => {
		userOnly(c);
		return c.json({ ok: true, proposal: desk.reject(id(c), (await body(c)).reason) });
	});
	app.post("/api/proposals/:id/cancel", async (c) => {
		userOnly(c);
		return c.json({ ok: true, proposal: await desk.cancel(id(c)) });
	});
	app.post("/api/proposals/:id/confirm", async (c) => {
		userOnly(c);
		const p = await desk.confirmBroker(id(c));
		const ok = p.status === "placed" || p.status === "filled";
		return c.json({ ok, proposal: p, msg: ok ? undefined : p.brokerMessage ?? p.reason }, ok ? 200 : 409);
	});

	/* Broker */
	app.get("/api/brokers", (c) => c.json(desk.brokerStatuses()));
	// Vorschau: GET für die Web-App (mit Sitzung), POST …/preview als Variante ohne GET (holt beim Broker ab)
	app.get("/api/accounts/:id/reconcile", async (c) => {
		userOnly(c);
		return c.json(await desk.reconcile(c.req.param("id")));
	});
	app.post("/api/accounts/:id/reconcile/preview", async (c) => {
		userOnly(c);
		return c.json(await desk.reconcile(c.req.param("id")));
	});
	app.post("/api/accounts/:id/reconcile", async (c) => {
		userOnly(c);
		return c.json(await desk.applyReconcile(c.req.param("id")));
	});
	app.post("/api/proposals/:id/fill", async (c) => {
		userOnly(c);
		return c.json({ ok: true, proposal: desk.fill(id(c), await body(c)) });
	});

	/* Risiko */
	app.get("/api/risk", (c) => c.json(desk.risk()));
	app.put("/api/risk/kill", async (c) => {
		userOnly(c);
		const b = await body(c);
		if (typeof b.on !== "boolean") throw new DeskError("on: true oder false");
		return c.json(desk.setKill(b.on));
	});
	app.put("/api/risk/:account", async (c) => {
		userOnly(c);
		return c.json(desk.setLimits(c.req.param("account"), await body(c)));
	});

	/* Daytrading */
	app.get("/api/cockpit", (c) => c.json(desk.cockpit()));
	app.get("/api/market/scan", (c) => c.json(desk.scan()));
	app.get("/api/market/analysis/:symbol", async (c) => c.json(await desk.analysis(c.req.param("symbol"))));
	app.get("/api/market/news/:symbol", async (c) => c.json(await desk.news(c.req.param("symbol"))));
	app.get("/api/accounts/:id/day", (c) => c.json(desk.dayStatsOf(desk.account(c.req.param("id")).id)));

	/* Chat: du im Browser, Agenten über cli/desk.py – eine Nachricht genehmigt nie eine Order */
	app.get("/api/chat", (c) => {
		const since = c.req.query("since");
		return c.json(desk.chat({ since: since === undefined ? undefined : int(since, 0, 0, Number.MAX_SAFE_INTEGER), limit: int(c.req.query("limit"), 200, 1, 1000) }));
	});
	app.post("/api/chat", async (c) => c.json({ ok: true, message: desk.say(await body(c), c.get("origin")) }));

	/* Agenten und Journal */
	app.get("/api/agents", (c) => c.json(desk.agentsData()));
	app.get("/api/journal", (c) => c.json(desk.journal({ author: c.req.query("author"), symbol: c.req.query("symbol"), limit: int(c.req.query("limit"), 100, 1, 500) })));
	app.post("/api/journal", async (c) => c.json({ ok: true, entry: desk.addJournal(await body(c), c.get("origin")) }));

	/* Live */
	app.get("/api/stream", (c) =>
		streamSSE(c, async (stream) => {
			const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined);
			await send("hello", { version: VERSION });
			const onEvent = (e: unknown) => void send("event", e);
			const onTick = (t: unknown) => void send("tick", t);
			const onChat = (m: unknown) => void send("chat", m);
			desk.on("event", onEvent);
			desk.on("tick", onTick);
			desk.on("chat", onChat);
			const unwatch = desk.watch(); // solange jemand zusieht: schneller Kurstakt
			stream.onAbort(() => {
				desk.off("event", onEvent);
				desk.off("tick", onTick);
				desk.off("chat", onChat);
				unwatch();
			});
			while (!stream.aborted && !stream.closed) {
				await stream.sleep(15_000);
				await send("ping", { at: Date.now() });
			}
			unwatch();
		}),
	);

	/* Web-App (SPA) */
	app.get("*", (c) => {
		if (c.req.path.startsWith("/api/")) return c.json({ ok: false, msg: "not found" }, 404);
		const index = path.join(cfg.webDist, "index.html");
		if (!existsSync(index)) return c.text("Web-App nicht gebaut: npm run build", 503);
		const asset = c.req.path === "/" ? null : inside(cfg.webDist, c.req.path.slice(1));
		if (asset) return sendFile(c, asset, c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
		return sendFile(c, index);
	});

	return app;
}
