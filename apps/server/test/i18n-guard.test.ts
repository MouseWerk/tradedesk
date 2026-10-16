// Prüft das Prüfwerkzeug der Textkataloge selbst: Würde es einen vergessenen Text, einen falschen Wortlaut, eine
// verbotene Glossar-Variante und einen toten Schlüssel finden? Ohne diese Tests könnte die Heuristik still nichts finden.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deadKeys, glossary, glossaryViolations, hygiene, leafPaths, leftovers } from "./i18n-guard.ts";

describe("leftover heuristic", () => {
	it("finds JSX text, text attributes, toast texts and German strings, but not classes, keys, types or comparisons", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "desk-i18n-"));
		try {
			const f = path.join(dir, "x.tsx");
			writeFileSync(
				f,
				[
					'import { a } from "./über";',
					'type T = "für" | "von";',
					'const x = <p className="flex gap-2" data-testid="über">Freigeben</p>;',
					'const y = <b title="Cash" aria-label={ok ? "Market" : "Limit"}>{open ? "These kürzen" : "These lesen"}</b>;',
					'toast({ text: "Gespeichert", tone: "info" });',
					'if (s === "abgelehnt") throw new DeskError("Depot fehlt.");',
					'const m = { pending: 1, "für": 2 };',
					"const z = `Order ${id} an ${b} gesendet`;",
					'db.run("UPDATE x SET y = ? WHERE z = 1", v);',
					"// ein Kommentar über die Freigabe",
				].join("\n"),
			);
			expect(leftovers([f]).map((h) => h.text)).toEqual(["Freigeben", "Cash", "Market", "Limit", "These kürzen", "These lesen", "Gespeichert", "Depot fehlt.", "Order ${…} an ${…} gesendet"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("wording rules", () => {
	it("flags each rule once and passes clean text", () => {
		expect(hygiene("Freigeben…")).toEqual([]);
		expect(hygiene("Speichern …")).toEqual(["space before …"]);
		expect(hygiene("Laden...")).toEqual(["... instead of …"]);
		expect(hygiene('Name "Atlas"')).toEqual(['ASCII " instead of „…“']);
		expect(hygiene("Name „Atlas")).toEqual(["unbalanced „…“"]);
		expect(hygiene("Verlust -12 €")).toEqual(["hyphen as minus"]);
		expect(hygiene("1.5 %")).toEqual(["decimal point instead of comma"]);
		expect(hygiene("1.000 Trades, 100.64.0.0/10, 31.03., −1,5 %")).toEqual([]);
		expect(hygiene("4-12 Ziffern")).toEqual(["hyphen in a range (–)"]);
		expect(hygiene("Bitte melden Sie sich an")).toEqual(["„Sie“ instead of „du“"]);
		expect(hygiene("3 Trade(s)")).toEqual(["plural shortcut like Trade(s)"]);
		expect(hygiene("\u{1F680} los")).toEqual(["emoji"]);
	});
});

describe("glossary", () => {
	const entries = glossary();

	it("reads docs/GLOSSARY.md", () => {
		expect(entries.find((e) => e.terms.includes("Depot"))?.forbidden).toContain("echtes Konto");
	});

	it("allows the terms (also inside compounds) and flags the variants", () => {
		expect(glossaryViolations("Order-Rechner: 40", entries)).toEqual([]);
		expect(glossaryViolations("Läuft auf diesem Rechner", entries)).toEqual(["Rechner"]);
		expect(glossaryViolations("Papierkonto bei IBKR", entries)).toEqual([]);
		expect(glossaryViolations("als echtes Konto eingetragen", entries)).toEqual(["echtes Konto"]);
		expect(glossaryViolations("Risiko bis zum Stop", entries)).toEqual(["Risiko bis zum Stop"]);
	});
});

describe("dead keys", () => {
	it("finds an unused key and counts a map used as a whole", () => {
		const cat = { a: { used: "x", dead: "y", map: { k: "z" }, fn: () => "f", list: ["a"], other: "o" } };
		expect(deadKeys(leafPaths(cat, "de"), ["de.a.used; de.a.map[k]; de.a.fn(1); [...de.a.list]; x.de.a.other; de.a.usedTwice"])).toEqual(["de.a.dead", "de.a.other"]);
	});
});
