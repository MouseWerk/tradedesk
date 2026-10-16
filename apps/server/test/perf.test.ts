// Takt und Abfragen mit viel Verlauf (Q1 B14, B31) und Stop-Hinweise nur für die Position, die der Vorschlag eröffnet
// hat (B27). Budgets: siehe budget.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orderValueCents } from "@desk/shared";
import { makeFixture, type Fixture } from "../src/fixture.ts";
import { best, slowdown, withinBudget } from "./budget.ts";

let fx: Fixture;
let clock: number;

beforeEach(async () => {
	clock = new Date(2026, 9, 15, 11, 0).getTime();
	fx = await makeFixture({ now: () => clock });
});
afterEach(() => fx.cleanup());

/** 50 Tage × 3 Agenten-artig: 1 500 ausgeführte Käufe mit Stop und Ziel (längst verkauft), dazu weitere Trades – 4 000 Trades. */
function history(trades = 4_000, proposals = 1_500) {
	const day = 86_400_000;
	const symbols = ["SAP.DE", "ALV.DE", "EUNL.DE"];
	fx.db.tx(() => {
		let n = 0;
		for (let i = 0; i < proposals; i++) {
			const symbol = symbols[i % symbols.length];
			const t = clock - 60 * day + i * 60_000;
			const { lastId } = fx.db.run(
				`INSERT INTO proposal (account_id, author, symbol, side, qty, order_type, stop_loss, take_profit, confidence, thesis, status, quote_price, created_at, decided_at, decided_by, approved_qty, expires_at, fill_price)
				 VALUES ('agent-atlas','Atlas',?, 'buy', 1, 'market', 1, 100000, 0.7, 'x', 'filled', 100, ?, ?, 'Maurice', 1, ?, 100)`,
				symbol, t, t, t + day,
			);
			const ins = (side: string, time: number, pid: number | null) =>
				fx.db.run("INSERT INTO trade (account_id, symbol, side, qty, price, currency, fx, value_cents, fee_cents, time, source, proposal_id, note) VALUES ('agent-atlas',?,?,1,100,'EUR',1,?,0,?,'proposal',?,'')", symbol, side, orderValueCents(1, 100, 1), time, pid);
			ins("buy", t, lastId);
			ins("sell", t + 30_000, null);
			n += 2;
		}
		for (; n < trades; n += 2) {
			const t = clock - 59 * day + n * 1_000;
			fx.db.run("INSERT INTO trade (account_id, symbol, side, qty, price, currency, fx, value_cents, fee_cents, time, source, note) VALUES ('agent-atlas','EUNL.DE','buy',1,100,'EUR',1,10000,0,?,'proposal','')", t);
			fx.db.run("INSERT INTO trade (account_id, symbol, side, qty, price, currency, fx, value_cents, fee_cents, time, source, note) VALUES ('agent-atlas','EUNL.DE','sell',1,100,'EUR',1,10000,0,?,'proposal','')", t + 500);
		}
	});
}

describe("budget with 4 000 trades and 1 500 filled stop proposals (B14, B31)", () => {
	it("tick stays under 300 ms, reads stay fast", async () => {
		history();
		const before = await slowdown();
		const first = await best(1, () => fx.desk.tick()); // schließt einmalig die längst verkauften Vorschläge, nicht wiederholbar
		const tick = await best(5, () => fx.desk.tick());
		const cockpit = await best(5, () => fx.desk.cockpit());
		const overview = await best(5, () => fx.desk.overview());
		const detail = await best(5, () => fx.desk.detail("agent-atlas"));
		const agents = await best(5, () => fx.desk.agentsData());
		const proposals = await best(5, () => fx.desk.proposals());
		const factor = Math.max(before, await slowdown());
		expect(withinBudget("4 000 Trades", factor, { "first tick": [first, 1_000], tick: [tick, 300], cockpit: [cockpit, 150], overview: [overview, 100], detail: [detail, 150], agents: [agents, 150], proposals: [proposals, 150] })).toEqual([]);
	});

	it("a proposal whose position was sold no longer takes part in the stop check", async () => {
		history(20, 10);
		await fx.desk.tick();
		const open = fx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM proposal WHERE account_id = 'agent-atlas' AND status = 'filled' AND closed_at IS NULL AND stop_loss = 1")!.n;
		expect(open).toBe(0);
	});
});

describe("stop reminders belong to the position the proposal opened (B27)", () => {
	it("buy, sell all, buy again by hand: the old stop does not fire, the position shows no stop", async () => {
		const nova = fx.desk.proposals({ status: "pending" }).find((p) => p.accountId === "tr" && p.symbol === "EUNL.DE")!;
		await fx.desk.approve(nova.id, {});
		fx.desk.fill(nova.id, { price: 104.5 });
		expect(fx.desk.detail("tr").positions.find((p) => p.symbol === "EUNL.DE")!.stopLoss).toBe(101);
		const held = fx.desk.detail("tr").positions.find((p) => p.symbol === "EUNL.DE")!.qty;
		await fx.desk.recordTrade("tr", { symbol: "EUNL.DE", side: "sell", qty: held, price: 104 });
		clock += 60_000;
		await fx.desk.recordTrade("tr", { symbol: "EUNL.DE", side: "buy", qty: 5, price: 100 });
		fx.market.set("EUNL.DE", 100.5);
		await fx.desk.tick();
		expect(fx.desk.events(50).filter((e) => e.kind === "stop")).toHaveLength(0);
		expect(fx.desk.detail("tr").positions.find((p) => p.symbol === "EUNL.DE")!.stopLoss).toBeNull();
	});

	it("still fires for the position the proposal opened", async () => {
		const r = await fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "ALV.DE", side: "buy", qty: 1, stopLoss: 345, confidence: 0.7, thesis: "x" }, "cli");
		await fx.desk.approve(r.proposal!.id, {});
		fx.market.set("ALV.DE", 344);
		await fx.desk.tick();
		expect(fx.desk.events(50).filter((e) => e.kind === "stop")).toHaveLength(1);
	});
});
