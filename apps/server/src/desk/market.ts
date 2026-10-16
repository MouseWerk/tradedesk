// Markt: Kurse holen und speichern, Kursalter, Watchlist, Suche, Charts, Alarme, Handelszeiten, Scanner, Analyse, News.
import type { Alert, Analysis, Chart, ChartRange, NewsItem, ScanRow, SearchHit, SessionInfo, WatchItem, SessionState } from "@desk/shared";
import { atr, dayKey, ema, last, rsi, sessionState, vwap } from "@desk/shared";
import { fxSymbol, type QuoteData } from "../market.ts";
import { DeskError, parsePrice, num, type QuoteRow } from "./core.ts";
import { DeskRisk } from "./risk.ts";

const SYMBOL = /^[A-Z0-9.=^-]{1,24}$/;
const QUOTE_FRESH_MS = 60_000;

export abstract class DeskMarket extends DeskRisk {
	private charts = new Map<string, { at: number; chart: Chart }>();

	protected storeQuotes(quotes: QuoteData[]) {
		const at = this.now();
		this.db.tx(() => {
			for (const q of quotes) {
				this.db.run(
					"INSERT INTO instrument (symbol, name, currency, exchange, type) VALUES (?,?,?,?,?) ON CONFLICT (symbol) DO UPDATE SET name = excluded.name, currency = excluded.currency, exchange = excluded.exchange, type = excluded.type",
					q.symbol, q.name, q.currency, q.exchange, q.type,
				);
				this.db.run(
					`INSERT INTO quote (symbol, price, prev_close, market_time, fetched_at, day_open, day_high, day_low, volume, pre_start, reg_start, reg_end, post_end, timezone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
					 ON CONFLICT (symbol) DO UPDATE SET price = excluded.price, prev_close = excluded.prev_close, market_time = excluded.market_time, fetched_at = excluded.fetched_at, day_open = excluded.day_open,
					 day_high = excluded.day_high, day_low = excluded.day_low, volume = excluded.volume, pre_start = excluded.pre_start, reg_start = excluded.reg_start, reg_end = excluded.reg_end, post_end = excluded.post_end, timezone = excluded.timezone`,
					q.symbol, q.price, q.prevClose, q.marketTime, at, q.dayOpen, q.dayHigh, q.dayLow, q.volume, q.session?.preStart ?? null, q.session?.regStart ?? null, q.session?.regEnd ?? null, q.session?.postEnd ?? null, q.timezone,
				);
			}
		});
	}

	/** Kurse holen (Wechselkurse gleich mit). Ein Ausfall der Börse lässt die alten Kurse stehen und sagt es. */
	async refresh(symbols: string[]): Promise<void> {
		if (this.market.kind === "off" || !symbols.length) return;
		const unique = [...new Set(symbols)];
		const { quotes, error, failed } = await this.market.quotes(unique);
		this.storeQuotes(quotes);
		const currencies = new Set<string>();
		for (const s of unique) {
			const c = this.instrument(s)?.currency;
			if (c && c !== "EUR") currencies.add(c);
		}
		const fxSyms = [...currencies].map(fxSymbol).filter((s) => !unique.includes(s));
		const fxRes = fxSyms.length ? await this.market.quotes(fxSyms) : { quotes: [], error: null, failed: [] };
		this.storeQuotes(fxRes.quotes);
		for (const q of [...quotes, ...fxRes.quotes]) this.quoteErrors.delete(q.symbol);
		for (const f of [...(failed ?? []), ...(fxRes.failed ?? [])]) this.quoteErrors.set(f.symbol, f.message);
		const err = error ?? fxRes.error;
		this.marketState = err ? "error" : "live";
		// einzelne Ausfälle sichtbar machen: der Markt ist "live", aber diese Symbole haben keinen neuen Kurs
		const some = [...this.quoteErrors.keys()];
		this.marketError = err ?? (some.length ? `Kein neuer Kurs für ${some.slice(0, 6).join(", ")}${some.length > 6 ? ` und ${some.length - 6} weitere` : ""}` : null);
		if (quotes.length) this.quotesAt = this.now();
	}

	/**
	 * Warum ein Kurs für eine Entscheidung nicht reicht: während der Handelszeit älter als maxQuoteAgeSec (der Wechselkurs
	 * ebenso). Außerhalb der Handelszeit ist der letzte Kurs der aktuelle. Ohne Handelszeiten gilt: wie offen.
	 */
	quoteProblem(symbol: string): string | null {
		if (this.market.kind === "off") return null;
		const q = this.quoteRow(symbol);
		if (!q) return null; // ohne Kurs meldet die Risikoprüfung selbst "Kein aktueller Kurs"
		if (q.reg_start !== null && this.sessionOf(q) !== "open") return null;
		const max = this.cfg.maxQuoteAgeSec * 1000;
		const age = (fetched: number) => `${Math.round((this.now() - fetched) / 60_000)} min`;
		if (this.now() - q.fetched_at > max) return `Kein aktueller Kurs für ${symbol} – der letzte ist ${age(q.fetched_at)} alt (Grenze ${this.cfg.maxQuoteAgeSec} s während der Handelszeit).`;
		const currency = this.instrument(symbol)?.currency;
		if (currency && currency !== "EUR") {
			const f = this.quoteRow(fxSymbol(currency));
			if (!f || this.now() - f.fetched_at > max) return `Kein aktueller Wechselkurs ${currency}/EUR${f ? ` – der letzte ist ${age(f.fetched_at)} alt` : ""}.`;
		}
		return null;
	}

	protected async ensureFresh(symbol: string) {
		const q = this.quoteRow(symbol);
		if (!q || this.now() - q.fetched_at > QUOTE_FRESH_MS) await this.refresh([symbol]);
	}

	protected heldSymbols(): string[] {
		const out = new Set<string>();
		for (const a of this.cfg.accounts) for (const s of this.book(a.id).holdings.keys()) out.add(s);
		return [...out];
	}

	trackedSymbols(): string[] {
		const watch = this.db.all<{ symbol: string }>("SELECT symbol FROM watch").map((r) => r.symbol);
		const active = this.db.all<{ symbol: string }>(`SELECT DISTINCT symbol FROM proposal WHERE status IN ('pending','open','placed','sending','confirm')`).map((r) => r.symbol);
		return [...new Set([...watch, ...this.heldSymbols(), ...active])];
	}

	protected isWatched(symbol: string) {
		return !!this.db.get("SELECT 1 FROM watch WHERE symbol = ?", symbol);
	}

	watchlist(): WatchItem[] {
		const watched = this.db.all<{ symbol: string }>("SELECT symbol FROM watch ORDER BY added_at").map((r) => r.symbol);
		const held = this.heldSymbols();
		const alerts = this.db.all<{ id: number; symbol: string; op: "above" | "below"; price: number; created_at: number; triggered_at: number | null }>("SELECT * FROM alert ORDER BY id");
		return [...new Set([...watched, ...held])].map((symbol) => {
			const i = this.instrument(symbol);
			const q = this.quoteRow(symbol);
			return {
				symbol,
				name: i?.name ?? symbol,
				currency: i?.currency ?? "EUR",
				exchange: i?.exchange ?? "",
				price: q?.price ?? null,
				prevClose: q?.prev_close ?? null,
				changePct: q?.prev_close ? ((q.price - q.prev_close) / q.prev_close) * 100 : null,
				marketTime: q?.market_time ?? null,
				held: held.includes(symbol),
				watched: watched.includes(symbol),
				alerts: alerts.filter((a) => a.symbol === symbol).map((a): Alert => ({ id: a.id, symbol: a.symbol, op: a.op, price: a.price, createdAt: a.created_at, triggeredAt: a.triggered_at })),
			};
		});
	}

	normalizeSymbol(raw: unknown): string {
		const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
		if (!SYMBOL.test(s)) throw new DeskError("Ungültiges Symbol – Yahoo-Schreibweise, z. B. SAP.DE, AAPL, EUNL.DE oder BTC-EUR.");
		return s;
	}

	async addWatch(raw: unknown, actor: string): Promise<WatchItem[]> {
		const symbol = this.normalizeSymbol(raw);
		if (this.market.kind !== "off") {
			await this.refresh([symbol]);
			if (!this.quoteRow(symbol)) throw new DeskError(`Kein Kurs für ${symbol} gefunden – Symbol prüfen (Yahoo-Schreibweise, z. B. SAP.DE).`, 404);
		} else if (!this.instrument(symbol)) {
			this.db.run("INSERT INTO instrument (symbol, name, currency) VALUES (?,?,?)", symbol, symbol, "EUR");
		}
		const { changes } = this.db.run("INSERT OR IGNORE INTO watch (symbol, added_at, added_by) VALUES (?,?,?)", symbol, this.now(), actor);
		if (changes) this.event("watch.add", actor, `${symbol} auf die Watchlist`);
		return this.watchlist();
	}

	removeWatch(raw: unknown, actor: string): WatchItem[] {
		const symbol = this.normalizeSymbol(raw);
		if (this.db.run("DELETE FROM watch WHERE symbol = ?", symbol).changes) this.event("watch.remove", actor, `${symbol} von der Watchlist`);
		return this.watchlist();
	}

	async search(q: string): Promise<SearchHit[]> {
		const s = q.trim();
		if (s.length < 1 || s.length > 60) return [];
		try {
			return await this.market.search(s);
		} catch (e) {
			throw new DeskError(`Suche nicht möglich: ${(e as Error).message}`, 502);
		}
	}

	async chart(raw: unknown, range: ChartRange): Promise<Chart> {
		const symbol = this.normalizeSymbol(raw);
		const key = `${symbol}|${range}`;
		const hit = this.charts.get(key);
		const ttl = range === "1d" ? 15_000 : range === "5d" ? 60_000 : 10 * 60_000;
		if (hit && this.now() - hit.at < ttl) return hit.chart;
		try {
			const { meta, candles } = await this.market.chart(symbol, range);
			const chart: Chart = { symbol, name: meta.name, currency: meta.currency, range, prevClose: meta.prevClose, candles };
			if (this.charts.size > 200) this.charts.clear();
			this.charts.set(key, { at: this.now(), chart });
			return chart;
		} catch (e) {
			if (hit) return hit.chart; // lieber ein älterer Chart als keiner
			throw new DeskError(`Chart für ${symbol} nicht verfügbar: ${(e as Error).message}`, 502);
		}
	}

	addAlert(body: { symbol?: unknown; op?: unknown; price?: unknown }, actor: string): WatchItem[] {
		const symbol = this.normalizeSymbol(body.symbol);
		if (body.op !== "above" && body.op !== "below") throw new DeskError("Alarm: über oder unter?");
		const price = parsePrice(body.price, "Alarm: Kurs");
		this.db.run("INSERT INTO alert (symbol, op, price, created_at) VALUES (?,?,?,?)", symbol, body.op, price, this.now());
		this.event("alert.add", actor, `Alarm ${symbol} ${body.op === "above" ? "über" : "unter"} ${num(price)}`);
		return this.watchlist();
	}

	removeAlert(id: number): WatchItem[] {
		this.db.run("DELETE FROM alert WHERE id = ?", id);
		return this.watchlist();
	}

	protected viewers = 0;
	private news$ = new Map<string, { at: number; items: NewsItem[] }>();

	/** Ein Browser hört zu (SSE-Stream): Kurse im schnellen Takt, bis er geht. */
	watch(): () => void {
		this.viewers++;
		let done = false;
		return () => {
			if (!done) this.viewers = Math.max(0, this.viewers - 1);
			done = true;
		};
	}

	/** Watchlist und Bestände ohne Wechselkurse. */
	scanSymbols(): string[] {
		const watched = this.db.all<{ symbol: string }>("SELECT symbol FROM watch ORDER BY added_at").map((r) => r.symbol);
		return [...new Set([...watched, ...this.heldSymbols()])].filter((s) => !s.endsWith("=X"));
	}

	protected dailyStat(symbol: string): { avg_volume: number | null; atr: number | null } | undefined {
		return this.db.get("SELECT avg_volume, atr FROM daily_stat WHERE symbol = ? AND day = ?", symbol, dayKey(this.now()));
	}

	/** Schnitt-Volumen (20 Tage, ohne heute) und ATR 14 aus Tageskerzen, einmal am Tag je Symbol. */
	async refreshDaily(symbols: string[]): Promise<void> {
		if (this.market.kind === "off") return;
		const today = dayKey(this.now());
		for (const symbol of symbols) {
			try {
				const { candles } = await this.market.chart(symbol, "3mo");
				const past = candles.filter((c) => dayKey(c.t) < today);
				const vols = past.slice(-20).map((c) => c.v).filter((v) => v > 0);
				const avg = vols.length ? vols.reduce((x, y) => x + y, 0) / vols.length : null;
				this.db.run(
					"INSERT INTO daily_stat (symbol, day, avg_volume, atr) VALUES (?,?,?,?) ON CONFLICT (symbol) DO UPDATE SET day = excluded.day, avg_volume = excluded.avg_volume, atr = excluded.atr",
					symbol, today, avg, last(atr(candles, 14)),
				);
			} catch {
				// ohne Tageskerzen bleiben Rel. Volumen und ATR leer
			}
		}
	}

	protected sessionOf(q: QuoteRow | undefined): SessionState {
		if (!q || q.reg_start === null || q.reg_end === null) return "closed";
		return sessionState({ preStart: q.pre_start, regStart: q.reg_start, regEnd: q.reg_end, postEnd: q.post_end }, this.now());
	}

	sessions(): SessionInfo[] {
		const by = new Map<string, { q: QuoteRow; n: number }>();
		for (const s of this.scanSymbols()) {
			const i = this.instrument(s);
			const q = this.quoteRow(s);
			if (!i || !q || q.reg_start === null) continue;
			const key = i.exchange || "?";
			const cur = by.get(key);
			if (!cur) by.set(key, { q, n: 1 });
			else by.set(key, { q: (q.reg_start ?? 0) > (cur.q.reg_start ?? 0) ? q : cur.q, n: cur.n + 1 });
		}
		return [...by.entries()].map(([exchange, { q, n }]) => ({ exchange, timezone: q.timezone, state: this.sessionOf(q), preStart: q.pre_start, regStart: q.reg_start, regEnd: q.reg_end, postEnd: q.post_end, symbols: n }));
	}

	scan(): ScanRow[] {
		const held = new Set(this.heldSymbols());
		const alerts = this.db.all<{ symbol: string; n: number }>("SELECT symbol, COUNT(*) AS n FROM alert WHERE triggered_at IS NULL GROUP BY symbol");
		return this.scanSymbols().map((symbol) => {
			const i = this.instrument(symbol);
			const q = this.quoteRow(symbol);
			const d = this.dailyStat(symbol);
			const state = this.sessionOf(q);
			const price = q?.price ?? null;
			// Volumen zeitanteilig: zur Mittagszeit zählt der halbe Tagesschnitt
			let relVolume: number | null = null;
			if (q?.volume && d?.avg_volume) {
				const span = q.reg_start && q.reg_end ? q.reg_end - q.reg_start : 0;
				const part = state === "open" && span > 0 ? Math.min(1, Math.max(0.05, (this.now() - q.reg_start!) / span)) : 1;
				relVolume = q.volume / (d.avg_volume * part);
			}
			return {
				symbol,
				name: i?.name ?? symbol,
				currency: i?.currency ?? "EUR",
				exchange: i?.exchange ?? "",
				state,
				price,
				changePct: q?.prev_close && price !== null ? ((price - q.prev_close) / q.prev_close) * 100 : null,
				gapPct: q?.prev_close && q.day_open ? ((q.day_open - q.prev_close) / q.prev_close) * 100 : null,
				dayOpen: q?.day_open ?? null,
				dayHigh: q?.day_high ?? null,
				dayLow: q?.day_low ?? null,
				rangePos: q?.day_high && q.day_low && price !== null && q.day_high > q.day_low ? Math.min(1, Math.max(0, (price - q.day_low) / (q.day_high - q.day_low))) : null,
				volume: q?.volume ?? null,
				relVolume,
				atrPct: d?.atr && price ? (d.atr / price) * 100 : null,
				marketTime: q?.market_time ?? null,
				held: held.has(symbol),
				alerts: alerts.find((a) => a.symbol === symbol)?.n ?? 0,
				quoteStale: this.quoteErrors.has(symbol) || this.quoteProblem(symbol) !== null,
			};
		});
	}

	/** Kennzahlen eines Werts aus 1-Minuten-Kerzen (EMA 9/21, VWAP, RSI 14) und Tageskerzen (ATR 14). */
	async analysis(raw: unknown): Promise<Analysis> {
		const symbol = this.normalizeSymbol(raw);
		const chart = await this.chart(symbol, "1d");
		if (!this.dailyStat(symbol)) await this.refreshDaily([symbol]);
		const closes = chart.candles.map((c) => c.c);
		const row = this.scan().find((r) => r.symbol === symbol);
		const q = this.quoteRow(symbol);
		const price = q?.price ?? closes.at(-1) ?? null;
		return {
			symbol,
			name: chart.name,
			currency: chart.currency,
			state: this.sessionOf(q),
			price,
			prevClose: q?.prev_close ?? chart.prevClose,
			dayOpen: q?.day_open ?? chart.candles[0]?.o ?? null,
			dayHigh: q?.day_high ?? null,
			dayLow: q?.day_low ?? null,
			gapPct: row?.gapPct ?? null,
			changePct: row?.changePct ?? null,
			ema9: last(ema(closes, 9)),
			ema21: last(ema(closes, 21)),
			vwap: last(vwap(chart.candles, dayKey)),
			rsi14: last(rsi(closes, 14)),
			atr14: this.dailyStat(symbol)?.atr ?? null,
			relVolume: row?.relVolume ?? null,
			candles: chart.candles.length,
			asOf: chart.candles.at(-1)?.t ?? null,
		};
	}

	async news(raw: unknown): Promise<NewsItem[]> {
		const symbol = this.normalizeSymbol(raw);
		const hit = this.news$.get(symbol);
		if (hit && this.now() - hit.at < 5 * 60_000) return hit.items;
		try {
			const items = await this.market.news(symbol);
			if (this.news$.size > 200) this.news$.clear();
			this.news$.set(symbol, { at: this.now(), items });
			return items;
		} catch (e) {
			if (hit) return hit.items;
			throw new DeskError(`News für ${symbol} nicht verfügbar: ${(e as Error).message}`, 502);
		}
	}

	/** Börse des Symbols offen und der Kurs aus der laufenden Sitzung? */
	protected inSession(symbol: string): boolean {
		const q = this.quoteRow(symbol);
		if (!q || this.sessionOf(q) !== "open") return false;
		return q.market_time === null || q.reg_start === null || q.market_time >= q.reg_start;
	}

	protected checkAlerts() {
		for (const al of this.db.all<{ id: number; symbol: string; op: "above" | "below"; price: number }>("SELECT * FROM alert WHERE triggered_at IS NULL")) {
			const q = this.quoteRow(al.symbol);
			if (!q || !(al.op === "above" ? q.price >= al.price : q.price <= al.price)) continue;
			this.db.run("UPDATE alert SET triggered_at = ? WHERE id = ?", this.now(), al.id);
			this.event("alert", "Desk", `Alarm ${al.symbol} ${al.op === "above" ? "über" : "unter"} ${num(al.price)} – jetzt ${num(q.price)}`, { ref: al.symbol });
		}
	}
}
