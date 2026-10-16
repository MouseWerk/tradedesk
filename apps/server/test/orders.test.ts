// Freigaben und Ausführung (Q1 B4, B6, B13, B26, B28): offene Orders binden Cash und Bestand, alte Kurse entscheiden
// nichts, die Prüfung bei der Limit-Ausführung ist vollständig, Papier füllt nur zur Handelszeit.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFixture, type Fixture } from "../src/fixture.ts";

let fx: Fixture;
let clock: number;

beforeEach(async () => {
	clock = new Date(2026, 9, 15, 11, 0).getTime(); // Donnerstag, XETRA offen, Nasdaq vorbörslich
	fx = await makeFixture({ now: () => clock });
});
afterEach(() => fx.cleanup());

const propose = async (over: Record<string, unknown>) => {
	const r = await fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 2, stopLoss: 195, confidence: 0.7, thesis: "x", ...over }, "cli");
	if (!r.ok) throw new Error(r.check.violations.join(" "));
	return r.proposal!.id;
};

describe("approved but unfilled orders reserve cash and position (B4)", () => {
	it("two approvals for a manual account that fit alone but not together: the second is refused", async () => {
		fx.desk.setLimits("tr", { maxRiskPct: 0, maxOrderCents: 0, maxPositionPct: 0 });
		const cash = fx.desk.summary(fx.desk.account("tr")).cashCents; // ca. 9.600 €
		const qty = Math.floor((cash * 0.6) / 100 / 201.25);
		const a = await propose({ accountId: "tr", qty, stopLoss: 190 });
		const b = await propose({ accountId: "tr", qty, stopLoss: 190 });
		expect((await fx.desk.approve(a, {})).status).toBe("placed");
		const second = await fx.desk.approve(b, {});
		expect(second.status).toBe("rejected");
		expect(second.reason).toContain("Cash");
	});

	it("the position cap counts approved orders of the same symbol", async () => {
		fx.desk.setLimits("tr", { maxRiskPct: 0, maxOrderCents: 0, maxPositionPct: 25 });
		const eq = fx.desk.summary(fx.desk.account("tr")).equityCents;
		const held = fx.desk.detail("tr").positions.find((p) => p.symbol === "SAP.DE")!.valueCents;
		const qty = Math.floor(((eq * 0.24 - held) / 2 / 100 / 201.25) * 1.5);
		const a = await propose({ accountId: "tr", qty, stopLoss: 190 });
		const b = await propose({ accountId: "tr", qty, stopLoss: 190 });
		expect((await fx.desk.approve(a, {})).status).toBe("placed");
		const second = await fx.desk.approve(b, {});
		expect(second.status).toBe("rejected");
		expect(second.reason).toContain("% des Depots");
	});

	it("two sells of the whole holding: the second is refused", async () => {
		const a = await propose({ accountId: "tr", side: "sell", qty: 8, stopLoss: undefined });
		const b = await propose({ accountId: "tr", side: "sell", qty: 8, stopLoss: undefined });
		expect((await fx.desk.approve(a, {})).status).toBe("placed");
		const second = await fx.desk.approve(b, {});
		expect(second.status).toBe("rejected");
		expect(second.reason).toContain("Leerverkäufe");
	});

	it("open IBKR orders reserve too", async () => {
		clock = new Date(2026, 9, 15, 16, 0).getTime();
		fx.desk.setLimits("ibkr", { maxRiskPct: 0, maxOrderCents: 0, maxPositionPct: 0 });
		const qty = Math.floor(25_000 * 0.6 / 201.25);
		const a = await propose({ accountId: "ibkr", qty, stopLoss: 190, orderType: "limit", limitPrice: 199 });
		const b = await propose({ accountId: "ibkr", qty, stopLoss: 190, orderType: "limit", limitPrice: 199 });
		expect((await fx.desk.approve(a, {})).status).toBe("placed");
		expect((await fx.desk.approve(b, {})).status).toBe("rejected");
		expect(fx.broker.placed).toHaveLength(1);
	});
});

describe("quote age (B6)", () => {
	it("approval during the session refuses a quote older than maxQuoteAgeSec and fills nothing", async () => {
		const id = await propose({});
		fx.market.failing = true;
		const trades = fx.desk.detail("agent-atlas").trades.length;
		clock += 10 * 60_000;
		await expect(fx.desk.approve(id, {})).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Kein aktueller Kurs") });
		expect(fx.desk.proposal(id).status).toBe("pending");
		expect(fx.desk.detail("agent-atlas").trades.length).toBe(trades);
	});

	it("a proposal on a stale quote is not created", async () => {
		fx.market.failing = true;
		clock += 10 * 60_000;
		const r = await fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 2, stopLoss: 195, confidence: 0.7, thesis: "x" }, "cli");
		expect(r.ok).toBe(false);
		expect(r.check.violations.join()).toContain("Kein aktueller Kurs");
	});

	it("an open limit does not fill on an old quote", async () => {
		const id = await propose({ orderType: "limit", limitPrice: 195, stopLoss: 190 });
		await fx.desk.approve(id, {});
		fx.db.run("UPDATE quote SET price = 190, fetched_at = ? WHERE symbol = 'SAP.DE'", clock - 10 * 60_000);
		fx.market.failing = true;
		clock += 60_000;
		await fx.desk.tick();
		expect(fx.desk.proposal(id).status).toBe("open");
	});

	it("names the symbols whose quote failed while others arrived", async () => {
		fx.market.failSymbols.add("ALV.DE");
		await fx.desk.tick();
		const o = fx.desk.overview();
		expect(o.market).toBe("live");
		expect(o.failedQuotes).toEqual(["ALV.DE"]);
		expect(o.marketError).toContain("ALV.DE");
		expect(fx.desk.cockpit().failedQuotes).toEqual(["ALV.DE"]);
		clock += 10 * 60_000;
		await fx.desk.tick();
		expect(fx.desk.scan().find((r) => r.symbol === "ALV.DE")!.quoteStale).toBe(true);
		expect(fx.desk.scan().find((r) => r.symbol === "SAP.DE")!.quoteStale).toBe(false);
	});
});

describe("limit fill re-checks the stop and risk (B13)", () => {
	it("cancels when the risk per trade exceeds a tightened limit", async () => {
		const id = await propose({ symbol: "ALV.DE", qty: 2, orderType: "limit", limitPrice: 340, stopLoss: 300 });
		expect((await fx.desk.approve(id, {})).status).toBe("open");
		fx.desk.setLimits("agent-atlas", { maxRiskPct: 0.1 });
		fx.market.set("ALV.DE", 339);
		await fx.desk.tick();
		const p = fx.desk.proposal(id);
		expect(p.status).toBe("cancelled");
		expect(p.reason).toContain("je Trade");
	});

	it("does not count the order itself as a reservation", async () => {
		const id = await propose({ orderType: "limit", limitPrice: 195, stopLoss: 190 });
		await fx.desk.approve(id, {});
		fx.market.set("SAP.DE", 194.5);
		await fx.desk.tick();
		expect(fx.desk.proposal(id).status).toBe("filled");
	});
});

describe("maxOpenProposals per author (B26)", () => {
	it("counts an agent's pending proposals over all accounts", async () => {
		for (const a of ["agent-atlas", "papier", "tr", "ibkr"]) fx.desk.setLimits(a, { maxOpenProposals: 2 });
		// aus der Fixture wartet schon je einer von Atlas in agent-atlas (MSFT) und papier (ALV.DE)
		const r = await fx.desk.submit({ author: "Atlas", accountId: "tr", symbol: "SAP.DE", side: "buy", qty: 1, stopLoss: 190, confidence: 0.7, thesis: "x" }, "cli");
		expect(r.ok).toBe(false);
		expect(r.check.violations.join()).toContain("offene Vorschläge");
	});
});

describe("paper fills only while the exchange is open (B28)", () => {
	it("an approved market order waits after the close and fills at the next open", async () => {
		clock = new Date(2026, 9, 15, 20, 0).getTime(); // XETRA nachbörslich
		await fx.desk.refresh(["SAP.DE"]);
		const id = await propose({});
		const p = await fx.desk.approve(id, {});
		expect(p.status).toBe("open");
		expect(p.reason).toContain("Handelsbeginn");
		await fx.desk.tick();
		expect(fx.desk.proposal(id).status).toBe("open");
		clock = new Date(2026, 9, 16, 9, 5).getTime();
		await fx.desk.tick();
		expect(fx.desk.proposal(id)).toMatchObject({ status: "filled", fillPrice: 201.25 });
	});

	it("on a Saturday nothing fills, a limit neither", async () => {
		clock = new Date(2026, 9, 17, 12, 0).getTime(); // Samstag
		await fx.desk.refresh(["SAP.DE"]);
		const id = await propose({});
		expect((await fx.desk.approve(id, {})).status).toBe("open");
		const lim = await propose({ symbol: "ALV.DE", orderType: "limit", limitPrice: 353, qty: 1, stopLoss: 345 });
		expect((await fx.desk.approve(lim, {})).status).toBe("open");
		await fx.desk.tick();
		expect(fx.desk.proposal(lim).status).toBe("open");
		expect(fx.desk.sessions().find((s) => s.exchange === "XETRA")!.state).toBe("closed");
	});

	it("a queued agent order goes stale if the open is far from the proposal price", async () => {
		clock = new Date(2026, 9, 15, 20, 0).getTime();
		await fx.desk.refresh(["SAP.DE"]);
		const id = await propose({});
		await fx.desk.approve(id, {});
		fx.market.set("SAP.DE", 201.25 * 0.95);
		clock = new Date(2026, 9, 16, 9, 5).getTime();
		await fx.desk.tick();
		expect(fx.desk.proposal(id).status).toBe("stale");
	});
});
