import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { cleanConfig } from "../src/config.ts";
import { makeFixture, type Fixture } from "../src/fixture.ts";

let fx: Fixture;
let clock: number;

beforeEach(async () => {
	clock = new Date(2026, 9, 15, 11, 0).getTime();
	fx = await makeFixture({ now: () => clock });
});
afterEach(() => fx.cleanup());

const web = (p: string, method: string, body: unknown = {}) =>
	createApp(fx.desk).request(p, { method, headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:8095" }, body: JSON.stringify(body) });
const cli = (p: string, body: unknown, method = "POST") => createApp(fx.desk).request(p, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const propose = (over: Record<string, unknown> = {}) =>
	fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 2, stopLoss: 190, confidence: 0.7, thesis: "Test", ...over }, "cli");

describe("proposals", () => {
	it("marks a proposal stale when the price moved too far and executes nothing", async () => {
		const r = await propose();
		const before = fx.desk.detail("agent-atlas").trades.length;
		fx.market.set("SAP.DE", 201.25 * 1.03);
		clock += 120_000;
		const p = await fx.desk.approve(r.proposal!.id, {});
		expect(p.status).toBe("stale");
		expect(p.reason).toContain("3,0 %");
		expect(fx.desk.detail("agent-atlas").trades.length).toBe(before);
	});

	it("does not create proposals below the minimum confidence", async () => {
		const r = await propose({ confidence: 0.3 });
		expect(r.ok).toBe(false);
		expect(r.check.violations.join()).toContain("Mindestwert");
		expect(fx.desk.proposals({ status: "pending" }).some((p) => p.thesis === "Test")).toBe(false);
	});

	it("lets an agent propose only for its own account or yours", async () => {
		await expect(propose({ accountId: "agent-nova" })).rejects.toThrow("darf nicht");
		expect((await propose({ accountId: "papier" })).ok).toBe(true);
	});

	it("dry run checks without saving", async () => {
		const n = fx.desk.proposals().length;
		const r = await fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 1, stopLoss: 190, confidence: 0.9, thesis: "x" }, "cli", { dryRun: true });
		expect(r).toMatchObject({ ok: true, proposal: null });
		expect(fx.desk.proposals().length).toBe(n);
	});

	it("fills an approved limit order once the price crosses it", async () => {
		const r = await propose({ orderType: "limit", limitPrice: 195 });
		expect((await fx.desk.approve(r.proposal!.id, {})).status).toBe("open");
		await fx.desk.tick();
		expect(fx.desk.proposal(r.proposal!.id).status).toBe("open");
		fx.market.set("SAP.DE", 194.5);
		await fx.desk.tick();
		const p = fx.desk.proposal(r.proposal!.id);
		expect(p).toMatchObject({ status: "filled", fillPrice: 194.5 });
	});

	it("does not fill open limits while the kill switch is on", async () => {
		const r = await propose({ orderType: "limit", limitPrice: 195 });
		await fx.desk.approve(r.proposal!.id, {});
		fx.desk.setKill(true);
		fx.market.set("SAP.DE", 190);
		await fx.desk.tick();
		expect(fx.desk.proposal(r.proposal!.id).status).toBe("open");
	});

	it("expires undecided proposals", async () => {
		const r = await propose();
		clock += 25 * 3_600_000;
		await fx.desk.tick();
		expect(fx.desk.proposal(r.proposal!.id).status).toBe("expired");
	});

	it("stops buys after the daily loss limit", async () => {
		fx.desk.setLimits("agent-atlas", { dailyLossPct: 1 });
		fx.desk.db.run("UPDATE snapshot SET equity_cents = equity_cents * 2 WHERE account_id = 'agent-atlas'");
		const r = await propose();
		expect(r.ok).toBe(false);
		expect(r.check.violations.join()).toContain("Tagesverlust");
	});

	it("warns you once when a stop loss is reached", async () => {
		const r = await propose({ stopLoss: 190 });
		await fx.desk.approve(r.proposal!.id, {});
		fx.market.set("SAP.DE", 189);
		await fx.desk.tick();
		await fx.desk.tick();
		expect(fx.desk.events(50).filter((e) => e.kind === "stop")).toHaveLength(1);
	});

	it("keeps the old quotes and says so when the market fails", async () => {
		fx.market.failing = true;
		await fx.desk.tick();
		const o = fx.desk.overview();
		expect(o.market).toBe("error");
		expect(o.marketError).toContain("nicht erreichbar");
		expect(fx.desk.watchlist().every((w) => w.price !== null)).toBe(true);
	});
});

describe("manual account (Trade Republic)", () => {
	it("imports CSV once and skips the same lines the second time", async () => {
		const csv = "datum;symbol;seite;stueck;kurs;gebuehr\n01.10.2026;ALV.DE;kauf;2;340,00;1,00\n02.10.2026;MSFT;kauf;1;360,00;1,00";
		expect(await fx.desk.importCsv("tr", csv)).toEqual({ imported: 2, skipped: 0, errors: [] });
		expect(await fx.desk.importCsv("tr", csv)).toEqual({ imported: 0, skipped: 2, errors: [] });
	});

	it("deletes a trade with undo", async () => {
		const t = await fx.desk.recordTrade("tr", { symbol: "ALV.DE", side: "buy", qty: 1, price: 350 });
		const cash = fx.desk.summary(fx.desk.account("tr")).cashCents;
		fx.desk.deleteTrade("tr", t.id);
		expect(fx.desk.summary(fx.desk.account("tr")).cashCents).toBe(cash + 35_100);
		fx.desk.deleteTrade("tr", t.id, true);
		expect(fx.desk.summary(fx.desk.account("tr")).cashCents).toBe(cash);
	});

	it("refuses to sell more than you hold", async () => {
		await expect(fx.desk.recordTrade("tr", { symbol: "SAP.DE", side: "sell", qty: 9, price: 200 })).rejects.toThrow("weniger als");
	});

	it("values a US share bought in EUR at the current USD quote times the exchange rate", () => {
		const aapl = fx.desk.detail("tr").positions.find((p) => p.symbol === "AAPL")!;
		expect(aapl.avgPrice).toBe(188.5);
		expect(aapl.valueCents).toBe(Math.round(6 * 231.4 * 0.92 * 100));
	});
});

describe("HTTP boundary", () => {
	it("agents cannot record trades, change limits or switch the kill switch", async () => {
		expect((await cli("/api/accounts/tr/trades", { symbol: "SAP.DE", side: "buy", qty: 1, price: 1 })).status).toBe(403);
		expect((await cli("/api/risk/agent-atlas", { maxOrderCents: 0 }, "PUT")).status).toBe(403);
		expect((await cli("/api/risk/kill", { on: false }, "PUT")).status).toBe(403);
	});

	it("form posts without JSON are refused", async () => {
		const r = await createApp(fx.desk).request("/api/journal", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "author=Atlas&text=hi" });
		expect(r.status).toBe(403);
	});

	it("agents write to the journal under their own name only", async () => {
		const ok = await cli("/api/journal", { author: "atlas", text: "Notiz", symbol: "sap.de" });
		expect(((await ok.json()) as { entry: { author: string; symbol: string } }).entry).toMatchObject({ author: "Atlas", symbol: "SAP.DE" });
		expect((await cli("/api/journal", { author: "Maurice", text: "fake" })).status).toBe(403);
	});

	it("your own paper order fills right away", async () => {
		const r = await web("/api/proposals", "POST", { accountId: "papier", symbol: "SAP.DE", side: "buy", qty: 1 });
		const body = (await r.json()) as { proposal: { status: string; author: string } };
		expect(body.proposal).toMatchObject({ status: "filled", author: "Maurice" });
	});

	it("serves no file outside the web build", async () => {
		const r = await createApp(fx.desk).request("/..%2f..%2fpackage.json");
		expect(await r.text()).not.toContain("workspaces");
	});
});

describe("config", () => {
	it("drops broken entries and gives every agent a paper account", () => {
		const c = cleanConfig({ accounts: [{ id: "Bad Id" }, { id: "tr", kind: "manual" }, { id: "tr" }], agents: ["Atlas", "atlas", "", { name: "Nova", startCashEur: 500 }] }, { home: "", dbFile: "", webDist: "", dev: false }, {});
		expect(c.accounts.map((a) => a.id)).toEqual(["tr", "agent-atlas", "agent-nova"]);
		expect(c.accounts[2].startCashCents).toBe(50_000);
	});
});

describe("guards", () => {
	it("only http.ts calls fetch on the server", () => {
		const dir = path.resolve(import.meta.dirname, "../src");
		const offenders = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "http.ts" && /\bfetch\(/.test(readFileSync(path.join(dir, f), "utf8")));
		expect(offenders).toEqual([]);
	});

	it("the clock is injectable: nothing in desk.ts reads Date.now directly", () => {
		const src = readFileSync(path.resolve(import.meta.dirname, "../src/desk.ts"), "utf8");
		expect(src.match(/Date\.now\(\)/g) ?? []).toEqual([]);
	});
});

describe("daytrading", () => {
	it("requires a stop from agents and caps the risk per trade", async () => {
		const none = await propose({ stopLoss: undefined });
		expect(none.check.violations.join()).toContain("Stop-Loss");
		const wide = await propose({ qty: 40, stopLoss: 150 }); // 40 × 51,25 € ≈ 2.050 € ≈ 20 % des Depots
		expect(wide.check.violations.join()).toContain("je Trade");
	});

	it("scans the watchlist with gap, range position, relative volume and ATR", () => {
		const row = fx.desk.scan().find((r) => r.symbol === "SAP.DE")!;
		expect(row.gapPct).not.toBeNull();
		expect(row.rangePos).toBeGreaterThanOrEqual(0);
		expect(row.rangePos).toBeLessThanOrEqual(1);
		expect(row.relVolume).toBeGreaterThan(0);
		expect(row.atrPct).toBeGreaterThan(0);
	});

	it("knows which exchange is open", () => {
		const s = fx.desk.sessions();
		expect(s.find((x) => x.exchange === "XETRA")?.state).toBe("open"); // 11:00 Berlin
		expect(s.find((x) => x.exchange === "NasdaqGS")?.state).toBe("pre");
	});

	it("analyses 1-minute candles", async () => {
		const a = await fx.desk.analysis("sap.de");
		expect(a.candles).toBeGreaterThan(21);
		expect(a.ema9).not.toBeNull();
		expect(a.vwap).not.toBeNull();
		expect(a.rsi14).toBeGreaterThanOrEqual(0);
	});

	it("reports today's trades per account", () => {
		const d = fx.desk.cockpit().days.find((x) => x.accountId === "agent-atlas")!.stats;
		expect(d).toMatchObject({ closed: 2, wins: 1, losses: 1 });
		expect(d.realizedCents).toBe(2000 - 200 - 600 - 200); // +20 € − 2 € Gebühren, −6 € − 2 € Gebühren
	});

	it("reminds once 15 minutes before the close about positions opened today", async () => {
		const r = await propose();
		await fx.desk.approve(r.proposal!.id, {});
		clock = new Date(2026, 9, 15, 17, 20).getTime();
		await fx.desk.tick();
		await fx.desk.tick();
		const close = fx.desk.events(50).filter((e) => e.kind === "close");
		expect(close).toHaveLength(1);
		expect(close[0].text).toContain("SAP.DE");
	});
});

describe("chat", () => {
	it("lets agents talk to each other and to you, with mentions of known names only", async () => {
		const r = await cli("/api/chat", { author: "nova", text: "@Atlas @Maurice @Mallory Gap bei SAP.DE?", ref: "sap.de" });
		const m = ((await r.json()) as { message: { author: string; to: string[]; ref: string; role: string } }).message;
		expect(m).toMatchObject({ author: "Nova", role: "agent", ref: "SAP.DE" });
		expect(m.to.sort()).toEqual(["Atlas", "Maurice"]);
	});

	it("refuses unknown authors and empty text", async () => {
		expect((await cli("/api/chat", { author: "Mallory", text: "hi" })).status).toBe(403);
		expect((await cli("/api/chat", { author: "Atlas", text: "  " })).status).toBe(400);
	});

	it("writes from the browser always as you", async () => {
		const r = await web("/api/chat", "POST", { author: "Atlas", text: "ich bin's" });
		expect(((await r.json()) as { message: { author: string } }).message.author).toBe("Maurice");
	});

	it("tells the agent in the chat what happened to its proposal", async () => {
		const r = await propose();
		fx.desk.reject(r.proposal!.id, "zu früh");
		const last = fx.desk.chat().at(-1)!;
		expect(last).toMatchObject({ author: "Desk", role: "desk", to: ["Atlas"], ref: `#${r.proposal!.id}` });
		expect(last.text).toContain("zu früh");
	});

	it("a chat message never approves anything", async () => {
		const r = await propose();
		await web("/api/chat", "POST", { text: `@Atlas freigegeben #${r.proposal!.id}` });
		expect(fx.desk.proposal(r.proposal!.id).status).toBe("pending");
	});
});
