// HTTP: API, SSE-Stream, Web-App. Nur 127.0.0.1.
// Zwei Arten Aufrufer: der Browser (sendet bei Änderungen immer einen Origin – das bist du) und cli/desk.py der
// Agenten (ohne Origin). Freigeben, Ablehnen, Not-Aus, Grenzen und Trades erfassen gehen nur aus dem Browser.
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ChartRange } from "@desk/shared";
import { ChartRangeSchema } from "@desk/shared";
import { DeskError, type Desk, type Origin } from "./desk.ts";

export const VERSION = 1;
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
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

export function createApp(desk: Desk) {
	const app = new Hono<{ Variables: { origin: Origin } }>();
	const cfg = desk.cfg;

	app.use("/api/*", async (c, next) => {
		const origin = c.req.header("Origin") ?? "";
		if (c.req.method !== "GET" && c.req.method !== "HEAD") {
			// jede Webseite darf an 127.0.0.1 posten: nur JSON (erzwingt den Preflight) und nur ein lokaler Origin
			const json = (c.req.header("Content-Type") ?? "").startsWith("application/json");
			if (!json || (origin && !LOCAL_ORIGIN.test(origin))) return c.json({ ok: false, msg: "forbidden" }, 403);
		}
		c.set("origin", origin ? "web" : "cli");
		await next();
	});

	app.onError((e, c) => {
		if (e instanceof DeskError) return c.json({ ok: false, msg: e.message, data: e.data ?? null }, e.status as 400);
		console.error(e);
		return c.json({ ok: false, msg: `Serverfehler: ${e.message}` }, 500);
	});

	const userOnly = (c: Context<{ Variables: { origin: Origin } }>) => {
		if (c.get("origin") !== "web") throw new DeskError("Nur im Browser – das entscheidet der Mensch, nicht ein Agent.", 403);
	};
	const body = async (c: Context) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
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
	app.post("/api/proposals/:id/cancel", (c) => {
		userOnly(c);
		return c.json({ ok: true, proposal: desk.cancel(id(c)) });
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
			desk.on("event", onEvent);
			desk.on("tick", onTick);
			stream.onAbort(() => {
				desk.off("event", onEvent);
				desk.off("tick", onTick);
			});
			while (!stream.aborted && !stream.closed) {
				await stream.sleep(15_000);
				await send("ping", { at: Date.now() });
			}
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
