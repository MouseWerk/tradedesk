// Zahlen an der Grenze (Q1 B2, B19, B30): nicht endliche oder absurde Werte sind ein Fehler, nie 0 und nie "ok".
import { describe, expect, it } from "vitest";
import { MAX_PRICE, MAX_QTY, ProposalInputSchema, cents, checkOrder, decimals, positionSize, type OrderCheckInput } from "./index.ts";

const base: OrderCheckInput = {
	side: "buy", qty: 1, orderType: "market", symbol: "SAP.DE", price: 100, fx: 1, cashCents: 100_000, equityCents: 100_000, feeCents: 100, heldQty: 0, positionValueCents: 0,
	limits: { accountId: "a", maxOrderCents: 500_000, maxPositionPct: 25, dailyLossPct: 5, maxOpenProposals: 5, maxRiskPct: 1, requireStop: true }, killSwitch: false, dayLossPct: null,
};

describe("cents", () => {
	it("throws for values that are not finite or beyond safe integers instead of returning 0", () => {
		expect(() => cents(Number.NaN)).toThrow();
		expect(() => cents(Number.POSITIVE_INFINITY)).toThrow();
		expect(() => cents(-Number.POSITIVE_INFINITY)).toThrow();
		expect(() => cents(1e308)).toThrow();
		expect(() => cents(1e14)).toThrow(); // 1e16 Cent liegt über 2^53
		expect(cents(1e12)).toBe(1e14);
	});
});

describe("decimals", () => {
	it("counts decimals in exponent notation", () => {
		expect(decimals(1.23e-5)).toBe(7);
		expect(decimals(1e-7)).toBe(7);
		expect(decimals(0.5)).toBe(1);
		expect(decimals(12)).toBe(0);
	});
});

describe("checkOrder with extreme numbers", () => {
	it("refuses a limit of 1e308 instead of passing with an estimate of 0", () => {
		const c = checkOrder({ ...base, qty: 100_000, orderType: "limit", limitPrice: 1e308, stopLoss: 1 });
		expect(c.ok).toBe(false);
		expect(Number.isFinite(c.estimateCents)).toBe(true);
	});
	it("refuses a stop of 1e308", () => expect(checkOrder({ ...base, stopLoss: 1e308 }).ok).toBe(false));
	it("never passes an order worth less than a cent", () => {
		const c = checkOrder({ ...base, qty: 0.000001, price: 0.001 });
		expect(c.ok).toBe(false);
		expect(c.violations.join()).toContain("Cent");
	});
	it("refuses a limit more than 50 % away from the quote", () => {
		expect(checkOrder({ ...base, orderType: "limit", limitPrice: 160, stopLoss: 150 }).ok).toBe(false);
		expect(checkOrder({ ...base, side: "sell", heldQty: 1, orderType: "limit", limitPrice: 40 }).ok).toBe(false);
	});
	it("over extreme doubles the estimate is finite whenever the order passes", () => {
		const values = [0, 1e-12, 1e-7, 0.000001, 0.01, 1, 99.99, 1e6, 1e7, 1e9, 1e15, 1e154, 1e308, Number.MAX_VALUE, Number.POSITIVE_INFINITY, Number.NaN, -1];
		let passed = 0;
		for (const qty of values)
			for (const price of values)
				for (const limitPrice of [null, ...values])
					for (const stopLoss of [null, 1, 1e308, Number.NaN]) {
						const c = checkOrder({ ...base, qty, price, orderType: limitPrice === null ? "market" : "limit", limitPrice, stopLoss, cashCents: 1e13, equityCents: 1e13, limits: { ...base.limits, maxOrderCents: 0, maxPositionPct: 0, maxRiskPct: 0 } });
						expect(Number.isFinite(c.estimateCents)).toBe(true);
						if (c.ok) {
							passed++;
							expect(c.estimateCents).toBeGreaterThan(0);
							expect(c.estimateCents).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
						}
					}
		expect(passed).toBeGreaterThan(0);
	});
});

describe("ProposalInputSchema bounds", () => {
	const ok = { author: "Atlas", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 2, confidence: 0.7, thesis: "x" };
	it("accepts a normal proposal", () => expect(ProposalInputSchema.safeParse(ok).success).toBe(true));
	it("refuses absurd quantities and prices", () => {
		expect(ProposalInputSchema.safeParse({ ...ok, qty: MAX_QTY * 10 }).success).toBe(false);
		expect(ProposalInputSchema.safeParse({ ...ok, orderType: "limit", limitPrice: 1e308 }).success).toBe(false);
		expect(ProposalInputSchema.safeParse({ ...ok, stopLoss: MAX_PRICE * 2 }).success).toBe(false);
		expect(ProposalInputSchema.safeParse({ ...ok, takeProfit: Number.POSITIVE_INFINITY }).success).toBe(false);
	});
	it("refuses more than 6 decimals in the quantity", () => expect(ProposalInputSchema.safeParse({ ...ok, qty: 0.0000001 }).success).toBe(false));
});

describe("positionSize", () => {
	it("returns null instead of throwing for absurd inputs", () => {
		expect(positionSize({ budgetCents: 1e300, entry: 1e-300, stop: 0, fx: 1, feeCents: 100, cashCents: 1e300 })).toBeNull();
	});
});
