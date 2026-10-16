// Textkatalog der Web-App (AICodeGuidelines design/writing.md, design/guard-tests.md „Translation catalogs“): Die
// Oberfläche ist nur deutsch, also gibt es einen Katalog (src/i18n/de.ts) statt einer i18n-Bibliothek. Geprüft wird:
// kein deutscher UI-Text mehr als Literal im Code, Wortlaut der Katalogtexte, Begriffe aus docs/GLOSSARY.md, kein
// toter Schlüssel. Die Heuristik für „UI-Text“ steht in apps/server/test/i18n-guard.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { catalogTexts, deadKeys, glossary, glossaryViolations, hygiene, leafPaths, leftovers, readSources, sourceFiles } from "../../server/test/i18n-guard.ts";
import { de } from "../src/i18n/de.ts";

const SRC = path.resolve(import.meta.dirname, "../src");
const CATALOG = path.join(SRC, "i18n/de.ts");
const code = sourceFiles(SRC, ["i18n"]);

/**
 * Bewusst kein Katalogtext – Eigennamen und Daten, keine UI-Wörter. Jeder Eintrag mit Grund; ein neuer Eintrag hier
 * ist die Ausnahme, nicht der Weg, einen Text am Katalog vorbeizuschieben.
 */
const ALLOW: { text: string; why: string }[] = [
	{ text: "Yahoo Finance", why: "Name der Kursquelle" },
	{ text: "Interactive Brokers", why: "Name des Brokers" },
	{ text: "desk: API-Antwort passt nicht zum Schema", why: "Entwicklerhinweis in der Browser-Konsole; die Oberfläche zeigt de.api.mismatch" },
];

describe("web texts come from the catalog", () => {
	it("no German UI text is left as a literal in src/ (outside src/i18n)", () => {
		const hits = leftovers(code, (_f, text) => ALLOW.some((a) => a.text === text));
		expect(hits.map((h) => `${h.file}:${h.line}: ${h.text}`)).toEqual([]);
	});

	it("the catalog is one file without imports", () => {
		expect(readFileSync(CATALOG, "utf8")).not.toMatch(/^\s*import\s/m);
	});
});

describe("catalog wording (design/writing.md)", () => {
	const texts = catalogTexts(CATALOG, "de");

	it("reads the catalog", () => {
		expect(texts.length).toBeGreaterThan(300);
	});

	it("no emoji, no space before …, „…“ quotes, real minus, decimal comma, en dash in ranges, du instead of Sie, plural written out", () => {
		const bad = texts.flatMap((t) => hygiene(t.text).map((v) => `${t.path} (Zeile ${t.line}): ${v} – ${t.text}`));
		expect(bad).toEqual([]);
	});

	it("uses the terms of docs/GLOSSARY.md, none of their forbidden variants", () => {
		const entries = glossary();
		expect(entries.length).toBeGreaterThanOrEqual(20);
		// Suchwörter der Befehlspalette sind absichtlich Synonyme (GLOSSARY.md, Entscheidungen)
		const bad = texts.filter((t) => !t.path.startsWith("de.nav.keywords")).flatMap((t) => glossaryViolations(t.text, entries).map((v) => `${t.path}: „${v}“ in ${t.text}`));
		expect(bad).toEqual([]);
	});
});

describe("catalog keys", () => {
	it("every key is used somewhere in src/", () => {
		expect(deadKeys(leafPaths(de, "de"), readSources(code))).toEqual([]);
	});
});

describe("chart ranges", () => {
	it("are written the same way on every chart: number and unit without a space (1T, 1M, 1J), YTD, Alles, Eigener", () => {
		const labels = [...Object.values(de.overview.range).map((r) => r.label), ...Object.values(de.analytics.ranges), ...Object.values(de.intraday.ranges), ...Object.values(de.market.range)];
		expect(labels.filter((l) => !/^(\d+[TWMJ]|YTD|Alles|Eigener)$/.test(l))).toEqual([]);
	});
});
