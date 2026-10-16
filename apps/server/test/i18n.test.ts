// Textkataloge des Servers (src/i18n/de.ts) und der gemeinsamen Logik (packages/shared/src/i18n/de.ts): jede
// Meldung an dich oder an Agenten (DeskError, Ereignisse, Chat, Prüfungen, Broker, Konsole) kommt von dort
// (AICodeGuidelines design/writing.md, design/guard-tests.md „Translation catalogs“). Geprüft wird wie in der Web-App:
// keine deutschen Literale mehr im Code, Wortlaut, Glossar, keine toten Schlüssel. Heuristik in ./i18n-guard.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sharedDe } from "@desk/shared";
import { de } from "../src/i18n/de.ts";
import { REPO, catalogTexts, deadKeys, glossary, glossaryViolations, hygiene, leafPaths, leftovers, readSources, sourceFiles } from "./i18n-guard.ts";

const SERVER = path.join(REPO, "apps/server/src");
const SHARED = path.join(REPO, "packages/shared/src");
const WEB = path.join(REPO, "apps/web/src");
const SERVER_CATALOG = path.join(SERVER, "i18n/de.ts");
const SHARED_CATALOG = path.join(SHARED, "i18n/de.ts");

// Daten statt Text: die Wegwerf-Werkstatt für Tests (Depots, Chat, Thesen) und die Namen der Selbsttest-Prüfungen
const serverCode = sourceFiles(SERVER, ["i18n", "fixture.ts", "selftest.ts"]);
const sharedCode = sourceFiles(SHARED, ["i18n"]);
const webCode = sourceFiles(WEB, ["i18n"]);

/** Bewusst kein Katalogtext, mit Grund. */
const ALLOW: { file: string; text: (t: string) => boolean; why: string }[] = [
	// Spaltennamen, die der CSV-Import in der Kopfzeile wiedererkennt – Eingabedaten, kein Text der Oberfläche
	{ file: "packages/shared/src/csv.ts", text: (t) => /^[a-zäöü_]+$/.test(t), why: "CSV-Spaltennamen" },
	// die Rückfrage, die der Fake-Broker wie IBKR stellt: IBKRs eigene Worte (englisch), nur in Tests und der Fixture
	{ file: "apps/server/src/broker.ts", text: (t) => t.startsWith("The following order"), why: "IBKR-Wortlaut im Fake-Broker" },
	// Namen der Werte der Fake-Börse (Fixture, Tests)
	{ file: "apps/server/src/market.ts", text: (t) => /^(Allianz SE|Apple Inc\.|Bitcoin EUR|Microsoft Corporation|SAP SE|NVIDIA Corporation)$/.test(t), why: "Daten der Fake-Börse" },
	{ file: "*", text: (t) => /^(Interactive Brokers|Yahoo Finance|Trade Republic)$/.test(t), why: "Eigennamen" },
];
const allowed = (file: string, text: string) => ALLOW.some((a) => (a.file === "*" || a.file === file) && a.text(text));

describe("server and shared texts come from the catalogs", () => {
	it("no German message is left as a literal in apps/server/src", () => {
		expect(leftovers(serverCode, allowed).map((h) => `${h.file}:${h.line}: ${h.text}`)).toEqual([]);
	});

	it("no German message is left as a literal in packages/shared/src", () => {
		expect(leftovers(sharedCode, allowed).map((h) => `${h.file}:${h.line}: ${h.text}`)).toEqual([]);
	});

	it("SQL carries no German text (reasons go in as parameters)", () => {
		// jedes SQL-Literal '…' einzeln: deutsch ist es mit Umlaut oder mit zwei Wörtern („von dir storniert“)
		const literals = readSources(serverCode).flatMap((src) => [...src.matchAll(/"[^"\n]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"\n]*"|`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*`/g)].flatMap((q) => [...q[0].matchAll(/'([^']*)'/g)].map((m) => m[1])));
		expect(literals.length).toBeGreaterThan(10);
		expect(literals.filter((l) => /[äöüÄÖÜß]|\p{L}+ \p{L}+/u.test(l))).toEqual([]);
	});

	it("the catalogs import nothing", () => {
		for (const f of [SERVER_CATALOG, SHARED_CATALOG]) expect(readFileSync(f, "utf8"), f).not.toMatch(/^\s*import\s/m);
	});
});

const catalogs = [
	{ name: "server", file: SERVER_CATALOG, root: "de" },
	{ name: "shared", file: SHARED_CATALOG, root: "sharedDe" },
];

describe.each(catalogs)("$name catalog wording (design/writing.md)", ({ file, root }) => {
	const texts = catalogTexts(file, root);

	it("reads the catalog", () => {
		expect(texts.length).toBeGreaterThan(20);
	});

	it("no emoji, no space before …, „…“ quotes, real minus, decimal comma, en dash in ranges, du instead of Sie, plural written out", () => {
		expect(texts.flatMap((t) => hygiene(t.text).map((v) => `${t.path} (Zeile ${t.line}): ${v} – ${t.text}`))).toEqual([]);
	});

	it("uses the terms of docs/GLOSSARY.md, none of their forbidden variants", () => {
		const entries = glossary();
		expect(texts.flatMap((t) => glossaryViolations(t.text, entries).map((v) => `${t.path}: „${v}“ in ${t.text}`))).toEqual([]);
	});
});

describe("catalog keys", () => {
	it("every server key is used in apps/server/src", () => {
		expect(deadKeys(leafPaths(de, "de"), readSources(sourceFiles(SERVER, ["i18n"])))).toEqual([]);
	});

	it("every shared key is used in shared, server or web code", () => {
		expect(deadKeys(leafPaths(sharedDe, "sharedDe"), readSources([...sharedCode, ...serverCode, ...webCode]))).toEqual([]);
	});
});
