// Der Desk: Depots, Kurse, Vorschläge, Freigaben, Risiko, Journal, Tagesstände. Ein Prozess, eine Datenbank;
// jede Änderung läuft synchron in einer Transaktion (Node ist einthreadig – zwei Klicks führen nie doppelt aus).
// Agenten schlagen vor, du gibst frei. Echtes Geld bewegt der Desk nie: Orders für ein manuelles Depot
// (z. B. Trade Republic) führst du selbst in der App des Brokers aus und trägst die Ausführung hier ein.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
	Account, AccountDetail, AccountSummary, AgentsData, Alert, Analysis, BrokerStatus, Reconcile, CashMove, Chart, ChartRange, ChatMessage, Check, Cockpit, CockpitPosition, CurvePoint, DeskEvent, ImportResult, JournalEntry,
	NewsItem, Overview, Position, Proposal, ProposalStatus, RiskData, RiskLimits, ScanRow, SearchHit, SessionInfo, Side, Trade, WatchItem,
} from "@desk/shared";
import {
	MAX_EUR, PriceSchema, ProposalInputSchema, QtySchema, RiskLimitsSchema, atr, cents, decimals, buildBook, checkOrder, dayKey, dayStats, ema, last, movePct, orderValueCents, parseTradesCsv, rMultiple, returnPct, roundQty, rsi, sessionState, sideLabel, valueHoldings, vwap,
	type DayStats, type SessionState,
} from "@desk/shared";
import type { Config } from "./config.ts";
import type { Database } from "./db.ts";
import { fxSymbol, type Market, type QuoteData } from "./market.ts";
import type { Broker, BrokerExecution, BrokerOrder, PlaceResult } from "./broker.ts";
import { OwnerAuth } from "./auth.ts";

export class DeskError extends Error {
	readonly status: number;
	readonly data: unknown;
	constructor(message: string, status = 400, data?: unknown) {
		super(message);
		this.status = status;
		this.data = data;
	}
}

/** Wer fragt: der Browser (du) oder ein Agent über cli/desk.py. */
export type Origin = "web" | "cli";

interface TradeRow { id: number; account_id: string; symbol: string; side: Side; qty: number; price: number; currency: string; fx: number; value_cents: number; fee_cents: number; time: number; source: Trade["source"]; proposal_id: number | null; note: string }
interface ProposalRow {
	id: number; account_id: string; author: string; symbol: string; side: Side; qty: number; order_type: "market" | "limit"; limit_price: number | null; stop_loss: number | null; take_profit: number | null;
	confidence: number; thesis: string; status: ProposalStatus; reason: string; quote_price: number; warnings: string; created_at: number; decided_at: number | null; decided_by: string | null;
	approved_qty: number | null; expires_at: number; fill_price: number | null; stop_hit_at: number | null; target_hit_at: number | null;
	broker_order_id: string | null; broker_message: string | null; reply_id: string | null; broker_conid: number | null;
	broker_coid: string | null; status_at: number | null; last_seen_at: number | null; filled_qty: number | null; closed_at: number | null;
}
interface QuoteRow {
	symbol: string; price: number; prev_close: number | null; market_time: number | null; fetched_at: number; day_open: number | null; day_high: number | null; day_low: number | null; volume: number | null;
	pre_start: number | null; reg_start: number | null; reg_end: number | null; post_end: number | null; timezone: string;
}
interface InstrumentRow { symbol: string; name: string; currency: string; exchange: string; type: string }

export const DEFAULT_LIMITS: Omit<RiskLimits, "accountId"> = { maxOrderCents: 500_000, maxPositionPct: 25, dailyLossPct: 5, maxOpenProposals: 5, maxRiskPct: 1, requireStop: true };
const SYMBOL = /^[A-Z0-9.=^-]{1,24}$/;
const QUOTE_FRESH_MS = 60_000;
const OPEN_LIMIT_DAYS = 30;
const MARKET_WAIT_DAYS = 4; // eine Papier-Market-Order nach Börsenschluss wartet höchstens bis dahin auf die Eröffnung
const PLACED_DAYS = 7;
const CONFIRM_TTL_MS = 15 * 60_000; // eine Rückfrage des Brokers gilt so lange; danach neu freigeben
const UNLISTED_MS = 24 * 3_600_000; // so lange darf eine Broker-Order aus der Orderliste fehlen, dann gilt sie als abgelaufen
const BROKER_KEEPALIVE_MS = 60_000; // IBKR empfiehlt etwa einmal je Minute /tickle, unabhängig vom Kurstakt

const MAX_FEE_EUR = 10_000;

/** Stückzahl aus einer Eingabe: endlich, > 0, höchstens MAX_QTY und 6 Nachkommastellen – sonst 400. */
function parseQty(v: unknown, what = "Stückzahl"): number {
	const r = QtySchema.safeParse(v);
	if (!r.success || roundQty(r.data) <= 0) throw new DeskError(`${what}: größer als 0, höchstens 10 Mio. und höchstens 6 Nachkommastellen.`);
	return roundQty(r.data);
}

function parsePrice(v: unknown, what = "Kurs"): number {
	const r = PriceSchema.safeParse(v);
	if (!r.success) throw new DeskError(`${what}: größer als 0, höchstens 10 Mio. und höchstens 8 Nachkommastellen.`);
	return r.data;
}

/** Betrag in EUR mit höchstens zwei Nachkommastellen → Cent; fehlt er, gilt fallback. */
function parseFeeCents(v: unknown, fallback: number): number {
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_FEE_EUR || decimals(v) > 2) throw new DeskError(`Gebühr in EUR zwischen 0 und ${MAX_FEE_EUR.toLocaleString("de-DE")}, höchstens 2 Nachkommastellen.`);
	return cents(v);
}

const RESERVING = "'open','placed','sending','confirm'"; // freigegeben, aber noch nicht (ganz) ausgeführt
const eurText = (c: number) => `${(c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

const pct = (n: number) => `${n.toFixed(1).replace(".", ",")} %`;
const num = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 6 });

export class Desk extends EventEmitter {
	marketState: "live" | "off" | "error";
	marketError: string | null = null;
	/** Symbol → Fehler des letzten Abrufs (auch wenn andere Symbole Kurse bekamen). */
	readonly quoteErrors = new Map<string, string>();
	quotesAt: number | null = null;
	ticks = 0;
	private timer: NodeJS.Timeout | null = null;
	private ticking: Promise<void> | null = null;
	private charts = new Map<string, { at: number; chart: Chart }>();
	readonly brokers: Map<string, Broker>;
	private brokerState = new Map<string, BrokerStatus>();

	readonly cfg: Config;
	readonly db: Database;
	readonly market: Market;
	readonly now: () => number;
	readonly auth: OwnerAuth; // deine PIN und Sitzungen (ein Objekt je Desk: Sperre nach Fehlversuchen gilt prozessweit)

	constructor(cfg: Config, db: Database, market: Market, now: () => number = Date.now, brokers: Map<string, Broker> = new Map()) {
		super();
		this.brokers = brokers;
		this.cfg = cfg;
		this.db = db;
		this.market = market;
		this.now = now;
		this.auth = new OwnerAuth(db, now);
		this.setMaxListeners(200);
		this.marketState = market.kind === "off" ? "off" : "live";
		for (const a of cfg.accounts)
			db.run(
				"INSERT OR IGNORE INTO risk (account_id, max_order_cents, max_position_pct, daily_loss_pct, max_open_proposals, max_risk_pct, require_stop) VALUES (?,?,?,?,?,?,?)",
				a.id, DEFAULT_LIMITS.maxOrderCents, DEFAULT_LIMITS.maxPositionPct, DEFAULT_LIMITS.dailyLossPct, DEFAULT_LIMITS.maxOpenProposals, DEFAULT_LIMITS.maxRiskPct, DEFAULT_LIMITS.requireStop,
			);
		const last = db.get<{ fetched_at: number }>("SELECT MAX(fetched_at) AS fetched_at FROM quote");
		this.quotesAt = last?.fetched_at ?? null;
	}

	/* ------------------------------------------------------------------ Grundlagen */

	account(id: string): Account {
		const a = this.cfg.accounts.find((x) => x.id === id);
		if (!a) throw new DeskError(`Unbekanntes Depot ${id}.`, 404);
		return a;
	}

	/** Kanonischer Agentenname oder null – nur Agenten aus config.json dürfen vorschlagen. */
	agentName(name: string): string | null {
		return this.cfg.agents.find((a) => a.toLowerCase() === name.trim().toLowerCase()) ?? null;
	}

	get killSwitch(): boolean {
		return this.db.get<{ value: string }>("SELECT value FROM setting WHERE key = 'kill_switch'")?.value === "1";
	}

	/** Ereignis im Verlauf; mit chat zusätzlich als Nachricht des Desks im Chat (Agenten lesen dort ihre Ergebnisse). */
	event(kind: string, actor: string, text: string, chat?: { to?: string[]; ref?: string | null }): DeskEvent {
		const time = this.now();
		const { lastId } = this.db.run("INSERT INTO event (time, kind, actor, text) VALUES (?,?,?,?)", time, kind, actor, text.slice(0, 500));
		const e = { id: lastId, time, kind, actor, text: text.slice(0, 500) };
		this.emit("event", e);
		if (chat) this.postChat({ author: "Desk", role: "desk", text: actor === "Desk" || text.startsWith(actor) ? text : `${actor}: ${text}`, to: chat.to ?? [], ref: chat.ref ?? null });
		return e;
	}

	events(limit = 40): DeskEvent[] {
		return this.db.all<DeskEvent>("SELECT id, time, kind, actor, text FROM event ORDER BY id DESC LIMIT ?", limit);
	}

	instrument(symbol: string): InstrumentRow | undefined {
		return this.db.get<InstrumentRow>("SELECT * FROM instrument WHERE symbol = ?", symbol);
	}

	private quoteRow(symbol: string): QuoteRow | undefined {
		return this.db.get<QuoteRow>("SELECT * FROM quote WHERE symbol = ?", symbol);
	}

	/** Wechselkurs Währung → EUR oder null. */
	fx(currency: string): number | null {
		if (currency === "EUR") return 1;
		return this.quoteRow(fxSymbol(currency))?.price ?? null;
	}

	/** Kurs in Wertpapierwährung + Wechselkurs, nur wenn beides bekannt ist. */
	priced(symbol: string): { price: number; fx: number; currency: string; prevClose: number | null; marketTime: number | null; fetchedAt: number } | null {
		const i = this.instrument(symbol);
		const q = this.quoteRow(symbol);
		if (!i || !q) return null;
		const fx = this.fx(i.currency);
		return fx === null ? null : { price: q.price, fx, currency: i.currency, prevClose: q.prev_close, marketTime: q.market_time, fetchedAt: q.fetched_at };
	}

	private storeQuotes(quotes: QuoteData[]) {
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

	private async ensureFresh(symbol: string) {
		const q = this.quoteRow(symbol);
		if (!q || this.now() - q.fetched_at > QUOTE_FRESH_MS) await this.refresh([symbol]);
	}

	/* ------------------------------------------------------------------ Depots */

	private tradeRows(accountId: string): TradeRow[] {
		return this.db.all<TradeRow>("SELECT * FROM trade WHERE account_id = ? AND deleted_at IS NULL ORDER BY time, id", accountId);
	}

	private book(accountId: string) {
		return buildBook(this.tradeRows(accountId).map((t) => ({ id: t.id, symbol: t.symbol, side: t.side, qty: t.qty, price: t.price, valueCents: t.value_cents, feeCents: t.fee_cents, time: t.time })));
	}

	private depositsCents(a: Account): number {
		return a.startCashCents + (this.db.get<{ s: number | null }>("SELECT SUM(amount_cents) AS s FROM cash_move WHERE account_id = ?", a.id)?.s ?? 0);
	}

	private prevSnapshot(accountId: string): { equity_cents: number; deposits_cents: number } | undefined {
		return this.db.get("SELECT equity_cents, deposits_cents FROM snapshot WHERE account_id = ? AND day < ? ORDER BY day DESC LIMIT 1", accountId, dayKey(this.now()));
	}

	summary(a: Account): AccountSummary {
		const book = this.book(a.id);
		const deposits = this.depositsCents(a);
		const cash = deposits - book.buysCents + book.sellsCents;
		const v = valueHoldings(book.holdings, (s) => this.priced(s));
		const equity = cash + v.marketValueCents;
		const prev = this.prevSnapshot(a.id);
		return {
			...a,
			cashCents: cash,
			marketValueCents: v.marketValueCents,
			equityCents: equity,
			costCents: v.costCents,
			unrealizedCents: v.unrealizedCents,
			realizedCents: book.realizedCents,
			feesCents: book.feesCents,
			dayChangeCents: prev ? equity - deposits - (prev.equity_cents - prev.deposits_cents) : null,
			depositsCents: deposits,
			returnPct: returnPct(equity, deposits),
			positions: book.holdings.size,
			missingQuotes: v.missing,
		};
	}

	dayLossPct(a: Account, s = this.summary(a)): number | null {
		const prev = this.prevSnapshot(a.id);
		if (!prev || prev.equity_cents <= 0 || s.dayChangeCents === null) return null;
		return Math.max(0, (-s.dayChangeCents / prev.equity_cents) * 100);
	}

	private positions(a: Account, s: AccountSummary): Position[] {
		const book = this.book(a.id);
		const out: Position[] = [];
		for (const h of book.holdings.values()) {
			const i = this.instrument(h.symbol);
			const p = this.priced(h.symbol);
			const value = p ? orderValueCents(h.qty, p.price, p.fx) : h.costCents;
			const last = this.db.get<{ stop_loss: number | null; take_profit: number | null }>(
				"SELECT stop_loss, take_profit FROM proposal WHERE account_id = ? AND symbol = ? AND side = 'buy' AND status = 'filled' ORDER BY decided_at DESC LIMIT 1",
				a.id, h.symbol,
			);
			out.push({
				symbol: h.symbol,
				name: i?.name ?? h.symbol,
				currency: i?.currency ?? "EUR",
				qty: h.qty,
				avgPrice: h.avgPrice,
				costCents: h.costCents,
				price: p ? p.price * p.fx : null,
				nativePrice: p?.price ?? null,
				valueCents: value,
				unrealizedCents: p ? value - h.costCents : 0,
				unrealizedPct: p && h.costCents > 0 ? ((value - h.costCents) / h.costCents) * 100 : null,
				dayChangePct: p?.prevClose ? ((p.price - p.prevClose) / p.prevClose) * 100 : null,
				weightPct: s.equityCents > 0 ? (value / s.equityCents) * 100 : 0,
				quoteTime: p?.marketTime ?? null,
				stopLoss: last?.stop_loss ?? null,
				takeProfit: last?.take_profit ?? null,
			});
		}
		return out.sort((x, y) => y.valueCents - x.valueCents);
	}

	private trades(accountId: string, limit = 500): Trade[] {
		const book = this.book(accountId);
		return this.tradeRows(accountId)
			.reverse()
			.slice(0, limit)
			.map((t) => ({
				id: t.id, accountId: t.account_id, symbol: t.symbol, side: t.side, qty: t.qty, price: t.price, currency: t.currency, fx: t.fx, valueCents: t.value_cents, feeCents: t.fee_cents,
				time: t.time, source: t.source, proposalId: t.proposal_id, note: t.note, realizedCents: t.side === "sell" ? (book.realizedBySell.get(t.id) ?? null) : null,
			}));
	}

	/** Tagesstände; heute immer mit dem Live-Wert. */
	curve(a: Account, s?: AccountSummary): CurvePoint[] {
		const today = dayKey(this.now());
		const rows = this.db.all<{ day: string; equity_cents: number; deposits_cents: number }>("SELECT day, equity_cents, deposits_cents FROM snapshot WHERE account_id = ? AND day < ? ORDER BY day", a.id, today);
		const live = s ?? this.summary(a);
		return [...rows.map((r) => ({ day: r.day, equityCents: r.equity_cents, depositsCents: r.deposits_cents })), { day: today, equityCents: live.equityCents, depositsCents: live.depositsCents }];
	}

	limits(accountId: string): RiskLimits {
		const r = this.db.get<{ max_order_cents: number; max_position_pct: number; daily_loss_pct: number; max_open_proposals: number; max_risk_pct: number; require_stop: number }>("SELECT * FROM risk WHERE account_id = ?", accountId);
		return r
			? { accountId, maxOrderCents: r.max_order_cents, maxPositionPct: r.max_position_pct, dailyLossPct: r.daily_loss_pct, maxOpenProposals: r.max_open_proposals, maxRiskPct: r.max_risk_pct, requireStop: !!r.require_stop }
			: { accountId, ...DEFAULT_LIMITS };
	}

	detail(id: string): AccountDetail {
		const a = this.account(id);
		const s = this.summary(a);
		return {
			account: s,
			positions: this.positions(a, s),
			trades: this.trades(a.id),
			cashMoves: this.db.all<{ id: number; account_id: string; amount_cents: number; time: number; note: string }>("SELECT * FROM cash_move WHERE account_id = ? ORDER BY time DESC", a.id).map(
				(c): CashMove => ({ id: c.id, accountId: c.account_id, amountCents: c.amount_cents, time: c.time, note: c.note }),
			),
			curve: this.curve(a, s),
			risk: this.limits(a.id),
		};
	}

	overview(): Overview {
		const summaries = this.cfg.accounts.map((a) => this.summary(a));
		const mine = this.cfg.accounts.filter((a) => a.owner === "user");
		const curves = mine.map((a) => this.curve(a, summaries.find((s) => s.id === a.id)));
		const days = [...new Set(curves.flat().map((p) => p.day))].sort();
		const curve = days.map((day) => {
			let equityCents = 0;
			let depositsCents = 0;
			for (const c of curves) {
				const p = c.filter((x) => x.day <= day).at(-1);
				if (p) {
					equityCents += p.equityCents;
					depositsCents += p.depositsCents;
				}
			}
			return { day, equityCents, depositsCents };
		});
		return {
			user: this.cfg.user,
			baseCurrency: this.cfg.baseCurrency,
			killSwitch: this.killSwitch,
			market: this.marketState,
			marketError: this.marketError,
			quotesAt: this.quotesAt,
			accounts: summaries,
			curve,
			pending: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM proposal WHERE status = 'pending'")!.n,
			events: this.events(30),
			failedQuotes: [...this.quoteErrors.keys()].sort(),
		};
	}

	/* ------------------------------------------------------------------ Markt */

	private heldSymbols(): string[] {
		const out = new Set<string>();
		for (const a of this.cfg.accounts) for (const s of this.book(a.id).holdings.keys()) out.add(s);
		return [...out];
	}

	trackedSymbols(): string[] {
		const watch = this.db.all<{ symbol: string }>("SELECT symbol FROM watch").map((r) => r.symbol);
		const active = this.db.all<{ symbol: string }>(`SELECT DISTINCT symbol FROM proposal WHERE status IN ('pending','open','placed','sending','confirm')`).map((r) => r.symbol);
		return [...new Set([...watch, ...this.heldSymbols(), ...active])];
	}

	private isWatched(symbol: string) {
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

	/* ------------------------------------------------------------------ Vorschläge und Orders */

	private toProposal(r: ProposalRow): Proposal {
		const i = this.instrument(r.symbol);
		const p = this.priced(r.symbol);
		const qty = r.approved_qty ?? r.qty;
		const unit = r.limit_price ?? p?.price ?? r.quote_price;
		return {
			id: r.id, accountId: r.account_id, author: r.author, symbol: r.symbol, name: i?.name ?? r.symbol, currency: i?.currency ?? "EUR", side: r.side, qty: r.qty, orderType: r.order_type,
			limitPrice: r.limit_price, stopLoss: r.stop_loss, takeProfit: r.take_profit, confidence: r.confidence, thesis: r.thesis, status: r.status, reason: r.reason, quotePrice: r.quote_price,
			price: p?.price ?? null, estimateCents: orderValueCents(qty, unit, p?.fx ?? this.fx(i?.currency ?? "EUR") ?? 1), warnings: JSON.parse(r.warnings) as string[], createdAt: r.created_at,
			decidedAt: r.decided_at, decidedBy: r.decided_by, approvedQty: r.approved_qty, expiresAt: r.expires_at, fillPrice: r.fill_price,
			brokerOrderId: r.broker_order_id, brokerMessage: r.broker_message, filledQty: r.filled_qty,
		};
	}

	private proposalRow(id: number): ProposalRow {
		const r = this.db.get<ProposalRow>("SELECT * FROM proposal WHERE id = ?", id);
		if (!r) throw new DeskError(`Unbekannter Vorschlag ${id}.`, 404);
		return r;
	}

	proposal(id: number): Proposal {
		return this.toProposal(this.proposalRow(id));
	}

	proposals(opts: { status?: string; author?: string; limit?: number } = {}): Proposal[] {
		const where: string[] = [];
		const params: unknown[] = [];
		if (opts.status === "active") where.push(`status IN ('pending','open','placed','sending','confirm')`);
		else if (opts.status) {
			where.push("status = ?");
			params.push(opts.status);
		}
		if (opts.author) {
			where.push("lower(author) = lower(?)");
			params.push(opts.author);
		}
		const rows = this.db.all<ProposalRow>(`SELECT * FROM proposal ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, opts.limit ?? 300);
		return rows.map((r) => this.toProposal(r));
	}

	/**
	 * Was freigegebene, noch nicht (ganz) ausgeführte Orders eines Depots binden: Cash und Positionswert der Käufe, Stück
	 * der Verkäufe. Ohne Kurs oder Wechselkurs einer Kauf-Order lässt sich das Cash nicht prüfen (unpriced).
	 */
	private reserved(accountId: string, exclude?: number): { cashCents: number; buyValue: Map<string, number>; sellQty: Map<string, number>; unpriced: number[]; riskCents: number } {
		const a = this.account(accountId);
		const out = { cashCents: 0, buyValue: new Map<string, number>(), sellQty: new Map<string, number>(), unpriced: [] as number[], riskCents: 0 };
		for (const r of this.db.all<ProposalRow>(`SELECT * FROM proposal WHERE account_id = ? AND status IN (${RESERVING}) AND id != ?`, accountId, exclude ?? 0)) {
			const qty = roundQty((r.approved_qty ?? r.qty) - (r.filled_qty ?? 0)); // der ausgeführte Teil steckt schon im Buch
			if (qty <= 0) continue;
			if (r.side === "sell") {
				out.sellQty.set(r.symbol, (out.sellQty.get(r.symbol) ?? 0) + qty);
				continue;
			}
			const p = this.priced(r.symbol);
			const fx = p?.fx ?? this.fx(this.instrument(r.symbol)?.currency ?? "");
			const unit = r.limit_price ?? p?.price ?? r.quote_price;
			if (fx === null || !(unit > 0)) {
				out.unpriced.push(r.id);
				continue;
			}
			const value = orderValueCents(qty, unit, fx);
			out.cashCents += value + a.feeCents;
			out.buyValue.set(r.symbol, (out.buyValue.get(r.symbol) ?? 0) + value);
			if (r.stop_loss && r.stop_loss < unit) out.riskCents += orderValueCents(qty, unit - r.stop_loss, fx) + 2 * a.feeCents;
		}
		return out;
	}

	/**
	 * Risikoprüfung gegen Bestand, Cash und alle schon freigegebenen offenen Orders des Depots (exclude: die Order selbst).
	 * Während der Handelszeit nur mit frischem Kurs.
	 */
	private check(a: Account, o: { side: Side; qty: number; orderType: "market" | "limit"; limitPrice?: number | null; stopLoss?: number | null; takeProfit?: number | null; symbol: string }, opts: { openByAuthor?: number; byAgent?: boolean; exclude?: number } = {}): Check {
		const s = this.summary(a);
		const p = this.priced(o.symbol);
		const book = this.book(a.id);
		const held = book.holdings.get(o.symbol);
		const res = this.reserved(a.id, opts.exclude);
		const c = checkOrder({
			...o,
			price: p?.price ?? null,
			fx: p?.fx ?? null,
			cashCents: s.cashCents - res.cashCents,
			equityCents: s.equityCents,
			feeCents: a.feeCents,
			heldQty: Math.max(0, roundQty((held?.qty ?? 0) - (res.sellQty.get(o.symbol) ?? 0))),
			positionValueCents: (held ? (p ? orderValueCents(held.qty, p.price, p.fx) : held.costCents) : 0) + (res.buyValue.get(o.symbol) ?? 0),
			limits: this.limits(a.id),
			killSwitch: this.killSwitch,
			dayLossPct: this.dayLossPct(a, s),
			openByAuthor: opts.openByAuthor,
			byAgent: opts.byAgent ?? false,
		});
		const violations = [...c.violations];
		const warnings = [...c.warnings];
		const stale = this.quoteProblem(o.symbol);
		if (stale) violations.unshift(stale);
		if (o.side === "buy" && res.unpriced.length) violations.push(`Freigegebene Order ${res.unpriced.map((id) => `#${id}`).join(", ")} ohne Kurs oder Wechselkurs – das gebundene Cash ist nicht prüfbar.`);
		if (o.side === "buy" && res.cashCents > 0) warnings.push(`Freigegebene, noch offene Orders binden ${eurText(res.cashCents)} – im verfügbaren Cash schon abgezogen.`);
		if (o.side === "sell" && res.sellQty.get(o.symbol)) warnings.push(`${num(res.sellQty.get(o.symbol)!)} Stück ${o.symbol} sind schon in offenen Verkaufsorders gebunden.`);
		return { ...c, ok: violations.length === 0, violations, warnings };
	}

	/**
	 * Neuer Vorschlag. Vom Browser ist es deine eigene Order (nur Papierdepot) und wird sofort ausgeführt.
	 * Von der CLI muss der Autor ein Agent aus config.json sein; was die Prüfung nicht besteht, wird gar nicht angelegt.
	 */
	async submit(body: unknown, origin: Origin, { dryRun = false } = {}): Promise<{ ok: boolean; check: Check; proposal: Proposal | null }> {
		const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
		// Tippfehler wie "stoploss" sind kein "ohne Stop": unbekannte Felder von Agenten werden abgewiesen
		const unknown = origin === "cli" ? Object.keys(raw).filter((k) => !(k in ProposalInputSchema.shape)) : [];
		if (unknown.length) throw new DeskError(`Ungültiger Vorschlag: unbekanntes Feld „${unknown[0].slice(0, 40)}“ – erlaubt: ${Object.keys(ProposalInputSchema.shape).join(", ")}.`);
		const parsed = ProposalInputSchema.safeParse(origin === "web" ? { confidence: 1, thesis: "Eigene Order", ...raw, author: this.cfg.user } : raw);
		if (!parsed.success) {
			const i = parsed.error.issues[0];
			throw new DeskError(`Ungültiger Vorschlag: ${i.path.join(".") || "?"} – ${i.message}`);
		}
		const input = parsed.data;
		const isUser = origin === "web";
		const author = isUser ? this.cfg.user : this.agentName(input.author);
		if (!author) throw new DeskError(`Unbekannter Agent „${input.author}“ – in config.json unter "agents" eintragen.`, 403);
		const a = this.account(input.accountId);
		if (!isUser && a.owner !== "user" && a.owner !== author) throw new DeskError(`${author} darf nicht für ${a.name} vorschlagen – nur fürs eigene Papierdepot oder deine Depots.`, 403);
		if (isUser && a.kind === "broker" && !this.brokers.has(a.id)) throw new DeskError(`${a.name}: keine Verbindung zum Broker eingerichtet.`);
		if (isUser && a.kind === "manual") throw new DeskError(`${a.name} führst du beim Broker aus – dort ausgeführte Trades mit „Trade erfassen…“ eintragen.`);
		const symbol = this.normalizeSymbol(input.symbol);
		const extra: string[] = [];
		// die Allow-List: nur, was auf der Watchlist oder im Depot steht – nie ein erfundenes Symbol
		if (!this.isWatched(symbol) && !this.book(a.id).holdings.has(symbol)) extra.push(`${symbol} steht nicht auf der Watchlist und nicht im Depot.`);
		if (!isUser && input.confidence < this.cfg.minConfidence) extra.push(`Zuversicht ${Math.round(input.confidence * 100)} % liegt unter dem Mindestwert von ${Math.round(this.cfg.minConfidence * 100)} %.`);
		if (input.orderType === "market" && input.limitPrice) extra.push("Market-Order mit Limitkurs – orderType \"limit\" verwenden oder den Limitkurs weglassen.");
		if (!extra.length) await this.ensureFresh(symbol);
		// "je Autor": über alle Depots gezählt, sonst hielte ein Agent mit vier Depots viermal so viele offen
		const openByAuthor = isUser ? undefined : this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM proposal WHERE author = ? AND status = 'pending'", author)!.n;
		const c = this.check(a, { ...input, symbol }, { openByAuthor, byAgent: !isUser });
		const waiting = input.side === "buy" ? this.db.all<ProposalRow>("SELECT * FROM proposal WHERE account_id = ? AND side = 'buy' AND status = 'pending'", a.id) : [];
		const waitingCents = waiting.reduce((sum, w) => sum + orderValueCents(w.qty, w.limit_price ?? w.quote_price, this.priced(w.symbol)?.fx ?? 1) + a.feeCents, 0);
		if (waiting.length && c.ok && waitingCents + c.estimateCents + c.feeCents > this.summary(a).cashCents - this.reserved(a.id).cashCents)
			c.warnings.push(`Zusammen mit ${waiting.length} wartenden Kaufvorschlägen reicht das Cash nicht für alle – bei der Freigabe wird neu geprüft.`);
		const check: Check = { ...c, ok: c.ok && !extra.length, violations: [...extra, ...c.violations] };
		if (!check.ok && !dryRun && !isUser) this.event("proposal.blocked", author, `Vorschlag ${sideLabel[input.side]} ${num(input.qty)} ${symbol} nicht angelegt: ${check.violations[0]}`);
		if (dryRun || !check.ok) return { ok: check.ok, check, proposal: null };
		const now = this.now();
		const id = this.db.tx(() => {
			const { lastId } = this.db.run(
				`INSERT INTO proposal (account_id, author, symbol, side, qty, order_type, limit_price, stop_loss, take_profit, confidence, thesis, status, quote_price, warnings, created_at, expires_at, raw)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`,
				a.id, author, symbol, input.side, roundQty(input.qty), input.orderType, input.limitPrice ?? null, input.side === "buy" ? (input.stopLoss ?? null) : null, input.side === "buy" ? (input.takeProfit ?? null) : null,
				input.confidence, input.thesis, check.price ?? 0, JSON.stringify(check.warnings), now, now + this.cfg.proposalTtlHours * 3_600_000, JSON.stringify(raw).slice(0, 4000),
			);
			if (!isUser) this.event("proposal.new", author, `${author} schlägt vor: ${sideLabel[input.side]} ${num(input.qty)} ${symbol} (${a.name}) #${lastId}`, { to: [this.cfg.user], ref: `#${lastId}` });
			else this.execute(lastId, roundQty(input.qty), this.cfg.user);
			return lastId;
		});
		if (this.proposalRow(id).status === "sending") await this.sendToBroker(id);
		this.emit("tick", { at: now });
		return { ok: true, check, proposal: this.proposal(id) };
	}

	/**
	 * Prüfung direkt bevor eine Order rausgeht (Freigabe, Bestätigen einer Broker-Rückfrage): Kursbewegung seit dem
	 * Vorschlag (bei Agenten) und die volle Risikoprüfung. null heißt: darf raus.
	 */
	private verdict(r: ProposalRow, qty: number): { status: "stale" | "rejected"; reason: string } | null {
		const a = this.account(r.account_id);
		const p = this.priced(r.symbol);
		if (r.author !== this.cfg.user && p && movePct(r.quote_price, p.price) > this.cfg.staleMovePct)
			return { status: "stale", reason: `Kurs hat sich um ${pct(movePct(r.quote_price, p.price))} bewegt (${num(r.quote_price)} → ${num(p.price)} ${p.currency}) – nichts ausgeführt. Agent soll neu vorschlagen.` };
		const check = this.check(a, { side: r.side, qty, orderType: r.order_type, limitPrice: r.limit_price, stopLoss: r.stop_loss, takeProfit: r.take_profit, symbol: r.symbol }, { byAgent: r.author !== this.cfg.user, exclude: r.id });
		if (!check.ok) return { status: "rejected", reason: `Risikoprüfung vor dem Senden: ${check.violations.join(" ")}` };
		return null;
	}

	/** Ausführen innerhalb einer Transaktion; nimmt den Vorschlag nur, solange er noch "pending" ist. */
	private execute(id: number, qty: number, by: string): Proposal {
		const r = this.proposalRow(id);
		const a = this.account(r.account_id);
		const now = this.now();
		const p = this.priced(r.symbol);
		const set = (status: ProposalStatus, fields: Record<string, unknown> = {}) => {
			const cols = Object.keys(fields);
			const { changes } = this.db.run(
				`UPDATE proposal SET status = ?, decided_at = ?, decided_by = ?, approved_qty = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ? AND status = 'pending'`,
				status, now, by, qty, ...cols.map((c) => fields[c]), id,
			);
			if (!changes) throw new DeskError("Dieser Vorschlag wurde schon entschieden.", 409, this.proposal(id));
		};
		const label = `${sideLabel[r.side]} ${num(qty)} ${r.symbol} #${id}`;
		const notify = r.author === this.cfg.user ? undefined : { to: [r.author], ref: `#${id}` };
		const v = this.verdict(r, qty);
		if (v) {
			set(v.status, { reason: v.reason });
			this.event(v.status === "stale" ? "proposal.stale" : "proposal.rejected", by, `${label}: ${v.reason}`, notify);
			return this.proposal(id);
		}
		if (a.kind === "broker") {
			// echtes Geld nur mit Hauptschalter; Senden passiert nach der Transaktion (Netzwerk), hier nur reservieren
			if (a.live && !this.cfg.liveTrading) {
				const reason = `Live-Handel ist aus – in config.json "liveTrading": true setzen, um echte Orders an ${a.broker} zu senden.`;
				set("rejected", { reason });
				this.event("proposal.rejected", by, `${label}: ${reason}`, notify);
				return this.proposal(id);
			}
			set("sending", { expires_at: now + PLACED_DAYS * 86_400_000, status_at: now });
			return this.proposal(id);
		}
		if (a.kind === "manual") {
			set("placed", { expires_at: now + PLACED_DAYS * 86_400_000 });
			this.event("proposal.placed", by, `${label} freigegeben – jetzt in ${a.broker} ausführen und die Ausführung eintragen.`, notify);
			return this.proposal(id);
		}
		if (r.order_type === "limit" && r.limit_price && (!crossed(r.side, p!.price, r.limit_price) || !this.inSession(r.symbol))) {
			set("open", { expires_at: now + OPEN_LIMIT_DAYS * 86_400_000 });
			this.event("proposal.open", by, `${label} freigegeben – Limit ${num(r.limit_price)} ${p!.currency} offen.`, notify);
			return this.proposal(id);
		}
		if (!this.inSession(r.symbol)) {
			// Papier füllt nur zur Handelszeit – sonst zum letzten Schlusskurs, mit dem Wissen von heute
			set("open", { expires_at: now + MARKET_WAIT_DAYS * 86_400_000, reason: "wartet auf den Handelsbeginn" });
			this.event("proposal.open", by, `${label} freigegeben – wartet auf den Handelsbeginn.`, notify);
			return this.proposal(id);
		}
		set("filled", { fill_price: p!.price });
		this.insertTrade(a, { symbol: r.symbol, side: r.side, qty, price: p!.price, currency: p!.currency, fx: p!.fx, feeCents: a.feeCents, time: now, source: r.author === this.cfg.user ? "order" : "proposal", proposalId: id, note: "" });
		this.event("trade.fill", by, `${label} zu ${num(p!.price)} ${p!.currency} ausgeführt (${a.name})`, notify);
		return this.proposal(id);
	}

	/** Freigabe – nur von dir, nur verkleinern (weniger Stück), nie vergrößern. */
	async approve(id: number, body: { qty?: unknown }): Promise<Proposal> {
		const r = this.proposalRow(id);
		if (r.status !== "pending") throw new DeskError("Dieser Vorschlag wurde schon entschieden.", 409, this.toProposal(r));
		let qty = r.qty;
		if (body.qty !== undefined) {
			qty = parseQty(body.qty); // 0,0000001 wird nicht zu 0 gerundet und abgelehnt, sondern ist eine falsche Eingabe
			if (qty > r.qty + 1e-9) throw new DeskError(`Freigeben darfst du höchstens ${num(r.qty)} Stück – mehr als vorgeschlagen geht nicht.`);
		}
		await this.refresh([r.symbol]); // direkt vor dem Schreiben neu lesen
		// ein alter Kurs entscheidet nichts – der Vorschlag bleibt offen, du gibst später frei
		const stale = this.quoteProblem(r.symbol);
		if (stale) throw new DeskError(`${stale} Nichts ausgeführt, der Vorschlag wartet weiter.`, 409, this.toProposal(r));
		const out = this.db.tx(() => this.execute(id, qty, this.cfg.user));
		if (out.status === "sending") await this.sendToBroker(id);
		this.emit("tick", { at: this.now() });
		return this.proposal(id);
	}

	reject(id: number, reason: unknown): Proposal {
		const r = this.proposalRow(id);
		const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
		const { changes } = this.db.run("UPDATE proposal SET status = 'rejected', reason = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", why || "von dir abgelehnt", this.now(), this.cfg.user, id);
		if (!changes) throw new DeskError("Dieser Vorschlag wurde schon entschieden.", 409, this.toProposal(r));
		this.event("proposal.rejected", this.cfg.user, `${sideLabel[r.side]} ${num(r.qty)} ${r.symbol} #${id} von ${r.author} abgelehnt${why ? `: ${why}` : ""}`, r.author === this.cfg.user ? undefined : { to: [r.author], ref: `#${id}` });
		return this.proposal(id);
	}

	async cancel(id: number): Promise<Proposal> {
		const r = this.proposalRow(id);
		const a = this.account(r.account_id);
		if (a.kind === "broker" && r.status === "placed" && r.broker_order_id) {
			// beim Broker stornieren; endgültig "storniert" erst, wenn der Broker es meldet (eine Order kann schon ausgeführt sein)
			try {
				await this.brokerOf(a.id).cancel(r.broker_order_id);
			} catch (e) {
				throw new DeskError(`Storno bei ${a.broker} fehlgeschlagen: ${(e as Error).message}`, 502);
			}
			this.db.run("UPDATE proposal SET reason = 'Storno beim Broker angefragt' WHERE id = ?", id);
			this.event("proposal.cancel", this.cfg.user, `${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} #${id}: Storno an ${a.broker} gesendet`);
			await this.pollBroker(a.id).catch(() => undefined);
			return this.proposal(id);
		}
		const { changes } = this.db.run(`UPDATE proposal SET status = 'cancelled', reason = 'von dir storniert', decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, ?) WHERE id = ? AND status IN ('open','placed','confirm')`, this.now(), this.cfg.user, id);
		if (!changes) throw new DeskError("Nur offene Limits, Broker-Rückfragen und noch nicht eingetragene Broker-Orders lassen sich stornieren.", 409, this.toProposal(r));
		this.event("proposal.cancelled", this.cfg.user, `${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} storniert`);
		return this.proposal(id);
	}

	/** Ausführung beim Broker eintragen (manuelles Depot): was dort wirklich passiert ist, in EUR. */
	fill(id: number, body: { qty?: unknown; price?: unknown; feeEur?: unknown; time?: unknown }): Proposal {
		const r = this.proposalRow(id);
		if (r.status !== "placed") throw new DeskError("Nur freigegebene Broker-Orders lassen sich als ausgeführt eintragen.", 409, this.toProposal(r));
		const a = this.account(r.account_id);
		if (a.kind !== "manual") throw new DeskError(`Ausführungen von ${a.broker} kommen automatisch über die API.`, 409, this.toProposal(r));
		const max = r.approved_qty ?? r.qty;
		const qty = body.qty === undefined || body.qty === null ? max : parseQty(body.qty);
		if (qty > max + 1e-9) throw new DeskError(`Stück zwischen 0 und ${num(max)}.`);
		const price = parsePrice(body.price, "Ausführungskurs in EUR");
		const feeCents = parseFeeCents(body.feeEur, a.feeCents);
		const time = typeof body.time === "number" && body.time > 0 && body.time <= this.now() + 60_000 ? body.time : this.now();
		if (r.side === "sell" && (this.book(a.id).holdings.get(r.symbol)?.qty ?? 0) + 1e-9 < qty) throw new DeskError(`Im Depot sind weniger als ${num(qty)} Stück ${r.symbol}.`);
		this.db.tx(() => {
			const { changes } = this.db.run("UPDATE proposal SET status = 'filled', fill_price = ?, approved_qty = ? WHERE id = ? AND status = 'placed'", price, qty, id);
			if (!changes) throw new DeskError("Schon eingetragen.", 409);
			this.insertTrade(a, { symbol: r.symbol, side: r.side, qty, price, currency: "EUR", fx: 1, feeCents, time, source: "proposal", proposalId: id, note: "" });
			this.event("trade.fill", this.cfg.user, `${sideLabel[r.side]} ${num(qty)} ${r.symbol} #${id} zu ${num(price)} € in ${a.broker} ausgeführt`, r.author === this.cfg.user ? undefined : { to: [r.author], ref: `#${id}` });
		});
		this.emit("tick", { at: this.now() });
		return this.proposal(id);
	}

	private insertTrade(a: Account, t: { symbol: string; side: Side; qty: number; price: number; currency: string; fx: number; feeCents: number; time: number; source: Trade["source"]; proposalId: number | null; note: string; importKey?: string }): number {
		const { lastId, changes } = this.db.run(
			"INSERT OR IGNORE INTO trade (account_id, symbol, side, qty, price, currency, fx, value_cents, fee_cents, time, source, proposal_id, note, import_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			a.id, t.symbol, t.side, roundQty(t.qty), t.price, t.currency, t.fx, orderValueCents(t.qty, t.price, t.fx), t.feeCents, t.time, t.source, t.proposalId, t.note, t.importKey ?? null,
		);
		return changes ? lastId : 0;
	}

	/* ------------------------------------------------------------------ Broker (IBKR) */

	private brokerOf(accountId: string): Broker {
		const b = this.brokers.get(accountId);
		if (!b) throw new DeskError(`${this.account(accountId).name}: keine Broker-Verbindung eingerichtet.`, 409);
		return b;
	}

	brokerStatus(accountId: string): BrokerStatus {
		const a = this.account(accountId);
		const b = this.brokers.get(accountId);
		return (
			this.brokerState.get(accountId) ?? {
				accountId, adapter: b?.adapter ?? "–", connected: false, authenticated: false, brokerAccount: null, paper: null, live: a.live, liveTrading: this.cfg.liveTrading,
				message: b ? "Noch nicht geprüft." : "Keine Broker-Verbindung eingerichtet.", checkedAt: null, loginUrl: b?.loginUrl ?? null,
			}
		);
	}

	brokerStatuses(): BrokerStatus[] {
		return this.cfg.accounts.filter((a) => a.kind === "broker").map((a) => this.brokerStatus(a.id));
	}

	/** Symbol zu einer Kontrakt-ID dieses Depots (aus gesendeten Orders, dem Abgleich oder config.json). */
	private symbolOfConid(accountId: string, conid: number | null): string | null {
		if (conid === null) return null;
		const known = this.db.get<{ symbol: string }>("SELECT symbol FROM broker_conid WHERE account_id = ? AND conid = ?", accountId, conid)?.symbol;
		return known ?? Object.entries(this.cfg.brokers[accountId]?.conids ?? {}).find(([, c]) => c === conid)?.[0] ?? null;
	}

	private rememberConid(accountId: string, conid: number, symbol: string) {
		this.db.run("INSERT INTO broker_conid (account_id, conid, symbol) VALUES (?,?,?) ON CONFLICT (account_id, conid) DO UPDATE SET symbol = excluded.symbol", accountId, conid, symbol);
	}

	/** Einmal je Schlüssel (Tabelle setting): für Hinweise, die bei jedem Abruf wieder auftreten würden. */
	private noteOnce(key: string, fn: () => void) {
		if (this.db.run("INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)", key, String(this.now())).changes) fn();
	}

	/**
	 * Kennung dieser Installation (zufällig, einmal erzeugt). Steht in jeder Client-Order-ID, damit desk-<id> aus einer
	 * neuen, wiederhergestellten oder zweiten Datenbank nie mit einer alten Order desselben IBKR-Kontos verwechselt wird.
	 */
	get installId(): string {
		const row = this.db.get<{ value: string }>("SELECT value FROM setting WHERE key = 'install_id'");
		if (row) return row.value;
		this.db.run("INSERT OR IGNORE INTO setting (key, value) VALUES ('install_id', ?)", randomBytes(4).toString("hex"));
		return this.db.get<{ value: string }>("SELECT value FROM setting WHERE key = 'install_id'")!.value;
	}

	/** Client-Order-ID eines Vorschlags; Orders von vor Migration 4 hießen desk-<id>. */
	private coidOf(r: ProposalRow): string {
		return r.broker_coid ?? `desk-${r.id}`;
	}

	/** Beim Broker gebuchte Stück und Durchschnittskurs eines Vorschlags (aus den Trades – die Wahrheit des Buchs). */
	private fillsOf(id: number): { qty: number; avg: number | null } {
		const f = this.db.get<{ q: number | null; v: number | null }>("SELECT SUM(qty) AS q, SUM(qty * price) AS v FROM trade WHERE proposal_id = ? AND deleted_at IS NULL", id);
		const qty = roundQty(f?.q ?? 0);
		return { qty, avg: qty > 0 ? (f!.v ?? 0) / qty : null };
	}

	/** Reservierte Order ("sending") an den Broker geben. Ergebnis: beim Broker, Rückfrage, abgelehnt oder unbekannt. */
	private async sendToBroker(id: number): Promise<void> {
		const r = this.proposalRow(id);
		if (r.status !== "sending") return;
		const a = this.account(r.account_id);
		const notify = r.author === this.cfg.user ? undefined : { to: [r.author], ref: `#${id}` };
		const label = `${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} #${id}`;
		const fail = (msg: string) => {
			this.db.run("UPDATE proposal SET status = 'rejected', reason = ?, status_at = ? WHERE id = ? AND status = 'sending'", `${a.broker}: ${msg}`, this.now(), id);
			this.event("proposal.rejected", "Desk", `${label}: ${a.broker} – ${msg}`, notify);
		};
		// bis hierher ist nichts gesendet: jeder Fehler ist eine Ablehnung
		let broker: Broker;
		try {
			broker = this.brokerOf(a.id);
			const session = await broker.session();
			if (!session.account) return fail(session.message || "nicht angemeldet");
			if (a.live && session.paper === true) return fail("das Gateway ist mit einem Papierkonto angemeldet, das Depot ist aber als echtes Konto eingetragen");
		} catch (e) {
			return fail((e as Error).message);
		}
		let conid: number;
		try {
			conid = (await broker.resolve(r.symbol)).conid;
		} catch (e) {
			return fail((e as Error).message);
		}
		const cOID = `desk-${this.installId}-${id}`;
		this.rememberConid(a.id, conid, r.symbol);
		this.db.run("UPDATE proposal SET broker_conid = ?, broker_coid = ?, status_at = ? WHERE id = ?", conid, cOID, this.now(), id);
		let res: PlaceResult;
		try {
			res = await broker.place({ conid, side: r.side, qty: r.approved_qty ?? r.qty, type: r.order_type, limit: r.limit_price, cOID });
		} catch (e) {
			res = { kind: "unknown", message: (e as Error).message }; // ab hier kann die Order beim Broker sein
		}
		this.applyPlace(id, res);
	}

	private applyPlace(id: number, res: PlaceResult) {
		const r = this.proposalRow(id);
		const a = this.account(r.account_id);
		const now = this.now();
		const notify = r.author === this.cfg.user ? undefined : { to: [r.author], ref: `#${id}` };
		const label = `${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} #${id}`;
		if (res.kind === "submitted") {
			this.db.run("UPDATE proposal SET status = 'placed', broker_order_id = ?, broker_message = NULL, reply_id = NULL, reason = '', status_at = ?, last_seen_at = ? WHERE id = ? AND status = 'sending'", res.orderId, now, now, id);
			this.event("broker.sent", "Desk", `${label} an ${a.broker} gesendet (Order ${res.orderId}${a.live ? ", echtes Geld" : ", Papierkonto"})`, notify);
		} else if (res.kind === "reply") {
			this.db.run("UPDATE proposal SET status = 'confirm', reply_id = ?, broker_message = ?, status_at = ? WHERE id = ? AND status = 'sending'", res.replyId, res.message.slice(0, 1000), now, id);
			this.event("broker.confirm", "Desk", `${label}: ${a.broker} fragt nach – „${res.message.slice(0, 200)}“ – bitte unter Orders bestätigen oder stornieren.`, { to: [this.cfg.user], ref: `#${id}` });
		} else if (res.kind === "unknown") {
			// keine sichere Antwort: die Order kann beim Broker arbeiten. Sie bleibt "wird gesendet"; der Abruf findet sie über
			// ihre Client-Order-ID oder sagt nach 5 Minuten, dass du beim Broker nachsehen musst. Nie erneut senden.
			const reason = `Keine sichere Antwort von ${a.broker} (${res.message}) – Ergebnis unbekannt. Der Desk sucht die Order über ihre ID und sendet nicht erneut.`;
			this.db.run("UPDATE proposal SET reason = ?, status_at = ? WHERE id = ? AND status = 'sending'", reason.slice(0, 500), now, id);
			this.event("broker.unknown", "Desk", `${label}: ${reason}`, { to: [this.cfg.user, ...(notify?.to ?? [])], ref: `#${id}` });
		} else {
			this.db.run("UPDATE proposal SET status = 'rejected', reason = ?, status_at = ? WHERE id = ? AND status = 'sending'", `${a.broker}: ${res.message}`.slice(0, 500), now, id);
			this.event("proposal.rejected", "Desk", `${label}: ${a.broker} hat abgelehnt – ${res.message}`, notify);
		}
	}

	/**
	 * Rückfrage des Brokers bestätigen – nur du, im Browser, nach dem Lesen des Originaltexts. Bestätigen ist der Moment,
	 * in dem die Order wirklich losgeht: Kursalter, Kursbewegung, Risikoprüfung und Sitzung werden wie bei der Freigabe
	 * neu geprüft, und eine Rückfrage gilt nur 15 Minuten.
	 */
	async confirmBroker(id: number): Promise<Proposal> {
		const r = this.proposalRow(id);
		if (r.status !== "confirm" || !r.reply_id) throw new DeskError("Hier gibt es keine offene Rückfrage des Brokers.", 409, this.toProposal(r));
		if (this.killSwitch) throw new DeskError("Not-Aus ist aktiv – keine Orders, bis du ihn ausschaltest.", 409, this.toProposal(r));
		const a = this.account(r.account_id);
		if (a.live && !this.cfg.liveTrading) throw new DeskError(`Live-Handel ist aus – in config.json "liveTrading": true setzen.`, 409, this.toProposal(r));
		const notify = r.author === this.cfg.user ? undefined : { to: [r.author], ref: `#${id}` };
		const label = `${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} #${id}`;
		const end = (status: ProposalStatus, reason: string, kind: string) => {
			if (this.db.run("UPDATE proposal SET status = ?, reason = ?, status_at = ? WHERE id = ? AND status = 'confirm'", status, reason.slice(0, 500), this.now(), id).changes)
				this.event(kind, this.cfg.user, `${label}: ${reason}`, notify);
			this.emit("tick", { at: this.now() });
			return this.proposal(id);
		};
		if (this.now() - (r.status_at ?? r.decided_at ?? r.created_at) > CONFIRM_TTL_MS) return end("expired", "Rückfrage des Brokers nicht innerhalb von 15 Minuten bestätigt – nichts gesendet.", "proposal.expired");
		await this.refresh([r.symbol]);
		const stale = this.quoteProblem(r.symbol);
		if (stale) throw new DeskError(`${stale} Nichts gesendet, die Rückfrage wartet weiter.`, 409, this.toProposal(r));
		const verdict = this.verdict(r, r.approved_qty ?? r.qty);
		if (verdict) return end(verdict.status, verdict.reason, verdict.status === "stale" ? "proposal.stale" : "proposal.rejected");
		const broker = this.brokerOf(a.id);
		const session = await broker.session();
		if (!session.account) throw new DeskError(`${a.broker}: ${session.message || "nicht angemeldet"} – erst im Gateway anmelden, dann bestätigen.`, 409, this.toProposal(r));
		if (a.live && session.paper === true) return end("rejected", "das Gateway ist mit einem Papierkonto angemeldet, das Depot ist aber als echtes Konto eingetragen", "proposal.rejected");
		if (!this.db.run("UPDATE proposal SET status = 'sending', status_at = ? WHERE id = ? AND status = 'confirm'", this.now(), id).changes) throw new DeskError("Schon bestätigt.", 409);
		let res: PlaceResult;
		try {
			res = await broker.confirm(r.reply_id);
		} catch (e) {
			res = { kind: "unknown", message: (e as Error).message };
		}
		this.applyPlace(id, res);
		this.emit("tick", { at: this.now() });
		return this.proposal(id);
	}

	/** Sitzung prüfen, wach halten, Orderstatus und Ausführungen abholen. */
	async pollBroker(accountId: string): Promise<void> {
		const a = this.account(accountId);
		const broker = this.brokerOf(accountId);
		const session = await broker.session();
		this.brokerState.set(accountId, {
			accountId, adapter: broker.adapter, connected: session.connected, authenticated: session.authenticated, brokerAccount: session.account, paper: session.paper, live: a.live,
			liveTrading: this.cfg.liveTrading, message: session.message, checkedAt: this.now(), loginUrl: broker.loginUrl,
		});
		if (!session.account) return;
		await broker.keepAlive();
		const orders = await broker.orders();
		const execs = await broker.executions();
		const missing = new Set<string>(); // Instrumente oder Wechselkurse, ohne die eine Ausführung noch nicht gebucht wird
		this.db.tx(() => {
			const now = this.now();
			// unterbrochen oder ohne Antwort gesendet: über die Client-Order-ID beim Broker wiederfinden, nie erneut senden
			for (const r of this.db.all<ProposalRow>("SELECT * FROM proposal WHERE account_id = ? AND status = 'sending' AND COALESCE(status_at, decided_at) < ?", accountId, now - 60_000)) {
				const o = orders.find((x) => x.cOID === this.coidOf(r));
				if (o) {
					if (this.db.run("UPDATE proposal SET status = 'placed', broker_order_id = ?, reason = '', status_at = ?, last_seen_at = ? WHERE id = ? AND status = 'sending'", o.orderId, now, now, r.id).changes)
						this.event("broker.sent", "Desk", `${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} #${r.id}: bei ${a.broker} gefunden (Order ${o.orderId}).`, { to: [this.cfg.user], ref: `#${r.id}` });
				} else if ((r.status_at ?? r.decided_at!) < now - 5 * 60_000 && this.db.run("UPDATE proposal SET status = 'rejected', reason = ?, status_at = ? WHERE id = ? AND status = 'sending'", `Senden an ${a.broker} unterbrochen – Order dort nicht gefunden. Bei ${a.broker} prüfen; der Desk sendet nicht erneut.`, now, r.id).changes)
					this.event("proposal.rejected", "Desk", `${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} #${r.id}: Senden an ${a.broker} unterbrochen – bitte dort prüfen.`, { to: [this.cfg.user], ref: `#${r.id}` });
			}
			for (const e of execs) this.importExecution(a, e, missing);
			this.syncOrders(a, orders, now);
		});
		if (missing.size) await this.refresh([...missing]).catch(() => undefined); // beim nächsten Abruf wird gebucht
	}

	/** Orderstatus des Brokers auf die Vorschläge übertragen; Ausführungen (Trades) sind die Wahrheit über die Stückzahl. */
	private syncOrders(a: Account, orders: BrokerOrder[], now: number) {
		const rows = this.db.all<ProposalRow>("SELECT * FROM proposal WHERE account_id = ? AND broker_order_id IS NOT NULL AND status IN ('placed','filled','cancelled','rejected','expired')", a.id);
		for (const r of rows) {
			const o = orders.find((x) => x.orderId === r.broker_order_id || x.cOID === this.coidOf(r));
			const want = r.approved_qty ?? r.qty;
			const f = this.fillsOf(r.id);
			const notify = { to: r.author === this.cfg.user ? [this.cfg.user] : [this.cfg.user, r.author], ref: `#${r.id}` };
			const label = `${sideLabel[r.side]} ${num(want)} ${r.symbol} #${r.id}`;
			const part = (q: number) => `teilweise ausgeführt: ${num(q)} von ${num(want)} Stück`;
			if (f.qty > 0 && f.qty !== (r.filled_qty ?? 0)) this.db.run("UPDATE proposal SET filled_qty = ?, fill_price = ? WHERE id = ?", f.qty, f.avg, r.id);
			if (r.status === "filled") continue;
			if (r.status !== "placed") {
				// schon storniert, abgelehnt oder abgelaufen – und trotzdem kommt eine Ausführung (z. B. während PendingCancel)
				if (f.qty > (r.filled_qty ?? 0) + 1e-9) {
					const full = f.qty >= want - 1e-9;
					this.db.run("UPDATE proposal SET status = ?, reason = ?, status_at = ? WHERE id = ?", full ? "filled" : r.status, full ? "" : `${part(f.qty)}, Rest ${r.reason || "nicht ausgeführt"}`.slice(0, 500), now, r.id);
					this.event("trade.fill", "Desk", `${label}: nach „${r.reason || r.status}“ doch bei ${a.broker} ausgeführt (${num(f.qty)} Stück) – Bestand prüfen.`, notify);
				}
				continue;
			}
			if (o) this.db.run("UPDATE proposal SET last_seen_at = ? WHERE id = ?", now, r.id);
			if (o?.status === "filled" || f.qty >= want - 1e-9) {
				if (this.db.run("UPDATE proposal SET status = 'filled', fill_price = COALESCE(?, fill_price), reason = '', status_at = ? WHERE id = ? AND status = 'placed'", f.avg ?? o?.avgPrice ?? null, now, r.id).changes)
					this.event("trade.fill", "Desk", `${label} bei ${a.broker} ausgeführt${f.avg ?? o?.avgPrice ? ` zu ${num(f.avg ?? o!.avgPrice!)}` : ""}`, notify);
			} else if (o && (o.status === "cancelled" || o.status === "rejected")) {
				const why = `${o.status === "cancelled" ? `bei ${a.broker} storniert` : `von ${a.broker} abgelehnt`}${f.qty > 0 ? ` (${part(f.qty)})` : ""}`;
				if (this.db.run("UPDATE proposal SET status = ?, reason = ?, status_at = ? WHERE id = ? AND status = 'placed'", o.status, why, now, r.id).changes) this.event("proposal.cancelled", "Desk", `${label} ${why}`, notify);
			} else if (!o) {
				// nicht mehr gelistet (eine Tagesorder verschwindet am nächsten Tag): nach 24 h ohne Lebenszeichen abgelaufen
				const seen = r.last_seen_at ?? r.status_at ?? r.decided_at ?? r.created_at;
				if (now - seen > UNLISTED_MS) {
					const why = `bei ${a.broker} nicht mehr gelistet – dort prüfen${f.qty > 0 ? ` (${part(f.qty)})` : ""}`;
					if (this.db.run("UPDATE proposal SET status = 'expired', reason = ?, status_at = ? WHERE id = ? AND status = 'placed'", why, now, r.id).changes) this.event("proposal.expired", "Desk", `${label} ${why}`, notify);
				}
			} else if (o.rawStatus.toLowerCase() === "inactive") {
				this.noteOnce(`inactive:${r.id}`, () => {
					this.db.run("UPDATE proposal SET broker_message = ? WHERE id = ?", `${a.broker} meldet „Inactive“ – die Order arbeitet nicht, kann aber wieder aktiv werden (z. B. außerhalb der Handelszeit). Bei ${a.broker} prüfen.`, r.id);
					this.event("broker.inactive", "Desk", `${label}: ${a.broker} meldet „Inactive“ – bitte dort prüfen.`, notify);
				});
			}
		}
	}

	/** Ausführung des Brokers einmalig als Trade buchen (Schlüssel: Ausführungs-ID), auch wenn sie nicht vom Desk kam. */
	private importExecution(a: Account, e: BrokerExecution, missing: Set<string>) {
		const key = `exec:${e.id}`;
		if (this.db.get("SELECT 1 FROM trade WHERE account_id = ? AND import_key = ?", a.id, key)) return;
		// einem Vorschlag nur zuordnen, wenn Depot, Client-Order-ID und Kontrakt passen
		const byCoid = e.cOID?.startsWith("desk-") ? this.db.get<ProposalRow>("SELECT * FROM proposal WHERE account_id = ? AND (broker_coid = ? OR (broker_coid IS NULL AND 'desk-' || id = ?))", a.id, e.cOID, e.cOID) : undefined;
		const proposal = byCoid && byCoid.broker_conid !== null && e.conid !== null && byCoid.broker_conid === e.conid ? byCoid : undefined;
		if (byCoid && !proposal)
			this.noteOnce(`mismatch:${a.id}:${e.id}`, () => this.event("broker.mismatch", "Desk", `${a.broker}: Ausführung ${e.id} trägt die Order-ID von #${byCoid.id}, aber einen anderen Kontrakt (${e.conid ?? "?"} statt ${byCoid.broker_conid ?? "?"}) – nicht diesem Vorschlag zugeordnet.`, { to: [this.cfg.user], ref: `#${byCoid.id}` }));
		const symbol = proposal?.symbol ?? this.symbolOfConid(a.id, e.conid);
		if (!symbol) {
			this.noteOnce(`unmapped:${a.id}:${e.conid}`, () => this.event("broker.unknown", "Desk", `${a.broker}: Ausführung für Kontrakt ${e.conid} ohne Symbol – in config.json unter "conids" zuordnen, dann „Mit ${a.broker} abgleichen“.`));
			return;
		}
		// vom Abgleich schon im Bestand übernommen: nicht noch einmal buchen
		const reconciled = Number(this.db.get<{ value: string }>("SELECT value FROM setting WHERE key = ?", `reconciled:${a.id}:${e.conid}`)?.value ?? 0);
		if (!proposal && e.conid !== null && e.time <= reconciled) return;
		// ohne Währung und Wechselkurs wird nichts geraten (nie fx = 1): warten, Kurs holen, beim nächsten Abruf buchen
		const inst = this.instrument(symbol);
		const fx = inst ? this.fx(inst.currency) : null;
		const feeFx = e.commissionCurrency ? this.fx(e.commissionCurrency) : fx;
		if (!inst || fx === null || feeFx === null) {
			missing.add(symbol);
			if (inst && inst.currency !== "EUR") missing.add(fxSymbol(inst.currency));
			if (e.commissionCurrency && e.commissionCurrency !== "EUR") missing.add(fxSymbol(e.commissionCurrency));
			this.noteOnce(`fxwait:${a.id}:${e.id}`, () => this.event("broker.wait", "Desk", `${a.broker}: Ausführung ${num(e.qty)} ${symbol} wartet auf ${inst ? `den Wechselkurs ${inst.currency}/EUR` : "Kursdaten (Währung)"} – wird gebucht, sobald er da ist.`));
			return;
		}
		this.insertTrade(a, {
			symbol, side: e.side, qty: e.qty, price: e.price, currency: inst.currency, fx, feeCents: cents(e.commission * feeFx), time: e.time,
			source: proposal ? (proposal.author === this.cfg.user ? "order" : "proposal") : "import", proposalId: proposal?.id ?? null, note: proposal ? "" : `${a.broker}`, importKey: key,
		});
	}

	/** Bestand und Cash beim Broker gegen das Buch des Desks. */
	async reconcile(accountId: string): Promise<Reconcile> {
		const a = this.account(accountId);
		if (a.kind !== "broker") throw new DeskError(`${a.name} ist kein Broker-Depot.`);
		const broker = this.brokerOf(accountId);
		await this.pollBroker(accountId);
		const status = this.brokerStatus(accountId);
		if (!status.brokerAccount) return { status, rows: [], brokerCashCents: null, deskCashCents: this.summary(a).cashCents, differences: 0, cashNote: null };
		const [positions, cash] = await Promise.all([broker.positions(), broker.cash()]);
		const book = this.book(a.id);
		const rows: Reconcile["rows"] = [];
		const seen = new Set<string>();
		for (const p of positions) {
			const symbol = this.symbolOfConid(a.id, p.conid);
			if (symbol) seen.add(symbol);
			rows.push({ symbol, conid: p.conid, description: p.description, brokerQty: p.qty, deskQty: symbol ? (book.holdings.get(symbol)?.qty ?? 0) : 0, avgCost: p.avgCost, currency: p.currency });
		}
		for (const h of book.holdings.values()) if (!seen.has(h.symbol)) rows.push({ symbol: h.symbol, conid: null, description: h.symbol, brokerQty: 0, deskQty: h.qty, avgCost: null, currency: this.instrument(h.symbol)?.currency ?? "EUR" });
		const deskCash = this.summary(a).cashCents;
		// Cash nur in EUR vergleichen: eine andere oder unbekannte Basiswährung wird nicht als EUR gebucht
		const eurCash = cash && cash.currency === "EUR" ? cents(cash.amount) : null;
		const cashNote = cash && cash.currency !== "EUR" ? `Cash bei ${a.broker} in ${cash.currency === "BASE" ? "unbekannter Basiswährung" : cash.currency} – der Desk gleicht nur EUR ab.` : null;
		return { status, rows, brokerCashCents: eurCash, deskCashCents: deskCash, differences: rows.filter((r) => Math.abs(r.brokerQty - r.deskQty) > 1e-9).length + (eurCash !== null && Math.abs(eurCash - deskCash) >= 100 ? 1 : 0), cashNote };
	}

	/**
	 * Abgleich übernehmen: Unterschiede als Eröffnungs-/Korrekturbuchungen und Cash-Ausgleich. Nur du, nur nach Ansicht.
	 * Zuerst die Zuordnungen merken und die damit zuordenbaren Ausführungen buchen, dann nur den Rest als Korrektur – und
	 * Ausführungen bis jetzt für diese Kontrakte als übernommen markieren, damit nichts doppelt gebucht wird.
	 */
	async applyReconcile(accountId: string): Promise<Reconcile> {
		const a = this.account(accountId);
		const first = await this.reconcile(accountId);
		if (!first.status.brokerAccount) throw new DeskError(`${a.broker}: nicht angemeldet – erst im Gateway anmelden.`, 409);
		for (const row of first.rows) if (row.symbol && row.conid !== null) this.rememberConid(a.id, row.conid, row.symbol);
		const r = await this.reconcile(accountId); // bucht die jetzt zuordenbaren Ausführungen
		const skipped: string[] = [];
		this.db.tx(() => {
			const now = this.now();
			for (const row of r.rows) {
				const diff = roundQty(row.brokerQty - row.deskQty);
				if (!row.symbol || Math.abs(diff) < 1e-9) continue;
				const currency = this.instrument(row.symbol)?.currency ?? (row.currency || null);
				const fx = currency ? this.fx(currency) : null;
				const price = row.avgCost ?? this.priced(row.symbol)?.price;
				if (!price || fx === null || !currency) {
					skipped.push(row.symbol);
					continue;
				}
				this.insertTrade(a, { symbol: row.symbol, side: diff > 0 ? "buy" : "sell", qty: Math.abs(diff), price, currency, fx, feeCents: 0, time: now, source: "import", proposalId: null, note: `Abgleich ${a.broker}` });
				if (row.conid !== null) this.db.run("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", `reconciled:${a.id}:${row.conid}`, String(now));
			}
			const deskCash = this.summary(a).cashCents;
			if (r.brokerCashCents !== null && r.brokerCashCents !== deskCash)
				this.db.run("INSERT INTO cash_move (account_id, amount_cents, time, note) VALUES (?,?,?,?)", a.id, r.brokerCashCents - deskCash, now, `Abgleich ${a.broker}`);
			this.event("broker.reconcile", this.cfg.user, `${a.name} mit ${a.broker} abgeglichen (${r.differences} Unterschiede übernommen)${skipped.length ? ` – ohne Kurs oder Wechselkurs nicht übernommen: ${skipped.join(", ")}` : ""}`);
		});
		this.emit("tick", { at: this.now() });
		return this.reconcile(accountId);
	}

	/* ------------------------------------------------------------------ Manuelle Depots */

	private manual(accountId: string): Account {
		const a = this.account(accountId);
		if (a.kind !== "manual") throw new DeskError(`${a.name} ist ein Papierdepot – dort gibt es Orders statt erfasster Trades.`);
		return a;
	}

	async recordTrade(accountId: string, body: Record<string, unknown>): Promise<Trade> {
		const a = this.manual(accountId);
		const symbol = this.normalizeSymbol(body.symbol);
		const side = body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : null;
		if (!side) throw new DeskError("Kauf oder Verkauf?");
		const qty = parseQty(body.qty);
		const price = parsePrice(body.price);
		const feeCents = parseFeeCents(body.feeEur, a.feeCents);
		const time = typeof body.time === "number" && body.time > 0 && body.time <= this.now() + 60_000 ? body.time : this.now();
		const note = typeof body.note === "string" ? body.note.slice(0, 200) : "";
		if (!this.instrument(symbol) && this.market.kind !== "off") await this.refresh([symbol]); // Name und Kurs, wenn Yahoo das Symbol kennt
		const id = this.db.tx(() => {
			if (side === "sell" && (this.book(a.id).holdings.get(symbol)?.qty ?? 0) + 1e-9 < qty) throw new DeskError(`Im Depot sind weniger als ${num(qty)} Stück ${symbol}.`);
			const id = this.insertTrade(a, { symbol, side, qty, price, currency: "EUR", fx: 1, feeCents, time, source: "manual", proposalId: null, note });
			this.event("trade.manual", this.cfg.user, `${sideLabel[side]} ${num(qty)} ${symbol} zu ${num(price)} € erfasst (${a.name})`);
			return id;
		});
		this.emit("tick", { at: this.now() });
		return this.trades(a.id).find((t) => t.id === id)!;
	}

	/** Löschen mit Rückgängig: der Trade wird nur ausgeblendet, restoreTrade holt ihn zurück. */
	deleteTrade(accountId: string, id: number, restore = false) {
		const a = this.manual(accountId);
		const { changes } = this.db.run(
			restore ? "UPDATE trade SET deleted_at = NULL WHERE id = ? AND account_id = ? AND deleted_at IS NOT NULL" : "UPDATE trade SET deleted_at = ? WHERE id = ? AND account_id = ? AND deleted_at IS NULL AND source IN ('manual','import')",
			...(restore ? [id, a.id] : [this.now(), id, a.id]),
		);
		if (!changes) throw new DeskError(restore ? "Nichts zum Wiederherstellen." : "Nur selbst erfasste oder importierte Trades lassen sich löschen.", 404);
		this.event(restore ? "trade.restore" : "trade.delete", this.cfg.user, `Trade ${id} in ${a.name} ${restore ? "wiederhergestellt" : "gelöscht"}`);
		this.emit("tick", { at: this.now() });
	}

	cashMove(accountId: string, body: { amountEur?: unknown; note?: unknown }): CashMove {
		const a = this.account(accountId);
		const v = body.amountEur;
		// endlich, nicht 0, höchstens 100 Mio. € und ganze Cent: -0,004 € ist keine Auszahlung, 1e308 € kein Kontostand
		if (typeof v !== "number" || !Number.isFinite(v) || v === 0 || Math.abs(v) > MAX_EUR || decimals(v) > 2)
			throw new DeskError("Betrag in EUR mit höchstens 2 Nachkommastellen (bis 100 Mio.), positiv für Einzahlung, negativ für Auszahlung.");
		const amount = cents(v);
		if (amount < 0 && this.summary(a).cashCents + amount < 0) throw new DeskError("Auszahlung größer als das Cash im Depot.");
		const note = typeof body.note === "string" ? body.note.slice(0, 200) : "";
		const time = this.now();
		const { lastId } = this.db.run("INSERT INTO cash_move (account_id, amount_cents, time, note) VALUES (?,?,?,?)", a.id, amount, time, note);
		this.event("cash", this.cfg.user, `${amount > 0 ? "Einzahlung" : "Auszahlung"} ${(Math.abs(amount) / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 })} € (${a.name})`);
		this.emit("tick", { at: time });
		return { id: lastId, accountId: a.id, amountCents: amount, time, note };
	}

	async importCsv(accountId: string, text: unknown): Promise<ImportResult> {
		const a = this.manual(accountId);
		if (typeof text !== "string" || !text.trim()) throw new DeskError("Leere Datei.");
		if (text.length > 2_000_000) throw new DeskError("Datei zu groß (höchstens 2 MB).");
		const { rows, errors } = parseTradesCsv(text);
		const foreign = [...new Set(rows.filter((r) => r.currency !== "EUR").map((r) => r.currency))];
		if (foreign.length && this.market.kind !== "off") await this.refresh(foreign.map(fxSymbol));
		const unknown = [...new Set(rows.map((r) => r.symbol))].filter((s) => !this.instrument(s));
		if (unknown.length && this.market.kind !== "off") await this.refresh(unknown);
		let imported = 0;
		let skipped = 0;
		this.db.tx(() => {
			for (const r of rows) {
				const fx = r.currency === "EUR" ? 1 : (this.quoteRow(fxSymbol(r.currency))?.price ?? null);
				if (fx === null) {
					errors.push(`Zeile ${r.line}: kein Wechselkurs für ${r.currency} – Kurs in EUR angeben.`);
					continue;
				}
				const id = this.insertTrade(a, { symbol: r.symbol, side: r.side, qty: r.qty, price: r.price, currency: r.currency, fx, feeCents: r.feeCents, time: r.time, source: "import", proposalId: null, note: r.note, importKey: r.key });
				if (id) imported++;
				else skipped++;
			}
			if (imported) this.event("trade.import", this.cfg.user, `${imported} Trades in ${a.name} importiert${skipped ? `, ${skipped} schon vorhanden` : ""}`);
		});
		this.emit("tick", { at: this.now() });
		return { imported, skipped, errors };
	}

	/* ------------------------------------------------------------------ Risiko */

	risk(): RiskData {
		return {
			killSwitch: this.killSwitch,
			minConfidence: this.cfg.minConfidence,
			staleMovePct: this.cfg.staleMovePct,
			proposalTtlHours: this.cfg.proposalTtlHours,
			accounts: this.cfg.accounts.map((a) => ({ account: a, limits: this.limits(a.id), dayLossPct: this.dayLossPct(a) })),
		};
	}

	setLimits(accountId: string, body: unknown): RiskData {
		const a = this.account(accountId);
		const parsed = RiskLimitsSchema.safeParse({ ...this.limits(a.id), ...(body && typeof body === "object" ? body : {}), accountId: a.id });
		if (!parsed.success) throw new DeskError(`Ungültige Grenze: ${parsed.error.issues[0].path.join(".")} – ${parsed.error.issues[0].message}`);
		const l = parsed.data;
		this.db.run(
			"UPDATE risk SET max_order_cents = ?, max_position_pct = ?, daily_loss_pct = ?, max_open_proposals = ?, max_risk_pct = ?, require_stop = ? WHERE account_id = ?",
			l.maxOrderCents, l.maxPositionPct, l.dailyLossPct, l.maxOpenProposals, l.maxRiskPct, l.requireStop, a.id,
		);
		this.event("risk.limits", this.cfg.user, `Grenzen für ${a.name} geändert`);
		return this.risk();
	}

	setKill(on: boolean): RiskData {
		this.db.run("INSERT INTO setting (key, value) VALUES ('kill_switch', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", on ? "1" : "0");
		this.event("risk.kill", this.cfg.user, on ? "Not-Aus eingeschaltet – keine Freigaben und keine Ausführungen" : "Not-Aus ausgeschaltet");
		this.emit("tick", { at: this.now() });
		return this.risk();
	}

	/* ------------------------------------------------------------------ Journal und Agenten */

	journal(opts: { author?: string; symbol?: string; limit?: number } = {}): JournalEntry[] {
		const where: string[] = [];
		const params: unknown[] = [];
		if (opts.author) {
			where.push("lower(author) = lower(?)");
			params.push(opts.author);
		}
		if (opts.symbol) {
			where.push("symbol = ?");
			params.push(opts.symbol.toUpperCase());
		}
		return this.db.all<JournalEntry>(`SELECT id, author, kind, symbol, text, time FROM journal ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY time DESC, id DESC LIMIT ?`, ...params, opts.limit ?? 100);
	}

	addJournal(body: Record<string, unknown>, origin: Origin): JournalEntry {
		const author = origin === "web" ? this.cfg.user : this.agentName(typeof body.author === "string" ? body.author : "");
		if (!author) throw new DeskError(`Unbekannter Agent „${String(body.author ?? "")}“ – in config.json unter "agents" eintragen.`, 403);
		const kind = body.kind === "thesis" || body.kind === "review" ? body.kind : "note";
		const text = typeof body.text === "string" ? body.text.trim() : "";
		if (!text || text.length > 4000) throw new DeskError("Text fehlt oder ist länger als 4000 Zeichen.");
		const symbol = body.symbol ? this.normalizeSymbol(body.symbol) : null;
		const time = this.now();
		const { lastId } = this.db.run("INSERT INTO journal (author, kind, symbol, text, time) VALUES (?,?,?,?,?)", author, kind, symbol, text, time);
		this.emit("event", { id: 0, time, kind: "journal", actor: author, text: text.slice(0, 120) });
		return { id: lastId, author, kind, symbol, text, time };
	}

	agentsData(): AgentsData {
		const agents = this.cfg.agents.map((name) => {
			const a = this.cfg.accounts.find((x) => x.owner === name)!;
			const s = this.summary(a);
			const book = this.book(a.id);
			const closed = [...book.realizedBySell.values()];
			const count = (status: string) => this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM proposal WHERE author = ? AND ${status}`, name)!.n;
			const last = this.db.get<{ t: number | null }>("SELECT MAX(t) AS t FROM (SELECT MAX(created_at) AS t FROM proposal WHERE author = ? UNION ALL SELECT MAX(time) FROM journal WHERE author = ?)", name, name);
			return {
				name,
				accountId: a.id,
				equityCents: s.equityCents,
				returnPct: s.returnPct,
				curve: this.curve(a, s),
				trades: this.tradeRows(a.id).length,
				closed: closed.length,
				winRate: closed.length ? (closed.filter((x) => x > 0).length / closed.length) * 100 : null,
				pending: count("status = 'pending'"),
				approved: count("status IN ('open','placed','filled')"),
				rejected: count("status IN ('rejected','stale')"),
				lastActive: last?.t ?? null,
			};
		});
		const you = this.cfg.accounts.filter((a) => a.owner === "user").map((a) => {
			const s = this.summary(a);
			return { accountId: a.id, name: a.name, returnPct: s.returnPct, curve: this.curve(a, s) };
		});
		return { agents, you, journal: this.journal({ limit: 80 }) };
	}

	/* ------------------------------------------------------------------ Daytrading */

	private viewers = 0;
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

	private dailyStat(symbol: string): { avg_volume: number | null; atr: number | null } | undefined {
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

	private sessionOf(q: QuoteRow | undefined): SessionState {
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

	startOfDay(): number {
		const d = new Date(this.now());
		return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	}

	dayStatsOf(accountId: string): DayStats {
		const rows = this.tradeRows(accountId);
		return dayStats(rows.map((t) => ({ id: t.id, side: t.side, time: t.time, feeCents: t.fee_cents })), this.book(accountId).realizedBySell, this.startOfDay());
	}

	cockpit(): Cockpit {
		const from = this.startOfDay();
		const positions: CockpitPosition[] = [];
		const days = this.cfg.accounts.map((a) => {
			const s = this.summary(a);
			const rows = this.tradeRows(a.id);
			for (const p of this.positions(a, s)) {
				const fx = this.priced(p.symbol)?.fx ?? null;
				const avgNative = fx ? p.avgPrice / fx : null;
				positions.push({
					accountId: a.id, symbol: p.symbol, name: p.name, currency: p.currency, qty: p.qty, avgPrice: p.avgPrice, price: p.price, nativePrice: p.nativePrice,
					unrealizedCents: p.unrealizedCents, unrealizedPct: p.unrealizedPct, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
					r: avgNative !== null && p.nativePrice !== null ? rMultiple(avgNative, p.stopLoss, p.nativePrice) : null,
					openedToday: rows.some((t) => t.symbol === p.symbol && t.side === "buy" && t.time >= from),
				});
			}
			return { accountId: a.id, name: a.name, owner: a.owner, kind: a.kind, equityCents: s.equityCents, cashCents: s.cashCents, dayChangeCents: s.dayChangeCents, dayLossPct: this.dayLossPct(a, s), stats: this.dayStatsOf(a.id) };
		});
		return {
			user: this.cfg.user,
			killSwitch: this.killSwitch,
			market: this.marketState,
			marketError: this.marketError,
			quotesAt: this.quotesAt,
			liveIntervalSec: this.cfg.liveIntervalSec,
			failedQuotes: [...this.quoteErrors.keys()].sort(),
			sessions: this.sessions(),
			scan: this.scan(),
			days,
			positions,
		};
	}

	/** 15 Minuten vor Handelsschluss: einmal je Börse und Tag erinnern, welche heute eröffneten Positionen noch offen sind. */
	private remindClose() {
		const now = this.now();
		for (const s of this.sessions()) {
			if (s.state !== "open" || !s.regEnd || s.regEnd - now > 15 * 60_000) continue;
			const key = `eod:${s.exchange}:${dayKey(now)}`;
			if (this.db.get("SELECT 1 FROM setting WHERE key = ?", key)) continue;
			this.db.run("INSERT INTO setting (key, value) VALUES (?, '1')", key);
			const open = this.cockpit().positions.filter((p) => p.openedToday && this.instrument(p.symbol)?.exchange === s.exchange);
			if (open.length)
				this.event("close", "Desk", `${s.exchange} schließt in 15 Minuten – heute eröffnet und noch offen: ${open.map((p) => `${p.symbol} (${this.account(p.accountId).name})`).join(", ")}.`, { ref: null });
		}
	}

	/* ------------------------------------------------------------------ Chat */

	chat(opts: { since?: number; limit?: number } = {}): ChatMessage[] {
		const rows = this.db.all<{ id: number; time: number; author: string; role: ChatMessage["role"]; text: string; recipients: string; ref: string | null }>(
			"SELECT * FROM chat WHERE id > ? ORDER BY id DESC LIMIT ?",
			opts.since ?? 0,
			opts.limit ?? 200,
		);
		return rows.reverse().map((r) => ({ id: r.id, time: r.time, author: r.author, role: r.role, text: r.text, to: JSON.parse(r.recipients) as string[], ref: r.ref }));
	}

	private postChat(m: Omit<ChatMessage, "id" | "time">): ChatMessage {
		const time = this.now();
		const text = m.text.slice(0, 4000);
		const { lastId } = this.db.run("INSERT INTO chat (time, author, role, text, recipients, ref) VALUES (?,?,?,?,?,?)", time, m.author, m.role, text, JSON.stringify(m.to), m.ref);
		const msg: ChatMessage = { ...m, text, id: lastId, time };
		this.emit("chat", msg);
		return msg;
	}

	/** Nachricht von dir (Browser) oder einem Agenten (CLI). Erwähnungen @Name nur für bekannte Namen. Der Chat genehmigt nie eine Order. */
	say(body: Record<string, unknown>, origin: Origin): ChatMessage {
		const author = origin === "web" ? this.cfg.user : this.agentName(typeof body.author === "string" ? body.author : "");
		if (!author) throw new DeskError(`Unbekannter Agent „${String(body.author ?? "")}“ – in config.json unter "agents" eintragen.`, 403);
		const text = typeof body.text === "string" ? body.text.trim() : "";
		if (!text) throw new DeskError("Leere Nachricht.");
		if (text.length > 4000) throw new DeskError("Nachricht länger als 4000 Zeichen.");
		const names = [this.cfg.user, ...this.cfg.agents];
		const canon = (n: string) => names.find((x) => x.toLowerCase() === n.toLowerCase()) ?? null;
		const to = new Set<string>();
		for (const m of text.matchAll(/@([\p{L}\p{N}_.-]{1,40})/gu)) {
			const n = canon(m[1]);
			if (n) to.add(n);
		}
		if (Array.isArray(body.to)) for (const n of body.to) if (typeof n === "string" && canon(n)) to.add(canon(n)!);
		to.delete(author);
		const rawRef = typeof body.ref === "string" ? body.ref.trim().toUpperCase() : "";
		const ref = /^(#\d{1,6}|[A-Z0-9.=^-]{1,24})$/.test(rawRef) ? rawRef : null;
		return this.postChat({ author, role: origin === "web" ? "user" : "agent", text, to: [...to], ref });
	}

	/* ------------------------------------------------------------------ Takt */

	/** Kurse holen, Limits ausführen, Abläufe, Alarme, Stop-/Ziel-Hinweise, Tagesstand. */
	tick(): Promise<void> {
		if (this.ticking) return this.ticking;
		this.ticking = (async () => {
			try {
				await this.refresh(this.trackedSymbols());
				await this.refreshDaily(this.scanSymbols().filter((s) => !this.dailyStat(s)).slice(0, 3)).catch(() => undefined);
				for (const id of this.brokers.keys()) await this.pollBroker(id).catch((e) => console.error(`broker ${id}:`, (e as Error).message));
				this.db.tx(() => {
					this.fillLimits();
					this.expire();
					this.checkAlerts();
					this.checkStops();
					this.remindClose();
					this.snapshot();
				});
				this.ticks++;
				this.emit("tick", { at: this.now() });
			} finally {
				this.ticking = null;
			}
		})();
		return this.ticking;
	}

	/** Börse des Symbols offen und der Kurs aus der laufenden Sitzung? */
	private inSession(symbol: string): boolean {
		const q = this.quoteRow(symbol);
		if (!q || this.sessionOf(q) !== "open") return false;
		return q.market_time === null || q.reg_start === null || q.market_time >= q.reg_start;
	}

	/** Offene Papier-Orders: Limits, sobald der Kurs sie erreicht, Market-Orders zur Eröffnung – nur zur Handelszeit. */
	private fillLimits() {
		if (this.killSwitch) return;
		for (const r of this.db.all<ProposalRow>("SELECT * FROM proposal WHERE status = 'open' ORDER BY id")) {
			if (!this.inSession(r.symbol) || this.quoteProblem(r.symbol)) continue; // warten statt auf altem Kurs ausführen
			const p = this.priced(r.symbol);
			if (!p || (r.limit_price && !crossed(r.side, p.price, r.limit_price))) continue;
			const a = this.account(r.account_id);
			const qty = r.approved_qty ?? r.qty;
			const byAgent = r.author !== this.cfg.user;
			const label = `${sideLabel[r.side]} ${num(qty)} ${r.symbol}`;
			if (!r.limit_price && byAgent && movePct(r.quote_price, p.price) > this.cfg.staleMovePct) {
				const reason = `Kurs hat sich bis zur Eröffnung um ${pct(movePct(r.quote_price, p.price))} bewegt (${num(r.quote_price)} → ${num(p.price)} ${p.currency}) – nichts ausgeführt.`;
				if (this.db.run("UPDATE proposal SET status = 'stale', reason = ? WHERE id = ? AND status = 'open'", reason, r.id).changes) this.event("proposal.stale", "Desk", `${label} #${r.id}: ${reason}`, { to: [r.author], ref: `#${r.id}` });
				continue;
			}
			// dieselbe Prüfung wie bei der Freigabe, mit Stop, Risiko je Trade und Stop-Pflicht – ohne sich selbst als Reservierung
			const c = this.check(a, { side: r.side, qty, orderType: "market", stopLoss: r.stop_loss, takeProfit: r.take_profit, symbol: r.symbol }, { byAgent, exclude: r.id });
			if (!c.ok) {
				const what = r.limit_price ? "Limit erreicht" : "Börse offen";
				this.db.run("UPDATE proposal SET status = 'cancelled', reason = ? WHERE id = ? AND status = 'open'", `${what}, aber Risikoprüfung: ${c.violations.join(" ")}`, r.id);
				this.event("proposal.cancelled", "Desk", `${label}: ${what}, nicht ausgeführt – ${c.violations[0]}`, byAgent ? { to: [r.author], ref: `#${r.id}` } : undefined);
				continue;
			}
			if (!this.db.run("UPDATE proposal SET status = 'filled', fill_price = ?, reason = '' WHERE id = ? AND status = 'open'", p.price, r.id).changes) continue;
			this.insertTrade(a, { symbol: r.symbol, side: r.side, qty, price: p.price, currency: p.currency, fx: p.fx, feeCents: a.feeCents, time: this.now(), source: r.author === this.cfg.user ? "order" : "proposal", proposalId: r.id, note: r.limit_price ? "Limit" : "Eröffnung" });
			this.event("trade.fill", "Desk", `${label} #${r.id} zu ${num(p.price)} ${p.currency} ausgeführt (${r.limit_price ? `Limit ${num(r.limit_price)}` : "zur Eröffnung"}, ${a.name})`, { to: r.author === this.cfg.user ? [] : [r.author], ref: `#${r.id}` });
		}
	}

	private expire() {
		const now = this.now();
		// eine unbeantwortete Rückfrage des Brokers verfällt; bestätigt werden kann sie danach nicht mehr
		for (const r of this.db.all<ProposalRow>("SELECT * FROM proposal WHERE status = 'confirm' AND COALESCE(status_at, decided_at, created_at) <= ?", now - CONFIRM_TTL_MS)) {
			if (this.db.run("UPDATE proposal SET status = 'expired', reason = ?, status_at = ? WHERE id = ? AND status = 'confirm'", "Rückfrage des Brokers nicht innerhalb von 15 Minuten bestätigt – nichts gesendet.", now, r.id).changes)
				this.event("proposal.expired", "Desk", `${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} #${r.id}: Rückfrage des Brokers abgelaufen – nichts gesendet.`, { to: r.author === this.cfg.user ? [this.cfg.user] : [this.cfg.user, r.author], ref: `#${r.id}` });
		}
		// Broker-Orders laufen beim Broker ab (Tagesorder); deren Ende meldet der Abruf, nicht diese Uhr
		for (const r of this.db.all<ProposalRow>("SELECT * FROM proposal WHERE status IN ('pending','open','placed') AND expires_at <= ? AND broker_order_id IS NULL", now)) {
			if (this.db.run("UPDATE proposal SET status = 'expired', reason = ? WHERE id = ? AND status = ?", r.status === "pending" ? "nicht rechtzeitig entschieden" : "nicht ausgeführt", r.id, r.status).changes)
				this.event("proposal.expired", "Desk", `${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} von ${r.author} abgelaufen`);
		}
	}

	private checkAlerts() {
		for (const al of this.db.all<{ id: number; symbol: string; op: "above" | "below"; price: number }>("SELECT * FROM alert WHERE triggered_at IS NULL")) {
			const q = this.quoteRow(al.symbol);
			if (!q || !(al.op === "above" ? q.price >= al.price : q.price <= al.price)) continue;
			this.db.run("UPDATE alert SET triggered_at = ? WHERE id = ?", this.now(), al.id);
			this.event("alert", "Desk", `Alarm ${al.symbol} ${al.op === "above" ? "über" : "unter"} ${num(al.price)} – jetzt ${num(q.price)}`, { ref: al.symbol });
		}
	}

	/** Stop-Loss und Kursziel sind Hinweise an dich, keine automatischen Orders. */
	private checkStops() {
		const rows = this.db.all<ProposalRow>("SELECT * FROM proposal WHERE status = 'filled' AND side = 'buy' AND ((stop_loss IS NOT NULL AND stop_hit_at IS NULL) OR (take_profit IS NOT NULL AND target_hit_at IS NULL))");
		for (const r of rows) {
			if (!this.book(r.account_id).holdings.has(r.symbol)) continue;
			const q = this.quoteRow(r.symbol);
			if (!q) continue;
			const a = this.account(r.account_id);
			if (r.stop_loss && !r.stop_hit_at && q.price <= r.stop_loss) {
				this.db.run("UPDATE proposal SET stop_hit_at = ? WHERE id = ?", this.now(), r.id);
				this.event("stop", "Desk", `${r.symbol} hat den Stop-Loss ${num(r.stop_loss)} erreicht (${a.name}) – Verkauf prüfen.`, { to: [this.cfg.user, ...(r.author === this.cfg.user ? [] : [r.author])], ref: r.symbol });
			}
			if (r.take_profit && !r.target_hit_at && q.price >= r.take_profit) {
				this.db.run("UPDATE proposal SET target_hit_at = ? WHERE id = ?", this.now(), r.id);
				this.event("target", "Desk", `${r.symbol} hat das Kursziel ${num(r.take_profit)} erreicht (${a.name}).`, { to: [this.cfg.user, ...(r.author === this.cfg.user ? [] : [r.author])], ref: r.symbol });
			}
		}
	}

	private snapshot() {
		const day = dayKey(this.now());
		for (const a of this.cfg.accounts) {
			const s = this.summary(a);
			this.db.run(
				"INSERT INTO snapshot (account_id, day, equity_cents, deposits_cents) VALUES (?,?,?,?) ON CONFLICT (account_id, day) DO UPDATE SET equity_cents = excluded.equity_cents, deposits_cents = excluded.deposits_cents",
				a.id, day, s.equityCents, s.depositsCents,
			);
		}
	}

	/** Takt: schnell, solange ein Browser zusieht (liveIntervalSec), sonst ruhig; bei Störung der Börse dreifach langsamer. */
	start() {
		this.stop();
		let last = 0;
		let lastKeepAlive = this.now();
		this.timer = setInterval(() => {
			// Broker-Sitzungen eigenständig wach halten – auch bei Kurstakt 3600 s oder gestörter Börse
			if (this.brokers.size && this.now() - lastKeepAlive >= BROKER_KEEPALIVE_MS) {
				lastKeepAlive = this.now();
				for (const [id, b] of this.brokers) void b.keepAlive().catch((e) => console.error(`broker ${id} keepAlive:`, (e as Error).message));
			}
			const every = (this.viewers > 0 ? this.cfg.liveIntervalSec : this.cfg.quoteIntervalSec) * 1000 * (this.marketState === "error" ? 3 : 1);
			if (this.now() - last < every) return;
			last = this.now();
			void this.tick().catch((e) => console.error("tick:", e));
		}, 1000);
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

function crossed(side: Side, price: number, limit: number): boolean {
	return side === "buy" ? price <= limit : price >= limit;
}
