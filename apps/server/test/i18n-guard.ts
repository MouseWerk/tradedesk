// Prüfwerkzeug für die Textkataloge (AICodeGuidelines design/writing.md, design/guard-tests.md): findet deutsche
// UI-Texte, die noch als Literal im Code stehen, liest die Texte eines Katalogs mit ihrem Schlüsselpfad und die
// Begriffe aus docs/GLOSSARY.md. Geparst wird mit dem Parser von rolldown (kommt mit Vite), nicht per Regex über den
// Quelltext: Kommentare, Klassennamen und Typen zählen so nie als Text.
//
// Heuristik für „UI-Text“ (leftovers):
// - JSX-Text mit mindestens zwei Buchstaben am Stück;
// - jeder String in einem Text-Attribut (TEXT_ATTRS, z. B. title, aria-label, placeholder) oder als Wert einer
//   Text-Eigenschaft (TEXT_KEYS, z. B. title, text, body, confirm in toast()/confirm()) mit zwei Buchstaben am Stück;
// - jeder andere String oder Template-Teil mit Umlaut/ß oder einem deutschen Funktionswort (GERMAN_WORDS);
// - jeder String in new DeskError(…) mit zwei Buchstaben am Stück.
// Nicht geprüft: Import-Pfade, Objektschlüssel, TS-Typen, className/data-*, Vergleiche (=== "…", case "…") – dort
// stehen Daten und Bezeichner, kein Text. Was bewusst Daten sind (Fixture, CSV-Spaltennamen), steht in der Allow-List
// des jeweiligen Tests, mit Grund.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseAst } from "rolldown/parseAst";

export const REPO = path.resolve(import.meta.dirname, "../../..");

/** .ts/.tsx unter dir, ohne Tests und ohne die übergebenen Ordner/Dateien (relativ zu dir, mit /). */
export function sourceFiles(dir: string, skip: string[] = []): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const f of readdirSync(d)) {
			const p = path.join(d, f);
			const rel = path.relative(dir, p).replaceAll("\\", "/");
			if (skip.some((s) => rel === s || rel.startsWith(s + "/"))) continue;
			if (statSync(p).isDirectory()) walk(p);
			else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts")) out.push(p);
		}
	};
	walk(dir);
	return out.sort();
}

type Node = { type: string; start: number; end: number; [k: string]: unknown };

const TEXT_ATTRS = new Set(["title", "aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "placeholder", "alt", "label", "hint", "description", "submit", "confirm", "sub", "empty", "text", "heading", "tooltip", "caption", "legend", "note", "error"]);
const TEXT_KEYS = new Set(["title", "text", "body", "confirm", "label", "hint", "description", "placeholder", "sub", "empty", "submit", "message", "msg", "detail", "heading", "tooltip", "caption", "note"]);
const SKIP_ATTRS = /^(className|class|data-[\w-]+|key|id|to|href|type|variant|size|role|name|htmlFor|autoComplete|inputMode|pattern|form|target|rel|lang|method|tone|side|align|kind|value|defaultValue|testid)$/;
// Kleinbuchstaben-Funktionswörter, die es im Englischen nicht (oder nicht in Bezeichnern) gibt
export const GERMAN_WORDS = ["der", "die", "das", "dem", "den", "des", "und", "oder", "nicht", "kein", "keine", "keinen", "keiner", "keines", "kann", "muss", "wird", "werden", "wurde", "ist", "sind", "hat", "haben", "mit", "für", "von", "bei", "nach", "zum", "zur", "über", "unter", "auch", "noch", "nur", "schon", "bitte", "du", "dich", "dir", "dein", "deine", "deinen", "deinem", "deiner", "ein", "eine", "einen", "einem", "einer", "aus", "wie", "als", "ohne", "sich", "bis", "sobald", "jetzt", "hier", "gibt", "erst", "mehr", "heute", "gestern", "seit", "vom", "beim", "ins", "im", "am", "zu", "es", "wenn", "dann", "weil", "dort", "hat", "alle", "neu", "neue", "offen", "offene", "gesendet", "abgelehnt", "ausgeführt", "storniert", "freigegeben", "fehlt", "fehlgeschlagen", "ungültig", "unbekannt", "unbekannte", "unbekanntes", "erlaubt", "gelöscht", "Stück", "Kurs", "Depot", "Depots", "Vorschlag", "Vorschläge", "Gebühr", "Kauf", "Verkauf", "Agent", "Agenten", "Einstand", "Ausführung", "Freigabe", "Grenze", "vor", "gerade", "eben", "Min", "Std", "Tag", "Tage", "Tagen", "Woche", "Monat", "Jahr", "Uhr", "laut", "Quelle", "Fehler", "neu", "laden", "Laden", "Speichern", "Abbrechen", "Schließen", "Suchen", "Kurse", "Echtzeit", "verzögert", "veraltet", "Stop", "Ziel", "Cash", "Limit", "Market", "Order", "Orders", "Trade", "Trades", "Watchlist", "Scanner", "Auswertung", "Risiko", "Not-Aus", "Hoch", "Tief", "Schluss", "Volumen", "Wert", "Summe", "Ergebnis", "Datum", "Zeit", "Notiz", "These", "Chat", "Agent", "Konto", "Broker", "Gewinn", "Verlust", "Bestand", "Positionen", "Position", "Alarm", "Alarme", "Markt", "Übersicht"];
const WORD_RE = new RegExp(`(^|[^\\p{L}])(${GERMAN_WORDS.join("|")})(?=$|[^\\p{L}])`, "u");
const UMLAUT = /[äöüÄÖÜß]/;
const LETTERS = /\p{L}{2,}/u;

// Satz: großes Wort, dann weitere Wörter, ohne Zeichen aus Code, Pfaden oder Klassennamen
const SENTENCE = /^[A-ZÄÖÜ][a-zäöüß]+(?: [\p{L}\d„“"',.–:%€()+−-]+)+[.!?…]?$/u;
const TECH = /[_{}=<>\\/@#;]|\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/;

export const looksGerman = (s: string) => UMLAUT.test(s) || WORD_RE.test(s) || (SENTENCE.test(s.trim()) && !TECH.test(s));

export interface Hit {
	file: string;
	line: number;
	text: string;
}

function lineOf(src: string, offset: number): number {
	let n = 1;
	for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
	return n;
}

const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && typeof (v as Node).type === "string";

/** Kinder eines Knotens (Arrays flach), ohne Positionsfelder. */
function children(n: Node): [string, Node][] {
	const out: [string, Node][] = [];
	for (const [k, v] of Object.entries(n)) {
		if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
		if (Array.isArray(v)) for (const c of v) isNode(c) && out.push([k, c]);
		else if (isNode(v)) out.push([k, v]);
	}
	return out;
}

const attrName = (a: Node) => {
	const n = a.name as Node;
	return n.type === "JSXNamespacedName" ? `${(n.namespace as Node).name}:${(n.name as Node).name}` : String(n.name);
};
const keyName = (p: Node) => {
	const k = p.key as Node;
	return k.type === "Identifier" ? String(k.name) : k.type === "Literal" ? String(k.value) : "";
};
const calleeName = (c: Node): string => {
	const e = c.callee as Node;
	if (e.type === "Identifier") return String(e.name);
	if (e.type === "MemberExpression") return `${calleeObj(e.object as Node)}.${(e.property as Node).name}`;
	return "";
};
const calleeObj = (o: Node): string => (o.type === "Identifier" ? String(o.name) : o.type === "ThisExpression" ? "this" : "?");

/** Deutsche UI-Texte, die als Literal im Code stehen (Heuristik oben). */
export function leftovers(files: string[], allow: (file: string, text: string) => boolean = () => false): Hit[] {
	const hits: Hit[] = [];
	for (const file of files) {
		const src = readFileSync(file, "utf8");
		const rel = path.relative(REPO, file).replaceAll("\\", "/");
		const ast = parseAst(src, { lang: file.endsWith(".tsx") ? "tsx" : "ts" }) as unknown as Node;
		const report = (n: Node, text: string) => {
			const t = text.replace(/\s+/g, " ").trim();
			if (t && !allow(rel, t)) hits.push({ file: rel, line: lineOf(src, n.start), text: t.slice(0, 140) });
		};
		// mode: "text" = jeder Buchstabentext ist UI-Text, "plain" = nur wenn er deutsch aussieht, "skip" = Daten
		const visit = (n: Node, mode: "text" | "plain" | "skip") => {
			switch (n.type) {
				case "ImportDeclaration":
				case "ExportAllDeclaration":
				case "TSTypeAnnotation":
				case "TSTypeAliasDeclaration":
				case "TSInterfaceDeclaration":
				case "TSLiteralType":
				case "TSTypeParameterInstantiation":
				case "TSEnumDeclaration":
					return;
				case "ExportNamedDeclaration":
					if (n.source) return;
					break;
				case "JSXText":
					if (LETTERS.test(String(n.value))) report(n, String(n.value));
					return;
				case "Literal": {
					if (typeof n.value !== "string" || n.regex) return;
					const v = n.value;
					if (mode === "skip") return;
					if (mode === "text" ? LETTERS.test(v) : looksGerman(v)) report(n, v);
					return;
				}
				case "TemplateLiteral": {
					if (mode === "skip") break;
					const quasis = (n.quasis as Node[]).map((q) => String((q.value as { cooked: string | null }).cooked ?? ""));
					const whole = quasis.join("${…}");
					if (mode === "text" ? quasis.some((q) => LETTERS.test(q)) : quasis.some(looksGerman)) report(n, whole);
					for (const e of n.expressions as Node[]) visit(e, mode === "text" ? "text" : "plain");
					return;
				}
				case "TaggedTemplateExpression":
					return;
				case "JSXAttribute": {
					const name = attrName(n);
					if (!n.value) return;
					if (SKIP_ATTRS.test(name)) return;
					visit(n.value as Node, TEXT_ATTRS.has(name) ? "text" : "plain");
					return;
				}
				case "Property": {
					if (n.computed) visit(n.key as Node, "skip");
					const k = keyName(n);
					// ein einzelnes kleines Wort unter einem Text-Schlüssel ist ein Wert wie eine Badge-Variante (confirm: "warn")
					const token = (n.value as Node).type === "Literal" && /^[a-z]+$/.test(String((n.value as Node).value));
					visit(n.value as Node, TEXT_KEYS.has(k) && !token ? "text" : mode === "text" ? "plain" : mode);
					return;
				}
				case "BinaryExpression":
					if (["===", "!==", "==", "!=", "in"].includes(String(n.operator))) {
						for (const side of [n.left, n.right] as Node[]) if (side.type !== "Literal") visit(side, mode);
						return;
					}
					break;
				case "SwitchCase":
					for (const c of n.consequent as Node[]) visit(c, mode);
					return;
				case "MemberExpression":
					visit(n.object as Node, mode);
					if (n.computed) visit(n.property as Node, "skip");
					return;
				case "CallExpression": {
					const name = calleeName(n);
					if (/^(console\.\w+|require|import|Symbol|RegExp|\w+\.(get|has|delete|getItem|setItem|removeItem|querySelector|querySelectorAll|getElementById|addEventListener|removeEventListener|run|all|exec|prepare|startsWith|endsWith|includes|split|replace|replaceAll|join|padStart|padEnd|toLocaleString|toLocaleDateString|toLocaleTimeString|header|on|emit|set|append))$/.test(name)) {
						// Datenbank, DOM, Strings: Argumente sind Schlüssel und SQL; console nur, wenn deutsch
						visit(n.callee as Node, mode);
						for (const a of n.arguments as Node[]) visit(a, name.startsWith("console.") ? "plain" : "skip");
						return;
					}
					break;
				}
				case "NewExpression": {
					const c = n.callee as Node;
					if (c.type === "Identifier" && c.name === "DeskError") {
						const [msg, ...rest] = n.arguments as Node[];
						if (msg) visit(msg, "text");
						for (const a of rest) visit(a, mode);
						return;
					}
					if (c.type === "Identifier" && (c.name === "RegExp" || c.name === "Intl" || c.name === "URL" || c.name === "URLSearchParams")) return;
					break;
				}
				case "JSXElement":
				case "JSXFragment":
					if (n.type === "JSXElement") visit(n.openingElement as Node, mode);
					// {bedingung ? "Text" : "anderer Text"} als Kind ist sichtbarer Text
					for (const c of n.children as Node[]) visit(c, c.type === "JSXExpressionContainer" ? "text" : mode);
					return;
				case "ConditionalExpression":
					visit(n.test as Node, "skip");
					visit(n.consequent as Node, mode);
					visit(n.alternate as Node, mode);
					return;
			}
			for (const [, c] of children(n)) visit(c, mode === "text" && !["ConditionalExpression", "LogicalExpression", "JSXExpressionContainer", "TemplateLiteral", "ArrayExpression", "ObjectExpression", "Property"].includes(n.type) ? "plain" : mode);
		};
		visit(ast, "plain");
	}
	return hits;
}

/** Ein Text aus einem Katalog: Schlüsselpfad (z. B. de.proposal.approve) und Wortlaut; ${…} steht für einen Wert. */
export interface CatalogText {
	path: string;
	text: string;
	line: number;
}

/** Alle Texte (Strings und Template-Teile) eines Katalogs mit ihrem Schlüsselpfad, ab der Konstante root. */
export function catalogTexts(file: string, root: string): CatalogText[] {
	const src = readFileSync(file, "utf8");
	const ast = parseAst(src, { lang: "ts" }) as unknown as Node;
	const out: CatalogText[] = [];
	const visit = (n: Node, p: string | null) => {
		if (n.type === "VariableDeclarator" && (n.id as Node).name === root) return visit(n.init as Node, root);
		if (p === null) {
			for (const [, c] of children(n)) visit(c, null);
			return;
		}
		if (n.type === "Property") {
			const k = keyName(n);
			return visit(n.value as Node, `${p}.${k}`);
		}
		if (n.type === "Literal" && typeof n.value === "string") return void out.push({ path: p, text: n.value, line: lineOf(src, n.start) });
		if (n.type === "TemplateLiteral") {
			const quasis = (n.quasis as Node[]).map((q) => String((q.value as { cooked: string | null }).cooked ?? ""));
			out.push({ path: p, text: quasis.join("${…}"), line: lineOf(src, n.start) });
			for (const e of n.expressions as Node[]) visit(e, p);
			return;
		}
		if (n.type === "BinaryExpression" && ["===", "!==", "==", "!=", "<", ">", "<=", ">="].includes(String(n.operator))) return;
		for (const [, c] of children(n)) visit(c, p);
	};
	visit(ast, null);
	return out.filter((t) => t.text !== "");
}

/** Blätter eines Katalogobjekts (Strings und Funktionen) als Pfade, z. B. de.proposal.approve. */
export function leafPaths(obj: unknown, prefix: string): string[] {
	if (typeof obj === "string" || typeof obj === "function") return [prefix];
	if (obj && typeof obj === "object") return Object.entries(obj).flatMap(([k, v]) => leafPaths(v, `${prefix}.${k}`));
	return [];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Schlüssel, die im Code nirgends vorkommen. Benutzt ist ein Blatt, wenn sein Pfad dasteht (de.a.b) oder ein
 * übergeordneter Pfad als Ganzes (de.a[status], de.a als Wert, ...de.a) – so zählen Tabellen wie Status-Namen.
 */
export function deadKeys(paths: string[], sources: string[]): string[] {
	const code = sources.join("\n");
	const used = new Map<string, boolean>();
	const isUsed = (p: string, whole: boolean) => {
		const key = `${p}|${whole}`;
		if (!used.has(key)) used.set(key, new RegExp(`(?<![\\w$])(?<!(?:^|[^.])\\.)${esc(p)}(?![\\w$${whole ? "." : ""}])`).test(code));
		return used.get(key)!;
	};
	return paths.filter((p) => {
		if (isUsed(p, false)) return false;
		const parts = p.split(".");
		for (let i = parts.length - 1; i >= 2; i--) if (isUsed(parts.slice(0, i).join("."), true)) return false;
		return true;
	});
}

/** Prüfungen für den Wortlaut eines Katalogtextes (design/writing.md); gibt die Verstöße als kurze Namen zurück. */
export function hygiene(text: string): string[] {
	const out: string[] = [];
	if (/\p{Extended_Pictographic}/u.test(text)) out.push("emoji");
	if (/\s…/.test(text)) out.push("space before …");
	if (/\.\.\./.test(text)) out.push("... instead of …");
	if (/"/.test(text)) out.push('ASCII " instead of „…“');
	if (/“[^„]*“|„[^“]*„|„[^“]*$/.test(text)) out.push("unbalanced „…“");
	if (/(^|[\s(/=])-\d/.test(text)) out.push("hyphen as minus");
	if (/(?<![\d.,])\d+\.\d{1,2}(?![\d.])/.test(text)) out.push("decimal point instead of comma");
	if (/(?<![\d.-])\d{1,2}-\d{1,2}(?![\d.-])/.test(text)) out.push("hyphen in a range (–)");
	if (/\p{L}\((n|s|e|en|er|es)\)/u.test(text)) out.push("plural shortcut like Trade(s)");
	if (/(^|[^\p{L}])(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?=$|[^\p{L}])/u.test(text)) out.push("„Sie“ instead of „du“");
	return out;
}

export interface GlossaryEntry {
	terms: string[]; // erlaubte Schreibweisen (Spalte 1, in `…`)
	forbidden: string[]; // nicht verwenden (Spalte 3, in `…`)
}

/** Tabelle in docs/GLOSSARY.md: | `Begriff` | Bedeutung | `Variante`, `Variante` | */
export function glossary(file = path.join(REPO, "docs/GLOSSARY.md")): GlossaryEntry[] {
	const ticks = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => /^\|\s*`/.test(l))
		.map((l) => l.split("|").slice(1, -1))
		.filter((c) => c.length >= 3)
		.map((c) => ({ terms: ticks(c[0]), forbidden: ticks(c[2]) }));
}

/** Verbotene Varianten im Text; erlaubte Begriffe (auch Zusammensetzungen wie „Order-Rechner“) zählen nicht. */
export function glossaryViolations(text: string, entries: GlossaryEntry[]): string[] {
	const terms = entries.flatMap((e) => e.terms);
	const found = entries.flatMap((e) =>
		e.forbidden.filter((f) => {
			// erlaubte Begriffe, die die Variante enthalten („Order-Rechner“ für „Rechner“), zählen nicht
			let t = text;
			for (const term of terms) if (term.toLowerCase() !== f.toLowerCase() && term.toLowerCase().includes(f.toLowerCase())) t = t.replace(new RegExp(`(?<![\\p{L}-])${esc(term)}(?![\\p{L}-])`, "gu"), " ");
			return new RegExp(`(?<![\\p{L}-])${esc(f)}(?![\\p{L}])`, "iu").test(t);
		}),
	);
	return [...new Set(found)];
}

export const readSources = (files: string[]) => files.map((f) => readFileSync(f, "utf8"));
