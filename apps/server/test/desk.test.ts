import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanConfig } from "../src/config.ts";
import { makeFixture, type Fixture } from "../src/fixture.ts";
import { deskHttp } from "./owner.ts";

let fx: Fixture;
let clock: number;
let http: ReturnType<typeof deskHttp>;

beforeEach(async () => {
	clock = new Date(2026, 9, 15, 11, 0).getTime();
	fx = await makeFixture({ now: () => clock });
	http = deskHttp(fx);
	await http.login();
});
afterEach(() => fx.cleanup());

const web = (p: string, method: string, body: unknown = {}) => http.web(p, method, body);
const cli = (p: string, body: unknown, method = "POST") => http.cli(p, body, method);
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
		const r = await http.request("/api/journal", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "author=Atlas&text=hi" });
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
		const r = await http.request("/..%2f..%2fpackage.json");
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

	it("since + limit returns the next messages in order, without since the newest (Q1 B21)", async () => {
		const before = fx.desk.chat().at(-1)!.id;
		for (let i = 1; i <= 5; i++) await cli("/api/chat", { author: "Nova", text: `msg ${i}` });
		const page = (await (await http.get(`/api/chat?since=${before}&limit=2`)).json()) as { text: string }[];
		expect(page.map((m) => m.text)).toEqual(["msg 1", "msg 2"]);
		const newest = (await (await http.get("/api/chat?limit=2")).json()) as { text: string }[];
		expect(newest.map((m) => m.text)).toEqual(["msg 4", "msg 5"]);
	});

	it("a chat message never approves anything", async () => {
		const r = await propose();
		await web("/api/chat", "POST", { text: `@Atlas freigegeben #${r.proposal!.id}` });
		expect(fx.desk.proposal(r.proposal!.id).status).toBe("pending");
	});
});

describe("broker (IBKR, fake gateway)", () => {
	const proposeIb = (over: Record<string, unknown> = {}) =>
		fx.desk.submit({ author: "Atlas", accountId: "ibkr", symbol: "SAP.DE", side: "buy", qty: 3, stopLoss: 195, confidence: 0.7, thesis: "IBKR-Test", ...over }, "cli");

	it("sends an approved proposal to the broker with a unique client order id, then books the fill", async () => {
		const r = await proposeIb();
		const p = await fx.desk.approve(r.proposal!.id, {});
		expect(p).toMatchObject({ status: "placed", brokerOrderId: expect.any(String) });
		expect(fx.broker.placed.at(-1)).toMatchObject({ side: "buy", qty: 3, type: "market", cOID: `desk-${fx.desk.installId}-${r.proposal!.id}` });
		expect(fx.desk.installId).toMatch(/^[0-9a-f]{8}$/);
		await fx.desk.tick();
		expect(fx.desk.proposal(r.proposal!.id)).toMatchObject({ status: "filled", fillPrice: 201.25 });
		const t = fx.desk.detail("ibkr").trades.find((x) => x.proposalId === r.proposal!.id)!;
		expect(t).toMatchObject({ qty: 3, price: 201.25, feeCents: 125, source: "proposal" });
		await fx.desk.tick(); // zweiter Abruf bucht nichts doppelt
		expect(fx.desk.detail("ibkr").trades.filter((x) => x.proposalId === r.proposal!.id)).toHaveLength(1);
	});

	it("shows the broker's question and sends only after you confirm", async () => {
		fx.broker.replyAbove = 2;
		const r = await proposeIb();
		const p = await fx.desk.approve(r.proposal!.id, {});
		expect(p.status).toBe("confirm");
		expect(p.brokerMessage).toContain("Size Limit");
		expect([...fx.broker.book.values()].some((o) => o.t.cOID.endsWith(`-${r.proposal!.id}`))).toBe(false);
		expect((await cli(`/api/proposals/${r.proposal!.id}/confirm`, {})).status).toBe(403); // Agenten bestätigen nie
		expect((await fx.desk.confirmBroker(r.proposal!.id)).status).toBe("placed");
	});

	it("refuses real money while liveTrading is off", async () => {
		const live = fx.cfg.accounts.find((a) => a.id === "ibkr")!;
		live.live = true;
		const r = await proposeIb();
		const p = await fx.desk.approve(r.proposal!.id, {});
		expect(p.status).toBe("rejected");
		expect(p.reason).toContain("liveTrading");
		expect(fx.broker.placed).toHaveLength(0);
		fx.cfg.liveTrading = true;
		const r2 = await proposeIb();
		const mismatch = await fx.desk.approve(r2.proposal!.id, {});
		expect(mismatch.reason).toContain("Papierkonto angemeldet"); // echtes Depot, aber Papier-Sitzung im Gateway
		fx.broker.paper = false;
		const r3 = await proposeIb();
		expect((await fx.desk.approve(r3.proposal!.id, {})).status).toBe("placed");
	});

	it("rejects with the reason when you are not logged in at the gateway", async () => {
		fx.broker.authenticated = false;
		const r = await proposeIb();
		const p = await fx.desk.approve(r.proposal!.id, {});
		expect(p).toMatchObject({ status: "rejected" });
		expect(p.reason).toContain("nicht angemeldet");
	});

	it("cancels a working limit order at the broker and marks it when the broker confirms", async () => {
		const r = await proposeIb({ orderType: "limit", limitPrice: 199 });
		const p = await fx.desk.approve(r.proposal!.id, {});
		expect(p.status).toBe("placed");
		const after = await fx.desk.cancel(r.proposal!.id);
		expect(after.status).toBe("cancelled");
	});

	it("kill switch blocks broker orders too", async () => {
		const r = await proposeIb();
		fx.desk.setKill(true);
		const p = await fx.desk.approve(r.proposal!.id, {});
		expect(p.status).toBe("rejected");
		expect(fx.broker.placed).toHaveLength(0);
	});

	it("does not trade crypto through IBKR", async () => {
		await fx.desk.addWatch("BTC-EUR", "Maurice");
		const r = await proposeIb({ symbol: "BTC-EUR", qty: 0.01, stopLoss: 60000 });
		const p = await fx.desk.approve(r.proposal!.id, {});
		expect(p.reason).toContain("Krypto");
	});

	it("reconciles positions and cash you hold at the broker into the book", async () => {
		fx.broker.extraPositions.push({ conid: 4242, ticker: "SAP", description: "SAP SE IBIS", qty: 7, avgCost: 180, currency: "EUR" });
		fx.cfg.brokers.ibkr = { adapter: "ibkr", account: "DU0000001", gateway: "https://localhost:5000", conids: { "SAP.DE": 4242 } };
		const before = await fx.desk.reconcile("ibkr");
		expect(before.rows.find((x) => x.conid === 4242)).toMatchObject({ symbol: "SAP.DE", brokerQty: 7, deskQty: 0 });
		expect(before.brokerCashCents).toBe(2_500_000);
		const after = await fx.desk.applyReconcile("ibkr");
		expect(after.rows.find((x) => x.conid === 4242)).toMatchObject({ brokerQty: 7, deskQty: 7 });
		expect(after.deskCashCents).toBe(2_500_000);
	});

	it("only talks to gateways on localhost", async () => {
		const { localJson } = await import("../src/http.ts");
		await expect(localJson("GET", "https://example.com:5000/v1/api/tickle")).rejects.toThrow("nur lokale");
		const c = cleanConfig({ accounts: [{ id: "ib", kind: "broker", ibAccount: "U123456", gateway: "https://evil.example:5000" }, { id: "ib2", kind: "broker", ibAccount: "U123456" }] }, { home: "", dbFile: "", webDist: "", dev: false }, {});
		expect(c.accounts.map((a) => [a.id, a.live])).toEqual([["ib2", true]]);
		expect(c.liveTrading).toBe(false);
	});
});

describe("broker: interrupted send", () => {
	it("finds an order that reached the broker by its client id and never sends twice", async () => {
		const r = await fx.desk.submit({ author: "Atlas", accountId: "ibkr", symbol: "SAP.DE", side: "buy", qty: 2, stopLoss: 195, confidence: 0.7, thesis: "x" }, "cli");
		const id = r.proposal!.id;
		// Absturz simulieren: reserviert, beim Broker angekommen, Antwort verloren
		fx.db.run("UPDATE proposal SET status = 'sending', decided_at = ?, approved_qty = 2 WHERE id = ?", clock, id);
		await fx.broker.place({ conid: 1, side: "buy", qty: 2, type: "limit", limit: 190, cOID: `desk-${id}` });
		clock += 2 * 60_000;
		await fx.desk.pollBroker("ibkr");
		expect(fx.desk.proposal(id)).toMatchObject({ status: "placed", brokerOrderId: expect.any(String) });
		expect(fx.broker.placed).toHaveLength(1);
	});

	it("gives up after 5 minutes without the order and tells you to check, without resending", async () => {
		const r = await fx.desk.submit({ author: "Atlas", accountId: "ibkr", symbol: "SAP.DE", side: "buy", qty: 2, stopLoss: 195, confidence: 0.7, thesis: "x" }, "cli");
		const id = r.proposal!.id;
		fx.db.run("UPDATE proposal SET status = 'sending', decided_at = ?, approved_qty = 2 WHERE id = ?", clock, id);
		clock += 6 * 60_000;
		await fx.desk.pollBroker("ibkr");
		expect(fx.desk.proposal(id).status).toBe("rejected");
		expect(fx.desk.proposal(id).reason).toContain("nicht erneut");
		expect(fx.broker.placed).toHaveLength(0);
	});
});
