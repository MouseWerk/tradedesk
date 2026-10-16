// Kontrast aus den Token-Werten in styles.css (AICodeGuidelines design/guard-tests.md): Text 4,5:1 in beiden Designs,
// auch auf getönten Flächen (Badges, Hinweise), Fokusring und Not-Aus-Fläche mindestens 3:1 gegen den Grund.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(import.meta.dirname, "../src/styles.css"), "utf8");

type Rgb = [number, number, number]; // sRGB 0..1, gammakodiert

function block(selector: RegExp): Record<string, string> {
	const m = css.match(selector);
	if (!m) throw new Error(`block ${selector} missing`);
	return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
}
const light = block(/:root\s*\{([^}]*)\}/);
const dark = { ...light, ...block(/\.dark\s*\{([^}]*)\}/) };

/** oklch(L C h) → sRGB (Oklab-Matrizen von Björn Ottosson, außerhalb des Farbraums abgeschnitten). */
function oklch(v: string): Rgb {
	const m = v.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
	if (!m) throw new Error(`not an opaque oklch() color: ${v}`);
	const [L, C, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
	const a = C * Math.cos(h);
	const b = C * Math.sin(h);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s];
	return lin.map((c) => {
		const x = Math.min(1, Math.max(0, c));
		return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
	}) as Rgb;
}

const lum = (c: Rgb) => {
	const [r, g, b] = c.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
};
/** Tailwinds bg-warn/14: Token mit Deckkraft über dem Grund, wie der Browser mischt (gammakodiert). */
const tint = (fg: Rgb, alpha: number, base: Rgb): Rgb => fg.map((c, i) => c * alpha + base[i] * (1 - alpha)) as Rgb;

const THEMES = { light, dark };
const TEXT_ON = ["bg", "bg-2", "surface", "surface-2", "surface-3"];

describe.each(Object.entries(THEMES))("%s theme", (_, t) => {
	const c = (name: string) => oklch(t[name]);

	it.each(["fg", "fg-2", "fg-3"])("--%s text is readable on every surface", (fg) => {
		for (const bg of TEXT_ON) expect(ratio(c(fg), c(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
	});

	it.each(["ok", "warn", "err"])("--%s text is readable on surfaces and on its own tint", (k) => {
		for (const bg of ["bg", "surface", "surface-2", "surface-3"]) {
			expect(ratio(c(k), c(bg)), `${k} on ${bg}`).toBeGreaterThanOrEqual(4.5);
			// Badges (12–14 %), Hinweiskästen (10 %), Not-Aus-Leiste (8 %)
			for (const a of [0.08, 0.1, 0.12, 0.14]) expect(ratio(c(k), tint(c(k), a, c(bg))), `${k} on ${k}/${Math.round(a * 100)} over ${bg}`).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("button labels are readable on their fills", () => {
		expect(ratio(c("primary-fg"), c("primary")), "primary").toBeGreaterThanOrEqual(4.5);
		expect(ratio(c("danger-fg"), c("danger")), "danger").toBeGreaterThanOrEqual(4.5);
		// Zähler im Chat-Knopf
		expect(ratio(c("primary-fg"), c("warn")), "unread badge").toBeGreaterThanOrEqual(4.5);
	});

	it("focus ring and the danger fill stand out from the page (3:1)", () => {
		for (const bg of ["bg", "surface", "surface-2"]) {
			expect(ratio(c("focus-ring"), c(bg)), `focus ring on ${bg}`).toBeGreaterThanOrEqual(3);
			expect(ratio(c("danger"), c(bg)), `danger fill on ${bg}`).toBeGreaterThanOrEqual(3);
		}
	});
});

describe("contrast helper", () => {
	it("matches known values", () => {
		expect(ratio([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 5);
		expect(ratio(oklch("oklch(1 0 0)"), oklch("oklch(0 0 0)"))).toBeCloseTo(21, 2);
	});
});
