// Depots: FIFO-Buch je Depot (zwischengespeichert), Kennzahlen, Positionen, Trades, Kurve, Tagesstände, Übersicht.
import type { Account, AccountDetail, AccountSummary, Allocation, AssetClass, CashMove, CurvePoint, Overview, Position, QuoteInfo, RiskLimits, Side, Trade, DayStats } from "@desk/shared";
import { assetClassOf, combineCurves, equityChanges, oversold, buildBook, dayKey, dayStats, orderValueCents, returnPct, roundQty, valueHoldings } from "@desk/shared";
import { DeskCore, DeskError, MIN_TRADE_TIME, type TradeRow } from "./core.ts";
import { de } from "../i18n/de.ts";

export abstract class DeskBook extends DeskCore {
	/** Grenzen eines Depots (risk.ts). */
	abstract limits(accountId: string): RiskLimits;
	/** Herkunft und Alter eines Kurses (market.ts). */
	abstract quoteInfo(symbol: string): QuoteInfo | null;

	private ledgers = new Map<string, { key: string; rows: TradeRow[]; book: ReturnType<typeof buildBook> }>();

	/**
	 * Trades und FIFO-Buch je Depot, zwischengespeichert, bis sich die Trades des Depots ändern (Anzahl, höchste ID, Summe
	 * der aktiven IDs – fängt auch Löschen und Wiederherstellen). Ein Takt oder eine Abfrage baut das Buch so einmal statt
	 * einmal je Position, Vorschlag oder Stop-Hinweis.
	 */
	protected ledger(accountId: string): { rows: TradeRow[]; book: ReturnType<typeof buildBook> } {
		const k = this.db.get<{ n: number; m: number | null; s: number | null }>("SELECT COUNT(*) AS n, MAX(id) AS m, SUM(CASE WHEN deleted_at IS NULL THEN id ELSE 0 END) AS s FROM trade WHERE account_id = ?", accountId)!;
		const key = `${k.n}|${k.m ?? 0}|${k.s ?? 0}`;
		const hit = this.ledgers.get(accountId);
		if (hit && hit.key === key) return hit;
		const rows = this.db.all<TradeRow>("SELECT * FROM trade WHERE account_id = ? AND deleted_at IS NULL ORDER BY time, id", accountId);
		const book = buildBook(rows.map((t) => ({ id: t.id, symbol: t.symbol, side: t.side, qty: t.qty, price: t.price, valueCents: t.value_cents, feeCents: t.fee_cents, time: t.time })));
		const entry = { key, rows, book };
		this.ledgers.set(accountId, entry);
		return entry;
	}

	protected tradeRows(accountId: string): TradeRow[] {
		return this.ledger(accountId).rows;
	}

	/**
	 * Vorschläge, deren Kauf-Lose noch im Bestand sind (FIFO), jüngstes Los zuerst. Ein Stop gilt nur für die Position, die
	 * sein Vorschlag eröffnet hat – nicht für einen späteren Kauf von Hand desselben Symbols.
	 */
	protected heldProposals(accountId: string): Map<string, number[]> {
		const { rows, book } = this.ledger(accountId);
		const byTrade = new Map(rows.map((t) => [t.id, t.proposal_id]));
		const out = new Map<string, number[]>();
		for (const [symbol, lots] of book.openLots) {
			const ids = [...new Set(lots.map((l) => byTrade.get(l.tradeId)).filter((x): x is number => typeof x === "number"))].reverse();
			if (ids.length) out.set(symbol, ids);
		}
		return out;
	}

	/**
	 * Verkäufe, die mit dieser Änderung (add kommt dazu, remove fällt weg) zu ihrem Zeitpunkt nicht mehr gedeckt wären:
	 * Trade-ID → Stück zu viel. Geprüft wird das ganze Buch in zeitlicher Reihenfolge, nicht nur der heutige Bestand.
	 */
	protected newOversells(accountId: string, add: { id: number; symbol: string; side: Side; qty: number; time: number }[], remove?: number): Map<number, number> {
		const rows = this.tradeRows(accountId);
		const before = oversold(rows);
		const after = oversold([...rows.filter((t) => t.id !== remove), ...add]);
		return new Map([...after].filter(([id, q]) => q > (before.get(id) ?? 0) + 1e-9));
	}

	/** Zeitpunkt aus einer Eingabe: fehlt er, gilt jetzt; sonst ab 1990 und höchstens eine Minute in der Zukunft. */
	protected tradeTime(v: unknown): number {
		if (v === undefined || v === null) return this.now();
		if (typeof v !== "number" || !Number.isFinite(v) || v < MIN_TRADE_TIME || v > this.now() + 60_000) throw new DeskError(de.book.tradeTime);
		return Math.trunc(v);
	}

	protected book(accountId: string) {
		return this.ledger(accountId).book;
	}

	protected depositsCents(a: Account): number {
		return a.startCashCents + (this.db.get<{ s: number | null }>("SELECT SUM(amount_cents) AS s FROM cash_move WHERE account_id = ?", a.id)?.s ?? 0);
	}

	protected prevSnapshot(accountId: string): { equity_cents: number; deposits_cents: number } | undefined {
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
			oversoldTrades: [...book.oversold.keys()],
		};
	}

	protected positions(a: Account, s: AccountSummary): Position[] {
		const book = this.book(a.id);
		const held = this.heldProposals(a.id);
		const out: Position[] = [];
		for (const h of book.holdings.values()) {
			const i = this.instrument(h.symbol);
			const p = this.priced(h.symbol);
			const value = p ? orderValueCents(h.qty, p.price, p.fx) : h.costCents;
			// Stop und Ziel des jüngsten Vorschlags, dessen Kauf noch im Bestand ist; ein Kauf von Hand hat keinen
			const ids = held.get(h.symbol) ?? [];
			const last = ids.length
				? this.db.get<{ stop_loss: number | null; take_profit: number | null }>(`SELECT stop_loss, take_profit FROM proposal WHERE id IN (${ids.map(() => "?").join(",")}) AND side = 'buy' ORDER BY (stop_loss IS NULL), decided_at DESC LIMIT 1`, ...ids)
				: undefined;
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
				quote: this.quoteInfo(h.symbol),
			});
		}
		return out.sort((x, y) => y.valueCents - x.valueCents);
	}

	protected trades(accountId: string, limit = 500): Trade[] {
		const book = this.book(accountId);
		// toReversed: die Zeilen gehören dem Zwischenspeicher, ein reverse() drehte sie für alle anderen Leser mit um
		return this.tradeRows(accountId)
			.toReversed()
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
		const curve = combineCurves(mine.map((a) => this.curve(a, summaries.find((s) => s.id === a.id))));
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
			quoteFeed: this.feed.source,
			allocation: this.allocation(mine, summaries),
			changes: equityChanges(curve),
		};
	}

	/** Deine Depots nach Symbol und Anlageklasse, bewertet wie in summary() (siehe AllocationSchema). */
	protected allocation(accounts: Account[], summaries: AccountSummary[]): Allocation {
		const bySymbol = new Map<string, number>();
		let cash = 0;
		for (const a of accounts) {
			cash += summaries.find((s) => s.id === a.id)!.cashCents;
			for (const [symbol, v] of valueHoldings(this.book(a.id).holdings, (s) => this.priced(s)).values) bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + v);
		}
		const total = cash + [...bySymbol.values()].reduce((s, v) => s + v, 0);
		const pct = (v: number) => (total > 0 ? (v / total) * 100 : null);
		const rows = [...bySymbol].map(([symbol, valueCents]) => {
			const i = this.instrument(symbol);
			return { symbol, name: i?.name ?? symbol, assetClass: assetClassOf(i?.type), valueCents, pct: pct(valueCents) };
		});
		const classes: AssetClass[] = ["equity", "etf", "crypto", "cash", "other"];
		return {
			totalCents: total,
			byClass: classes.map((assetClass) => {
				const valueCents = assetClass === "cash" ? cash : rows.filter((r) => r.assetClass === assetClass).reduce((s, r) => s + r.valueCents, 0);
				return { assetClass, valueCents, pct: pct(valueCents) };
			}),
			bySymbol: rows.sort((x, y) => y.valueCents - x.valueCents || (x.symbol < y.symbol ? -1 : 1)),
		};
	}

	protected insertTrade(a: Account, t: { symbol: string; side: Side; qty: number; price: number; currency: string; fx: number; feeCents: number; time: number; source: Trade["source"]; proposalId: number | null; note: string; importKey?: string }): number {
		const { lastId, changes } = this.db.run(
			"INSERT OR IGNORE INTO trade (account_id, symbol, side, qty, price, currency, fx, value_cents, fee_cents, time, source, proposal_id, note, import_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			a.id, t.symbol, t.side, roundQty(t.qty), t.price, t.currency, t.fx, orderValueCents(t.qty, t.price, t.fx), t.feeCents, t.time, t.source, t.proposalId, t.note, t.importKey ?? null,
		);
		return changes ? lastId : 0;
	}

	dayStatsOf(accountId: string): DayStats {
		const rows = this.tradeRows(accountId);
		return dayStats(rows.map((t) => ({ id: t.id, side: t.side, time: t.time, feeCents: t.fee_cents })), this.book(accountId).realizedBySell, this.startOfDay());
	}

	protected snapshot() {
		const day = dayKey(this.now());
		for (const a of this.cfg.accounts) {
			const s = this.summary(a);
			this.db.run(
				"INSERT INTO snapshot (account_id, day, equity_cents, deposits_cents) VALUES (?,?,?,?) ON CONFLICT (account_id, day) DO UPDATE SET equity_cents = excluded.equity_cents, deposits_cents = excluded.deposits_cents",
				a.id, day, s.equityCents, s.depositsCents,
			);
		}
	}
}
