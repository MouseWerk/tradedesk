// Auswertung: geschlossene Trades (FIFO-Lose aus dem Buch) mit R aus dem Stop des Vorschlags, Kennzahlen, Gruppen,
// Kurve mit Drawdown und Ergebnis je Tag aus den Tagesständen. Nur lesen; Buch und Tagesstände kommen aus book.ts.
import type { Account, Analytics, ClosedTrade, CurvePoint } from "@desk/shared";
import { closedTrade, combineCurves, dayKey, dayResults, drawdowns, groupStats, isoWeekday, rBuckets, tradeStats } from "@desk/shared";
import { DeskError } from "./core.ts";
import { DeskJournal } from "./journal.ts";
import { de } from "../i18n/de.ts";

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TRADE_LIST_MAX = 1000; // so viele geschlossene Trades stehen in der Liste; Kennzahlen zählen alle

/** "YYYY-MM-DD" als gültiges Kalenderdatum oder null (fehlt); sonst 400. */
function parseDay(v: unknown, what: string): string | null {
	if (v === undefined || v === null || v === "") return null;
	const m = typeof v === "string" ? DAY.exec(v) : null;
	const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
	if (!m || !d || d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) throw new DeskError(de.analytics.badDate(what));
	return v as string;
}

export abstract class DeskAnalytics extends DeskJournal {
	/** Depots einer Auswahl: "mine" deine, "all" alle, sonst eine Depot-ID. */
	protected scopeAccounts(scope: string): Account[] {
		if (scope === "mine") return this.cfg.accounts.filter((a) => a.owner === "user");
		if (scope === "all") return this.cfg.accounts;
		return [this.account(scope)];
	}

	/** Alle geschlossenen Trades der Depots (ohne Zeitraum), Ausstieg aufsteigend. */
	protected closedTrades(accounts: Account[]): ClosedTrade[] {
		if (!accounts.length) return [];
		const ids = accounts.map((a) => a.id);
		const marks = ids.map(() => "?").join(",");
		const proposals = new Map(
			this.db.all<{ id: number; author: string; stop_loss: number | null }>(`SELECT id, author, stop_loss FROM proposal WHERE account_id IN (${marks}) AND side = 'buy'`, ...ids).map((p) => [p.id, p]),
		);
		const instruments = new Map(this.db.all<{ symbol: string; name: string; currency: string }>("SELECT symbol, name, currency FROM instrument").map((i) => [i.symbol, i]));
		const out: ClosedTrade[] = [];
		for (const a of accounts) {
			const { rows, book } = this.ledger(a.id);
			const byId = new Map(rows.map((t) => [t.id, t]));
			const owner = a.owner === "user" ? this.cfg.user : a.owner;
			for (const l of book.closed) {
				const buy = byId.get(l.buyId)!;
				const p = buy.proposal_id !== null ? proposals.get(buy.proposal_id) : undefined;
				const inst = instruments.get(l.symbol);
				out.push(
					closedTrade(l, {
						accountId: a.id, name: inst?.name ?? l.symbol, author: p?.author ?? owner, proposalId: buy.proposal_id, stopLoss: p?.stop_loss ?? null,
						buyPrice: buy.price, buyCurrency: buy.currency, buyFx: buy.fx, stopCurrency: inst?.currency ?? buy.currency,
					}),
				);
			}
		}
		return accounts.length > 1 ? out.sort((x, y) => x.exitTime - y.exitTime || x.sellTradeId - y.sellTradeId) : out;
	}

	/** Tagesstände der Depots zusammen (heute mit dem Live-Wert). */
	protected scopeCurve(accounts: Account[]): CurvePoint[] {
		return accounts.length ? combineCurves(accounts.map((a) => this.curve(a))) : [];
	}

	/** GET /api/analytics (siehe AnalyticsSchema). */
	analytics(q: { account?: unknown; from?: unknown; to?: unknown } = {}): Analytics {
		const scope = typeof q.account === "string" && q.account ? q.account : "mine";
		const accounts = this.scopeAccounts(scope);
		const from = parseDay(q.from, "from");
		const to = parseDay(q.to, "to") ?? dayKey(this.now());
		if (from !== null && from > to) throw new DeskError(de.analytics.fromAfterTo);
		const inRange = (d: string) => (from === null || d >= from) && d <= to;
		const all = this.closedTrades(accounts);
		const trades = all.filter((t) => inRange(dayKey(t.exitTime)));
		const curve = this.scopeCurve(accounts);
		const dd = drawdowns(curve.filter((p) => inRange(p.day)));
		const authors = [this.cfg.user, ...this.cfg.agents];
		const names = new Map(trades.map((t) => [t.symbol, t.name]));
		return {
			scope,
			accountIds: accounts.map((a) => a.id),
			from,
			to,
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			curve: dd.points,
			maxDrawdown: dd.max,
			days: dayResults(curve, all, from, to),
			// neueste Verkäufe zuerst; die Teile eines Verkaufs bleiben in FIFO-Reihenfolge (sort ist stabil)
			trades: trades.slice(-TRADE_LIST_MAX).sort((x, y) => y.exitTime - x.exitTime || y.sellTradeId - x.sellTradeId),
			tradesTotal: trades.length,
			stats: tradeStats(trades),
			rBuckets: rBuckets(trades),
			byWeekday: [...groupStats(trades, (t) => isoWeekday(t.entryTime), [1, 2, 3, 4, 5, 6, 7])].map(([weekday, s]) => ({ weekday, ...s })),
			byHour: [...groupStats(trades, (t) => new Date(t.entryTime).getHours(), Array.from({ length: 24 }, (_, h) => h))].map(([hour, s]) => ({ hour, ...s })),
			byAuthor: [...groupStats(trades, (t) => t.author, authors)].map(([author, s]) => ({ author, ...s })),
			bySymbol: [...groupStats(trades, (t) => t.symbol)].map(([symbol, s]) => ({ symbol, name: names.get(symbol) ?? symbol, ...s })).sort((x, y) => y.pnlCents - x.pnlCents || (x.symbol < y.symbol ? -1 : 1)),
		};
	}
}
