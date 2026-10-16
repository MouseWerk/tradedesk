// Grundlage des Desks: Konfiguration, Datenbank, Uhr, Ereignisse, Depots und Kurse nachschlagen. Ein Prozess, eine
// Datenbank; jede Änderung läuft synchron in einer Transaktion (Node ist einthreadig – zwei Klicks führen nie doppelt aus).
// Die Module unter src/desk/ bauen als Klassenkette aufeinander auf (docs/ARCHITECTURE.md); Desk in desk.ts ist das Ganze.
import { EventEmitter } from "node:events";
import type { Account, ChatMessage, DeskEvent, ProposalStatus, RiskLimits, Side, Trade } from "@desk/shared";
import { PriceSchema, QtySchema, cents, decimals, roundQty } from "@desk/shared";
import type { Config } from "../config.ts";
import type { Database } from "../db.ts";
import { fxSymbol, type Market } from "../market.ts";
import type { Broker } from "../broker.ts";
import { OwnerAuth } from "../auth.ts";
import { MarketFeed, type QuoteFeed } from "../feed.ts";
import { de } from "../i18n/de.ts";

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

export interface TradeRow { id: number; account_id: string; symbol: string; side: Side; qty: number; price: number; currency: string; fx: number; value_cents: number; fee_cents: number; time: number; source: Trade["source"]; proposal_id: number | null; note: string; deleted_at?: number | null }
export interface ProposalRow {
	id: number; account_id: string; author: string; symbol: string; side: Side; qty: number; order_type: "market" | "limit"; limit_price: number | null; stop_loss: number | null; take_profit: number | null;
	confidence: number; thesis: string; status: ProposalStatus; reason: string; quote_price: number; warnings: string; created_at: number; decided_at: number | null; decided_by: string | null;
	approved_qty: number | null; expires_at: number; fill_price: number | null; stop_hit_at: number | null; target_hit_at: number | null;
	broker_order_id: string | null; broker_message: string | null; reply_id: string | null; broker_conid: number | null;
	broker_coid: string | null; status_at: number | null; last_seen_at: number | null; filled_qty: number | null; closed_at: number | null;
}
export interface QuoteRow {
	symbol: string; price: number; prev_close: number | null; market_time: number | null; fetched_at: number; day_open: number | null; day_high: number | null; day_low: number | null; volume: number | null;
	pre_start: number | null; reg_start: number | null; reg_end: number | null; post_end: number | null; timezone: string;
	source: string; bid: number | null; ask: number | null; delayed: number | null;
}
export interface InstrumentRow { symbol: string; name: string; currency: string; exchange: string; type: string }

export const DEFAULT_LIMITS: Omit<RiskLimits, "accountId"> = { maxOrderCents: 500_000, maxPositionPct: 25, dailyLossPct: 5, maxOpenProposals: 5, maxRiskPct: 1, requireStop: true };
export const CONFIRM_TTL_MS = 15 * 60_000; // eine Rückfrage des Brokers gilt so lange; danach neu freigeben
export const MAX_FEE_EUR = 10_000;
export const MIN_TRADE_TIME = new Date(1990, 0, 1).getTime(); // davor erfasst niemand einen Trade – ein Tippfehler
export const dateText = (t: number) => new Date(t).toLocaleDateString("de-DE");

/** Stückzahl aus einer Eingabe: endlich, > 0, höchstens MAX_QTY und 6 Nachkommastellen – sonst 400. */
export function parseQty(v: unknown, what = de.core.qty): number {
	const r = QtySchema.safeParse(v);
	if (!r.success || roundQty(r.data) <= 0) throw new DeskError(de.core.qtyInvalid(what));
	return roundQty(r.data);
}

export function parsePrice(v: unknown, what = de.core.price): number {
	const r = PriceSchema.safeParse(v);
	if (!r.success) throw new DeskError(de.core.priceInvalid(what));
	return r.data;
}

/** Betrag in EUR mit höchstens zwei Nachkommastellen → Cent; fehlt er, gilt fallback. */
export function parseFeeCents(v: unknown, fallback: number): number {
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_FEE_EUR || decimals(v) > 2) throw new DeskError(de.core.feeInvalid(MAX_FEE_EUR.toLocaleString("de-DE")));
	return cents(v);
}

export const num = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 6 });

export abstract class DeskCore extends EventEmitter {
	marketState: "live" | "off" | "error";
	marketError: string | null = null;
	/** Symbol → Fehler des letzten Abrufs (auch wenn andere Symbole Kurse bekamen). */
	readonly quoteErrors = new Map<string, string>();
	quotesAt: number | null = null;
	ticks = 0;
	readonly brokers: Map<string, Broker>;
	readonly feed: QuoteFeed; // Kursquelle (src/feed.ts); ohne Angabe die Market-Schnittstelle wie bisher

	readonly cfg: Config;
	readonly db: Database;
	readonly market: Market;
	readonly now: () => number;
	readonly auth: OwnerAuth; // deine PIN und Sitzungen (ein Objekt je Desk: Sperre nach Fehlversuchen gilt prozessweit)

	constructor(cfg: Config, db: Database, market: Market, now: () => number = Date.now, brokers: Map<string, Broker> = new Map(), feed: QuoteFeed = new MarketFeed(market)) {
		super();
		this.brokers = brokers;
		this.feed = feed;
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

	/**
	 * SQL-Bedingung: nur Zeilen von Depots, die config.json noch kennt. Ein entferntes Depot (z. B. Papier abgeschaltet)
	 * behält seine Daten in der Datenbank, taucht aber nirgends mehr auf – und bricht keine Liste oder keinen Takt ab.
	 * Die IDs sind von cleanConfig geprüft ([a-z0-9-]), das Einsetzen ist sicher.
	 */
	protected knownAccounts(col = "account_id"): string {
		return `${col} IN (${this.cfg.accounts.map((a) => `'${a.id}'`).join(",") || "''"})`;
	}

	account(id: string): Account {
		const a = this.cfg.accounts.find((x) => x.id === id);
		if (!a) throw new DeskError(de.core.unknownDepot(id), 404);
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

	protected quoteRow(symbol: string): QuoteRow | undefined {
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

	protected postChat(m: Omit<ChatMessage, "id" | "time">): ChatMessage {
		const time = this.now();
		const text = m.text.slice(0, 4000);
		const { lastId } = this.db.run("INSERT INTO chat (time, author, role, text, recipients, ref) VALUES (?,?,?,?,?,?)", time, m.author, m.role, text, JSON.stringify(m.to), m.ref);
		const msg: ChatMessage = { ...m, text, id: lastId, time };
		this.emit("chat", msg);
		return msg;
	}

	startOfDay(): number {
		const d = new Date(this.now());
		return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	}
}
