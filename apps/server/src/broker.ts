// Broker-Anbindung hinter einer Schnittstelle: Interactive Brokers über das lokale Client Portal Gateway
// (https://localhost:5000, Anmeldung macht der Besitzer dort selbst – der Desk sieht nie Zugangsdaten) und ein
// Fake-Broker für Tests und Fixture. Felder und Pfade nach der IBKR-Web-API-Dokumentation (docs/web-api).
import { HttpError, localJson } from "./http.ts";
import { de } from "./i18n/de.ts";

export interface BrokerSession {
	connected: boolean;
	authenticated: boolean;
	account: string | null; // Konto, falls in der Sitzung handelbar
	paper: boolean | null;
	message: string;
}

export type PlaceResult =
	| { kind: "submitted"; orderId: string; status: string }
	| { kind: "reply"; replyId: string; message: string } // Broker fragt nach, bevor die Order arbeitet
	| { kind: "rejected"; message: string } // eine Antwort des Brokers: die Order arbeitet nicht
	| { kind: "unknown"; message: string }; // keine sichere Antwort (Zeitlimit, Abbruch, 5xx): die Order kann trotzdem arbeiten

export interface BrokerOrder {
	orderId: string;
	cOID: string | null;
	status: "working" | "filled" | "cancelled" | "rejected";
	rawStatus: string; // Status im Wortlaut des Brokers, z. B. "Inactive"
	filledQty: number;
	avgPrice: number | null;
}

export interface BrokerExecution {
	id: string;
	cOID: string | null;
	conid: number | null;
	side: "buy" | "sell";
	qty: number;
	price: number;
	time: number;
	commission: number; // positiv
	commissionCurrency: string | null; // Währung der Gebühr, falls der Broker sie nennt; sonst gilt die Wertpapierwährung
}

export interface BrokerPosition {
	conid: number;
	ticker: string;
	description: string;
	qty: number;
	avgCost: number | null; // je Stück in Wertpapierwährung
	currency: string;
}

export interface OrderTicket {
	conid: number;
	side: "buy" | "sell";
	qty: number;
	type: "market" | "limit";
	limit?: number | null;
	cOID: string; // eindeutig über Datenbanken hinweg: desk-<Installation>-<id>
}

export interface Broker {
	readonly adapter: "ibkr" | "fake";
	readonly loginUrl: string | null;
	session(): Promise<BrokerSession>;
	keepAlive(): Promise<void>;
	/** Kontrakt-ID zu einem Yahoo-Symbol; wirft, wenn es keinen oder keinen eindeutigen gibt. */
	resolve(symbol: string): Promise<{ conid: number; description: string }>;
	place(t: OrderTicket): Promise<PlaceResult>;
	confirm(replyId: string): Promise<PlaceResult>;
	cancel(orderId: string): Promise<void>;
	orders(): Promise<BrokerOrder[]>;
	executions(): Promise<BrokerExecution[]>;
	positions(): Promise<BrokerPosition[]>;
	/** Cash in der Basiswährung des Kontos; currency "BASE", wenn der Broker die Basiswährung nicht nennt. */
	cash(): Promise<{ amount: number; currency: string } | null>;
}

/* ------------------------------------------------------------------ IBKR */

/** Yahoo-Endung → IBKR-Börsen, an denen derselbe Wert in derselben Währung gehandelt wird. */
const EXCHANGES: Record<string, string[]> = {
	DE: ["IBIS", "IBIS2"], // XETRA
	F: ["FWB", "FWB2"],
	AS: ["AEB"],
	PA: ["SBF"],
	L: ["LSE", "LSEETF"],
	MI: ["BVME"],
	SW: ["EBS"],
	MC: ["BM"],
	VI: ["VSE"],
};

/**
 * IBKR-Orderstatus → Desk. Endgültig sind nur Filled, Cancelled und ApiCancelled (und Rejected). PendingCancel kann noch
 * ausgeführt werden, Inactive ist oft vorübergehend (außerhalb der Handelszeit, Prüfung bei IBKR): beides arbeitet noch.
 */
export function ibkrStatus(s: string): BrokerOrder["status"] {
	const v = s.toLowerCase();
	if (v === "filled") return "filled";
	if (v === "cancelled" || v === "apicancelled") return "cancelled";
	if (v === "rejected") return "rejected";
	return "working";
}

/** Fehler beim Senden: ohne Antwort (Zeitlimit, Abbruch) oder bei 5xx ist das Ergebnis unbekannt, sonst eine Ablehnung. */
export function sendFailure(e: unknown): PlaceResult {
	const status = e instanceof HttpError ? e.status : 0;
	const message = (e as Error).message;
	return status === 0 || status >= 500 ? { kind: "unknown", message } : { kind: "rejected", message };
}

/** Antwort auf eine Order oder Bestätigung: Bestätigung der Order, Rückfrage, Fehler – oder nichts Verlässliches. */
export function parsePlace(r: unknown): PlaceResult {
	const first = (Array.isArray(r) ? r[0] : r) as Record<string, unknown> | undefined;
	if (!first) return { kind: "unknown", message: de.broker.emptyAnswer };
	if (typeof first.error === "string") return { kind: "rejected", message: first.error };
	if (first.order_id !== undefined) return { kind: "submitted", orderId: String(first.order_id), status: String(first.order_status ?? "") };
	if (typeof first.id === "string") {
		const msg = Array.isArray(first.message) ? first.message.join(" ") : String(first.message ?? "");
		return { kind: "reply", replyId: first.id, message: msg.replace(/\s+/g, " ").trim() };
	}
	return { kind: "unknown", message: de.broker.unknownAnswer(JSON.stringify(first).slice(0, 200)) };
}

export class IbkrBroker implements Broker {
	readonly adapter = "ibkr" as const;
	readonly loginUrl: string;
	private readonly base: string;
	private readonly account: string;
	private readonly conids: Record<string, number>;
	private ready = false; // /iserver/accounts und /portfolio/accounts müssen vor Orders bzw. Bestand gerufen sein
	private baseCurrency: string | null = null; // aus /portfolio/accounts
	private primed = false; // erster Orderabruf mit force=true (frische Liste nach dem Start)

	private readonly timeoutMs: number;

	constructor(opts: { gateway: string; account: string; conids?: Record<string, number>; timeoutMs?: number }) {
		this.base = `${opts.gateway.replace(/\/+$/, "")}/v1/api`;
		this.loginUrl = opts.gateway.replace(/\/+$/, "");
		this.account = opts.account;
		this.conids = opts.conids ?? {};
		this.timeoutMs = opts.timeoutMs ?? 10_000;
	}

	private call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
		return localJson<T>(method, this.base + path, body, { timeoutMs: this.timeoutMs });
	}

	async session(): Promise<BrokerSession> {
		try {
			const s = await this.call<{ authenticated?: boolean; connected?: boolean; message?: string; fail?: string }>("POST", "/iserver/auth/status");
			if (!s?.authenticated) {
				this.ready = false;
				return { connected: !!s?.connected, authenticated: false, account: null, paper: null, message: s?.fail || s?.message || de.broker.notLoggedIn };
			}
			const a = await this.call<{ accounts?: string[]; isPaper?: boolean }>("GET", "/iserver/accounts");
			const pa = await this.call<{ id?: string; accountId?: string; currency?: string }[]>("GET", "/portfolio/accounts");
			const mine = Array.isArray(pa) ? pa.find((x) => x.id === this.account || x.accountId === this.account) : undefined;
			this.baseCurrency = typeof mine?.currency === "string" && /^[A-Z]{3}$/.test(mine.currency) ? mine.currency : null;
			const has = (a.accounts ?? []).includes(this.account);
			this.ready = has;
			return { connected: true, authenticated: true, account: has ? this.account : null, paper: typeof a.isPaper === "boolean" ? a.isPaper : null, message: has ? "" : de.broker.accountNotTradable(this.account, (a.accounts ?? []).join(", ")) };
		} catch (e) {
			this.ready = false;
			const status = e instanceof HttpError ? e.status : 0;
			return { connected: status !== 0, authenticated: false, account: null, paper: null, message: status === 401 ? de.broker.notLoggedIn : de.broker.gateway((e as Error).message) };
		}
	}

	async keepAlive() {
		await this.call("POST", "/tickle").catch(() => undefined);
	}

	private async ensure() {
		if (this.ready) return;
		const s = await this.session();
		if (!s.account) throw new Error(s.message || de.broker.sessionNotReady);
	}

	async resolve(symbol: string) {
		if (this.conids[symbol]) return { conid: this.conids[symbol], description: de.broker.conidFromConfig(symbol) };
		if (/-[A-Z]{3}$/.test(symbol) || symbol.endsWith("=X")) throw new Error(de.broker.noCryptoFx(symbol));
		const [base, suffix] = symbol.split(".");
		const r = await this.call<Record<string, { name: string; assetClass: string; contracts: { conid: number; exchange: string; isUS: boolean }[] }[]>>("GET", `/trsrv/stocks?symbols=${encodeURIComponent(base)}`);
		const wanted = suffix ? EXCHANGES[suffix] : null;
		if (suffix && !wanted) throw new Error(de.broker.exchangeUnmapped(symbol, suffix));
		const hits = (r[base] ?? []).flatMap((s) => s.contracts.filter((c) => (wanted ? wanted.includes(c.exchange) : c.isUS)).map((c) => ({ conid: c.conid, description: `${s.name} ${c.exchange}` })));
		const unique = [...new Map(hits.map((h) => [h.conid, h])).values()];
		if (unique.length === 0) throw new Error(de.broker.noContract(symbol));
		if (unique.length > 1) throw new Error(de.broker.manyContracts(symbol, unique.map((u) => `${u.conid} ${u.description}`).join(", ")));
		return unique[0];
	}

	async place(t: OrderTicket): Promise<PlaceResult> {
		try {
			await this.ensure();
		} catch (e) {
			return { kind: "rejected", message: (e as Error).message }; // noch nichts gesendet
		}
		const order: Record<string, unknown> = { acctId: this.account, conid: t.conid, side: t.side === "buy" ? "BUY" : "SELL", orderType: t.type === "limit" ? "LMT" : "MKT", quantity: t.qty, tif: "DAY", cOID: t.cOID };
		if (t.type === "limit") order.price = t.limit;
		try {
			return parsePlace(await this.call("POST", `/iserver/account/${encodeURIComponent(this.account)}/orders`, { orders: [order] }));
		} catch (e) {
			return sendFailure(e);
		}
	}

	async confirm(replyId: string): Promise<PlaceResult> {
		try {
			return parsePlace(await this.call("POST", `/iserver/reply/${encodeURIComponent(replyId)}`, { confirmed: true }));
		} catch (e) {
			return sendFailure(e);
		}
	}

	async cancel(orderId: string) {
		await this.ensure();
		await this.call("DELETE", `/iserver/account/${encodeURIComponent(this.account)}/order/${encodeURIComponent(orderId)}`);
	}

	async orders(): Promise<BrokerOrder[]> {
		await this.ensure();
		type Raw = { orders?: { orderId: number | string; order_ref?: string; status?: string; filledQuantity?: number; avgPrice?: string | number; acct?: string }[] };
		if (!this.primed) {
			// nach dem Start einmal den Zwischenspeicher des Gateways leeren; diese Antwort ist laut IBKR leer, die nächste frisch
			await this.call<Raw>("GET", "/iserver/account/orders?force=true").catch(() => undefined);
			this.primed = true;
		}
		const r = await this.call<Raw>("GET", "/iserver/account/orders");
		return (r.orders ?? [])
			.filter((o) => !o.acct || o.acct === this.account)
			.map((o) => ({
				orderId: String(o.orderId), cOID: o.order_ref ?? null, status: ibkrStatus(o.status ?? ""), rawStatus: o.status ?? "", filledQty: Number(o.filledQuantity ?? 0),
				avgPrice: o.avgPrice === undefined || o.avgPrice === "" ? null : Number(o.avgPrice),
			}));
	}

	async executions(): Promise<BrokerExecution[]> {
		await this.ensure();
		type Raw = { execution_id: string; order_ref?: string; conid?: string | number; side: string; size: number; price: string | number; trade_time_r: number; commission?: string | number; commission_currency?: string; comission_currency?: string; account?: string };
		const r = await this.call<Raw[]>("GET", "/iserver/account/trades?days=7");
		const ccy = (x: Raw) => {
			const c = x.commission_currency ?? x.comission_currency; // IBKR schreibt das Feld je nach Version unterschiedlich
			return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : null;
		};
		return (r ?? [])
			.filter((x) => (x.side === "B" || x.side === "S") && (!x.account || x.account === this.account))
			.map((x) => ({
				id: x.execution_id, cOID: x.order_ref ?? null, conid: x.conid === undefined ? null : Number(x.conid), side: x.side === "B" ? "buy" : "sell", qty: Number(x.size), price: Number(x.price),
				time: Number(x.trade_time_r), commission: Math.abs(Number(x.commission ?? 0)) || 0, commissionCurrency: ccy(x),
			}));
	}

	async positions(): Promise<BrokerPosition[]> {
		await this.ensure();
		const out: BrokerPosition[] = [];
		for (let page = 0; page < 20; page++) {
			const r = await this.call<{ conid: number; ticker?: string; contractDesc?: string; position: number; avgPrice?: number; currency?: string; assetClass?: string }[]>("GET", `/portfolio/${encodeURIComponent(this.account)}/positions/${page}`);
			if (!Array.isArray(r) || r.length === 0) break;
			for (const p of r) if (p.position && p.assetClass !== "CASH") out.push({ conid: p.conid, ticker: p.ticker ?? "", description: p.contractDesc ?? p.ticker ?? String(p.conid), qty: p.position, avgCost: p.avgPrice ?? null, currency: p.currency ?? "" });
			if (r.length < 100) break;
		}
		return out;
	}

	async cash() {
		await this.ensure();
		const r = await this.call<Record<string, { cashbalance?: number; currency?: string }>>("GET", `/portfolio/${encodeURIComponent(this.account)}/ledger`);
		const base = r?.BASE;
		// BASE ist in der Basiswährung des Kontos – welche das ist, sagt /portfolio/accounts; unbekannt bleibt "BASE"
		return typeof base?.cashbalance === "number" ? { amount: base.cashbalance, currency: this.baseCurrency ?? "BASE" } : null;
	}
}

/* ------------------------------------------------------------------ Fake */

interface FakeOrder {
	t: OrderTicket;
	status: BrokerOrder["status"];
	raw: string; // Wortlaut wie bei IBKR (Submitted, PendingCancel, Inactive, Filled, Cancelled)
	fillAt: number | null;
	filled: number;
	listed: boolean; // false: aus der Orderliste verschwunden (wie eine Tagesorder am nächsten Tag)
}

/**
 * Verhält sich wie das Gateway: Rückfrage bei großen Orders, Market-Orders sind beim nächsten Abruf ausgeführt.
 * Für Tests: verlorene Antworten (die Order arbeitet trotzdem), PendingCancel, Teilausführungen, verschwundene Orders.
 */
export class FakeBroker implements Broker {
	readonly adapter = "fake" as const;
	readonly loginUrl = null;
	authenticated = true;
	paper = true; // Papier- oder Echtgeld-Sitzung im Gateway
	replyAbove = Number.POSITIVE_INFINITY; // Stückzahl, ab der eine Rückfrage kommt
	cashAmount = 25_000;
	baseCurrency = "EUR";
	loseNextAnswer = false; // nächste Order/Bestätigung kommt an, die Antwort geht verloren (Zeitlimit)
	pendingCancel = false; // Storno bleibt "PendingCancel", bis finishCancel()
	keepAlives = 0;
	readonly placed: OrderTicket[] = [];
	readonly book = new Map<string, FakeOrder>();
	readonly execs: BrokerExecution[] = [];
	readonly extraPositions: BrokerPosition[] = [];
	private next = 1000;
	private replies = new Map<string, OrderTicket>();
	private readonly prices: (conid: number) => number;
	private readonly now: () => number;

	constructor(prices: (conid: number) => number, now: () => number = Date.now) {
		this.prices = prices;
		this.now = now;
	}

	static conid(symbol: string): number {
		let h = 7;
		for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) % 9_000_000;
		return 1_000_000 + h;
	}

	async session(): Promise<BrokerSession> {
		return this.authenticated ? { connected: true, authenticated: true, account: "DU0000001", paper: this.paper, message: "" } : { connected: true, authenticated: false, account: null, paper: null, message: de.broker.notLoggedIn };
	}
	async keepAlive() {
		this.keepAlives++;
	}
	async resolve(symbol: string) {
		if (symbol.includes("-")) throw new Error(de.broker.noCryptoFx(symbol));
		return { conid: FakeBroker.conid(symbol), description: de.broker.fakeContract(symbol) };
	}
	private submit(t: OrderTicket): PlaceResult {
		const id = String(this.next++);
		this.book.set(id, { t, status: "working", raw: "Submitted", fillAt: t.type === "market" ? this.now() : null, filled: 0, listed: true });
		return this.answer({ kind: "submitted", orderId: id, status: "Submitted" });
	}
	private answer(r: PlaceResult): PlaceResult {
		if (!this.loseNextAnswer) return r;
		this.loseNextAnswer = false;
		return { kind: "unknown", message: de.http.noAnswer("10") };
	}
	async place(t: OrderTicket): Promise<PlaceResult> {
		if (!this.authenticated) return { kind: "rejected", message: de.broker.notLoggedInShort };
		this.placed.push(t);
		if (t.qty > this.replyAbove) {
			const id = `reply-${this.next++}`;
			this.replies.set(id, t);
			return this.answer({ kind: "reply", replyId: id, message: `The following order "${t.side.toUpperCase()} ${t.qty}" size exceeds the Size Limit. Are you sure you want to submit this order?` });
		}
		return this.submit(t);
	}
	async confirm(replyId: string): Promise<PlaceResult> {
		const t = this.replies.get(replyId);
		if (!t) return { kind: "rejected", message: de.broker.unknownReply };
		this.replies.delete(replyId);
		return this.submit(t);
	}
	async cancel(orderId: string) {
		const o = this.book.get(orderId);
		if (!o || o.status !== "working") return;
		if (this.pendingCancel) o.raw = "PendingCancel";
		else {
			o.status = "cancelled";
			o.raw = "Cancelled";
		}
	}
	finishCancel(orderId: string) {
		const o = this.book.get(orderId)!;
		if (o.status !== "working") return;
		o.status = "cancelled";
		o.raw = "Cancelled";
	}
	/** Status im Wortlaut von IBKR setzen (z. B. "Inactive"). */
	setRaw(orderId: string, raw: string) {
		const o = this.book.get(orderId)!;
		o.raw = raw;
		o.status = ibkrStatus(raw);
	}
	/** Order verschwindet aus /iserver/account/orders (Ausführungen bleiben). */
	drop(orderId: string) {
		this.book.get(orderId)!.listed = false;
	}
	/** Limit-Orders füllt der Test mit fill(). */
	fill(orderId: string, price?: number) {
		const o = this.book.get(orderId)!;
		o.fillAt = this.now();
		this.settle(orderId, price);
	}
	/** Teilausführung: qty Stück zu price, die Order arbeitet weiter. */
	partial(orderId: string, qty: number, price?: number) {
		const o = this.book.get(orderId)!;
		o.filled += qty;
		this.execs.push({ id: `exec-${orderId}-${this.execs.length}`, cOID: o.t.cOID, conid: o.t.conid, side: o.t.side, qty, price: price ?? this.prices(o.t.conid), time: this.now(), commission: 1.25, commissionCurrency: null });
	}
	private settle(orderId: string, price?: number) {
		const o = this.book.get(orderId)!;
		if (o.status !== "working") return;
		o.status = "filled";
		o.raw = "Filled";
		const qty = o.t.qty - o.filled;
		o.filled = o.t.qty;
		const px = price ?? this.prices(o.t.conid);
		this.execs.push({ id: `exec-${orderId}`, cOID: o.t.cOID, conid: o.t.conid, side: o.t.side, qty, price: px, time: this.now(), commission: 1.25, commissionCurrency: null });
	}
	async orders(): Promise<BrokerOrder[]> {
		for (const [id, o] of this.book) if (o.status === "working" && o.fillAt !== null && o.raw !== "PendingCancel") this.settle(id);
		return [...this.book.entries()]
			.filter(([, o]) => o.listed)
			.map(([id, o]) => {
				const fills = this.execs.filter((e) => e.cOID === o.t.cOID);
				const qty = fills.reduce((s, e) => s + e.qty, 0);
				return { orderId: id, cOID: o.t.cOID, status: o.status, rawStatus: o.raw, filledQty: qty, avgPrice: qty ? fills.reduce((s, e) => s + e.qty * e.price, 0) / qty : null };
			});
	}
	async executions() {
		return [...this.execs];
	}
	async positions(): Promise<BrokerPosition[]> {
		const by = new Map<number, number>();
		for (const e of this.execs) by.set(e.conid!, (by.get(e.conid!) ?? 0) + (e.side === "buy" ? e.qty : -e.qty));
		return [...[...by.entries()].filter(([, q]) => q).map(([conid, qty]) => ({ conid, ticker: "", description: String(conid), qty, avgCost: null, currency: "" })), ...this.extraPositions];
	}
	async cash() {
		return { amount: this.cashAmount, currency: this.baseCurrency };
	}
}
