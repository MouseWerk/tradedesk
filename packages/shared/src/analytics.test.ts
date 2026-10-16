// Auswertung mit von Hand gerechneten Fällen: Teilverkäufe über zwei Lose, Gebühren, USD mit Wechselkurs, Lücken in
// den Tagesständen, ein Tag ohne Trades, die Woche der Zeitumstellung (TZ=Europe/Berlin aus vitest.config.ts).
import { describe, expect, it } from "vitest";
import { buildBook, cents, closedTrade, combineCurves, dayResults, drawdowns, groupStats, isoWeekday, rBuckets, tradeStats, type ClosedTrade, type LotContext, type TradeLike } from "./index.ts";

const t = (id: number, side: "buy" | "sell", qty: number, price: number, fee = 100, time = id, symbol = "SAP.DE", fx = 1): TradeLike => ({ id, symbol, side, qty, price, valueCents: cents(qty * price * fx), feeCents: fee, time });
const ctx = (over: Partial<LotContext> = {}): LotContext => ({ accountId: "a", name: "SAP SE", author: "Maurice", proposalId: null, stopLoss: null, buyPrice: 100, buyCurrency: "EUR", buyFx: 1, stopCurrency: "EUR", ...over });

describe("closed lots from buildBook", () => {
	it("splits a sell over two lots with fees, the parts add up to the realized result", () => {
		const b = buildBook([t(1, "buy", 10, 100), t(2, "buy", 10, 120), t(3, "sell", 15, 130), t(4, "sell", 5, 110)]);
		// Los 1 ganz: Einstand 1000 € + 1 € Gebühr; Los 2 zur Hälfte: 1201 € / 2 = 600,50 €, Gebühr 0,50 €.
		// Erlös 1950 − 1 = 1949 € nach Stück 10 : 5 geteilt: 1299,33 € und 649,67 €; Verkaufsgebühr 0,67 € und 0,33 €.
		expect(b.closed).toEqual([
			{ buyId: 1, sellId: 3, symbol: "SAP.DE", qty: 10, entryTime: 1, exitTime: 3, entryPrice: 100, exitPrice: 130, costCents: 100100, proceedsCents: 129933, buyFeeCents: 100, sellFeeCents: 67, pnlCents: 29833 },
			{ buyId: 2, sellId: 3, symbol: "SAP.DE", qty: 5, entryTime: 2, exitTime: 3, entryPrice: 120, exitPrice: 130, costCents: 60050, proceedsCents: 64967, buyFeeCents: 50, sellFeeCents: 33, pnlCents: 4917 },
			// Rest von Los 2: 600,50 € Einstand mit 0,50 € Gebühr; Erlös 550 − 1 = 549 €
			{ buyId: 2, sellId: 4, symbol: "SAP.DE", qty: 5, entryTime: 2, exitTime: 4, entryPrice: 120, exitPrice: 110, costCents: 60050, proceedsCents: 54900, buyFeeCents: 50, sellFeeCents: 100, pnlCents: -5150 },
		]);
		expect(b.closed[0].pnlCents + b.closed[1].pnlCents).toBe(b.realizedBySell.get(3));
		expect(b.closed[2].pnlCents).toBe(b.realizedBySell.get(4));
	});

	it("counts only the held part of an oversold sell", () => {
		const b = buildBook([t(1, "buy", 2, 10, 0), t(2, "sell", 5, 12, 100)]);
		// 2 von 5 Stück gedeckt: Erlös (60 − 1) × 2/5 = 23,60 €, Gebühranteil 0,40 €
		expect(b.closed).toEqual([{ buyId: 1, sellId: 2, symbol: "SAP.DE", qty: 2, entryTime: 1, exitTime: 2, entryPrice: 10, exitPrice: 12, costCents: 2000, proceedsCents: 2360, buyFeeCents: 0, sellFeeCents: 40, pnlCents: 360 }]);
	});
});

describe("R multiple", () => {
	const usd = buildBook([t(1, "buy", 10, 200, 100, 1, "AAPL", 0.9), t(2, "sell", 10, 210, 100, 2, "AAPL", 0.92)]).closed[0];

	it("USD trade: risk at the buy's rate plus both fees", () => {
		// Einstand 10 × 200 × 0,9 = 1800 € + 1 €; Erlös 10 × 210 × 0,92 = 1932 € − 1 €; Ergebnis 130 €
		// Risiko 10 × (200 − 190) × 0,9 = 90 € + 1 € + 1 € = 92 €
		const c = closedTrade(usd, ctx({ stopLoss: 190, buyPrice: 200, buyCurrency: "USD", buyFx: 0.9, stopCurrency: "USD" }));
		expect(c).toMatchObject({ pnlCents: 13000, riskCents: 9200, feesCents: 200, holdMs: 1 });
		expect(c.r).toBeCloseTo(13000 / 9200, 12);
	});

	it("is unknown without a stop, with the stop above the entry, or with the buy in another currency than the stop", () => {
		expect(closedTrade(usd, ctx({ buyPrice: 200, buyCurrency: "USD", stopCurrency: "USD" })).r).toBeNull();
		expect(closedTrade(usd, ctx({ stopLoss: 205, buyPrice: 200, buyCurrency: "USD", stopCurrency: "USD" })).r).toBeNull();
		expect(closedTrade(usd, ctx({ stopLoss: 190, buyPrice: 184, buyCurrency: "EUR", stopCurrency: "USD" })).riskCents).toBeNull();
	});

	it("a trade stopped out exactly at the stop is -1 R", () => {
		const [l] = buildBook([t(1, "buy", 10, 100, 100), t(2, "sell", 10, 95, 100)]).closed;
		expect(closedTrade(l, ctx({ stopLoss: 95 })).r).toBe(-1);
	});
});

const ct = (pnlCents: number, r: number | null, over: Partial<ClosedTrade> = {}): ClosedTrade => ({
	accountId: "a", symbol: "SAP.DE", name: "SAP SE", author: "Maurice", buyTradeId: 1, sellTradeId: 2, proposalId: null, qty: 1, entryTime: 0, exitTime: 3_600_000, entryPrice: 1, exitPrice: 1,
	costCents: 0, proceedsCents: 0, feesCents: 200, pnlCents, holdMs: 3_600_000, stopLoss: null, riskCents: null, r, ...over,
});

describe("trade stats", () => {
	it("win rate, profit factor, expectancy in EUR and R, hold time", () => {
		const s = tradeStats([ct(3000, 1.5), ct(-1000, -0.5), ct(0, null), ct(1000, null, { holdMs: 7_200_000 })]);
		expect(s).toEqual({
			trades: 4, wins: 2, losses: 1, winRate: 50, pnlCents: 3000, grossProfitCents: 4000, grossLossCents: -1000, profitFactor: 4,
			expectancyCents: 750, expectancyR: 0.5, rTrades: 2, avgWinCents: 2000, avgLossCents: -1000, largestWinCents: 3000, largestLossCents: -1000,
			avgHoldMs: 4_500_000, feesCents: 800,
		});
	});

	it("empty", () => {
		expect(tradeStats([])).toMatchObject({ trades: 0, winRate: null, profitFactor: null, expectancyCents: null, expectancyR: null, avgHoldMs: null });
	});

	it("R buckets: from < r <= to, trades without R are left out", () => {
		const b = rBuckets([ct(-100, -3), ct(-100, -1), ct(50, 0.5), ct(300, 3), ct(400, 3.01), ct(0, null)]);
		expect(b.map((x) => [x.from, x.to, x.trades, x.pnlCents])).toEqual([
			[null, -2, 1, -100], [-2, -1, 1, -100], [-1, 0, 0, 0], [0, 1, 1, 50], [1, 2, 0, 0], [2, 3, 1, 300], [3, null, 1, 400],
		]);
	});

	it("groups keep the given keys even without trades", () => {
		const g = groupStats([ct(100, null, { author: "Atlas" })], (x) => x.author, ["Maurice", "Atlas", "Nova"]);
		expect([...g.keys()]).toEqual(["Maurice", "Atlas", "Nova"]);
		expect(g.get("Atlas")!.pnlCents).toBe(100);
		expect(g.get("Nova")!.trades).toBe(0);
	});
});

describe("curve and drawdown", () => {
	const p = (day: string, equityCents: number, depositsCents: number) => ({ day, equityCents, depositsCents });

	it("drawdown on the result (equity minus deposits), in % of deposits plus peak", () => {
		const { points, max } = drawdowns([
			p("2026-10-01", 100_000, 100_000), // Ergebnis 0
			p("2026-10-02", 110_000, 100_000), // 100 € Spitze
			p("2026-10-03", 105_000, 100_000), // −50 € = −50 / 1100
			p("2026-10-04", 152_000, 150_000), // Einzahlung 500 €: Ergebnis 20 €, −80 € = −80 / 1600
			p("2026-10-05", 160_000, 150_000), // erholt
			p("2026-10-06", 155_000, 150_000), // −50 € = −50 / 1600
		]);
		expect(points.map((x) => [x.resultCents, x.peakCents, x.drawdownCents])).toEqual([[0, 0, 0], [10_000, 10_000, 0], [5_000, 10_000, -5_000], [2_000, 10_000, -8_000], [10_000, 10_000, 0], [5_000, 10_000, -5_000]]);
		expect(points[2].drawdownPct).toBeCloseTo((-5_000 / 110_000) * 100, 10);
		expect(points[3].drawdownPct).toBeCloseTo(-5, 10);
		expect(max).toEqual({ cents: -8_000, pct: -5, peakDay: "2026-10-02", troughDay: "2026-10-04", recoveryDay: "2026-10-05" });
	});

	it("no drawdown on a rising curve, not recovered while below the peak", () => {
		expect(drawdowns([p("2026-10-01", 1, 0), p("2026-10-02", 2, 0)]).max).toBeNull();
		expect(drawdowns([p("2026-10-01", 2, 0), p("2026-10-02", 1, 0)]).max).toMatchObject({ cents: -1, recoveryDay: null });
	});

	it("combines accounts with the last known value of each", () => {
		const c = combineCurves([[p("2026-10-01", 100, 100), p("2026-10-03", 130, 100)], [p("2026-10-02", 50, 40)]]);
		expect(c).toEqual([p("2026-10-01", 100, 100), p("2026-10-02", 150, 140), p("2026-10-03", 180, 140)]);
	});
});

describe("daily results", () => {
	const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
	const p = (day: string, equityCents: number, depositsCents = 100_000) => ({ day, equityCents, depositsCents });

	it("realized per day, result since the previous snapshot, a day without trades and a gap", () => {
		const curve = [p("2026-10-05", 100_000), p("2026-10-06", 101_000), p("2026-10-07", 100_500), p("2026-10-09", 103_000), p("2026-10-10", 103_000)];
		// Verkäufe am 07. (+300 €) und am 08. (+200 €, Tag ohne Stand – gehört ins Fenster bis zum 09.)
		const trades = [ct(30_000, null, { exitTime: at(2026, 10, 7) }), ct(20_000, null, { exitTime: at(2026, 10, 8) })];
		expect(dayResults(curve, trades, "2026-10-06", "2026-10-10")).toEqual([
			{ day: "2026-10-06", realizedCents: 0, trades: 0, resultCents: 1_000, unrealizedChangeCents: 1_000, sinceDay: "2026-10-05" },
			{ day: "2026-10-07", realizedCents: 30_000, trades: 1, resultCents: -500, unrealizedChangeCents: -30_500, sinceDay: "2026-10-06" },
			{ day: "2026-10-08", realizedCents: 20_000, trades: 1, resultCents: null, unrealizedChangeCents: null, sinceDay: null },
			{ day: "2026-10-09", realizedCents: 0, trades: 0, resultCents: 2_500, unrealizedChangeCents: -17_500, sinceDay: "2026-10-07" },
			{ day: "2026-10-10", realizedCents: 0, trades: 0, resultCents: 0, unrealizedChangeCents: 0, sinceDay: "2026-10-09" },
		]);
	});

	it("a deposit is no result", () => {
		expect(dayResults([p("2026-10-05", 100_000), p("2026-10-06", 150_000, 150_000)], [], null, "2026-10-06")[1]).toMatchObject({ resultCents: 0, unrealizedChangeCents: 0 });
	});

	it("DST change week: days and hours in local time, Sunday 25 October 2026 has 25 hours", () => {
		const late = Date.UTC(2026, 9, 25, 22, 30); // 23:30 MEZ am 25., in Sommerzeit wäre es schon der 26.
		expect(dayResults([], [ct(100, null, { exitTime: late })], null, "2026-10-31").map((d) => d.day)).toEqual(["2026-10-25"]);
		expect(isoWeekday(late)).toBe(7);
		const beforeSwitch = Date.UTC(2026, 9, 24, 22, 30); // 00:30 MESZ am 25.
		const afterSwitch = Date.UTC(2026, 9, 26, 23, 30); // 00:30 MEZ am 27.
		expect([new Date(beforeSwitch).getHours(), new Date(afterSwitch).getHours()]).toEqual([0, 0]);
		const g = groupStats([ct(1, null, { entryTime: beforeSwitch }), ct(2, null, { entryTime: afterSwitch })], (x) => new Date(x.entryTime).getHours());
		expect(g.get(0)!.trades).toBe(2);
		expect([isoWeekday(beforeSwitch), isoWeekday(afterSwitch)]).toEqual([7, 2]);
	});
});
