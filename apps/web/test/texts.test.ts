// Text-Guards über die UI-Texte (AICodeGuidelines design/writing.md): deutsche Anführungszeichen, kein „im Mein
// Papierdepot“, ein Minuszeichen, Eingabefelder mit Tausenderpunkt, Owner-Regel für Broker-Orders.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../src");
function files(dir: string): string[] {
	return readdirSync(dir).flatMap((f) => {
		const p = path.join(dir, f);
		return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
	});
}
const all = files(SRC).map((f) => ({ f: path.relative(SRC, f).replaceAll("\\", "/"), src: readFileSync(f, "utf8") }));
const hits = (re: RegExp) => all.flatMap(({ f, src }) => src.split("\n").flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}: ${line.trim().slice(0, 120)}`] : [])));

describe("UI texts", () => {
	it("open German quotes close with German quotes", () => {
		// Ausdrücke in Template-Strings (${…}) dürfen eigene Anführungszeichen haben
		expect(hits(/„[^“”\n${}]{0,60}"/)).toEqual([]);
	});

	it("name accounts as „Name“ or with in, never 'im Mein Papierdepot'", () => {
		expect(hits(/\bim \$\{(acc|a|account)\??\.name|\bim Mein\b|\bim \$\{acc\.name/)).toEqual([]);
	});

	it("never print the hyphen as a minus sign", () => {
		expect(hits(/\? "-" :|"-" \+|`-\$\{/)).toEqual([]);
	});

	it("fill number fields with inputNumber (thousands dot) instead of toFixed or a bare String()", () => {
		expect(hits(/toFixed\(\d\)\.replace\("\.", ","\)|String\(v \/ 100\)/)).toEqual([]);
	});
});

describe("owner rule: broker orders never send on Enter (2026-10-16)", () => {
	it("every dialog that sends to a broker asks again via useConfirm first", () => {
		for (const f of ["modules/common.tsx", "modules/orders/OrderTicket.tsx", "modules/trade/OrderCalc.tsx"]) {
			const src = all.find((x) => x.f === f)!.src;
			expect(src, f).toMatch(/useConfirm\(\)/);
			expect(src, f).toMatch(/Mit echtem Geld senden/);
		}
	});
});
