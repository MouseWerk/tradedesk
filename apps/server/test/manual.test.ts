// Manuelle Depots (Q1 B9, B17, B18): ein Verkauf muss zu seinem Zeitpunkt gedeckt sein, CSV-Fremdwährung braucht den
// Kurs ihres Tages, gleiche Zeilen zählen doppelt, unmögliche und künftige Daten werden abgewiesen.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBook, parseTradesCsv } from "@desk/shared";
import { makeFixture, type Fixture } from "../src/fixture.ts";

let fx: Fixture;
let clock: number;
const day = 86_400_000;

beforeEach(async () => {
	clock = new Date(2026, 9, 15, 11, 0).getTime();
	fx = await makeFixture({ now: () => clock });
});
afterEach(() => fx.cleanup());

const tr = () => fx.desk.summary(fx.desk.account("tr"));

describe("backdated sells (B9)", () => {
	it("a sell dated before its buy is refused and creates no money", async () => {
		await fx.desk.recordTrade("tr", { symbol: "ALV.DE", side: "buy", qty: 10, price: 300 });
		const before = tr();
		await expect(fx.desk.recordTrade("tr", { symbol: "ALV.DE", side: "sell", qty: 10, price: 300, time: clock - day })).rejects.toMatchObject({ status: 400 });
		expect(tr().equityCents).toBe(before.equityCents);
		expect(tr().cashCents).toBe(before.cashCents);
	});

	it("buildBook reports a sell that sells more than was held at its time", () => {
		const b = buildBook([
			{ id: 1, symbol: "X", side: "buy", qty: 10, price: 10, valueCents: 10_000, feeCents: 0, time: 200 },
			{ id: 2, symbol: "X", side: "sell", qty: 10, price: 10, valueCents: 10_000, feeCents: 0, time: 100 },
		]);
		expect(b.oversold.get(2)).toBe(10);
	});

	it("deleting a buy that a later sell depends on is refused", async () => {
		const buy = await fx.desk.recordTrade("tr", { symbol: "ALV.DE", side: "buy", qty: 5, price: 300, time: clock - 2 * day });
		await fx.desk.recordTrade("tr", { symbol: "ALV.DE", side: "sell", qty: 5, price: 310, time: clock - day });
		expect(() => fx.desk.deleteTrade("tr", buy.id)).toThrow("Verkauf");
	});

	it("restoring a deleted sell that is no longer covered is refused", async () => {
		await fx.desk.recordTrade("tr", { symbol: "ALV.DE", side: "buy", qty: 5, price: 300, time: clock - 3 * day });
		const sell = await fx.desk.recordTrade("tr", { symbol: "ALV.DE", side: "sell", qty: 5, price: 310, time: clock - day });
		fx.desk.deleteTrade("tr", sell.id);
		await fx.desk.recordTrade("tr", { symbol: "ALV.DE", side: "sell", qty: 5, price: 305, time: clock - 2 * day });
		expect(() => fx.desk.deleteTrade("tr", sell.id, true)).toThrow();
	});

	it("an execution of a sell entered with a time before the holding is refused", async () => {
		const r = await fx.desk.submit({ author: "Nova", accountId: "tr", symbol: "AAPL", side: "sell", qty: 6, confidence: 0.8, thesis: "x" }, "cli");
		await fx.desk.approve(r.proposal!.id, {});
		await expect(async () => fx.desk.fill(r.proposal!.id, { price: 200, time: clock - 90 * day })).rejects.toMatchObject({ status: 400 });
		expect(fx.desk.proposal(r.proposal!.id).status).toBe("placed");
	});

	it("refuses times that are not numbers, in the far past or in the future", async () => {
		for (const time of [Number.NaN, "gestern", 0, new Date(1985, 0, 1).getTime(), clock + day])
			await expect(fx.desk.recordTrade("tr", { symbol: "ALV.DE", side: "buy", qty: 1, price: 300, time }), String(time)).rejects.toMatchObject({ status: 400 });
	});

	it("a CSV sell before its buy is named as an error, the buy is imported", async () => {
		const r = await fx.desk.importCsv("tr", "datum;symbol;seite;stueck;kurs\n2026-10-01;ALV.DE;verkauf;3;340\n2026-10-02;ALV.DE;kauf;3;340");
		expect(r.imported).toBe(1);
		expect(r.errors.join()).toContain("Zeile 2");
		expect(fx.desk.detail("tr").positions.find((p) => p.symbol === "ALV.DE")!.qty).toBe(3);
	});
});

describe("CSV in a foreign currency (B17)", () => {
	it("books a USD row at the rate given in the file, not today's", async () => {
		const r = await fx.desk.importCsv("tr", "datum;symbol;seite;stueck;kurs;gebuehr;waehrung;fx\n2025-01-02;AAPL;kauf;10;180,00;1,00;USD;0,9612");
		expect(r).toMatchObject({ imported: 1, errors: [] });
		const t = fx.desk.detail("tr").trades.find((x) => x.time === new Date(2025, 0, 2, 12).getTime())!;
		expect(t).toMatchObject({ currency: "USD", fx: 0.9612, valueCents: Math.round(10 * 180 * 0.9612 * 100) });
	});

	it("takes the EUR amount from betrag_eur", async () => {
		const r = await fx.desk.importCsv("tr", "datum;symbol;seite;stueck;kurs;waehrung;betrag_eur\n2025-01-02;AAPL;kauf;10;180,00;USD;1.730,16");
		expect(r.errors).toEqual([]);
		expect(fx.desk.detail("tr").trades.find((x) => x.time === new Date(2025, 0, 2, 12).getTime())!.valueCents).toBe(173_016);
	});

	it("refuses a foreign-currency row without a rate", async () => {
		const r = await fx.desk.importCsv("tr", "datum;symbol;seite;stueck;kurs;waehrung\n2025-01-02;AAPL;kauf;10;180,00;USD");
		expect(r.imported).toBe(0);
		expect(r.errors[0]).toContain("Wechselkurs");
	});
});

describe("CSV duplicates and dates (B18)", () => {
	it("imports two identical executions on the same day, and none the second time", async () => {
		const csv = "datum;symbol;seite;stueck;kurs;gebuehr\n2026-03-02;SAP.DE;kauf;1;180,00;0\n2026-03-02;SAP.DE;kauf;1;180,00;0";
		expect(await fx.desk.importCsv("tr", csv)).toEqual({ imported: 2, skipped: 0, errors: [] });
		expect(await fx.desk.importCsv("tr", csv)).toEqual({ imported: 0, skipped: 2, errors: [] });
	});

	it("keeps the key of a single line as before, so files imported earlier are still recognised", () => {
		const r = parseTradesCsv("datum;symbol;seite;stueck;kurs;gebuehr\n01.10.2026;ALV.DE;kauf;2;340,00;1,00");
		expect(r.rows[0].key).toBe(`${new Date(2026, 9, 1, 12).getTime()}|ALV.DE|buy|2|340|100`);
	});

	it("refuses impossible dates and trailing garbage", () => {
		const r = parseTradesCsv("datum;symbol;seite;stueck;kurs\n30.02.2026;SAP.DE;kauf;1;10\n2026-02-30;SAP.DE;kauf;1;10\n2026-03-02x;SAP.DE;kauf;1;10\n2026-03-02 25:00;SAP.DE;kauf;1;10\n2026-03-02;SAP.DE;kauf;1;10");
		expect(r.rows).toHaveLength(1);
		expect(r.errors).toHaveLength(4);
	});

	it("refuses dates in the future", async () => {
		const r = await fx.desk.importCsv("tr", "datum;symbol;seite;stueck;kurs\n2027-01-01;SAP.DE;kauf;1;180");
		expect(r.imported).toBe(0);
		expect(r.errors[0]).toContain("Zukunft");
	});
});
