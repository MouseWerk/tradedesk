// Zahlen lesen und schreiben wie ein deutscher Nutzer: Tausenderpunkt, Dezimalkomma, ein Minuszeichen.
import { describe, expect, it } from "vitest";
import { compact, eur, inputNumber, num, numberError, parseDe, pct, price, qty, signedEur } from "../src/lib/format.ts";

describe("parseDe", () => {
	it.each([
		["1.000", 1000],
		["12.000", 12000],
		["1.234.567", 1234567],
		["1.234,56", 1234.56],
		["1.234,5", 1234.5],
		["1234,5", 1234.5],
		["1234.5", 1234.5],
		["104.50", 104.5],
		["104,50", 104.5],
		["1.5", 1.5],
		["0.001", 0.001],
		["0,000001", 0.000001],
		[",5", 0.5],
		["5,", 5],
		["1,000", 1],
		["  2 500 € ", 2500],
		["2 500,00 €", 2500],
		["-8", -8],
		["−8,25", -8.25],
		["+3", 3],
		["0", 0],
	])("reads %j as %d", (raw, want) => {
		expect(parseDe(raw)).toBeCloseTo(want, 9);
	});

	it.each(["", " ", ",", ".", "1,234.5", "1.2.3", "1.23,4", "12,3,4", "1e5", "abc", "1.0000,5", "--1", "0x10"])("refuses %j", (raw) => {
		expect(parseDe(raw)).toBeNaN();
	});

	it("explains English notation and other junk", () => {
		expect(numberError("1,234.5")).toBe("Bitte deutsches Format: 1.234,50");
		expect(numberError("abc")).toMatch(/Keine Zahl/);
		expect(numberError("1.000")).toBeNull();
		expect(numberError("")).toBeNull();
	});

	it("reads back what inputNumber writes", () => {
		for (const v of [0, 0.5, 1, 203, 1000, 5000, 61250, 1234567.89, 0.0123]) expect(parseDe(inputNumber(v, v < 1 ? 4 : 2))).toBeCloseTo(v, 6);
		expect(inputNumber(5000, 0)).toBe("5.000");
		expect(inputNumber(Number.NaN)).toBe("");
	});
});

describe("one minus sign", () => {
	it("uses U+2212 and never the hyphen for negative numbers", () => {
		for (const s of [eur(-800), eur(-123456, { short: true }), signedEur(-3668), num(-1.5), pct(-2), compact(-12_400), compact(-3.4e9), qty(-2), price(-0.5)]) {
			expect(s).toContain("−");
			expect(s).not.toContain("-");
		}
		expect(eur(-800)).toBe("−8,00 €");
		expect(eur(800)).toBe("8,00 €");
	});

	it("shows prices below 1 with four digits", () => {
		expect(price(0.1234, "USD")).toBe("0,1234 $");
		expect(price(61250, "EUR")).toBe("61.250,00 €");
	});

	it("never breaks between amount and currency", () => {
		for (const s of [price(204.79, "USD"), price(0.5), eur(123456), signedEur(-800)]) expect(s).not.toMatch(/\d [€$]/);
	});
});
