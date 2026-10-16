// Die HTTP-Grenze (Q1 B1, B15, B16, B25, B30): nur du mit Sitzung erreichst die Routen des Besitzers, nur der eigene
// Host wird bedient, Größe und JSON werden geprüft. Agenten (ohne Cookie) lesen und schlagen weiter vor.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFixture, type Fixture } from "../src/fixture.ts";
import { deskHttp } from "./owner.ts";

let fx: Fixture;
let clock: number;
let http: ReturnType<typeof deskHttp>;

beforeEach(async () => {
	clock = new Date(2026, 9, 15, 11, 0).getTime();
	fx = await makeFixture({ now: () => clock });
	http = deskHttp(fx);
});
afterEach(() => fx.cleanup());

const pendingId = () => fx.desk.proposals({ status: "pending" }).find((p) => p.accountId === "agent-atlas")!.id;

/** Jede Route des Besitzers mit gültigem Body. */
function ownerRoutes(id: number): [string, string, unknown][] {
	return [
		["POST", `/api/proposals/${id}/approve`, {}],
		["POST", `/api/proposals/${id}/reject`, { reason: "x" }],
		["POST", `/api/proposals/${id}/cancel`, {}],
		["POST", `/api/proposals/${id}/confirm`, {}],
		["POST", `/api/proposals/${id}/fill`, { price: 100 }],
		["PUT", "/api/risk/kill", { on: true }],
		["PUT", "/api/risk/agent-atlas", { maxOrderCents: 0 }],
		["POST", "/api/accounts/tr/trades", { symbol: "SAP.DE", side: "buy", qty: 1, price: 1 }],
		["DELETE", "/api/accounts/tr/trades/1", {}],
		["POST", "/api/accounts/tr/trades/1/restore", {}],
		["POST", "/api/accounts/tr/cash", { amountEur: 1000 }],
		["POST", "/api/accounts/tr/import", { csv: "datum;symbol;seite;stueck;kurs\n2026-10-01;SAP.DE;kauf;1;10" }],
		["POST", "/api/accounts/ibkr/reconcile", {}],
		["POST", "/api/accounts/ibkr/reconcile/preview", {}],
		["POST", "/api/market/watchlist", { symbol: "AAPL" }],
		["DELETE", "/api/market/watchlist/SAP.DE", {}],
		["POST", "/api/market/alerts", { symbol: "SAP.DE", op: "above", price: 300 }],
		["DELETE", "/api/market/alerts/1", {}],
	];
}

describe("owner login (B1)", () => {
	it("a spoofed local Origin without your session reaches no owner route", async () => {
		const id = pendingId();
		const events = fx.desk.events(500).length;
		for (const [method, p, body] of ownerRoutes(id)) {
			const r = await http.request(p, { method, headers: { "Content-Type": "application/json", Origin: http.base }, body: JSON.stringify(body) });
			expect([401, 403], `${method} ${p}`).toContain(r.status);
		}
		expect((await http.get("/api/accounts/ibkr/reconcile")).status).toBe(403);
		expect(fx.desk.killSwitch).toBe(false);
		expect(fx.desk.proposal(id).status).toBe("pending");
		expect(fx.desk.limits("agent-atlas").maxOrderCents).toBe(500_000);
		expect(fx.desk.events(500).length).toBe(events);
	});

	it("your session without the desk's Origin, or with another port, changes nothing", async () => {
		await http.login();
		const id = pendingId();
		const noOrigin = await http.request(`/api/proposals/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: http.cookie }, body: "{}" });
		expect(noOrigin.status).toBe(403);
		const otherPort = await http.request("/api/risk/kill", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: http.cookie, Origin: "http://localhost:1" }, body: JSON.stringify({ on: true }) });
		expect(otherPort.status).toBe(403);
		expect(fx.desk.proposal(id).status).toBe("pending");
		expect(fx.desk.killSwitch).toBe(false);
	});

	it("logs in with the PIN, keeps only a hash of the token and logs out", async () => {
		expect(await (await http.get("/api/auth")).json()).toEqual({ pinSet: true, authenticated: false });
		const r = await http.login();
		const set = r.headers.get("set-cookie")!;
		expect(set).toMatch(/^desk_session=[A-Za-z0-9_-]{43};/);
		expect(set).toMatch(/HttpOnly/);
		expect(set).toMatch(/SameSite=Strict/);
		expect(set).toMatch(/Path=\//);
		expect(set).toMatch(/Max-Age=2592000/);
		expect(await (await http.webGet("/api/auth")).json()).toEqual({ pinSet: true, authenticated: true });
		const token = http.cookie.split("=")[1];
		const rows = fx.db.all<{ token_hash: string }>("SELECT token_hash FROM owner_session");
		expect(rows).toHaveLength(1);
		expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(fx.db.all("SELECT * FROM owner_session")) + JSON.stringify(fx.db.all("SELECT * FROM setting"))).not.toContain(token);
		expect((await http.web("/api/risk/kill", "PUT", { on: true })).status).toBe(200);
		expect((await http.web("/api/auth/logout")).status).toBe(200);
		expect(fx.db.all("SELECT * FROM owner_session")).toHaveLength(0);
		expect((await http.web("/api/risk/kill", "PUT", { on: false })).status).toBe(401);
		expect(fx.desk.killSwitch).toBe(true);
	});

	it("stores the PIN only as a salted scrypt hash", () => {
		const v = fx.db.get<{ value: string }>("SELECT value FROM setting WHERE key = 'owner_pin'")!.value;
		expect(v).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
		expect(v).not.toContain("2468");
		fx.desk.auth.presetPin("2468");
		expect(fx.db.get<{ value: string }>("SELECT value FROM setting WHERE key = 'owner_pin'")!.value).not.toBe(v); // neues Salz
	});

	it("locks after five wrong PINs for 60 s, then longer", async () => {
		for (let i = 0; i < 5; i++) expect((await http.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: http.base }, body: JSON.stringify({ pin: "1111" }) })).status).toBe(401);
		const locked = await http.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: http.base }, body: JSON.stringify({ pin: "2468" }) });
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get("Retry-After"))).toBe(60);
		clock += 61_000;
		await http.login();
		// nach einer zweiten Fünferserie wartet man doppelt so lang
		for (let i = 0; i < 5; i++) await http.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: http.base }, body: JSON.stringify({ pin: "1111" }) });
		clock += 61_000;
		for (let i = 0; i < 5; i++) await http.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: http.base }, body: JSON.stringify({ pin: "1111" }) });
		const again = await http.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: http.base }, body: JSON.stringify({ pin: "2468" }) });
		expect(Number(again.headers.get("Retry-After"))).toBe(120);
	});

	it("sets the first PIN only with the one-time code from the console", async () => {
		fx.desk.auth.reset();
		const post = (body: unknown) => http.request("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json", Origin: http.base }, body: JSON.stringify(body) });
		expect(await (await http.get("/api/auth")).json()).toEqual({ pinSet: false, authenticated: false });
		expect((await post({ code: "ABCDEFGH", pin: "1234" })).status).toBe(409); // noch kein Code aktiv (erst beim Start)
		const code = fx.desk.auth.startSetup()!;
		expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
		expect((await post({ code: "WRONG123", pin: "1234" })).status).toBe(403);
		expect((await post({ code, pin: "12" })).status).toBe(400);
		const ok = await post({ code: code.toLowerCase(), pin: "975310" });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("set-cookie")).toMatch(/desk_session=/);
		expect((await post({ code, pin: "1234" })).status).toBe(409); // einmalig
		expect(JSON.stringify(fx.db.all("SELECT * FROM setting")) + JSON.stringify(fx.db.all("SELECT * FROM event")) + JSON.stringify(fx.desk.chat())).not.toContain(code);
		await http.login("975310");
	});

	it("agents without a cookie still read and propose; your chat with a session is yours", async () => {
		for (const p of ["/api/overview", "/api/cockpit", "/api/market/scan", "/api/proposals", "/api/chat", "/api/risk", "/api/agents", "/api/accounts/agent-atlas"]) expect((await http.get(p)).status, p).toBe(200);
		const r = await http.cli("/api/proposals", { author: "Atlas", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 1, stopLoss: 190, confidence: 0.8, thesis: "x" });
		expect(r.status).toBe(200);
		await http.login();
		const m = (await (await http.web("/api/chat", "POST", { text: "hallo" })).json()) as { message: { author: string; role: string } };
		expect(m.message).toMatchObject({ author: "Maurice", role: "user" });
	});
});

describe("reconcile preview in the browser (B15)", () => {
	it("works with your session on a same-origin GET and as POST …/preview", async () => {
		await http.login();
		const get = await http.webGet("/api/accounts/ibkr/reconcile");
		expect(get.status).toBe(200);
		expect(((await get.json()) as { status: { brokerAccount: string } }).status.brokerAccount).toBe("DU0000001");
		expect((await http.web("/api/accounts/ibkr/reconcile/preview")).status).toBe(200);
		const crossSite = await http.request("/api/accounts/ibkr/reconcile", { headers: { Cookie: http.cookie, "Sec-Fetch-Site": "cross-site" } });
		expect(crossSite.status).toBe(403);
	});
});

describe("Host header (B16)", () => {
	it("serves only 127.0.0.1, localhost and [::1] on the desk's own port", async () => {
		const port = fx.cfg.port;
		for (const host of [`evil.example:${port}`, "evil.example", `127.0.0.1:${port + 1}`, "127.0.0.1"]) {
			expect((await http.request("/api/overview", { headers: { Host: host } })).status, host).toBe(403);
			expect((await http.request("/", { headers: { Host: host } })).status, host).toBe(403);
		}
		for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) expect((await http.request("/api/overview", { headers: { Host: host } })).status, host).toBe(200);
		expect((await http.request("/api/stream", { headers: { Host: `evil.example:${port}` } })).status).toBe(403);
	});
});

describe("body size and JSON (B25, B30)", () => {
	it("refuses a 3 MB chat body with 413 and accepts a large CSV import", async () => {
		const big = await http.cli("/api/chat", { author: "Atlas", text: "x".repeat(3_000_000) });
		expect(big.status).toBe(413);
		expect(fx.desk.chat().some((m) => m.text.startsWith("xxx"))).toBe(false);
		await http.login();
		const rows = Array.from({ length: 20_000 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")};SAP.DE;kauf;1;${100 + (i % 50)},${String(i % 100).padStart(2, "0")};0`).join("\n");
		const r = await http.web("/api/accounts/tr/import", "POST", { csv: `datum;symbol;seite;stueck;kurs;gebuehr\n${rows}` });
		expect(r.status).toBe(200);
	});

	it("answers 400 to broken JSON instead of reading it as {}", async () => {
		const r = await http.request("/api/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
		expect(r.status).toBe(400);
		expect(((await r.json()) as { msg: string }).msg).toBe("Ungültiges JSON.");
	});

	it("refuses unknown fields from agents, so a typo is not 'no stop'", async () => {
		const r = await http.cli("/api/proposals", { author: "Atlas", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 1, stoploss: 190, confidence: 0.8, thesis: "x" });
		expect(r.status).toBe(400);
		expect(((await r.json()) as { msg: string }).msg).toContain("stoploss");
	});
});

describe("setup code at startup (B1)", () => {
	it("is printed only to the server console and nowhere else", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "tradedesk-auth-"));
		const port = 18_000 + Math.floor(Math.random() * 2_000);
		writeFileSync(path.join(home, "config.json"), JSON.stringify({ user: "Maurice", port, market: "off" }));
		const server = path.resolve(import.meta.dirname, "../src/index.ts");
		const p = spawn(process.execPath, [server, "--home", home], { windowsHide: true, env: { ...process.env, TRADEDESK_HOME: home } });
		try {
			let out = "";
			const code = await new Promise<string>((resolve, reject) => {
				const t = setTimeout(() => reject(new Error(`no setup code within 30 s:\n${out}`)), 30_000);
				const read = (d: Buffer) => {
					out += d.toString();
					const m = /PIN festlegen: Einrichtungscode ([A-Z0-9]{8})/.exec(out);
					if (m) {
						clearTimeout(t);
						resolve(m[1]);
					}
				};
				p.stdout.on("data", read);
				p.stderr.on("data", read);
				p.on("exit", (c) => reject(new Error(`server exited ${c}:\n${out}`)));
			});
			const base = `http://127.0.0.1:${port}`;
			expect(await (await fetch(`${base}/api/auth`)).json()).toEqual({ pinSet: false, authenticated: false });
			for (const p2 of ["/api/auth", "/api/overview", "/api/chat", "/api/ping"]) expect(await (await fetch(base + p2)).text()).not.toContain(code);
			const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ code, pin: "4711" }) });
			expect(setup.status).toBe(200);
			// beendet sauber, dann liegt die Datenbank vollständig auf der Platte
			p.kill();
			await new Promise((r) => p.once("exit", r));
			const db = readFileSync(path.join(home, "desk.sqlite")).toString("latin1") + (() => {
				try {
					return readFileSync(path.join(home, "desk.sqlite-wal")).toString("latin1");
				} catch {
					return "";
				}
			})();
			expect(db).not.toContain(code);
			expect(db).not.toContain("4711");
		} finally {
			if (p.exitCode === null) p.kill();
			rmSync(home, { recursive: true, force: true });
		}
	});
});
