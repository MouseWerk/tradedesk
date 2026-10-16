// Broker-Anbindung hinter einer Schnittstelle: Interactive Brokers über das lokale Client Portal Gateway
// (https://localhost:5000, Anmeldung macht der Besitzer dort selbst – der Desk sieht nie Zugangsdaten) und ein
// Fake-Broker für Tests und Fixture. Felder und Pfade nach der IBKR-Web-API-Dokumentation (docs/web-api).
import { HttpError, localJson } from "./http.ts";

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
	| { kind: "rejected"; message: string };

export interface BrokerOrder {
	orderId: string;
	cOID: string | null;
	status: "working" | "filled" | "cancelled" | "rejected";
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
	commission: number; // in Kontowährung der Ausführung, positiv
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
	cOID: string; // eindeutig je Vorschlag: desk-<id>
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
	/** Cash in der Basiswährung des Kontos (EUR erwartet). */
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

export function ibkrStatus(s: string): BrokerOrder["status"] {
	const v = s.toLowerCase();
	if (v === "filled") return "filled";
	if (v === "cancelled" || v === "pendingcancel" || v === "apicancelled") return "cancelled";
	if (v === "inactive" || v === "rejected") return "rejected";
	return "working";
}

/** Antwort auf eine Order oder Bestätigung: Bestätigung der Order, Rückfrage oder Fehler. */
export function parsePlace(r: unknown): PlaceResult {
	const first = (Array.isArray(r) ? r[0] : r) as Record<string, unknown> | undefined;
	if (!first) return { kind: "rejected", message: "leere Antwort des Brokers" };
	if (typeof first.error === "string") return { kind: "rejected", message: first.error };
	if (first.order_id !== undefined) return { kind: "submitted", orderId: String(first.order_id), status: String(first.order_status ?? "") };
	if (typeof first.id === "string") {
		const msg = Array.isArray(first.message) ? first.message.join(" ") : String(first.message ?? "");
		return { kind: "reply", replyId: first.id, message: msg.replace(/\s+/g, " ").trim() };
	}
	return { kind: "rejected", message: `unbekannte Antwort: ${JSON.stringify(first).slice(0, 200)}` };
}

export class IbkrBroker implements Broker {
	readonly adapter = "ibkr" as const;
	readonly loginUrl: string;
	private readonly base: string;
	private readonly account: string;
	private readonly conids: Record<string, number>;
	private ready = false; // /iserver/accounts und /portfolio/accounts müssen vor Orders bzw. Bestand gerufen sein

	constructor(opts: { gateway: string; account: string; conids?: Record<string, number> }) {
		this.base = `${opts.gateway.replace(/\/+$/, "")}/v1/api`;
		this.loginUrl = opts.gateway.replace(/\/+$/, "");
		this.account = opts.account;
		this.conids = opts.conids ?? {};
	}

	private call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
		return localJson<T>(method, this.base + path, body);
	}

	async session(): Promise<BrokerSession> {
		try {
			const s = await this.call<{ authenticated?: boolean; connected?: boolean; message?: string; fail?: string }>("POST", "/iserver/auth/status");
			if (!s?.authenticated) {
				this.ready = false;
				return { connected: !!s?.connected, authenticated: false, account: null, paper: null, message: s?.fail || s?.message || "Im Gateway nicht angemeldet." };
			}
			const a = await this.call<{ accounts?: string[]; isPaper?: boolean }>("GET", "/iserver/accounts");
			await this.call("GET", "/portfolio/accounts");
			const has = (a.accounts ?? []).includes(this.account);
			this.ready = has;
			return { connected: true, authenticated: true, account: has ? this.account : null, paper: typeof a.isPaper === "boolean" ? a.isPaper : null, message: has ? "" : `Konto ${this.account} ist in dieser Sitzung nicht handelbar (gefunden: ${(a.accounts ?? []).join(", ") || "keins"}).` };
		} catch (e) {
			this.ready = false;
			const status = e instanceof HttpError ? e.status : 0;
			return { connected: status !== 0, authenticated: false, account: null, paper: null, message: status === 401 ? "Im Gateway nicht angemeldet." : `Gateway: ${(e as Error).message}` };
		}
	}

	async keepAlive() {
		await this.call("POST", "/tickle").catch(() => undefined);
	}

	private async ensure() {
		if (this.ready) return;
		const s = await this.session();
		if (!s.account) throw new Error(s.message || "IBKR-Sitzung nicht bereit.");
	}

	async resolve(symbol: string) {
		if (this.conids[symbol]) return { conid: this.conids[symbol], description: `${symbol} (conid aus config.json)` };
		if (/-[A-Z]{3}$/.test(symbol) || symbol.endsWith("=X")) throw new Error(`${symbol}: Krypto und Devisen handelt der Desk nicht über IBKR.`);
		const [base, suffix] = symbol.split(".");
		const r = await this.call<Record<string, { name: string; assetClass: string; contracts: { conid: number; exchange: string; isUS: boolean }[] }[]>>("GET", `/trsrv/stocks?symbols=${encodeURIComponent(base)}`);
		const wanted = suffix ? EXCHANGES[suffix] : null;
		if (suffix && !wanted) throw new Error(`${symbol}: Börse „.${suffix}“ ist nicht zugeordnet – conid in config.json unter "conids" eintragen.`);
		const hits = (r[base] ?? []).flatMap((s) => s.contracts.filter((c) => (wanted ? wanted.includes(c.exchange) : c.isUS)).map((c) => ({ conid: c.conid, description: `${s.name} ${c.exchange}` })));
		const unique = [...new Map(hits.map((h) => [h.conid, h])).values()];
		if (unique.length === 0) throw new Error(`${symbol}: kein passender Kontrakt bei IBKR gefunden.`);
		if (unique.length > 1) throw new Error(`${symbol}: mehrere Kontrakte (${unique.map((u) => `${u.conid} ${u.description}`).join(", ")}) – eindeutige conid in config.json unter "conids" eintragen.`);
		return unique[0];
	}

	async place(t: OrderTicket): Promise<PlaceResult> {
		await this.ensure();
		const order: Record<string, unknown> = { acctId: this.account, conid: t.conid, side: t.side === "buy" ? "BUY" : "SELL", orderType: t.type === "limit" ? "LMT" : "MKT", quantity: t.qty, tif: "DAY", cOID: t.cOID };
		if (t.type === "limit") order.price = t.limit;
		try {
			return parsePlace(await this.call("POST", `/iserver/account/${encodeURIComponent(this.account)}/orders`, { orders: [order] }));
		} catch (e) {
			return { kind: "rejected", message: (e as Error).message };
		}
	}

	async confirm(replyId: string): Promise<PlaceResult> {
		try {
			return parsePlace(await this.call("POST", `/iserver/reply/${encodeURIComponent(replyId)}`, { confirmed: true }));
		} catch (e) {
			return { kind: "rejected", message: (e as Error).message };
		}
	}

	async cancel(orderId: string) {
		await this.ensure();
		await this.call("DELETE", `/iserver/account/${encodeURIComponent(this.account)}/order/${encodeURIComponent(orderId)}`);
	}

	async orders(): Promise<BrokerOrder[]> {
		await this.ensure();
		const r = await this.call<{ orders?: { orderId: number | string; order_ref?: string; status?: string; filledQuantity?: number; avgPrice?: string | number; acct?: string }[] }>("GET", "/iserver/account/orders");
		return (r.orders ?? [])
			.filter((o) => !o.acct || o.acct === this.account)
			.map((o) => ({ orderId: String(o.orderId), cOID: o.order_ref ?? null, status: ibkrStatus(o.status ?? ""), filledQty: Number(o.filledQuantity ?? 0), avgPrice: o.avgPrice === undefined || o.avgPrice === "" ? null : Number(o.avgPrice) }));
	}

	async executions(): Promise<BrokerExecution[]> {
		await this.ensure();
		const r = await this.call<{ execution_id: string; order_ref?: string; conid?: string | number; side: string; size: number; price: string | number; trade_time_r: number; commission?: string | number; account?: string }[]>("GET", "/iserver/account/trades?days=7");
		return (r ?? [])
			.filter((x) => (x.side === "B" || x.side === "S") && (!x.account || x.account === this.account))
			.map((x) => ({ id: x.execution_id, cOID: x.order_ref ?? null, conid: x.conid === undefined ? null : Number(x.conid), side: x.side === "B" ? "buy" : "sell", qty: Number(x.size), price: Number(x.price), time: Number(x.trade_time_r), commission: Math.abs(Number(x.commission ?? 0)) || 0 }));
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
		return typeof base?.cashbalance === "number" ? { amount: base.cashbalance, currency: "BASE" } : null;
	}
}

/* ------------------------------------------------------------------ Fake */

/** Verhält sich wie das Gateway: Rückfrage bei großen Orders, Market-Orders sind beim nächsten Abruf ausgeführt. */
export class FakeBroker implements Broker {
	readonly adapter = "fake" as const;
	readonly loginUrl = null;
	authenticated = true;
	paper = true; // Papier- oder Echtgeld-Sitzung im Gateway
	replyAbove = Number.POSITIVE_INFINITY; // Stückzahl, ab der eine Rückfrage kommt
	cashAmount = 25_000;
	readonly placed: OrderTicket[] = [];
	readonly book = new Map<string, { t: OrderTicket; status: BrokerOrder["status"]; fillAt: number | null }>();
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
		return this.authenticated ? { connected: true, authenticated: true, account: "DU0000001", paper: this.paper, message: "" } : { connected: true, authenticated: false, account: null, paper: null, message: "Im Gateway nicht angemeldet." };
	}
	async keepAlive() {}
	async resolve(symbol: string) {
		if (symbol.includes("-")) throw new Error(`${symbol}: Krypto und Devisen handelt der Desk nicht über IBKR.`);
		return { conid: FakeBroker.conid(symbol), description: `${symbol} (Fake)` };
	}
	private submit(t: OrderTicket): PlaceResult {
		const id = String(this.next++);
		this.book.set(id, { t, status: "working", fillAt: t.type === "market" ? this.now() : null });
		return { kind: "submitted", orderId: id, status: "Submitted" };
	}
	async place(t: OrderTicket): Promise<PlaceResult> {
		if (!this.authenticated) return { kind: "rejected", message: "nicht angemeldet" };
		this.placed.push(t);
		if (t.qty > this.replyAbove) {
			const id = `reply-${this.next++}`;
			this.replies.set(id, t);
			return { kind: "reply", replyId: id, message: `The following order "${t.side.toUpperCase()} ${t.qty}" size exceeds the Size Limit. Are you sure you want to submit this order?` };
		}
		return this.submit(t);
	}
	async confirm(replyId: string): Promise<PlaceResult> {
		const t = this.replies.get(replyId);
		if (!t) return { kind: "rejected", message: "unbekannte Rückfrage" };
		this.replies.delete(replyId);
		return this.submit(t);
	}
	async cancel(orderId: string) {
		const o = this.book.get(orderId);
		if (o && o.status === "working") o.status = "cancelled";
	}
	/** Limit-Orders füllt der Test mit fill(). */
	fill(orderId: string, price?: number) {
		const o = this.book.get(orderId)!;
		o.fillAt = this.now();
		this.settle(orderId, price);
	}
	private settle(orderId: string, price?: number) {
		const o = this.book.get(orderId)!;
		if (o.status !== "working") return;
		o.status = "filled";
		const px = price ?? this.prices(o.t.conid);
		this.execs.push({ id: `exec-${orderId}`, cOID: o.t.cOID, conid: o.t.conid, side: o.t.side, qty: o.t.qty, price: px, time: this.now(), commission: 1.25 });
	}
	async orders(): Promise<BrokerOrder[]> {
		for (const [id, o] of this.book) if (o.status === "working" && o.fillAt !== null) this.settle(id);
		return [...this.book.entries()].map(([id, o]) => ({ orderId: id, cOID: o.t.cOID, status: o.status, filledQty: o.status === "filled" ? o.t.qty : 0, avgPrice: o.status === "filled" ? (this.execs.find((e) => e.cOID === o.t.cOID)?.price ?? null) : null }));
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
		return { amount: this.cashAmount, currency: "BASE" };
	}
}
