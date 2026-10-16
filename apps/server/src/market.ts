// Marktdaten hinter einer Schnittstelle: Yahoo Finance (frei, ohne Schlüssel, inoffiziell – kann sich ändern),
// eine deterministische Fake-Börse für Tests und Fixture, "off" ohne Netz. Wechselkurse sind Symbole wie USDEUR=X.
import type { Candle, ChartRange, NewsItem, SearchHit } from "@desk/shared";
import { httpJson } from "./http.ts";

export interface Session {
	preStart: number | null;
	regStart: number;
	regEnd: number;
	postEnd: number | null;
}

export interface QuoteData {
	symbol: string;
	name: string;
	currency: string;
	exchange: string;
	type: string;
	price: number;
	prevClose: number | null;
	marketTime: number | null;
	dayOpen: number | null;
	dayHigh: number | null;
	dayLow: number | null;
	volume: number | null;
	timezone: string;
	session: Session | null; // Handelszeiten des aktuellen bzw. letzten Handelstags
}

export interface Market {
	readonly kind: "yahoo" | "fake" | "off";
	/**
	 * Kurse; Symbole ohne Antwort fehlen im Ergebnis und stehen in failed, ein Fehler je Symbol bricht nicht alles ab.
	 * error nur, wenn gar nichts kam.
	 */
	quotes(symbols: string[]): Promise<{ quotes: QuoteData[]; error: string | null; failed?: { symbol: string; message: string }[] }>;
	chart(symbol: string, range: ChartRange): Promise<{ meta: QuoteData; candles: Candle[] }>;
	search(q: string): Promise<SearchHit[]>;
	news(symbol: string): Promise<NewsItem[]>;
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

interface YahooPeriod {
	start?: number;
	end?: number;
}

interface YahooChart {
	chart?: {
		result?: {
			meta: {
				currency?: string; symbol: string; longName?: string; shortName?: string; fullExchangeName?: string; exchangeName?: string; instrumentType?: string; regularMarketPrice?: number; chartPreviousClose?: number;
				previousClose?: number; regularMarketTime?: number; regularMarketDayHigh?: number; regularMarketDayLow?: number; regularMarketVolume?: number; exchangeTimezoneName?: string;
				currentTradingPeriod?: { pre?: YahooPeriod; regular?: YahooPeriod; post?: YahooPeriod };
			};
			timestamp?: number[];
			indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
		}[];
		error?: { description?: string } | null;
	};
}

const RANGE: Record<ChartRange, string> = {
	"1d": "range=1d&interval=1m",
	"5d": "range=5d&interval=5m",
	"1mo": "range=1mo&interval=60m",
	"3mo": "range=3mo&interval=1d",
	"6mo": "range=6mo&interval=1d",
	"1y": "range=1y&interval=1d",
	"5y": "range=5y&interval=1wk",
};
const SYMBOL = /^[A-Za-z0-9.=^-]{1,24}$/;
const ms = (s?: number) => (typeof s === "number" && s > 0 ? s * 1000 : null);

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
		const n = normalizeCurrency(m.currency ?? "EUR", m.regularMarketPrice!);
		const scale = n.price / m.regularMarketPrice!;
		const prev = m.chartPreviousClose ?? m.previousClose;
		const q = r.indicators?.quote?.[0] ?? {};
		const candles: Candle[] = [];
		(r.timestamp ?? []).forEach((ts, i) => {
			const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
			if ([o, h, l, c].every((v) => typeof v === "number")) candles.push({ t: ts * 1000, o: o! * scale, h: h! * scale, l: l! * scale, c: c! * scale, v: q.volume?.[i] ?? 0 });
		});
		const p = m.currentTradingPeriod;
		const regStart = ms(p?.regular?.start);
		const regEnd = ms(p?.regular?.end);
		const meta: QuoteData = {
			symbol, // das angefragte Symbol: Yahoo antwortet auf USDEUR=X mit EUR=X
			name: m.longName ?? m.shortName?.trim() ?? m.symbol,
			currency: n.currency,
			exchange: m.fullExchangeName ?? m.exchangeName ?? "",
			type: m.instrumentType ?? "",
			price: n.price,
			prevClose: typeof prev === "number" ? prev * scale : null,
			marketTime: ms(m.regularMarketTime),
			dayOpen: null,
			dayHigh: typeof m.regularMarketDayHigh === "number" ? m.regularMarketDayHigh * scale : null,
			dayLow: typeof m.regularMarketDayLow === "number" ? m.regularMarketDayLow * scale : null,
			volume: typeof m.regularMarketVolume === "number" ? m.regularMarketVolume : null,
			timezone: m.exchangeTimezoneName ?? "",
			session: regStart && regEnd ? { preStart: ms(p?.pre?.start), regStart, regEnd, postEnd: ms(p?.post?.end) } : null,
		};
		return { meta, candles };
	}

	async quotes(symbols: string[]) {
		let error: string | null = null;
		const failed: { symbol: string; message: string }[] = [];
		const got = await mapLimit(symbols, 4, async (s) => {
			try {
				const { meta, candles } = await this.fetchChart(s, "range=1d&interval=1h");
				// Tageseröffnung: erste Kerze des laufenden Handelstags
				const first = meta.session ? candles.find((c) => c.t >= meta.session!.regStart - 60_000) : candles[0];
				return { ...meta, dayOpen: first?.o ?? null };
			} catch (e) {
				error = `${s}: ${(e as Error).message}`;
				failed.push({ symbol: s, message: (e as Error).message });
				return null;
			}
		});
		const quotes = got.filter((q): q is QuoteData => q !== null);
		return { quotes, error: quotes.length || !symbols.length ? null : error, failed };
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

	async news(symbol: string): Promise<NewsItem[]> {
		if (!SYMBOL.test(symbol)) return [];
		const j = await httpJson<{ news?: { title?: string; publisher?: string; providerPublishTime?: number; link?: string }[] }>(`${this.base}/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=10&listsCount=0`);
		return (j.news ?? [])
			.filter((n) => n.title && n.link && /^https:\/\//.test(n.link))
			.map((n) => ({ title: n.title!.slice(0, 300), publisher: (n.publisher ?? "").slice(0, 80), time: (n.providerPublishTime ?? 0) * 1000, link: n.link! }));
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
	async news() {
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

/** Handelszeiten der Fake-Börsen in Berliner Zeit (Stunde, Minute). */
const FAKE_HOURS: Record<string, { tz: string; pre?: [number, number]; reg: [number, number]; end: [number, number]; post?: [number, number]; weekdays?: boolean }> = {
	XETRA: { tz: "Europe/Berlin", pre: [8, 0], reg: [9, 0], end: [17, 30], post: [22, 0], weekdays: true },
	NasdaqGS: { tz: "America/New_York", pre: [10, 0], reg: [15, 30], end: [22, 0], post: [23, 59], weekdays: true },
	CCC: { tz: "UTC", reg: [0, 0], end: [23, 59] },
	CCY: { tz: "Europe/London", reg: [0, 0], end: [23, 59] },
};

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
	readonly failSymbols = new Set<string>(); // nur diese Symbole antworten nicht (z. B. HTTP 429 für ein Symbol)
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

	private session(exchange: string): Session | null {
		const h = FAKE_HOURS[exchange];
		if (!h) return null;
		const d = new Date(this.now());
		// am Wochenende wie Yahoo: die Zeiten des letzten Handelstags (Freitag) – also geschlossen
		if (h.weekdays) while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
		const at = ([hh, mm]: [number, number]) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).getTime();
		return { preStart: h.pre ? at(h.pre) : null, regStart: at(h.reg), regEnd: at(h.end), postEnd: h.post ? at(h.post) : null };
	}

	private meta(i: FakeInstrument): QuoteData {
		const prevClose = Math.round(i.price * (1 - ((hash(i.symbol) % 41) - 20) / 1000) * 100) / 100;
		const open = Math.round(prevClose * (1 + ((hash(i.symbol + "o") % 21) - 10) / 1000) * 100) / 100;
		return {
			symbol: i.symbol, name: i.name, currency: i.currency, exchange: i.exchange, type: i.type, price: i.price, prevClose, marketTime: this.now() - 60_000,
			dayOpen: open, dayHigh: Math.max(open, i.price) * 1.008, dayLow: Math.min(open, i.price) * 0.992, volume: 200_000 + (hash(i.symbol) % 9) * 150_000,
			timezone: FAKE_HOURS[i.exchange]?.tz ?? "", session: this.session(i.exchange),
		};
	}

	async quotes(symbols: string[]) {
		this.calls++;
		if (this.failing) return { quotes: [], error: "Fake-Börse: nicht erreichbar", failed: symbols.map((symbol) => ({ symbol, message: "nicht erreichbar" })) };
		const failed = symbols.filter((s) => this.failSymbols.has(s)).map((symbol) => ({ symbol, message: "HTTP 429" }));
		const quotes = symbols.flatMap((s) => (this.items.has(s) && !this.failSymbols.has(s) ? [this.meta(this.items.get(s)!)] : []));
		return { quotes, error: quotes.length || !symbols.length ? null : "Fake-Börse: keine Kurse", failed };
	}

	async chart(symbol: string, range: ChartRange) {
		const i = this.items.get(symbol);
		if (!i) throw new Error(`keine Kurse für ${symbol}`);
		const [n, step, vol] = ({ "1d": [390, 60_000, 0.0015], "5d": [400, 5 * 60_000, 0.003], "1mo": [160, 3_600_000, 0.006], "3mo": [64, 86_400_000, 0.03], "6mo": [128, 86_400_000, 0.03], "1y": [252, 86_400_000, 0.03], "5y": [260, 7 * 86_400_000, 0.05] } as const)[range];
		let seed = hash(symbol + range);
		const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
		const closes = [i.price];
		for (let k = 1; k < n; k++) closes.unshift(closes[0] / (1 + (rnd() - 0.48) * vol));
		const end = Math.floor(this.now() / step) * step;
		const candles = closes.map((c, k) => {
			const o = k ? closes[k - 1] : c * (1 - vol / 4);
			const spread = Math.abs(c - o) + c * vol * 0.2 * rnd();
			return { t: end - (n - 1 - k) * step, o, h: Math.max(o, c) + spread * 0.5, l: Math.min(o, c) - spread * 0.5, c, v: Math.round((range === "1d" ? 2e3 : 1e5) * (1 + rnd() * 9)) };
		});
		return { meta: this.meta(i), candles };
	}

	async search(q: string) {
		const s = q.toLowerCase();
		return [...this.items.values()].filter((i) => i.type !== "CURRENCY" && (i.symbol.toLowerCase().includes(s) || i.name.toLowerCase().includes(s))).map((i) => ({ symbol: i.symbol, name: i.name, exchange: i.exchange, type: i.type }));
	}

	async news(symbol: string): Promise<NewsItem[]> {
		const i = this.items.get(symbol);
		if (!i) return [];
		return [
			{ title: `${i.name}: Quartalszahlen über den Erwartungen`, publisher: "Fake-Nachrichten", time: this.now() - 40 * 60_000, link: "https://example.com/a" },
			{ title: `Analyst hebt Kursziel für ${i.name} an`, publisher: "Fake-Nachrichten", time: this.now() - 5 * 3_600_000, link: "https://example.com/b" },
		];
	}
}
