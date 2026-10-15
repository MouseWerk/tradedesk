import { describe, expect, it } from "vitest";
import { atr, dayStats, ema, last, positionSize, rMultiple, riskToStopCents, rsi, sessionState, vwap } from "./index.ts";

const c = (t: number, o: number, h: number, l: number, cl: number, v = 100) => ({ t, o, h, l, c: cl, v });

describe("ema", () => {
	it("starts with the simple mean and then smooths", () => {
		const e = ema([1, 2, 3, 4, 5], 3);
		expect(e.slice(0, 2)).toEqual([null, null]);
		expect(e[2]).toBe(2);
		expect(e[3]).toBe(3); // 4*0.5 + 2*0.5
		expect(e[4]).toBe(4);
	});
});

describe("vwap", () => {
	it("weights by volume and restarts every day", () => {
		const v = vwap([c(1, 10, 10, 10, 10, 100), c(2, 20, 20, 20, 20, 300), c(3, 50, 50, 50, 50, 10)], (t) => (t < 3 ? "a" : "b"));
		expect(v[1]).toBe(17.5);
		expect(v[2]).toBe(50);
	});
	it("is null without volume", () => expect(vwap([c(1, 1, 1, 1, 1, 0)], () => "a")).toEqual([null]));
});

describe("rsi", () => {
	it("is 100 after only gains and near 50 for alternating moves", () => {
		expect(last(rsi([1, 2, 3, 4, 5, 6], 5))).toBe(100);
		const alt = Array.from({ length: 40 }, (_, i) => (i % 2 ? 11 : 10));
		expect(last(rsi(alt, 14))!).toBeGreaterThan(45);
		expect(last(rsi(alt, 14))!).toBeLessThan(55);
	});
});

describe("atr", () => {
	it("uses the true range across gaps", () => {
		const a = atr([c(1, 10, 11, 9, 10), c(2, 15, 16, 14, 15)], 2);
		expect(a[1]).toBe((2 + 6) / 2); // Lücke 10 → 16
	});
});

describe("sessionState", () => {
	const s = { preStart: 100, regStart: 200, regEnd: 300, postEnd: 400 };
	it("knows pre, open, post and closed", () => {
		expect([50, 150, 250, 350, 450].map((t) => sessionState(s, t))).toEqual(["closed", "pre", "open", "post", "closed"]);
		expect(sessionState(null, 1)).toBe("closed");
	});
});

describe("dayStats", () => {
	it("counts only today's closed trades and the profit factor", () => {
		const trades = [
			{ id: 1, side: "sell" as const, time: 5, feeCents: 100 },
			{ id: 2, side: "sell" as const, time: 15, feeCents: 100 },
			{ id: 3, side: "sell" as const, time: 16, feeCents: 100 },
			{ id: 4, side: "buy" as const, time: 17, feeCents: 100 },
		];
		const s = dayStats(trades, new Map([[1, 999], [2, 3000], [3, -1000]]), 10);
		expect(s).toMatchObject({ trades: 3, closed: 2, wins: 1, losses: 1, realizedCents: 2000, winRate: 50, profitFactor: 3, largestLossCents: -1000, feesCents: 300 });
	});
	it("has no rates on an empty day", () => expect(dayStats([], new Map(), 0)).toMatchObject({ winRate: null, profitFactor: null }));
});

describe("positionSize", () => {
	it("sizes by risk including both fees", () => {
		// 100 € Risiko, 2 € Gebühren → 98 € / (2 € je Stück) = 49 Stück
		expect(positionSize({ budgetCents: 10_000, entry: 50, stop: 48, fx: 1, feeCents: 100, cashCents: 1_000_000 })).toMatchObject({ qty: 49, riskCents: 9_800 + 200, valueCents: 245_000 });
	});
	it("is capped by cash", () => expect(positionSize({ budgetCents: 10_000, entry: 50, stop: 48, fx: 1, feeCents: 100, cashCents: 100_100 })).toMatchObject({ qty: 20, limitedBy: "cash" }));
	it("is capped by the order value and position limits", () => expect(positionSize({ budgetCents: 10_000, entry: 50, stop: 48, fx: 1, feeCents: 100, cashCents: 1e9, maxValueCents: 50_000 })).toMatchObject({ qty: 10, limitedBy: "value" }));
	it("converts currencies", () => expect(positionSize({ budgetCents: 10_200, entry: 100, stop: 99, fx: 0.5, feeCents: 100, cashCents: 1e9 })!.qty).toBe(200));
	it("refuses a stop above entry or a budget eaten by fees", () => {
		expect(positionSize({ budgetCents: 10_000, entry: 50, stop: 51, fx: 1, feeCents: 100, cashCents: 1e9 })).toBeNull();
		expect(positionSize({ budgetCents: 150, entry: 50, stop: 49, fx: 1, feeCents: 100, cashCents: 1e9 })).toBeNull();
	});
	it("allows fractional crypto", () => expect(positionSize({ budgetCents: 10_200, entry: 60000, stop: 59000, fx: 1, feeCents: 100, cashCents: 1e9, fractional: true })!.qty).toBe(0.1));
});

describe("R", () => {
	it("measures in multiples of the initial risk", () => {
		expect(rMultiple(100, 95, 110)).toBe(2);
		expect(rMultiple(100, null, 110)).toBeNull();
		expect(riskToStopCents(10, 100, 95, 1)).toBe(5000);
		expect(riskToStopCents(10, 100, 105, 1)).toBeNull();
	});
});
