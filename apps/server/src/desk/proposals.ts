// Vorschläge und Orders: anlegen und prüfen, freigeben, ablehnen, stornieren, Ausführungen eintragen, Limits im Takt
// ausführen, Abläufe, Stop- und Ziel-Hinweise. Agenten schlagen vor, du gibst frei. Orders für ein manuelles Depot
// führst du selbst in der App des Brokers aus und trägst die Ausführung hier ein.
import type { Account, AgentBudget, Check, Proposal, ProposalStatus, Side } from "@desk/shared";
import { ProposalInputSchema, checkOrder, movePct, orderValueCents, roundQty, sideLabel } from "@desk/shared";
import type { Broker } from "../broker.ts";
import { DeskError, CONFIRM_TTL_MS, dateText, parseQty, parsePrice, parseFeeCents, num, type Origin, type ProposalRow } from "./core.ts";
import { DeskMarket } from "./market.ts";
import { de } from "../i18n/de.ts";

const OPEN_LIMIT_DAYS = 30;
const MARKET_WAIT_DAYS = 4; // eine Papier-Market-Order nach Börsenschluss wartet höchstens bis dahin auf die Eröffnung
const PLACED_DAYS = 7;
const RESERVING = "'open','placed','sending','confirm'"; // freigegeben, aber noch nicht (ganz) ausgeführt
const eurText = (c: number) => `${(c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
/** Depots, für die das Agenten-Budget gilt: deine mit echtem Geld (manuell oder IBKR live), nie Papier */
export const realMoney = (a: Account) => a.owner === "user" && (a.kind === "manual" || a.live);
const pct = (n: number) => `${n.toFixed(1).replace(".", ",")} %`;

export abstract class DeskProposals extends DeskMarket {
	/** Broker-Schritte (broker.ts), die Freigabe und Storno brauchen. */
	protected abstract brokerOf(accountId: string): Broker;
	protected abstract sendToBroker(id: number): Promise<void>;
	abstract pollBroker(accountId: string): Promise<void>;

	/** Risiko eines Kaufs bis zum Stop (inkl. beider Gebühren), Anteil am Depot und Kursziel in R. */
	protected riskOf(r: ProposalRow, fx: number | null, equityCents: number) {
		const entry = r.fill_price ?? r.limit_price ?? this.priced(r.symbol)?.price ?? r.quote_price;
		const stop = r.side === "buy" ? r.stop_loss : null;
		if (!stop || !(entry > stop) || fx === null) return { riskCents: null, riskPct: null, targetR: null };
		const riskCents = orderValueCents(r.approved_qty ?? r.qty, entry - stop, fx) + 2 * this.account(r.account_id).feeCents;
		return { riskCents, riskPct: equityCents > 0 ? (riskCents / equityCents) * 100 : null, targetR: r.take_profit && r.take_profit > entry ? (r.take_profit - entry) / (entry - stop) : null };
	}

	protected toProposal(r: ProposalRow, equityCents?: number): Proposal {
		const i = this.instrument(r.symbol);
		const p = this.priced(r.symbol);
		const qty = r.approved_qty ?? r.qty;
		const unit = r.limit_price ?? p?.price ?? r.quote_price;
		const fx = p?.fx ?? this.fx(i?.currency ?? "EUR");
		return {
			id: r.id, accountId: r.account_id, author: r.author, symbol: r.symbol, name: i?.name ?? r.symbol, currency: i?.currency ?? "EUR", side: r.side, qty: r.qty, orderType: r.order_type,
			limitPrice: r.limit_price, stopLoss: r.stop_loss, takeProfit: r.take_profit, confidence: r.confidence, thesis: r.thesis, status: r.status, reason: r.reason, quotePrice: r.quote_price,
			price: p?.price ?? null, estimateCents: orderValueCents(qty, unit, fx ?? 1) /* nur Anzeige */, warnings: JSON.parse(r.warnings) as string[], createdAt: r.created_at,
			decidedAt: r.decided_at, decidedBy: r.decided_by, approvedQty: r.approved_qty, expiresAt: r.expires_at, fillPrice: r.fill_price,
			brokerOrderId: r.broker_order_id, brokerMessage: r.broker_message, filledQty: r.filled_qty,
			...this.riskOf(r, fx, equityCents ?? this.summary(this.account(r.account_id)).equityCents),
		};
	}

	protected proposalRow(id: number): ProposalRow {
		const r = this.db.get<ProposalRow>("SELECT * FROM proposal WHERE id = ?", id);
		if (!r) throw new DeskError(de.proposals.unknown(id), 404);
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
		const equity = new Map(this.cfg.accounts.map((a) => [a.id, this.summary(a).equityCents]));
		return rows.map((r) => this.toProposal(r, equity.get(r.account_id)));
	}

	/**
	 * Was freigegebene, noch nicht (ganz) ausgeführte Orders eines Depots binden: Cash und Positionswert der Käufe, Stück
	 * der Verkäufe. Ohne Kurs oder Wechselkurs einer Kauf-Order lässt sich das Cash nicht prüfen (unpriced).
	 */
	protected reserved(accountId: string, exclude?: number): { cashCents: number; buyValue: Map<string, number>; sellQty: Map<string, number>; unpriced: number[]; riskCents: number } {
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
	 * Was Agenten-Käufe in deinen Depots mit echtem Geld zusammen binden (config "agentBudgetEur"): gehaltene Lose aus
	 * Agenten-Vorschlägen zum Einstand mit Kaufgebühr, dazu wartende und freigegebene, noch nicht ausgeführte Käufe mit
	 * Gebühr. Ein Verkauf gibt das Budget wieder frei (zum Einstand, Gewinn und Verlust zählen nicht). exclude: die Order selbst.
	 */
	agentBudget(exclude?: number): AgentBudget | null {
		const budget = this.cfg.agentBudgetCents;
		if (budget === null) return null;
		const accounts = this.cfg.accounts.filter(realMoney);
		let used = 0;
		let unpriced = false;
		for (const a of accounts) {
			const agentBuys = new Set(this.db.all<{ id: number }>("SELECT id FROM proposal WHERE account_id = ? AND side = 'buy' AND author != ?", a.id, this.cfg.user).map((r) => r.id));
			if (!agentBuys.size) continue;
			const { rows, book } = this.ledger(a.id);
			const byId = new Map(rows.map((t) => [t.id, t]));
			for (const lots of book.openLots.values())
				for (const l of lots) {
					const t = byId.get(l.tradeId);
					if (t?.proposal_id && agentBuys.has(t.proposal_id) && t.qty > 0) used += Math.round(((t.value_cents + t.fee_cents) * l.qty) / t.qty);
				}
			for (const r of this.db.all<ProposalRow>(`SELECT * FROM proposal WHERE account_id = ? AND side = 'buy' AND author != ? AND status IN ('pending',${RESERVING}) AND id != ?`, a.id, this.cfg.user, exclude ?? 0)) {
				const qty = roundQty((r.approved_qty ?? r.qty) - (r.filled_qty ?? 0));
				if (qty <= 0) continue;
				const p = this.priced(r.symbol);
				const fx = p?.fx ?? this.fx(this.instrument(r.symbol)?.currency ?? "");
				const unit = r.limit_price ?? p?.price ?? r.quote_price;
				if (fx === null || !(unit > 0)) unpriced = true;
				else used += orderValueCents(qty, unit, fx) + a.feeCents;
			}
		}
		return { budgetCents: budget, usedCents: used, freeCents: unpriced ? 0 : Math.max(0, budget - used), unpriced, accounts: accounts.map((a) => a.id) };
	}

	/**
	 * Risikoprüfung gegen Bestand, Cash und alle schon freigegebenen offenen Orders des Depots (exclude: die Order selbst).
	 * Während der Handelszeit nur mit frischem Kurs.
	 */
	protected check(a: Account, o: { side: Side; qty: number; orderType: "market" | "limit"; limitPrice?: number | null; stopLoss?: number | null; takeProfit?: number | null; symbol: string }, opts: { openByAuthor?: number; byAgent?: boolean; exclude?: number } = {}): Check {
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
		if (o.side === "buy" && res.unpriced.length) violations.push(de.proposals.unpriced(res.unpriced.length, res.unpriced.map((id) => `#${id}`).join(", ")));
		if (o.side === "buy" && res.cashCents > 0) warnings.push(de.proposals.reservedCash(eurText(res.cashCents)));
		if (opts.byAgent && o.side === "buy" && realMoney(a)) {
			const b = this.agentBudget(opts.exclude);
			const cost = c.estimateCents + c.feeCents;
			if (b && b.unpriced) violations.push(de.proposals.budgetUnpriced);
			else if (b && cost > b.freeCents) violations.push(de.proposals.overBudget(eurText(cost), eurText(b.freeCents), eurText(b.budgetCents)));
		}
		if (o.side === "sell" && res.sellQty.get(o.symbol)) warnings.push(de.proposals.reservedSell(num(res.sellQty.get(o.symbol)!), o.symbol));
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
		if (unknown.length) throw new DeskError(de.proposals.unknownField(unknown[0].slice(0, 40), Object.keys(ProposalInputSchema.shape).join(", ")));
		const parsed = ProposalInputSchema.safeParse(origin === "web" ? { confidence: 1, thesis: de.proposals.ownThesis, ...raw, author: this.cfg.user } : raw);
		if (!parsed.success) {
			const i = parsed.error.issues[0];
			throw new DeskError(de.proposals.invalid(i.path.join(".") || "?", i.message));
		}
		const input = parsed.data;
		const isUser = origin === "web";
		const author = isUser ? this.cfg.user : this.agentName(input.author);
		if (!author) throw new DeskError(de.core.unknownAgent(input.author), 403);
		const a = this.account(input.accountId);
		if (!isUser && a.owner !== "user" && a.owner !== author) throw new DeskError(de.proposals.notAllowed(author, a.name), 403);
		if (isUser && a.kind === "broker" && !this.brokers.has(a.id)) throw new DeskError(de.proposals.noBroker(a.name));
		if (isUser && a.kind === "manual") throw new DeskError(de.proposals.manualDepot(a.name));
		const symbol = this.normalizeSymbol(input.symbol);
		const extra: string[] = [];
		// die Allow-List: nur, was auf der Watchlist oder im Depot steht – nie ein erfundenes Symbol
		if (!this.isWatched(symbol) && !this.book(a.id).holdings.has(symbol)) extra.push(de.proposals.notWatched(symbol));
		if (!isUser && input.confidence < this.cfg.minConfidence) extra.push(de.proposals.lowConfidence(Math.round(input.confidence * 100), Math.round(this.cfg.minConfidence * 100)));
		if (input.orderType === "market" && input.limitPrice) extra.push(de.proposals.marketWithLimit);
		if (!extra.length) await this.ensureFresh(symbol);
		// "je Autor": über alle Depots gezählt, sonst hielte ein Agent mit vier Depots viermal so viele offen
		const openByAuthor = isUser ? undefined : this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM proposal WHERE author = ? AND status = 'pending'", author)!.n;
		const c = this.check(a, { ...input, symbol }, { openByAuthor, byAgent: !isUser });
		const waiting = input.side === "buy" ? this.db.all<ProposalRow>("SELECT * FROM proposal WHERE account_id = ? AND side = 'buy' AND status = 'pending'", a.id) : [];
		const waitingCents = waiting.reduce((sum, w) => sum + orderValueCents(w.qty, w.limit_price ?? w.quote_price, this.priced(w.symbol)?.fx ?? 1) + a.feeCents, 0);
		if (waiting.length && c.ok && waitingCents + c.estimateCents + c.feeCents > this.summary(a).cashCents - this.reserved(a.id).cashCents)
			c.warnings.push(de.proposals.waitingBuys(waiting.length));
		const check: Check = { ...c, ok: c.ok && !extra.length, violations: [...extra, ...c.violations] };
		if (!check.ok && !dryRun && !isUser) this.event("proposal.blocked", author, de.proposals.blocked(`${sideLabel[input.side]} ${num(input.qty)} ${symbol}`, check.violations[0]));
		if (dryRun || !check.ok) return { ok: check.ok, check, proposal: null };
		const now = this.now();
		const id = this.db.tx(() => {
			const { lastId } = this.db.run(
				`INSERT INTO proposal (account_id, author, symbol, side, qty, order_type, limit_price, stop_loss, take_profit, confidence, thesis, status, quote_price, warnings, created_at, expires_at, raw)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`,
				a.id, author, symbol, input.side, roundQty(input.qty), input.orderType, input.limitPrice ?? null, input.side === "buy" ? (input.stopLoss ?? null) : null, input.side === "buy" ? (input.takeProfit ?? null) : null,
				input.confidence, input.thesis, check.price ?? 0, JSON.stringify(check.warnings), now, now + this.cfg.proposalTtlHours * 3_600_000, JSON.stringify(raw).slice(0, 4000),
			);
			if (!isUser) this.event("proposal.new", author, de.proposals.proposed(author, `${sideLabel[input.side]} ${num(input.qty)} ${symbol}`, a.name, lastId), { to: [this.cfg.user], ref: `#${lastId}` });
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
	protected verdict(r: ProposalRow, qty: number): { status: "stale" | "rejected"; reason: string } | null {
		const a = this.account(r.account_id);
		const p = this.priced(r.symbol);
		if (r.author !== this.cfg.user && p && movePct(r.quote_price, p.price) > this.cfg.staleMovePct)
			return { status: "stale", reason: de.proposals.moved(pct(movePct(r.quote_price, p.price)), num(r.quote_price), num(p.price), p.currency) };
		const check = this.check(a, { side: r.side, qty, orderType: r.order_type, limitPrice: r.limit_price, stopLoss: r.stop_loss, takeProfit: r.take_profit, symbol: r.symbol }, { byAgent: r.author !== this.cfg.user, exclude: r.id });
		if (!check.ok) return { status: "rejected", reason: de.proposals.riskBeforeSend(check.violations.join(" ")) };
		return null;
	}

	/** Ausführen innerhalb einer Transaktion; nimmt den Vorschlag nur, solange er noch "pending" ist. */
	protected execute(id: number, qty: number, by: string): Proposal {
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
			if (!changes) throw new DeskError(de.proposals.decided, 409, this.proposal(id));
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
				const reason = de.proposals.liveOff(a.broker);
				set("rejected", { reason });
				this.event("proposal.rejected", by, `${label}: ${reason}`, notify);
				return this.proposal(id);
			}
			set("sending", { expires_at: now + PLACED_DAYS * 86_400_000, status_at: now });
			return this.proposal(id);
		}
		if (a.kind === "manual") {
			set("placed", { expires_at: now + PLACED_DAYS * 86_400_000 });
			this.event("proposal.placed", by, de.proposals.manualApproved(label, a.broker), notify);
			return this.proposal(id);
		}
		if (r.order_type === "limit" && r.limit_price && (!crossed(r.side, p!.price, r.limit_price) || !this.inSession(r.symbol))) {
			set("open", { expires_at: now + OPEN_LIMIT_DAYS * 86_400_000 });
			this.event("proposal.open", by, de.proposals.limitOpen(label, num(r.limit_price), p!.currency), notify);
			return this.proposal(id);
		}
		if (!this.inSession(r.symbol)) {
			// Papier füllt nur zur Handelszeit – sonst zum letzten Schlusskurs, mit dem Wissen von heute
			set("open", { expires_at: now + MARKET_WAIT_DAYS * 86_400_000, reason: de.proposals.waitsForOpen });
			this.event("proposal.open", by, de.proposals.approvedWaits(label), notify);
			return this.proposal(id);
		}
		set("filled", { fill_price: p!.price });
		this.insertTrade(a, { symbol: r.symbol, side: r.side, qty, price: p!.price, currency: p!.currency, fx: p!.fx, feeCents: a.feeCents, time: now, source: r.author === this.cfg.user ? "order" : "proposal", proposalId: id, note: "" });
		this.event("trade.fill", by, de.proposals.filled(label, num(p!.price), p!.currency, a.name), notify);
		return this.proposal(id);
	}

	/** Freigabe – nur von dir, nur verkleinern (weniger Stück), nie vergrößern. */
	async approve(id: number, body: { qty?: unknown }): Promise<Proposal> {
		const r = this.proposalRow(id);
		if (r.status !== "pending") throw new DeskError(de.proposals.decided, 409, this.toProposal(r));
		let qty = r.qty;
		if (body.qty !== undefined) {
			qty = parseQty(body.qty); // 0,0000001 wird nicht zu 0 gerundet und abgelehnt, sondern ist eine falsche Eingabe
			if (qty > r.qty + 1e-9) throw new DeskError(de.proposals.tooMany(num(r.qty)));
		}
		await this.refresh([r.symbol]); // direkt vor dem Schreiben neu lesen
		// ein alter Kurs entscheidet nichts – der Vorschlag bleibt offen, du gibst später frei
		const stale = this.quoteProblem(r.symbol);
		if (stale) throw new DeskError(de.proposals.staleWaits(stale), 409, this.toProposal(r));
		const out = this.db.tx(() => this.execute(id, qty, this.cfg.user));
		if (out.status === "sending") await this.sendToBroker(id);
		this.emit("tick", { at: this.now() });
		return this.proposal(id);
	}

	reject(id: number, reason: unknown): Proposal {
		const r = this.proposalRow(id);
		const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
		const { changes } = this.db.run("UPDATE proposal SET status = 'rejected', reason = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", why || de.proposals.rejectedByYou, this.now(), this.cfg.user, id);
		if (!changes) throw new DeskError(de.proposals.decided, 409, this.toProposal(r));
		this.event("proposal.rejected", this.cfg.user, de.proposals.rejected(`${sideLabel[r.side]} ${num(r.qty)} ${r.symbol} #${id}`, r.author, why), r.author === this.cfg.user ? undefined : { to: [r.author], ref: `#${id}` });
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
				throw new DeskError(de.proposals.cancelFailed(a.broker, (e as Error).message), 502);
			}
			this.db.run("UPDATE proposal SET reason = ? WHERE id = ?", de.proposals.cancelRequested, id);
			this.event("proposal.cancel", this.cfg.user, de.proposals.cancelSent(`${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} #${id}`, a.broker));
			await this.pollBroker(a.id).catch(() => undefined);
			return this.proposal(id);
		}
		const { changes } = this.db.run(`UPDATE proposal SET status = 'cancelled', reason = ?, decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, ?) WHERE id = ? AND status IN ('open','placed','confirm')`, de.proposals.cancelledByYou, this.now(), this.cfg.user, id);
		if (!changes) throw new DeskError(de.proposals.notCancellable, 409, this.toProposal(r));
		this.event("proposal.cancelled", this.cfg.user, de.proposals.cancelled(`${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol}`));
		return this.proposal(id);
	}

	/** Ausführung beim Broker eintragen (manuelles Depot): was dort wirklich passiert ist, in EUR. */
	fill(id: number, body: { qty?: unknown; price?: unknown; feeEur?: unknown; time?: unknown }): Proposal {
		const r = this.proposalRow(id);
		if (r.status !== "placed") throw new DeskError(de.proposals.fillOnlyPlaced, 409, this.toProposal(r));
		const a = this.account(r.account_id);
		if (a.kind !== "manual") throw new DeskError(de.proposals.fillAutomatic(a.broker), 409, this.toProposal(r));
		const max = r.approved_qty ?? r.qty;
		const qty = body.qty === undefined || body.qty === null ? max : parseQty(body.qty);
		if (qty > max + 1e-9) throw new DeskError(de.proposals.fillQtyRange(num(max)));
		const price = parsePrice(body.price, de.proposals.fillPrice);
		const feeCents = parseFeeCents(body.feeEur, a.feeCents);
		const time = this.tradeTime(body.time);
		if (r.side === "sell" && (this.book(a.id).holdings.get(r.symbol)?.qty ?? 0) + 1e-9 < qty) throw new DeskError(de.core.fewerShares(num(qty), r.symbol));
		if (r.side === "sell" && this.newOversells(a.id, [{ id: Number.MAX_SAFE_INTEGER, symbol: r.symbol, side: "sell", qty, time }]).size)
			throw new DeskError(de.core.fewerSharesAt(dateText(time), num(qty), r.symbol));
		this.db.tx(() => {
			const { changes } = this.db.run("UPDATE proposal SET status = 'filled', fill_price = ?, approved_qty = ? WHERE id = ? AND status = 'placed'", price, qty, id);
			if (!changes) throw new DeskError(de.proposals.alreadyFilled, 409);
			this.insertTrade(a, { symbol: r.symbol, side: r.side, qty, price, currency: "EUR", fx: 1, feeCents, time, source: "proposal", proposalId: id, note: "" });
			this.event("trade.fill", this.cfg.user, de.proposals.filledAt(`${sideLabel[r.side]} ${num(qty)} ${r.symbol} #${id}`, num(price), a.broker), r.author === this.cfg.user ? undefined : { to: [r.author], ref: `#${id}` });
		});
		this.emit("tick", { at: this.now() });
		return this.proposal(id);
	}

	/** Offene Papier-Orders: Limits, sobald der Kurs sie erreicht, Market-Orders zur Eröffnung – nur zur Handelszeit. */
	protected fillLimits() {
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
				const reason = de.proposals.movedAtOpen(pct(movePct(r.quote_price, p.price)), num(r.quote_price), num(p.price), p.currency);
				if (this.db.run("UPDATE proposal SET status = 'stale', reason = ? WHERE id = ? AND status = 'open'", reason, r.id).changes) this.event("proposal.stale", "Desk", `${label} #${r.id}: ${reason}`, { to: [r.author], ref: `#${r.id}` });
				continue;
			}
			// dieselbe Prüfung wie bei der Freigabe, mit Stop, Risiko je Trade und Stop-Pflicht – ohne sich selbst als Reservierung
			const c = this.check(a, { side: r.side, qty, orderType: "market", stopLoss: r.stop_loss, takeProfit: r.take_profit, symbol: r.symbol }, { byAgent, exclude: r.id });
			if (!c.ok) {
				const what = r.limit_price ? de.proposals.limitReached : de.proposals.marketOpen;
				this.db.run("UPDATE proposal SET status = 'cancelled', reason = ? WHERE id = ? AND status = 'open'", de.proposals.riskAfter(what, c.violations.join(" ")), r.id);
				this.event("proposal.cancelled", "Desk", de.proposals.notFilledRisk(label, what, c.violations[0]), byAgent ? { to: [r.author], ref: `#${r.id}` } : undefined);
				continue;
			}
			if (!this.db.run("UPDATE proposal SET status = 'filled', fill_price = ?, reason = '' WHERE id = ? AND status = 'open'", p.price, r.id).changes) continue;
			this.insertTrade(a, { symbol: r.symbol, side: r.side, qty, price: p.price, currency: p.currency, fx: p.fx, feeCents: a.feeCents, time: this.now(), source: r.author === this.cfg.user ? "order" : "proposal", proposalId: r.id, note: r.limit_price ? de.proposals.noteLimit : de.proposals.noteOpening });
			this.event("trade.fill", "Desk", de.proposals.filledOpen(`${label} #${r.id}`, num(p.price), p.currency, r.limit_price ? de.proposals.viaLimit(num(r.limit_price)) : de.proposals.atOpening, a.name), { to: r.author === this.cfg.user ? [] : [r.author], ref: `#${r.id}` });
		}
	}

	protected expire() {
		const now = this.now();
		// eine unbeantwortete Rückfrage des Brokers verfällt; bestätigt werden kann sie danach nicht mehr
		for (const r of this.db.all<ProposalRow>("SELECT * FROM proposal WHERE status = 'confirm' AND COALESCE(status_at, decided_at, created_at) <= ?", now - CONFIRM_TTL_MS)) {
			if (this.db.run("UPDATE proposal SET status = 'expired', reason = ?, status_at = ? WHERE id = ? AND status = 'confirm'", de.proposals.replyExpired, now, r.id).changes)
				this.event("proposal.expired", "Desk", de.proposals.replyExpiredEvent(`${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol} #${r.id}`), { to: r.author === this.cfg.user ? [this.cfg.user] : [this.cfg.user, r.author], ref: `#${r.id}` });
		}
		// Broker-Orders laufen beim Broker ab (Tagesorder); deren Ende meldet der Abruf, nicht diese Uhr
		for (const r of this.db.all<ProposalRow>("SELECT * FROM proposal WHERE status IN ('pending','open','placed') AND expires_at <= ? AND broker_order_id IS NULL", now)) {
			if (this.db.run("UPDATE proposal SET status = 'expired', reason = ? WHERE id = ? AND status = ?", r.status === "pending" ? de.proposals.notDecidedInTime : de.proposals.notFilled, r.id, r.status).changes)
				this.event("proposal.expired", "Desk", de.proposals.expired(`${sideLabel[r.side]} ${num(r.approved_qty ?? r.qty)} ${r.symbol}`, r.author));
		}
	}

	/** Stop-Loss und Kursziel sind Hinweise an dich, keine automatischen Orders. */
	protected checkStops() {
		const rows = this.db.all<ProposalRow>("SELECT * FROM proposal WHERE status = 'filled' AND side = 'buy' AND closed_at IS NULL AND ((stop_loss IS NOT NULL AND stop_hit_at IS NULL) OR (take_profit IS NOT NULL AND target_hit_at IS NULL))");
		const held = new Map<string, Set<number>>(); // Depot → Vorschläge mit gehaltenen Losen
		const booked = new Set(rows.length ? this.db.all<{ p: number }>(`SELECT DISTINCT proposal_id AS p FROM trade WHERE deleted_at IS NULL AND proposal_id IN (${rows.map((r) => r.id).join(",")})`).map((x) => x.p) : []);
		for (const r of rows) {
			if (!held.has(r.account_id)) held.set(r.account_id, new Set([...this.heldProposals(r.account_id).values()].flat()));
			if (!held.get(r.account_id)!.has(r.id)) {
				// gebucht, aber verkauft: der Hinweis ist erledigt und kommt nie wieder (auch nicht für einen späteren Kauf)
				if (booked.has(r.id)) this.db.run("UPDATE proposal SET closed_at = ? WHERE id = ?", this.now(), r.id);
				continue; // ohne gebuchte Ausführung (Broker meldet sie noch) wartet der Hinweis
			}
			const q = this.quoteRow(r.symbol);
			if (!q) continue;
			const a = this.account(r.account_id);
			if (r.stop_loss && !r.stop_hit_at && q.price <= r.stop_loss) {
				this.db.run("UPDATE proposal SET stop_hit_at = ? WHERE id = ?", this.now(), r.id);
				this.event("stop", "Desk", de.proposals.stopHit(r.symbol, num(r.stop_loss), a.name), { to: [this.cfg.user, ...(r.author === this.cfg.user ? [] : [r.author])], ref: r.symbol });
			}
			if (r.take_profit && !r.target_hit_at && q.price >= r.take_profit) {
				this.db.run("UPDATE proposal SET target_hit_at = ? WHERE id = ?", this.now(), r.id);
				this.event("target", "Desk", de.proposals.targetHit(r.symbol, num(r.take_profit), a.name), { to: [this.cfg.user, ...(r.author === this.cfg.user ? [] : [r.author])], ref: r.symbol });
			}
		}
	}
}

function crossed(side: Side, price: number, limit: number): boolean {
	return side === "buy" ? price <= limit : price >= limit;
}
