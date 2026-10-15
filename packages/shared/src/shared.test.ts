import { describe, expect, it } from "vitest";
import { buildBook, cents, checkOrder, movePct, parseTradesCsv, valueHoldings, type OrderCheckInput, type TradeLike } from "./index.ts";

const t = (id: number, side: "buy" | "sell", qty: number, price: number, fee = 100, time = id): TradeLike => ({ id, symbol: "SAP.DE", side, qty, price, valueCents: cents(qty * price), feeCents: fee, time });

describe("cents", () => {
	it("rounds half away from zero", () => {
		expect(cents(1.005)).toBe(101);
		expect(cents(-1.005)).toBe(-101);
		expect(cents(0.1 + 0.2)).toBe(30);
		expect(cents(Number.NaN)).toBe(0);
	});
});

describe("buildBook (FIFO)", () => {
	it("sells the oldest lot first and counts fees in cost and proceeds", () => {
		const b = buildBook([t(1, "buy", 10, 100), t(2, "buy", 10, 120), t(3, "sell", 15, 130)]);
		// Kosten: Los 1 komplett 1001 €, Los 2 halb (1201/2 = 600,50 €); Erlös 1950 − 1 = 1949 €
		expect(b.realizedBySell.get(3)).toBe(194900 - 100100 - 60050);
		const h = b.holdings.get("SAP.DE")!;
		expect(h.qty).toBe(5);
		expect(h.avgPrice).toBe(120);
		expect(h.costCents).toBe(120100 - 60050);
	});

	it("orders by time, not by id", () => {
		const b = buildBook([t(5, "sell", 1, 50, 0, 20), t(9, "buy", 1, 40, 0, 10)]);
		expect(b.realizedCents).toBe(1000);
		expect(b.holdings.size).toBe(0);
	});

	it("never sells more than it holds", () => {
		const b = buildBook([t(1, "buy", 2, 10, 0), t(2, "sell", 5, 10, 0)]);
		expect(b.holdings.size).toBe(0);
		expect(b.realizedBySell.get(2)).toBe(0);
	});

	it("keeps fractional shares exact", () => {
		const b = buildBook([t(1, "buy", 0.123456, 100, 0), t(2, "buy", 0.876544, 100, 0), t(3, "sell", 0.5, 100, 0)]);
		expect(b.holdings.get("SAP.DE")!.qty).toBe(0.5);
	});
});

describe("valueHoldings", () => {
	it("falls back to cost without a quote and names the symbol", () => {
		const b = buildBook([t(1, "buy", 2, 100, 0)]);
		const v = valueHoldings(b.holdings, () => null);
		expect(v.marketValueCents).toBe(20000);
		expect(v.missing).toEqual(["SAP.DE"]);
		const w = valueHoldings(b.holdings, () => ({ price: 110, fx: 0.5 }));
		expect(w.marketValueCents).toBe(11000);
		expect(w.unrealizedCents).toBe(-9000);
	});
});

describe("checkOrder", () => {
	const base: OrderCheckInput = {
		side: "buy", qty: 1, orderType: "market", symbol: "SAP.DE", price: 100, fx: 1, cashCents: 100_000, equityCents: 100_000, feeCents: 100, heldQty: 0, positionValueCents: 0,
		limits: { accountId: "a", maxOrderCents: 0, maxPositionPct: 0, dailyLossPct: 0, maxOpenProposals: 0, maxRiskPct: 0, requireStop: true }, killSwitch: false, dayLossPct: null,
	};
	it("passes a plain order", () => expect(checkOrder(base)).toMatchObject({ ok: true, estimateCents: 10000 }));
	it("blocks everything while the kill switch is on", () => expect(checkOrder({ ...base, killSwitch: true }).ok).toBe(false));
	it("blocks without a quote", () => expect(checkOrder({ ...base, price: null }).violations.join()).toContain("Kein aktueller Kurs"));
	it("blocks short selling", () => expect(checkOrder({ ...base, side: "sell", heldQty: 0.5 }).ok).toBe(false));
	it("blocks buys over cash including the fee", () => expect(checkOrder({ ...base, cashCents: 10_050 }).ok).toBe(false));
	it("blocks position concentration", () => {
		const c = checkOrder({ ...base, qty: 30, cashCents: 1_000_000, equityCents: 1_000_000, limits: { ...base.limits, maxPositionPct: 25 } });
		expect(c.violations.join()).toContain("30,0 %");
	});
	it("blocks buys after the daily loss limit but allows sells", () => {
		const limits = { ...base.limits, dailyLossPct: 3 };
		expect(checkOrder({ ...base, limits, dayLossPct: 3.2 }).ok).toBe(false);
		expect(checkOrder({ ...base, side: "sell", heldQty: 1, limits, dayLossPct: 3.2 }).ok).toBe(true);
	});
	it("checks stop and target against the buy price", () => {
		expect(checkOrder({ ...base, stopLoss: 101 }).ok).toBe(false);
		expect(checkOrder({ ...base, takeProfit: 99 }).ok).toBe(false);
		expect(checkOrder({ ...base, stopLoss: 90, takeProfit: 120 }).ok).toBe(true);
	});
	it("uses the limit price for the estimate and warns when it is far away", () => {
		const c = checkOrder({ ...base, orderType: "limit", limitPrice: 80 });
		expect(c.estimateCents).toBe(8000);
		expect(c.warnings.join()).toContain("10 %");
	});
	it("limits open proposals per author", () => expect(checkOrder({ ...base, openByAuthor: 3, limits: { ...base.limits, maxOpenProposals: 3 } }).ok).toBe(false));
	it("rejects more than 6 decimals", () => expect(checkOrder({ ...base, qty: 0.1234567 }).ok).toBe(false));
});

describe("movePct", () => {
	it("is absolute", () => {
		expect(movePct(100, 97)).toBeCloseTo(3);
		expect(movePct(0, 5)).toBe(0);
	});
});

describe("parseTradesCsv", () => {
	it("reads German CSV with decimal comma, umlaut headers and quotes", () => {
		const r = parseTradesCsv('﻿Datum;Symbol;Seite;Stück;Kurs;Gebühr;Währung;Notiz\n02.03.2026;sap.de;Kauf;3;1.181,40;1,00;EUR;"Sparplan; März"\n\n2026-03-05 09:30;AAPL;verkauf;0,5;230;0;USD;');
		expect(r.errors).toEqual([]);
		expect(r.rows).toHaveLength(2);
		expect(r.rows[0]).toMatchObject({ symbol: "SAP.DE", side: "buy", qty: 3, price: 1181.4, feeCents: 100, note: "Sparplan; März" });
		expect(new Date(r.rows[1].time).getHours()).toBe(9);
	});
	it("reads English CSV with commas", () => {
		const r = parseTradesCsv("date,symbol,side,qty,price,fee\n2026-01-02,MSFT,buy,1.5,400.5,1");
		expect(r.rows[0]).toMatchObject({ qty: 1.5, price: 400.5, feeCents: 100, currency: "EUR" });
	});
	it("names bad lines instead of failing the file", () => {
		const r = parseTradesCsv("datum;symbol;seite;stueck;kurs\n2026-01-02;SAP.DE;halten;1;10\n2026-01-02;SAP.DE;kauf;1;10");
		expect(r.rows).toHaveLength(1);
		expect(r.errors[0]).toContain("Zeile 2");
	});
	it("explains a missing header column", () => expect(parseTradesCsv("a;b\n1;2").errors[0]).toContain("Kopfzeile"));
});

describe("checkOrder: risk per trade", () => {
	const base: OrderCheckInput = {
		side: "buy", qty: 10, orderType: "market", symbol: "X", price: 100, fx: 1, cashCents: 1_000_000, equityCents: 1_000_000, feeCents: 100, heldQty: 0, positionValueCents: 0,
		limits: { accountId: "a", maxOrderCents: 0, maxPositionPct: 0, dailyLossPct: 0, maxOpenProposals: 0, maxRiskPct: 1, requireStop: true }, killSwitch: false, dayLossPct: null,
	};
	it("counts the loss to the stop plus both fees against the limit", () => {
		expect(checkOrder({ ...base, stopLoss: 90.2 }).ok).toBe(true); // 98 € + 2 € = 1,00 %
		expect(checkOrder({ ...base, stopLoss: 90 }).violations.join()).toContain("1,02 %"); // 100 € + 2 €
	});
	it("requires a stop from agents but only warns you", () => {
		expect(checkOrder({ ...base, byAgent: true }).violations.join()).toContain("Stop-Loss");
		const mine = checkOrder(base);
		expect(mine.ok).toBe(true);
		expect(mine.warnings.join()).toContain("nicht begrenzt");
	});
});
