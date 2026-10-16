// Reine Logik der Web-App: Meldung nach einer Order, Grund ohne Stückzahl, Wechselkurs, Risiko einer Freigabe,
// Meldungsliste, Achsen.
import { describe, expect, it } from "vitest";
import type { Proposal } from "@desk/shared";
import { fxFromCheck, fxFromData, orderResultText, proposalRisk, sizingReason } from "../src/lib/orders.ts";
import { pushToast, type Toast } from "../src/ui/toasts.ts";
import { niceScale, niceTicks, tickCount } from "../src/ui/scale.ts";

const base = { label: "Verkauf 8 ALV.DE", broker: "Interactive Brokers", kind: "broker" as const };

describe("orderResultText", () => {
	it("says what happened instead of always 'geschlossen'", () => {
		expect(orderResultText({ status: "filled", reason: "" }, { ...base, kind: "paper", filled: "ALV.DE geschlossen." })).toBe("ALV.DE geschlossen.");
		expect(orderResultText({ status: "rejected", reason: "Tagesverlust-Grenze erreicht" }, { ...base, filled: "ALV.DE geschlossen." })).toBe("Verkauf 8 ALV.DE abgelehnt: Tagesverlust-Grenze erreicht");
		expect(orderResultText({ status: "confirm", reason: "" }, base)).toMatch(/Interactive Brokers fragt nach – unter Orders/);
		expect(orderResultText({ status: "placed", reason: "" }, base)).toBe("Verkauf 8 ALV.DE an Interactive Brokers gesendet, Ausführung folgt.");
		expect(orderResultText({ status: "sending", reason: "" }, base)).toMatch(/gesendet/);
		expect(orderResultText({ status: "placed", reason: "" }, { ...base, broker: "Trade Republic", kind: "manual" })).toMatch(/jetzt in Trade Republic ausführen/);
		expect(orderResultText({ status: "open", reason: "" }, { ...base, kind: "paper" })).toBe("Verkauf 8 ALV.DE: Limit angelegt.");
		expect(orderResultText({ status: "stale", reason: "Kurs 3 % bewegt" }, base)).toMatch(/nicht ausgeführt: Kurs 3 % bewegt/);
		for (const s of ["filled", "rejected", "confirm", "placed", "sending", "open", "stale", "expired", "cancelled", "pending"] as const) expect(orderResultText({ status: s, reason: "" }, base)).not.toMatch(/geschlossen/);
	});
});

describe("sizingReason", () => {
	const ok = { fx: 0.92, currency: "USD", entry: 231.4, stop: 229.2, budgetCents: 20_300, feeCents: 100, cashCents: 1_000_000 };
	it("names the real reason", () => {
		expect(sizingReason({ ...ok, fx: null })).toBe("Kein Wechselkurs USD/EUR – Stück selbst eintragen.");
		expect(sizingReason({ ...ok, stop: 240 })).toMatch(/Stop unter dem Einstieg/);
		expect(sizingReason({ ...ok, entry: Number.NaN })).toMatch(/Einstieg eintragen/);
		expect(sizingReason({ ...ok, budgetCents: 150 })).toMatch(/Gebühren/);
		expect(sizingReason({ ...ok, cashCents: 50 })).toMatch(/Kein Cash/);
		expect(sizingReason({ ...ok, entry: 61_250, stop: 1 })).toMatch(/nicht für 1 Stück/);
	});
});

const proposal = (o: Partial<Proposal>): Proposal => ({
	id: 1, accountId: "ibkr", author: "Nova", symbol: "SAP.DE", name: "SAP", currency: "EUR", side: "buy", qty: 2, orderType: "market", limitPrice: null, stopLoss: 195, takeProfit: 215,
	confidence: 0.75, thesis: "", status: "pending", reason: "", quotePrice: 201.25, price: 201.25, estimateCents: 40_250, warnings: [], createdAt: 0, decidedAt: null, decidedBy: null,
	approvedQty: null, expiresAt: 0, fillPrice: null, brokerOrderId: null, brokerMessage: null, ...o,
});

describe("fx and risk from API data", () => {
	it("takes the rate from any position or proposal in that currency", () => {
		expect(fxFromData("EUR")).toBe(1);
		expect(fxFromData("USD", { positions: [{ accountId: "tr", symbol: "AAPL", name: "", currency: "USD", qty: 1, avgPrice: 1, price: 212.89, nativePrice: 231.4, unrealizedCents: 0, unrealizedPct: null, stopLoss: null, takeProfit: null, r: null, openedToday: false }] })).toBeCloseTo(0.92, 3);
		expect(fxFromData("USD", { positions: [] }, [proposal({ currency: "USD", symbol: "MSFT", qty: 4, price: 418.9, quotePrice: 418.9, estimateCents: 154_155 })])).toBeCloseTo(0.92, 3);
		expect(fxFromData("USD", { positions: [] }, [])).toBeNull();
		expect(fxFromCheck({ ok: true, violations: [], warnings: [], estimateCents: 21_288_800, feeCents: 100, price: 231.4 }, 1000, 231.4)).toBeCloseTo(0.92, 4);
		expect(fxFromCheck(null, 1000, 231.4)).toBeNull();
	});

	it("computes loss to stop incl. both fees like the risk check", () => {
		const r = proposalRisk(proposal({}), 2, 200, 2_500_000)!;
		// 2 × (201,25 − 195) = 12,50 € + 2 × 2,00 € Gebühr
		expect(r.riskCents).toBe(1_650);
		expect(r.pctOfAccount).toBeCloseTo(0.066, 3);
		expect(r.targetR).toBeCloseTo((215 - 201.25) / 6.25, 6);
		expect(proposalRisk(proposal({}), 1, 200, 2_500_000)!.riskCents).toBe(625 + 400);
		expect(proposalRisk(proposal({ stopLoss: null }), 2, 200, 1)).toBeNull();
		expect(proposalRisk(proposal({ side: "sell" }), 2, 200, 1)).toBeNull();
		expect(proposalRisk(proposal({ stopLoss: 210 }), 2, 200, 1)).toBeNull();
	});
});

describe("pushToast", () => {
	const t = (id: number, action = false): Toast => ({ id, text: `t${id}`, tone: "info", action: action ? { label: "Rückgängig", run: () => undefined } : undefined });
	it("never pushes away a pending undo with later info toasts", () => {
		let xs: Toast[] = [t(1, true)];
		for (let i = 2; i <= 6; i++) xs = pushToast(xs, t(i));
		expect(xs.map((x) => x.id)).toEqual([1, 4, 5, 6]);
		expect(xs.some((x) => x.action)).toBe(true);
	});
	it("keeps the newest and drops the oldest plain toast", () => {
		let xs: Toast[] = [];
		for (let i = 1; i <= 5; i++) xs = pushToast(xs, t(i));
		expect(xs.map((x) => x.id)).toEqual([2, 3, 4, 5]);
	});
	it("lets more stand when all older ones carry an action", () => {
		let xs: Toast[] = [];
		for (let i = 1; i <= 4; i++) xs = pushToast(xs, t(i, true));
		xs = pushToast(xs, t(5));
		expect(xs.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
	});
});

describe("chart scale", () => {
	it("encloses the data with a labelled tick above and below", () => {
		const s = niceScale(131.64, 132.93, 4);
		expect(s.lo).toBeLessThanOrEqual(131.64);
		expect(s.hi).toBeGreaterThanOrEqual(132.93);
		expect(s.ticks[0]).toBe(s.lo);
		expect(s.ticks.at(-1)).toBe(s.hi);
		expect(s.ticks.length).toBeGreaterThanOrEqual(3);
	});
	it("handles flat and odd inputs", () => {
		expect(niceScale(100, 100).hi).toBeGreaterThan(100);
		expect(niceScale(0, 0).ticks.length).toBeGreaterThan(1);
		expect(niceScale(Number.NaN, 1)).toEqual({ lo: 0, hi: 1, ticks: [0, 1] });
		expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
		expect(tickCount(120)).toBe(3);
		expect(tickCount(1000)).toBe(6);
	});
});
