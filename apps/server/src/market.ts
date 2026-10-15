// Marktdaten hinter einer Schnittstelle: Yahoo Finance (frei, ohne Schlüssel, inoffiziell – kann sich ändern),
// eine deterministische Fake-Börse für Tests und Fixture, "off" ohne Netz. Wechselkurse sind Symbole wie USDEUR=X.
import type { Candle, ChartRange, SearchHit } from "@desk/shared";
import { httpJson } from "./http.ts";

export interface QuoteData {
	symbol: string;
	name: string;
	currency: string;
	exchange: string;
	type: string;
	price: number;
	prevClose: number | null;
	marketTime: number | null;
}

export interface Market {
	readonly kind: "yahoo" | "fake" | "off";
	/** Kurse; Symbole ohne Antwort fehlen im Ergebnis, ein Fehler je Symbol bricht nicht alles ab. */
	quotes(symbols: string[]): Promise<{ quotes: QuoteData[]; error: string | null }>;
	chart(symbol: string, range: ChartRange): Promise<{ meta: QuoteData; candles: Candle[] }>;
	search(q: string): Promise<SearchHit[]>;
}

export const fxSymbol = (currency: string) => `${currency}EUR=X`;

/** Pence/Cent-Notierungen (GBp, ZAc, ILA) auf die Hauptwährung umrechnen. */
export function normalizeCurrency(currency: string, price: number): { currency: string; price: number } {
	if (currency === "GBp" || currency === "GBX") return { currency: "GBP", price: price / 100 };
	if (currency === "ZAc") return { currency: "ZAR", price: price / 100 };
	if (currency === "ILA") return { currency: "ILS", price: price / 100 };
	return { currency: currency.toUpperCase(), price };
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	return out;
}

interface YahooChart {
	chart?: {
		result?: {
			meta: { currency?: string; symbol: string; longName?: string; shortName?: string; fullExchangeName?: string; exchangeName?: string; instrumentType?: string; regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number; regularMarketTime?: number };
			timestamp?: number[];
			indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
		}[];
		error?: { description?: string } | null;
	};
}

const RANGE: Record<ChartRange, string> = { "1d": "range=1d&interval=5m", "1mo": "range=1mo&interval=1d", "3mo": "range=3mo&interval=1d", "6mo": "range=6mo&interval=1d", "1y": "range=1y&interval=1d", "5y": "range=5y&interval=1wk" };
const SYMBOL = /^[A-Za-z0-9.=^-]{1,24}$/;

export class YahooMarket implements Market {
	readonly kind = "yahoo" as const;
	private readonly base: string;
	constructor(base = "https://query1.finance.yahoo.com") {
		this.base = base;
	}

	private async fetchChart(symbol: string, query: string) {
		if (!SYMBOL.test(symbol)) throw new Error(`ungültiges Symbol ${symbol}`);
		const j = await httpJson<YahooChart>(`${this.base}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`);
		const r = j.chart?.result?.[0];
		if (!r || typeof r.meta?.regularMarketPrice !== "number") throw new Error(j.chart?.error?.description ?? `keine Kurse für ${symbol}`);
		const m = r.meta;
		const raw = m.currency ?? "EUR";
		const n = normalizeCurrency(raw, m.regularMarketPrice!);
		const scale = n.price / m.regularMarketPrice!;
		const prev = m.chartPreviousClose ?? m.previousClose;
		const meta: QuoteData = {
			symbol, // das angefragte Symbol: Yahoo antwortet auf USDEUR=X mit EUR=X

			name: m.longName ?? m.shortName ?? m.symbol,
			currency: n.currency,
			exchange: m.fullExchangeName ?? m.exchangeName ?? "",
			type: m.instrumentType ?? "",
			price: n.price,
			prevClose: typeof prev === "number" ? prev * scale : null,
			marketTime: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
		};
		const q = r.indicators?.quote?.[0] ?? {};
		const candles: Candle[] = [];
		(r.timestamp ?? []).forEach((ts, i) => {
			const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
			if ([o, h, l, c].every((v) => typeof v === "number")) candles.push({ t: ts * 1000, o: o! * scale, h: h! * scale, l: l! * scale, c: c! * scale, v: q.volume?.[i] ?? 0 });
		});
		return { meta, candles };
	}

	async quotes(symbols: string[]) {
		let error: string | null = null;
		const got = await mapLimit(symbols, 4, async (s) => {
			try {
				return (await this.fetchChart(s, "range=1d&interval=1h")).meta;
			} catch (e) {
				error = `${s}: ${(e as Error).message}`;
				return null;
			}
		});
		const quotes = got.filter((q): q is QuoteData => q !== null);
		return { quotes, error: quotes.length || !symbols.length ? null : error };
	}

	chart(symbol: string, range: ChartRange) {
		return this.fetchChart(symbol, RANGE[range]);
	}

	async search(q: string): Promise<SearchHit[]> {
		const j = await httpJson<{ quotes?: { symbol?: string; longname?: string; shortname?: string; exchDisp?: string; exchange?: string; quoteType?: string }[] }>(
			`${this.base}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`,
		);
		return (j.quotes ?? [])
			.filter((x) => x.symbol && SYMBOL.test(x.symbol) && ["EQUITY", "ETF", "MUTUALFUND", "INDEX", "CRYPTOCURRENCY", "CURRENCY", "FUTURE"].includes(x.quoteType ?? ""))
			.map((x) => ({ symbol: x.symbol!, name: (x.longname ?? x.shortname ?? x.symbol!).trim(), exchange: x.exchDisp ?? x.exchange ?? "", type: x.quoteType ?? "" }));
	}
}

export class OffMarket implements Market {
	readonly kind = "off" as const;
	async quotes() {
		return { quotes: [], error: null };
	}
	async chart(symbol: string): Promise<{ meta: QuoteData; candles: Candle[] }> {
		throw new Error(`Marktdaten sind ausgeschaltet ("market": "off") – kein Chart für ${symbol}`);
	}
	async search() {
		return [];
	}
}

/* ------------------------------------------------------------------ Fake */

interface FakeInstrument {
	symbol: string;
	name: string;
	currency: string;
	exchange: string;
	type: string;
	price: number;
}

export const FAKE_CATALOG: FakeInstrument[] = [
	{ symbol: "SAP.DE", name: "SAP SE", currency: "EUR", exchange: "XETRA", type: "EQUITY", price: 201.25 },
	{ symbol: "ALV.DE", name: "Allianz SE", currency: "EUR", exchange: "XETRA", type: "EQUITY", price: 352.1 },
	{ symbol: "AAPL", name: "Apple Inc.", currency: "USD", exchange: "NasdaqGS", type: "EQUITY", price: 231.4 },
	{ symbol: "MSFT", name: "Microsoft Corporation", currency: "USD", exchange: "NasdaqGS", type: "EQUITY", price: 418.9 },
	{ symbol: "NVDA", name: "NVIDIA Corporation", currency: "USD", exchange: "NasdaqGS", type: "EQUITY", price: 132.7 },
	{ symbol: "EUNL.DE", name: "iShares Core MSCI World UCITS ETF", currency: "EUR", exchange: "XETRA", type: "ETF", price: 104.32 },
	{ symbol: "BTC-EUR", name: "Bitcoin EUR", currency: "EUR", exchange: "CCC", type: "CRYPTOCURRENCY", price: 61250 },
	{ symbol: "USDEUR=X", name: "USD/EUR", currency: "EUR", exchange: "CCY", type: "CURRENCY", price: 0.92 },
];

function hash(s: string): number {
	let h = 2166136261;
	for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
	return h >>> 0;
}

/** Deterministische Börse: feste Kurse, setzbar in Tests; Charts als Zufallspfad mit festem Samen, der beim aktuellen Kurs endet. */
export class FakeMarket implements Market {
	readonly kind = "fake" as const;
	readonly items = new Map(FAKE_CATALOG.map((i) => [i.symbol, { ...i }]));
	failing = false;
	calls = 0;
	private readonly now: () => number;
	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	set(symbol: string, price: number) {
		const i = this.items.get(symbol);
		if (!i) throw new Error(`unbekannt: ${symbol}`);
		i.price = price;
	}

	private meta(i: FakeInstrument): QuoteData {
		return { symbol: i.symbol, name: i.name, currency: i.currency, exchange: i.exchange, type: i.type, price: i.price, prevClose: Math.round(i.price * (1 - ((hash(i.symbol) % 41) - 20) / 1000) * 100) / 100, marketTime: this.now() - 60_000 };
	}

	async quotes(symbols: string[]) {
		this.calls++;
		if (this.failing) return { quotes: [], error: "Fake-Börse: nicht erreichbar" };
		return { quotes: symbols.flatMap((s) => (this.items.has(s) ? [this.meta(this.items.get(s)!)] : [])), error: null };
	}

	async chart(symbol: string, range: ChartRange) {
		const i = this.items.get(symbol);
		if (!i) throw new Error(`keine Kurse für ${symbol}`);
		const [n, step] = ({ "1d": [96, 5 * 60_000], "1mo": [22, 86_400_000], "3mo": [64, 86_400_000], "6mo": [128, 86_400_000], "1y": [252, 86_400_000], "5y": [260, 7 * 86_400_000] } as const)[range];
		let seed = hash(symbol + range);
		const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
		const closes = [i.price];
		for (let k = 1; k < n; k++) closes.unshift(closes[0] / (1 + (rnd() - 0.48) * 0.03));
		const end = Math.floor(this.now() / step) * step;
		const candles = closes.map((c, k) => {
			const o = k ? closes[k - 1] : c * (1 - 0.004);
			const spread = Math.abs(c - o) + c * 0.006 * rnd();
			return { t: end - (n - 1 - k) * step, o, h: Math.max(o, c) + spread * 0.5, l: Math.min(o, c) - spread * 0.5, c, v: Math.round(1e5 + rnd() * 1e6) };
		});
		return { meta: this.meta(i), candles };
	}

	async search(q: string) {
		const s = q.toLowerCase();
		return [...this.items.values()].filter((i) => i.type !== "CURRENCY" && (i.symbol.toLowerCase().includes(s) || i.name.toLowerCase().includes(s))).map((i) => ({ symbol: i.symbol, name: i.name, exchange: i.exchange, type: i.type }));
	}
}
