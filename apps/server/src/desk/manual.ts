// Manuelle Depots: Trades von Hand, Löschen mit Rückgängig, Ein- und Auszahlungen, CSV-Import.
import type { Account, CashMove, ImportResult, Side, Trade } from "@desk/shared";
import { MAX_EUR, cents, decimals, parseTradesCsv, sideLabel } from "@desk/shared";
import { DeskError, MIN_TRADE_TIME, dateText, parseQty, parsePrice, parseFeeCents, num, type TradeRow } from "./core.ts";
import { DeskBroker } from "./broker.ts";

export abstract class DeskManual extends DeskBroker {
	protected manual(accountId: string): Account {
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
		const time = this.tradeTime(body.time);
		const note = typeof body.note === "string" ? body.note.slice(0, 200) : "";
		if (!this.instrument(symbol) && this.market.kind !== "off") await this.refresh([symbol]); // Name und Kurs, wenn Yahoo das Symbol kennt
		const id = this.db.tx(() => {
			if (side === "sell" && (this.book(a.id).holdings.get(symbol)?.qty ?? 0) + 1e-9 < qty) throw new DeskError(`Im Depot sind weniger als ${num(qty)} Stück ${symbol}.`);
			// auch zurückdatiert: ein Verkauf vor dem Kauf würde Geld erzeugen, das es nie gab
			if (this.newOversells(a.id, [{ id: Number.MAX_SAFE_INTEGER, symbol, side, qty, time }]).size)
				throw new DeskError(side === "sell" ? `Am ${dateText(time)} waren weniger als ${num(qty)} Stück ${symbol} im Depot – Zeitpunkt prüfen.` : `Dieser Trade lässt einen späteren Verkauf ungedeckt.`);
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
		// ein Kauf, an dem spätere Verkäufe hängen, bleibt; ein gelöschter Verkauf kommt nur zurück, wenn er gedeckt ist
		const row = this.db.get<TradeRow>("SELECT * FROM trade WHERE id = ? AND account_id = ?", id, a.id);
		if (row && !restore && row.deleted_at === null && this.newOversells(a.id, [], id).size) throw new DeskError("Spätere Verkäufe hängen an diesem Kauf – zuerst den Verkauf löschen.", 409);
		if (row && restore && row.deleted_at !== null && this.newOversells(a.id, [row]).size) throw new DeskError(`Der Verkauf vom ${dateText(row.time)} wäre nicht mehr gedeckt – nicht wiederhergestellt.`, 409);
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

	/**
	 * CSV-Zeilen, die zusammen mit dem Buch gedeckt sind. Ein Verkauf, der zu seinem Zeitpunkt mehr verkauft als da war,
	 * wird als Fehler genannt; macht eine neue Zeile einen bestehenden Verkauf ungedeckt, fällt der späteste neue Verkauf
	 * desselben Symbols davor weg. Linear je Durchgang, meist genügt einer.
	 */
	protected coveredCsvRows<T extends { line: number; symbol: string; side: Side; qty: number; time: number }>(accountId: string, rows: T[], errors: string[]): T[] {
		const base = (this.db.get<{ m: number | null }>("SELECT MAX(id) AS m FROM trade")?.m ?? 0) + 1;
		let keep = rows.map((r, i) => ({ r, id: base + i }));
		for (let pass = 0; pass <= rows.length; pass++) {
			const bad = this.newOversells(accountId, keep.map((k) => ({ id: k.id, symbol: k.r.symbol, side: k.r.side, qty: k.r.qty, time: k.r.time })));
			if (!bad.size) break;
			const drop = new Set<number>();
			for (const id of bad.keys()) {
				const own = keep.find((k) => k.id === id);
				if (own) drop.add(id);
				else {
					const t = this.db.get<TradeRow>("SELECT * FROM trade WHERE id = ?", id)!;
					const culprit = keep.filter((k) => k.r.side === "sell" && k.r.symbol === t.symbol && k.r.time <= t.time).at(-1);
					if (culprit) drop.add(culprit.id);
				}
			}
			if (!drop.size) break;
			for (const k of keep) if (drop.has(k.id)) errors.push(`Zeile ${k.r.line}: Verkauf ${num(k.r.qty)} ${k.r.symbol} am ${dateText(k.r.time)} – zu dem Zeitpunkt nicht genug Stück im Depot.`);
			keep = keep.filter((k) => !drop.has(k.id));
		}
		return keep.map((k) => k.r);
	}

	async importCsv(accountId: string, text: unknown): Promise<ImportResult> {
		const a = this.manual(accountId);
		if (typeof text !== "string" || !text.trim()) throw new DeskError("Leere Datei.");
		if (text.length > 2_000_000) throw new DeskError("Datei zu groß (höchstens 2 MB).");
		const parsed = parseTradesCsv(text);
		const errors = parsed.errors;
		// keine Zeilen aus der Zukunft oder von vor 1990
		const dated = parsed.rows.filter((r) => {
			const bad = r.time > this.now() + 60_000 ? "liegt in der Zukunft" : r.time < MIN_TRADE_TIME ? "liegt vor 1990" : null;
			if (bad) errors.push(`Zeile ${r.line}: Datum ${bad}.`);
			return !bad;
		});
		const unknown = [...new Set(dated.map((r) => r.symbol))].filter((s) => !this.instrument(s));
		if (unknown.length && this.market.kind !== "off") await this.refresh(unknown);
		let imported = 0;
		let skipped = 0;
		this.db.tx(() => {
			// schon importierte Zeilen zählen nicht; die neuen müssen zusammen mit dem Buch gedeckt sein (kein Verkauf vor dem Kauf)
			const fresh = dated.filter((r) => {
				const known = !!this.db.get("SELECT 1 FROM trade WHERE account_id = ? AND import_key = ?", a.id, r.key);
				if (known) skipped++;
				return !known;
			});
			const rows = this.coveredCsvRows(a.id, fresh, errors);
			for (const r of rows) {
				const id = this.insertTrade(a, { symbol: r.symbol, side: r.side, qty: r.qty, price: r.price, currency: r.currency, fx: r.fx ?? 1, feeCents: r.feeCents, time: r.time, source: "import", proposalId: null, note: r.note, importKey: r.key });
				if (id) imported++;
				else skipped++;
			}
			if (imported) this.event("trade.import", this.cfg.user, `${imported} Trades in ${a.name} importiert${skipped ? `, ${skipped} schon vorhanden` : ""}`);
		});
		this.emit("tick", { at: this.now() });
		return { imported, skipped, errors };
	}
}
