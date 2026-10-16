// Kursquelle hinter einer Schnittstelle, damit ein bezahlter Echtzeit-Feed Yahoo später ersetzen kann (owner decision:
// Yahoo, bis du anders entscheidest). Der Takt des Desks ruft snapshot() – heute die einzige Quelle für Kurse; eine
// Push-Quelle meldet zusätzlich neue Kurse über onQuotes(), sobald sie sie hat. Jede Quelle sagt je Kurs, woher er
// kommt (source) und ob er verzögert ist (delayed, null = unbekannt).
import { HttpError, localJson } from "./http.ts";
import type { Broker } from "./broker.ts";
import type { Market, QuoteData, QuoteSource } from "./market.ts";

export interface QuoteResult {
	quotes: QuoteData[];
	error: string | null;
	failed?: { symbol: string; message: string }[];
}

export interface QuoteFeed {
	readonly source: QuoteSource | "off";
	/** Diese Symbole laufend liefern (ersetzt die vorige Liste). Eine Pull-Quelle merkt sie sich nur. */
	subscribe(symbols: string[]): void;
	/** Neue Kurse, sobald die Quelle sie hat; Rückgabe meldet ab. Eine Pull-Quelle ruft fn nie. */
	onQuotes(fn: (quotes: QuoteData[]) => void): () => void;
	/** Momentaufnahme jetzt; der Takt ruft sie immer – auch als Rückfall, wenn eine Push-Quelle schweigt. */
	snapshot(symbols: string[]): Promise<QuoteResult>;
}

/** Abruf über die Market-Schnittstelle (Yahoo, Fake, aus) – genau das bisherige Verhalten, nur mit Quelle je Kurs. */
export class MarketFeed implements QuoteFeed {
	readonly source: QuoteSource | "off";
	private readonly market: Market;
	constructor(market: Market) {
		this.market = market;
		this.source = market.kind;
	}
	subscribe() {}
	onQuotes() {
		return () => {};
	}
	async snapshot(symbols: string[]): Promise<QuoteResult> {
		const r = await this.market.quotes(symbols);
		const source = this.market.kind === "off" ? undefined : this.market.kind;
		return { ...r, quotes: r.quotes.map((q) => ({ ...q, source: q.source ?? source })) };
	}
}

/* ------------------------------------------------------------------ IBKR */

/**
 * Felder von GET /iserver/marketdata/snapshot (IBKR Web API, „Live Market Data Snapshot“): 31 Last Price (Präfix C =
 * Schlusskurs des Vortags, H = Handel ausgesetzt), 84 Bid, 86 Ask, 6509 Market Data Availability (erstes Zeichen
 * R = Echtzeit, D = verzögert, Z = eingefroren, Y = eingefroren und verzögert, N = kein Abo).
 */
export const IBKR_FIELDS = ["31", "84", "86", "6509"] as const;
const MAX_SOURCE_GAP_PCT = 20; // weiter weg vom Kurs der Rückfallquelle: anderer Kontrakt oder andere Einheit – nicht übernehmen
const NO_CONID_RETRY_MS = 3_600_000; // ein Symbol ohne Kontrakt wird so lange nicht neu gesucht

type IbkrSnapshotItem = { conid?: number; _updated?: number; "31"?: string; "84"?: string; "86"?: string; "6509"?: string } & Record<string, unknown>;

const num = (v: unknown): number | null => {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "")) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : null;
};

/** Letzter Kurs aus Feld 31; der Schlusskurs des Vortags (Präfix C) ist kein aktueller Kurs. */
export function ibkrLast(v: unknown): number | null {
	if (typeof v !== "string") return num(v);
	if (v.startsWith("C")) return null;
	return num(v.startsWith("H") ? v.slice(1) : v);
}

/** Feld 6509 → verzögert? R/Z nein, D/Y ja, sonst (N, leer) gibt es keine Daten. */
export function ibkrDelayed(v: unknown): boolean | null | undefined {
	const c = typeof v === "string" ? v[0] : "";
	if (c === "R" || c === "Z") return false;
	if (c === "D" || c === "Y") return true;
	return undefined; // keine verwertbaren Daten
}

/**
 * Momentaufnahme von IBKR über das lokale Client Portal Gateway (nur localhost, über localJson), sonst die
 * Rückfallquelle. Gerüst: Name, Währung, Börse, Handelszeiten und Tageswerte kommen weiter aus der Rückfallquelle (Yahoo);
 * IBKR ersetzt Kurs, Bid, Ask, Zeit und sagt, ob verzögert. Ohne Anmeldung im Gateway, ohne Kontrakt, ohne Daten (die
 * erste Anfrage je Kontrakt ist bei IBKR nur ein „Pre-Flight“) oder bei Fehlern bleibt der Kurs der Rückfallquelle.
 * Aus in der Grundeinstellung (config.json "quotes": "yahoo").
 */
export class IbkrQuoteFeed implements QuoteFeed {
	readonly source = "ibkr" as const;
	/** Letzter Fehler beim Abruf (für die Anzeige); null, solange es geht. */
	lastError: string | null = null;
	private readonly base: string;
	private readonly broker: Pick<Broker, "resolve">;
	private readonly fallback: QuoteFeed;
	private readonly timeoutMs: number;
	private readonly now: () => number;
	private readonly conids = new Map<string, { conid: number | null; at: number }>();
	private ready = false; // /iserver/accounts muss vor dem ersten Snapshot gerufen sein

	constructor(opts: { gateway: string; broker: Pick<Broker, "resolve">; fallback: QuoteFeed; timeoutMs?: number; now?: () => number }) {
		this.base = `${opts.gateway.replace(/\/+$/, "")}/v1/api`;
		this.broker = opts.broker;
		this.fallback = opts.fallback;
		this.timeoutMs = opts.timeoutMs ?? 5_000;
		this.now = opts.now ?? Date.now;
	}

	subscribe(symbols: string[]) {
		this.fallback.subscribe(symbols);
	}

	onQuotes(fn: (quotes: QuoteData[]) => void) {
		return this.fallback.onQuotes(fn);
	}

	private async conidOf(symbol: string): Promise<number | null> {
		const hit = this.conids.get(symbol);
		if (hit && (hit.conid !== null || this.now() - hit.at < NO_CONID_RETRY_MS)) return hit.conid;
		let conid: number | null = null;
		try {
			conid = (await this.broker.resolve(symbol)).conid;
		} catch {
			// kein oder kein eindeutiger Kontrakt (Krypto, Devisen, unbekannte Börse): Kurs aus der Rückfallquelle
		}
		this.conids.set(symbol, { conid, at: this.now() });
		return conid;
	}

	async snapshot(symbols: string[]): Promise<QuoteResult> {
		const base = await this.fallback.snapshot(symbols);
		const wanted = new Map<number, string>();
		for (const s of symbols) {
			if (s.endsWith("=X")) continue; // Wechselkurse bleiben bei der Rückfallquelle
			const conid = await this.conidOf(s);
			if (conid !== null) wanted.set(conid, s);
		}
		if (!wanted.size) return base;
		let items: IbkrSnapshotItem[];
		try {
			if (!this.ready) {
				await localJson("GET", `${this.base}/iserver/accounts`, undefined, { timeoutMs: this.timeoutMs });
				this.ready = true;
			}
			const r = await localJson<IbkrSnapshotItem[]>("GET", `${this.base}/iserver/marketdata/snapshot?conids=${[...wanted.keys()].join(",")}&fields=${IBKR_FIELDS.join(",")}`, undefined, { timeoutMs: this.timeoutMs });
			items = Array.isArray(r) ? r : [];
			this.lastError = null;
		} catch (e) {
			if (e instanceof HttpError && e.status === 401) this.ready = false;
			this.lastError = `IBKR-Kurse: ${(e as Error).message}`;
			return base;
		}
		const bySymbol = new Map<string, IbkrSnapshotItem>();
		for (const it of items) {
			const s = typeof it.conid === "number" ? wanted.get(it.conid) : typeof it.conid === "string" ? wanted.get(Number(it.conid)) : undefined;
			if (s) bySymbol.set(s, it);
		}
		const quotes = base.quotes.map((q) => {
			const it = bySymbol.get(q.symbol);
			const last = it ? ibkrLast(it["31"]) : null;
			const delayed = it ? ibkrDelayed(it["6509"]) : undefined;
			if (!it || last === null || delayed === undefined || Math.abs(last - q.price) / q.price > MAX_SOURCE_GAP_PCT / 100) return q;
			const updated = num(it._updated);
			return { ...q, price: last, bid: num(it["84"]), ask: num(it["86"]), marketTime: updated === null ? q.marketTime : updated < 1e12 ? updated * 1000 : updated, source: "ibkr" as const, delayed };
		});
		return { ...base, quotes };
	}
}
