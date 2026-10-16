// Zahlen an der Grenze des Desks (Q1 B2, B19, B30): absurde Werte werden abgewiesen, bevor etwas gespeichert wird.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFixture, type Fixture } from "../src/fixture.ts";

let fx: Fixture;
let clock: number;

beforeEach(async () => {
	clock = new Date(2026, 9, 15, 11, 0).getTime();
	fx = await makeFixture({ now: () => clock });
});
afterEach(() => fx.cleanup());

const cash = (id: string) => fx.desk.summary(fx.desk.account(id)).cashCents;

describe("proposal with absurd numbers (B2)", () => {
	it("a limit of 1e308 is never created and nothing reaches the paper account", async () => {
		const before = fx.desk.proposals().length;
		const cashBefore = cash("agent-atlas");
		await expect(fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 100_000, orderType: "limit", limitPrice: 1e308, stopLoss: 1, confidence: 0.9, thesis: "x" }, "cli")).rejects.toThrow("Ungültiger Vorschlag");
		expect(fx.desk.proposals().length).toBe(before);
		expect(cash("agent-atlas")).toBe(cashBefore);
	});

	it("a limit far away from the quote is refused", async () => {
		const r = await fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 1, orderType: "limit", limitPrice: 400, stopLoss: 390, confidence: 0.9, thesis: "x" }, "cli");
		expect(r.ok).toBe(false);
		expect(r.check.violations.join()).toContain("50 %");
	});
});

describe("approve with a quantity that rounds to 0 (B30)", () => {
	it("answers 400 and leaves the proposal pending", async () => {
		const r = await fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 2, stopLoss: 190, confidence: 0.7, thesis: "x" }, "cli");
		await expect(fx.desk.approve(r.proposal!.id, { qty: 1e-7 })).rejects.toMatchObject({ status: 400 });
		expect(fx.desk.proposal(r.proposal!.id).status).toBe("pending");
	});
});

describe("cash moves (B19)", () => {
	it("refuses 1e308, sub-cent amounts and more than two decimals", () => {
		const before = cash("papier");
		for (const amountEur of [1e308, 1e20, -0.004, 0.004, 10.005, Number.NaN])
			expect(() => fx.desk.cashMove("papier", { amountEur }), String(amountEur)).toThrow();
		expect(cash("papier")).toBe(before);
		expect(fx.desk.overview().accounts.find((a) => a.id === "papier")!.cashCents).toBe(before);
	});

	it("books a normal deposit exactly", () => {
		const before = cash("papier");
		expect(fx.desk.cashMove("papier", { amountEur: 10.05 }).amountCents).toBe(1005);
		expect(cash("papier")).toBe(before + 1005);
	});
});

describe("manual trades and fills", () => {
	it("refuse absurd quantity, price and fee", async () => {
		for (const body of [{ qty: 1e9, price: 10 }, { qty: 1, price: 1e308 }, { qty: 1, price: 10, feeEur: 1e308 }, { qty: 1, price: 10, feeEur: 0.001 }, { qty: 0.0000001, price: 10 }])
			await expect(fx.desk.recordTrade("tr", { symbol: "ALV.DE", side: "buy", ...body }), JSON.stringify(body)).rejects.toThrow();
	});

	it("refuse an alert at an absurd price", () => {
		expect(() => fx.desk.addAlert({ symbol: "SAP.DE", op: "above", price: 1e308 }, "Maurice")).toThrow();
	});
});
