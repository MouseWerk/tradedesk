// Broker (IBKR): senden, Rückfrage bestätigen, Abruf mit Wiederfindung, Orderstatus, Ausführungen, Abgleich.
import { randomBytes } from "node:crypto";
import type { Account, BrokerStatus, Reconcile, Proposal, ProposalStatus } from "@desk/shared";
import { cents, roundQty, sideLabel } from "@desk/shared";
import { fxSymbol } from "../market.ts";
import type { Broker, BrokerExecution, BrokerOrder, PlaceResult } from "../broker.ts";
import { DeskError, CONFIRM_TTL_MS, num, type ProposalRow } from "./core.ts";
import { DeskProposals } from "./proposals.ts";

const UNLISTED_MS = 24 * 3_600_000; // so lange darf eine Broker-Order aus der Orderliste fehlen, dann gilt sie als abgelaufen

export abstract class DeskBroker extends DeskProposals {
	private brokerState = new Map<string, BrokerStatus>();

	protected brokerOf(accountId: string): Broker {
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
	protected symbolOfConid(accountId: string, conid: number | null): string | null {
		if (conid === null) return null;
		const known = this.db.get<{ symbol: string }>("SELECT symbol FROM broker_conid WHERE account_id = ? AND conid = ?", accountId, conid)?.symbol;
		return known ?? Object.entries(this.cfg.brokers[accountId]?.conids ?? {}).find(([, c]) => c === conid)?.[0] ?? null;
	}

	protected rememberConid(accountId: string, conid: number, symbol: string) {
		this.db.run("INSERT INTO broker_conid (account_id, conid, symbol) VALUES (?,?,?) ON CONFLICT (account_id, conid) DO UPDATE SET symbol = excluded.symbol", accountId, conid, symbol);
	}

	/** Einmal je Schlüssel (Tabelle setting): für Hinweise, die bei jedem Abruf wieder auftreten würden. */
	protected noteOnce(key: string, fn: () => void) {
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
	protected coidOf(r: ProposalRow): string {
		return r.broker_coid ?? `desk-${r.id}`;
	}

	/** Beim Broker gebuchte Stück und Durchschnittskurs eines Vorschlags (aus den Trades – die Wahrheit des Buchs). */
	protected fillsOf(id: number): { qty: number; avg: number | null } {
		const f = this.db.get<{ q: number | null; v: number | null }>("SELECT SUM(qty) AS q, SUM(qty * price) AS v FROM trade WHERE proposal_id = ? AND deleted_at IS NULL", id);
		const qty = roundQty(f?.q ?? 0);
		return { qty, avg: qty > 0 ? (f!.v ?? 0) / qty : null };
	}

	/** Reservierte Order ("sending") an den Broker geben. Ergebnis: beim Broker, Rückfrage, abgelehnt oder unbekannt. */
	protected async sendToBroker(id: number): Promise<void> {
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

	protected applyPlace(id: number, res: PlaceResult) {
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

	/**
	 * Orderstatus des Brokers auf die Vorschläge übertragen; Ausführungen (Trades) sind die Wahrheit über die Stückzahl.
	 * Auch Vorschläge ohne Order-ID, die gesendet wurden (Kontrakt bekannt) – die Wiederfindung kann sie als
	 * „unterbrochen“ abgelehnt haben, bevor doch noch eine Ausführung kommt (Review q1 m2).
	 */
	protected syncOrders(a: Account, orders: BrokerOrder[], now: number) {
		const rows = this.db.all<ProposalRow>("SELECT * FROM proposal WHERE account_id = ? AND (broker_order_id IS NOT NULL OR broker_conid IS NOT NULL) AND status IN ('placed','filled','cancelled','rejected','expired')", a.id);
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
	protected importExecution(a: Account, e: BrokerExecution, missing: Set<string>) {
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
}
