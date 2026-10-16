// Design-Guards (AICodeGuidelines design/guard-tests.md): Regeln, die nicht getestet werden, kommen zurück.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../src");
const css = readFileSync(path.join(SRC, "styles.css"), "utf8");

function files(dir: string, ext: RegExp): string[] {
	return readdirSync(dir).flatMap((f) => {
		const p = path.join(dir, f);
		return statSync(p).isDirectory() ? files(p, ext) : ext.test(f) ? [p] : [];
	});
}
const tsx = files(SRC, /\.tsx$/).map((f) => ({ f: path.relative(SRC, f), src: readFileSync(f, "utf8") }));

describe("styles.css", () => {
	it("has balanced braces and no merge markers", () => {
		expect(css.split("{").length).toBe(css.split("}").length);
		expect(css).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
	});

	it("keeps literal colors inside the token blocks", () => {
		const outside = css.replace(/:root\s*\{[^}]*\}/, "").replace(/\.dark\s*\{[^}]*\}/, "");
		expect(outside.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/gi) ?? []).toEqual([]);
	});

	it("draws focus only with the neutral token", () => {
		expect(css).toMatch(/:focus-visible\s*\{[^}]*var\(--focus-ring\)/);
		expect(css).not.toMatch(/:focus\s*\{/);
	});

	it("keeps element resets in @layer base so utilities like text-[13px] win (inputs in dialogs were 16 px)", () => {
		const unlayered = css.replace(/@layer\s+[\w-]+\s*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "");
		expect(unlayered).not.toMatch(/(^|[\s,}])(input|select|textarea|button)\s*[,{]/);
		expect(css).toMatch(/@layer base\s*\{[^@]*input,[^}]*font: inherit/);
	});

	it("defines every series color for both themes", () => {
		for (let i = 1; i <= 5; i++) expect(css.match(new RegExp(`--series-${i}:`, "g"))).toHaveLength(2);
	});
});

describe("components", () => {
	it("use no accent- or status-colored borders, rings, outlines or glows", () => {
		const bad = /\b(?:border|ring|outline|shadow|divide)(?:-[trblxy])?-(?:ok|warn|err|s[1-5])\b/;
		expect(tsx.filter((x) => bad.test(x.src)).map((x) => x.f)).toEqual([]);
	});

	it("use no colored bars on the left", () => {
		expect(tsx.filter((x) => /\bborder-l-(?:\d|\[)|border-l-(?:ok|warn|err)|border-s-/.test(x.src)).map((x) => x.f)).toEqual([]);
	});

	it("use no literal colors (tokens only)", () => {
		expect(tsx.filter((x) => /#[0-9a-fA-F]{6}\b|\brgb\(|(?<!--)\bhsl\(/.test(x.src)).map((x) => x.f)).toEqual([]);
	});

	it("contain no emojis", () => {
		expect(tsx.filter((x) => /\p{Extended_Pictographic}/u.test(x.src)).map((x) => x.f)).toEqual([]);
	});

	it("write German ellipses directly after the word", () => {
		expect(tsx.filter((x) => /\w …|\w \.\.\."/.test(x.src)).map((x) => x.f)).toEqual([]);
	});
});

describe("index.html", () => {
	it("has no inline script or style (CSP script-src 'self')", () => {
		const html = readFileSync(path.join(SRC, "..", "index.html"), "utf8");
		expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
		expect(html).not.toMatch(/<style/);
	});
});

describe("network", () => {
	it("every request goes through lib/api.ts (session header, error texts)", () => {
		const offenders = tsxAndTs().filter((x) => !x.f.split(path.sep).join("/").endsWith("lib/api.ts") && /\bfetch\(/.test(x.src)).map((x) => x.f);
		expect(offenders).toEqual([]);
	});
});

function tsxAndTs() {
	return files(SRC, /\.(tsx|ts)$/).map((f) => ({ f: path.relative(SRC, f), src: readFileSync(f, "utf8") }));
}
