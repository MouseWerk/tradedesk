// IBKR über den Fake-Broker (Q1 B3, B5, B7, B8, B10, B11, B12, B20, B22, B23, B29): unbekannte Ergebnisse werden
// wiedergefunden statt abgelehnt, Bestätigen prüft neu, Ausführungen werden genau einmal und richtig gebucht.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBroker } from "../src/broker.ts";
import { makeFixture, type Fixture } from "../src/fixture.ts";

let fx: Fixture;
let clock: number;

beforeEach(async () => {
	clock = new Date(2026, 9, 15, 16, 0).getTime(); // XETRA und Nasdaq offen
	fx = await makeFixture({ now: () => clock });
});
afterEach(() => {
	vi.useRealTimers();
	fx.cleanup();
});

const proposeIb = async (over: Record<string, unknown> = {}) => {
	const r = await fx.desk.submit({ author: "Atlas", accountId: "ibkr", symbol: "SAP.DE", side: "buy", qty: 3, stopLoss: 195, confidence: 0.7, thesis: "IBKR-Test", ...over }, "cli");
	if (!r.ok) throw new Error(r.check.violations.join(" "));
	return r.proposal!.id;
};
const ibTrades = () => fx.desk.detail("ibkr").trades;
const orderOf = (id: number) => fx.desk.proposal(id).brokerOrderId!;

describe("unknown outcome on place (B3)", () => {
	it("a lost answer leaves the order 'sending', the poll finds it by its client id and nothing is sent twice", async () => {
		const id = await proposeIb();
		fx.broker.loseNextAnswer = true;
		const p = await fx.desk.approve(id, {});
		expect(p.status).toBe("sending");
		expect(p.reason).toContain("Ergebnis unbekannt");
		expect(fx.desk.events(20).some((e) => e.kind === "broker.unknown")).toBe(true);
		clock += 2 * 60_000;
		await fx.desk.tick();
		const after = fx.desk.proposal(id);
		expect(after.status).toBe("filled"); // gefunden, dann ausgeführt (Market-Order)
		expect(after.brokerOrderId).toMatch(/^\d+$/);
		expect(fx.broker.placed).toHaveLength(1);
		expect(ibTrades().filter((t) => t.proposalId === id)).toHaveLength(1);
	});

	it("an exception while placing is unknown too, not a 500 and not rejected", async () => {
		const id = await proposeIb();
		const place = fx.broker.place.bind(fx.broker);
		fx.broker.place = async (t) => {
			await place(t);
			throw new Error("socket hang up");
		};
		const p = await fx.desk.approve(id, {});
		expect(p.status).toBe("sending");
		clock += 2 * 60_000;
		await fx.desk.pollBroker("ibkr");
		expect(fx.desk.proposal(id).status).not.toBe("rejected");
		expect(fx.desk.proposal(id).brokerOrderId).not.toBeNull();
	});
});

describe("confirming IBKR's question (B5)", () => {
	const confirmable = async () => {
		fx.broker.replyAbove = 2;
		const id = await proposeIb();
		expect((await fx.desk.approve(id, {})).status).toBe("confirm");
		return id;
	};

	it("goes stale after a price move and sends nothing", async () => {
		const id = await confirmable();
		fx.market.set("SAP.DE", 201.25 * 1.05);
		const p = await fx.desk.confirmBroker(id);
		expect(p.status).toBe("stale");
		expect([...fx.broker.book.values()]).toHaveLength(0);
	});

	it("is refused after tighter limits", async () => {
		const id = await confirmable();
		fx.desk.setLimits("ibkr", { maxOrderCents: 10_000 });
		const p = await fx.desk.confirmBroker(id);
		expect(p.status).toBe("rejected");
		expect(p.reason).toContain("Grenze");
		expect([...fx.broker.book.values()]).toHaveLength(0);
	});

	it("expires after 15 minutes – at confirm and on a tick", async () => {
		const id = await confirmable();
		clock += 16 * 60_000;
		expect((await fx.desk.confirmBroker(id)).status).toBe("expired");
		const id2 = await confirmable();
		clock += 16 * 60_000;
		await fx.desk.tick();
		expect(fx.desk.proposal(id2).status).toBe("expired");
		expect([...fx.broker.book.values()]).toHaveLength(0);
	});

	it("refuses a real-money account whose gateway session is paper", async () => {
		fx.cfg.accounts.find((a) => a.id === "ibkr")!.live = true;
		fx.cfg.liveTrading = true;
		fx.broker.paper = false;
		const id = await confirmable();
		fx.broker.paper = true;
		expect((await fx.desk.confirmBroker(id)).status).toBe("rejected");
		expect([...fx.broker.book.values()]).toHaveLength(0);
	});

	it("still sends when nothing changed", async () => {
		const id = await confirmable();
		expect((await fx.desk.confirmBroker(id)).status).toBe("placed");
	});
});

describe("client order id and conid (B7)", () => {
	it("an execution with this proposal's id but another contract is not booked under its symbol", async () => {
		const id = await proposeIb({ orderType: "limit", limitPrice: 199 });
		await fx.desk.approve(id, {});
		const cOID = fx.broker.placed.at(-1)!.cOID;
		expect(cOID).toBe(`desk-${fx.desk.installId}-${id}`);
		fx.broker.execs.push({ id: "foreign-1", cOID, conid: FakeBroker.conid("AAPL"), side: "buy", qty: 50, price: 190, time: clock, commission: 1, commissionCurrency: null });
		await fx.desk.pollBroker("ibkr");
		expect(ibTrades().filter((t) => t.symbol === "SAP.DE")).toHaveLength(0);
		expect(fx.desk.proposal(id).status).toBe("placed");
		expect(fx.desk.events(20).some((e) => e.kind === "broker.mismatch")).toBe(true);
	});

	it("an old-style id from another database is not mapped to this database's proposal", async () => {
		const id = await proposeIb({ orderType: "limit", limitPrice: 199 });
		await fx.desk.approve(id, {});
		fx.broker.execs.push({ id: "old-db-1", cOID: `desk-${id}`, conid: FakeBroker.conid("AAPL"), side: "buy", qty: 50, price: 190, time: clock, commission: 1, commissionCurrency: null });
		await fx.desk.pollBroker("ibkr");
		expect(ibTrades().some((t) => t.symbol === "SAP.DE")).toBe(false);
	});

	it("two databases get different installation ids", async () => {
		const other = await makeFixture({ seed: false });
		try {
			expect(other.desk.installId).not.toBe(fx.desk.installId);
		} finally {
			other.cleanup();
		}
	});
});

describe("reconcile, then the execution import (B8)", () => {
	it("books an unmapped TWS fill once: desk = broker and no differences", async () => {
		const conid = 4242;
		fx.broker.execs.push({ id: "tws-1", cOID: null, conid, side: "buy", qty: 10, price: 230, time: clock - 60_000, commission: 1, commissionCurrency: null });
		await fx.desk.pollBroker("ibkr");
		expect(fx.desk.events(20).some((e) => e.kind === "broker.unknown")).toBe(true);
		fx.cfg.brokers.ibkr = { adapter: "ibkr", account: "DU0000001", gateway: "https://localhost:5000", conids: { AAPL: conid } };
		await fx.desk.applyReconcile("ibkr");
		await fx.desk.tick();
		await fx.desk.tick();
		const r = await fx.desk.reconcile("ibkr");
		expect(r.rows.find((x) => x.conid === conid)).toMatchObject({ symbol: "AAPL", brokerQty: 10, deskQty: 10 });
		expect(r.differences).toBe(0);
		expect(ibTrades().filter((t) => t.symbol === "AAPL")).toHaveLength(1);
	});

	it("a fill that the reconcile already took over is not booked again later", async () => {
		const conid = 4243;
		fx.cfg.brokers.ibkr = { adapter: "ibkr", account: "DU0000001", gateway: "https://localhost:5000", conids: { AAPL: conid } };
		fx.broker.extraPositions.push({ conid, ticker: "AAPL", description: "APPLE", qty: 5, avgCost: 200, currency: "USD" });
		await fx.desk.applyReconcile("ibkr");
		// die Ausführung taucht erst nach dem Abgleich in der Liste auf (Liste des Gateways hinkt hinterher)
		fx.broker.extraPositions.length = 0;
		fx.broker.execs.push({ id: "late-1", cOID: null, conid, side: "buy", qty: 5, price: 200, time: clock - 1_000, commission: 1, commissionCurrency: null });
		await fx.desk.tick();
		const aapl = fx.desk.detail("ibkr").positions.find((p) => p.symbol === "AAPL")!;
		expect(aapl.qty).toBe(5);
	});
});

describe("PendingCancel, Inactive and fills after a final state (B10)", () => {
	it("PendingCancel keeps the order working; a fill in that window ends 'filled'", async () => {
		fx.broker.pendingCancel = true;
		const id = await proposeIb({ orderType: "limit", limitPrice: 199 });
		await fx.desk.approve(id, {});
		await fx.desk.cancel(id);
		expect(fx.desk.proposal(id).status).toBe("placed");
		fx.broker.fill(orderOf(id), 199);
		await fx.desk.tick();
		expect(fx.desk.proposal(id)).toMatchObject({ status: "filled", filledQty: 3 });
	});

	it("an execution that arrives after 'cancelled' corrects the proposal and tells you", async () => {
		const id = await proposeIb({ orderType: "limit", limitPrice: 199 });
		await fx.desk.approve(id, {});
		await fx.desk.cancel(id);
		expect(fx.desk.proposal(id).status).toBe("cancelled");
		const o = fx.broker.book.get(orderOf(id))!;
		fx.broker.execs.push({ id: "late-fill", cOID: o.t.cOID, conid: o.t.conid, side: "buy", qty: 3, price: 199, time: clock, commission: 1.25, commissionCurrency: null });
		await fx.desk.tick();
		expect(fx.desk.proposal(id).status).toBe("filled");
		expect(fx.desk.events(30).some((e) => e.kind === "trade.fill" && e.text.includes("doch"))).toBe(true);
	});

	it("Inactive is not 'rejected': the order stays placed with a note", async () => {
		const id = await proposeIb({ orderType: "limit", limitPrice: 199 });
		await fx.desk.approve(id, {});
		fx.broker.setRaw(orderOf(id), "Inactive");
		await fx.desk.tick();
		const p = fx.desk.proposal(id);
		expect(p.status).toBe("placed");
		expect(p.brokerMessage).toContain("Inactive");
	});
});

describe("an order that drops off IBKR's list (B11)", () => {
	it("expires after a day without being listed, with an event", async () => {
		const id = await proposeIb({ orderType: "limit", limitPrice: 199 });
		await fx.desk.approve(id, {});
		fx.broker.drop(orderOf(id));
		await fx.desk.tick();
		expect(fx.desk.proposal(id).status).toBe("placed");
		clock += 2 * 86_400_000;
		await fx.desk.tick();
		const p = fx.desk.proposal(id);
		expect(p.status).toBe("expired");
		expect(p.reason).toContain("nicht mehr gelistet");
		expect(fx.desk.events(30).some((e) => e.kind === "proposal.expired" && e.text.includes(`#${id}`))).toBe(true);
	});
});

describe("execution without an exchange rate (B12)", () => {
	it("is not booked at fx = 1; it is booked once the rate is there, at that rate", async () => {
		const id = await proposeIb({ symbol: "MSFT", qty: 1, stopLoss: 400 });
		expect((await fx.desk.approve(id, {})).status).toBe("placed");
		fx.db.run("DELETE FROM quote WHERE symbol = 'USDEUR=X'");
		fx.market.failing = true;
		await fx.desk.tick();
		expect(ibTrades().filter((t) => t.symbol === "MSFT")).toHaveLength(0);
		expect(fx.desk.events(30).some((e) => e.kind === "broker.wait")).toBe(true);
		fx.market.failing = false;
		await fx.desk.tick();
		await fx.desk.tick();
		const t = ibTrades().filter((x) => x.symbol === "MSFT");
		expect(t).toHaveLength(1);
		expect(t[0]).toMatchObject({ fx: 0.92, valueCents: Math.round(418.9 * 0.92 * 100) });
	});
});

describe("commission currency (B23)", () => {
	it("an EUR commission on a USD trade is not converted with the USD rate", async () => {
		const id = await proposeIb({ symbol: "MSFT", qty: 1, stopLoss: 400 });
		await fx.desk.approve(id, {});
		const o = fx.broker.book.get(orderOf(id))!;
		o.fillAt = null; // nicht vom Fake füllen lassen, die Ausführung kommt hier
		fx.broker.execs.push({ id: "eur-fee", cOID: o.t.cOID, conid: o.t.conid, side: "buy", qty: 1, price: 418.9, time: clock, commission: 1.25, commissionCurrency: "EUR" });
		await fx.desk.pollBroker("ibkr");
		expect(ibTrades().find((t) => t.proposalId === id)!.feeCents).toBe(125);
	});
});

describe("cash at IBKR in another base currency (B22)", () => {
	it("is not compared or booked as EUR", async () => {
		fx.broker.baseCurrency = "USD";
		const r = await fx.desk.reconcile("ibkr");
		expect(r.brokerCashCents).toBeNull();
		expect(r.cashNote).toContain("USD");
		const moves = fx.desk.detail("ibkr").cashMoves.length;
		await fx.desk.applyReconcile("ibkr");
		expect(fx.desk.detail("ibkr").cashMoves.length).toBe(moves);
	});
});

describe("partial fill, then cancel (B29)", () => {
	it("keeps the filled part on the proposal", async () => {
		const id = await proposeIb({ orderType: "limit", limitPrice: 199, qty: 10, stopLoss: 197 });
		await fx.desk.approve(id, {});
		fx.broker.partial(orderOf(id), 3, 199);
		await fx.desk.tick();
		expect(fx.desk.proposal(id)).toMatchObject({ status: "placed", filledQty: 3 });
		await fx.desk.cancel(id);
		const p = fx.desk.proposal(id);
		expect(p).toMatchObject({ status: "cancelled", filledQty: 3, fillPrice: 199 });
		expect(p.reason).toContain("3 von 10");
		expect(ibTrades().filter((t) => t.proposalId === id).reduce((s, t) => s + t.qty, 0)).toBe(3);
	});
});

describe("keepAlive on its own timer (B20)", () => {
	it("tickles the gateway about once a minute even with a quote interval of an hour", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		fx.cfg.quoteIntervalSec = 3600;
		fx.desk.start();
		const before = fx.broker.keepAlives;
		for (let s = 0; s < 185; s++) {
			clock += 1000;
			await vi.advanceTimersByTimeAsync(1000);
		}
		fx.desk.stop();
		// ein Tick (mit Abruf) zu Beginn, danach nur der eigene Takt: 60, 120, 180 s
		expect(fx.broker.keepAlives - before).toBeGreaterThanOrEqual(4);
	});
});
