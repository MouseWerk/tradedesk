// CSV-Import von Trades in ein manuelles Depot (z. B. aus deinen Trade-Republic-Abrechnungen abgetippt oder
// aus einer eigenen Tabelle). Kopfzeile Pflicht, Spalten in beliebiger Reihenfolge, deutsch oder englisch:
//   datum;symbol;seite;stueck;kurs;gebuehr;waehrung;notiz
//   2026-03-02;SAP.DE;kauf;3;181,40;1,00;EUR;Sparplan
// Trennzeichen ; , oder Tab; bei ; gilt das Dezimalkomma. Datum YYYY-MM-DD oder TT.MM.JJJJ, optional mit HH:MM.
import { MAX_PRICE, MAX_QTY, type Side } from "./schema.ts";
import { QTY_DECIMALS, cents, decimals } from "./portfolio.ts";

export interface CsvTrade {
	line: number;
	time: number;
	symbol: string;
	side: Side;
	qty: number;
	price: number;
	feeCents: number;
	currency: string;
	note: string;
	key: string; // Wiedererkennung beim zweiten Import derselben Datei
}

const COLS: Record<string, string[]> = {
	date: ["datum", "date", "zeit", "time"],
	symbol: ["symbol", "ticker", "wertpapier"],
	side: ["seite", "side", "typ", "type", "art"],
	qty: ["stueck", "stück", "anzahl", "qty", "quantity", "shares"],
	price: ["kurs", "preis", "price"],
	fee: ["gebuehr", "gebühr", "fee", "fees", "kosten"],
	currency: ["waehrung", "währung", "currency"],
	note: ["notiz", "note", "kommentar"],
};

function splitLine(line: string, sep: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (quoted && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else quoted = !quoted;
		} else if (ch === sep && !quoted) {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out.map((s) => s.trim());
}

export function parseNumber(raw: string, decimalComma: boolean): number {
	let s = raw.replace(/\s|€|\$/g, "");
	if (!s) return Number.NaN;
	if (decimalComma) s = s.replace(/\./g, "").replace(",", ".");
	else s = s.replace(/,/g, "");
	return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}

export function parseDate(raw: string): number {
	const s = raw.trim();
	let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
	if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 12), +(m[5] ?? 0)).getTime();
	m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
	if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 12), +(m[5] ?? 0)).getTime();
	return Number.NaN;
}

function sideOf(raw: string): Side | null {
	const s = raw.trim().toLowerCase();
	if (["kauf", "buy", "k", "b", "sparplan", "savings plan"].includes(s)) return "buy";
	if (["verkauf", "sell", "v", "s"].includes(s)) return "sell";
	return null;
}

export function parseTradesCsv(text: string): { rows: CsvTrade[]; errors: string[] } {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	const head = lines.findIndex((l) => l.trim());
	if (head < 0) return { rows: [], errors: ["Datei ist leer."] };
	const first = lines[head];
	const sep = first.includes(";") ? ";" : first.includes("\t") ? "\t" : ",";
	const decimalComma = sep === ";";
	const header = splitLine(first, sep).map((h) => h.toLowerCase());
	const idx: Record<string, number> = {};
	for (const [k, names] of Object.entries(COLS)) idx[k] = header.findIndex((h) => names.includes(h));
	const missing = ["date", "symbol", "side", "qty", "price"].filter((k) => idx[k] < 0);
	if (missing.length) return { rows: [], errors: [`Kopfzeile ohne Spalte ${missing.map((k) => COLS[k][0]).join(", ")} – erwartet z. B. „datum;symbol;seite;stueck;kurs;gebuehr;waehrung“.`] };
	const rows: CsvTrade[] = [];
	const errors: string[] = [];
	for (let n = head + 1; n < lines.length; n++) {
		const line = lines[n];
		if (!line.trim()) continue;
		const f = splitLine(line, sep);
		const get = (k: string) => (idx[k] >= 0 ? (f[idx[k]] ?? "") : "");
		const time = parseDate(get("date"));
		const symbol = get("symbol").toUpperCase();
		const side = sideOf(get("side"));
		const qty = parseNumber(get("qty"), decimalComma);
		const price = parseNumber(get("price"), decimalComma);
		const fee = get("fee") ? parseNumber(get("fee"), decimalComma) : 0;
		const currency = (get("currency") || "EUR").toUpperCase();
		const problems = [
			Number.isNaN(time) && "Datum",
			!/^[A-Z0-9.=^-]{1,24}$/.test(symbol) && "Symbol",
			!side && "Seite (kauf/verkauf)",
			!(qty > 0 && qty <= MAX_QTY && decimals(qty) <= QTY_DECIMALS) && "Stück",
			!(price > 0 && price <= MAX_PRICE) && "Kurs",
			!(fee >= 0 && fee <= 10_000 && decimals(fee) <= 2) && "Gebühr",
			!/^[A-Z]{3}$/.test(currency) && "Währung",
		].filter(Boolean);
		if (problems.length) {
			errors.push(`Zeile ${n + 1}: ${problems.join(", ")} ungültig.`);
			continue;
		}
		rows.push({ line: n + 1, time, symbol, side: side!, qty, price, feeCents: cents(fee), currency, note: get("note").slice(0, 200), key: `${time}|${symbol}|${side}|${qty}|${price}|${cents(fee)}` });
	}
	return { rows, errors };
}
