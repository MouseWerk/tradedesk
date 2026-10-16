// Vertrag mit dem IBKR Client Portal Gateway gegen einen lokalen Fake (kein Netz): Pfade, Methoden und Bodies wie in
// der IBKR-Web-API-Dokumentation, Auswertung der Antworten (Bestätigung, Rückfrage, Fehler, Status, Ausführungen).
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IbkrBroker, ibkrStatus, parsePlace } from "../src/broker.ts";

let server: Server;
let gateway = "";
const calls: { method: string; path: string; body: unknown }[] = [];
let authed = true;
let orderReply: unknown = [{ order_id: "987654", order_status: "Submitted", encrypt_message: "1" }];

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const path = req.url!.replace(/^\/v1\/api/, "");
			calls.push({ method: req.method!, path, body: raw ? JSON.parse(raw) : null });
			res.setHeader("Content-Type", "application/json");
			const send = (v: unknown, status = 200) => {
				res.statusCode = status;
				res.end(JSON.stringify(v));
			};
			if (path === "/iserver/auth/status" && req.method === "POST") return send({ authenticated: authed, connected: true, competing: false, message: "" });
			if (path === "/iserver/accounts") return send({ accounts: ["DU123456"], selectedAccount: "DU123456", isPaper: true });
			if (path === "/portfolio/accounts") return send([{ id: "DU123456", accountId: "DU123456" }]);
			if (path === "/tickle" && req.method === "POST") return send({ session: "x" });
			if (path.startsWith("/trsrv/stocks")) {
				const sym = new URL("http://x" + path).searchParams.get("symbols");
				if (sym === "SAP") return send({ SAP: [{ name: "SAP SE", assetClass: "STK", contracts: [{ conid: 14204, exchange: "IBIS", isUS: false }, { conid: 99999, exchange: "NYSE", isUS: true }] }] });
				if (sym === "AAPL") return send({ AAPL: [{ name: "APPLE INC", assetClass: "STK", contracts: [{ conid: 265598, exchange: "NASDAQ", isUS: true }, { conid: 38708077, exchange: "MEXI", isUS: false }] }] });
				if (sym === "DUP") return send({ DUP: [{ name: "A", assetClass: "STK", contracts: [{ conid: 1, exchange: "NYSE", isUS: true }] }, { name: "B", assetClass: "STK", contracts: [{ conid: 2, exchange: "NASDAQ", isUS: true }] }] });
				return send({});
			}
			if (path === "/iserver/account/DU123456/orders" && req.method === "POST") return send(orderReply);
			if (path.startsWith("/iserver/reply/") && req.method === "POST") return send([{ order_id: "987655", order_status: "PreSubmitted" }]);
			if (path === "/iserver/account/DU123456/order/987654" && req.method === "DELETE") return send({ msg: "Request was submitted", order_id: 987654 });
			if (path === "/iserver/account/orders")
				return send({ orders: [{ acct: "DU123456", orderId: 987654, order_ref: "desk-12", status: "Filled", filledQuantity: 3, avgPrice: "201.30" }, { acct: "U999", orderId: 1, status: "Submitted" }], snapshot: true });
			if (path === "/iserver/account/trades?days=7")
				return send([{ execution_id: "0000e0d5.01", order_ref: "desk-12", conid: "14204", side: "B", size: 3, price: "201.30", trade_time_r: 1702317649000, commission: "1.25", account: "DU123456" }]);
			if (path === "/portfolio/DU123456/positions/0") return send([{ conid: 14204, ticker: "SAP", contractDesc: "SAP SE", position: 3, avgPrice: 201.3, currency: "EUR", assetClass: "STK" }]);
			if (path === "/portfolio/DU123456/ledger") return send({ BASE: { cashbalance: 24396.85, currency: "BASE" }, EUR: { cashbalance: 24396.85 } });
			send({ error: "not found" }, 404);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
	calls.length = 0;
	authed = true;
	orderReply = [{ order_id: "987654", order_status: "Submitted", encrypt_message: "1" }];
});

const ib = () => new IbkrBroker({ gateway, account: "DU123456" });

describe("IbkrBroker", () => {
	it("checks the session with POST /iserver/auth/status and loads the accounts", async () => {
		expect(await ib().session()).toMatchObject({ authenticated: true, account: "DU123456", paper: true });
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /iserver/auth/status", "GET /iserver/accounts", "GET /portfolio/accounts"]);
		authed = false;
		expect(await ib().session()).toMatchObject({ authenticated: false, account: null });
	});

	it("submits {orders:[…]} with conid, BUY/SELL, MKT/LMT, DAY and the client order id", async () => {
		const r = await ib().place({ conid: 14204, side: "buy", qty: 3, type: "limit", limit: 199.5, cOID: "desk-12" });
		expect(r).toEqual({ kind: "submitted", orderId: "987654", status: "Submitted" });
		const sent = calls.find((c) => c.path.endsWith("/orders") && c.method === "POST")!;
		expect(sent.body).toEqual({ orders: [{ acctId: "DU123456", conid: 14204, side: "BUY", orderType: "LMT", price: 199.5, quantity: 3, tif: "DAY", cOID: "desk-12" }] });
		await ib().place({ conid: 14204, side: "sell", qty: 1, type: "market", cOID: "desk-13" });
		const market = calls.filter((c) => c.path.endsWith("/orders") && c.method === "POST").at(-1)!.body as { orders: Record<string, unknown>[] };
		expect(market.orders[0]).toMatchObject({ side: "SELL", orderType: "MKT" });
		expect(market.orders[0]).not.toHaveProperty("price");
	});

	it("returns the broker's question and confirms with POST /iserver/reply/{id} {confirmed:true}", async () => {
		orderReply = [{ id: "07a13a5a", message: ['The following order "BUY 100 AAPL" price exceeds \nthe Percentage constraint of 3%.'], isSuppressed: false, messageIds: ["o163"] }];
		const r = await ib().place({ conid: 265598, side: "buy", qty: 100, type: "market", cOID: "desk-1" });
		expect(r).toEqual({ kind: "reply", replyId: "07a13a5a", message: 'The following order "BUY 100 AAPL" price exceeds the Percentage constraint of 3%.' });
		const c = await ib().confirm("07a13a5a");
		expect(c).toMatchObject({ kind: "submitted", orderId: "987655" });
		expect(calls.find((x) => x.path === "/iserver/reply/07a13a5a")!.body).toEqual({ confirmed: true });
	});

	it("reports an error response as rejected", async () => {
		orderReply = { error: "Order rejected - reason: insufficient funds" };
		expect(await ib().place({ conid: 1, side: "buy", qty: 1, type: "market", cOID: "desk-2" })).toEqual({ kind: "rejected", message: "Order rejected - reason: insufficient funds" });
	});

	it("resolves XETRA symbols to IBIS and US symbols to the US listing, refuses ambiguity", async () => {
		expect((await ib().resolve("SAP.DE")).conid).toBe(14204);
		expect((await ib().resolve("AAPL")).conid).toBe(265598);
		await expect(ib().resolve("DUP")).rejects.toThrow("mehrere Kontrakte");
		await expect(ib().resolve("SAP.XX")).rejects.toThrow("nicht zugeordnet");
		await expect(ib().resolve("BTC-EUR")).rejects.toThrow("Krypto");
		expect((await new IbkrBroker({ gateway, account: "DU123456", conids: { "SAP.DE": 777 } }).resolve("SAP.DE")).conid).toBe(777);
	});

	it("reads orders, executions, positions and cash of this account only", async () => {
		const b = ib();
		expect(await b.orders()).toEqual([{ orderId: "987654", cOID: "desk-12", status: "filled", filledQty: 3, avgPrice: 201.3 }]);
		expect(await b.executions()).toEqual([{ id: "0000e0d5.01", cOID: "desk-12", conid: 14204, side: "buy", qty: 3, price: 201.3, time: 1702317649000, commission: 1.25 }]);
		expect(await b.positions()).toEqual([{ conid: 14204, ticker: "SAP", description: "SAP SE", qty: 3, avgCost: 201.3, currency: "EUR" }]);
		expect(await b.cash()).toEqual({ amount: 24396.85, currency: "BASE" });
	});

	it("cancels with DELETE /iserver/account/{acct}/order/{id}", async () => {
		await ib().cancel("987654");
		expect(calls.some((c) => c.method === "DELETE" && c.path === "/iserver/account/DU123456/order/987654")).toBe(true);
	});

	it("maps IBKR order states", () => {
		expect(["Filled", "Cancelled", "PendingCancel", "Inactive", "Submitted", "PreSubmitted"].map(ibkrStatus)).toEqual(["filled", "cancelled", "cancelled", "rejected", "working", "working"]);
		expect(parsePlace([])).toMatchObject({ kind: "rejected" });
	});
});
