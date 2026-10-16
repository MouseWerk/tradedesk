// Kursquelle: Yahoo/Fake unverändert hinter QuoteFeed, IBKR-Momentaufnahmen gegen einen lokalen Fake des Client Portal
// Gateways (kein Netz) – Pfad und Felder wie in IBKRs Doku „Live Market Data Snapshot“ (GET /iserver/marketdata/snapshot,
// Felder 31, 84, 86, 6509), Pre-Flight, Rückfall auf die andere Quelle, Herkunft und Alter je Kurs im Desk.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScanRowSchema, WatchItemSchema } from "@desk/shared";
import { cleanConfig } from "../src/config.ts";
import { IbkrQuoteFeed, MarketFeed, ibkrDelayed, ibkrLast, type QuoteFeed } from "../src/feed.ts";
import { FakeMarket } from "../src/market.ts";
import { makeFixture, type Fixture } from "../src/fixture.ts";

let server: Server;
let gateway = "";
const calls: string[] = [];
let snapshots = 0; // je Anfrage: die erste liefert nur Kontrakte (Pre-Flight)
let item: Record<string, unknown> = {};
let fault: number | null = null;

beforeAll(async () => {
	server = createServer((req, res) => {
		const path = req.url!.replace(/^\/v1\/api/, "");
		calls.push(`${req.method} ${path}`);
		res.setHeader("Content-Type", "application/json");
		const send = (v: unknown, status = 200) => {
			res.statusCode = status;
			res.end(JSON.stringify(v));
		};
		if (fault) return send({ error: "boom" }, fault);
		if (path === "/iserver/accounts") return send({ accounts: ["DU123456"], selectedAccount: "DU123456", isPaper: true });
		if (path.startsWith("/iserver/marketdata/snapshot")) {
			const conids = new URL(`http://x${path}`).searchParams.get("conids")!.split(",").map(Number);
			snapshots++;
			return send(conids.map((conid) => (snapshots === 1 ? { conid, conidEx: String(conid) } : { conid, conidEx: String(conid), _updated: 1_760_000_000_000, server_id: "q0", ...item })));
		}
		send({ error: "not found" }, 404);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
	calls.length = 0;
	snapshots = 0;
	item = { "31": "205.10", "84": "205.05", "86": "205.15", "6509": "RpB" };
	fault = null;
});

const conids: Record<string, number> = { "SAP.DE": 14204, AAPL: 265598 };
const resolver = { resolve: async (s: string) => (conids[s] ? { conid: conids[s], description: s } : Promise.reject(new Error("kein Kontrakt"))) };
const feedOf = (market: FakeMarket) => new IbkrQuoteFeed({ gateway, broker: resolver, fallback: new MarketFeed(market), timeoutMs: 500 });

describe("IBKR field parsing", () => {
	it("last price without the previous-close prefix, halted price with H, availability", () => {
		expect([ibkrLast("201.3"), ibkrLast("H201.3"), ibkrLast("C199.0"), ibkrLast(""), ibkrLast("1,234.5")]).toEqual([201.3, 201.3, null, null, 1234.5]);
		expect(["RpB", "Rp", "DpB", "Z", "Y", "N", undefined].map(ibkrDelayed)).toEqual([false, false, true, false, true, undefined, undefined]);
	});
});

describe("IbkrQuoteFeed against a local fake gateway", () => {
	it("pre-flight first, then IBKR's last, bid, ask and time; the rest from the fallback", async () => {
		const market = new FakeMarket(() => 1_760_000_100_000);
		const feed = feedOf(market);
		const first = await feed.snapshot(["SAP.DE", "USDEUR=X", "BTC-EUR"]);
		expect(first.quotes.map((q) => [q.symbol, q.source, q.price])).toEqual([["SAP.DE", "fake", 201.25], ["USDEUR=X", "fake", 0.92], ["BTC-EUR", "fake", 61_250]]);
		expect(calls).toEqual(["GET /iserver/accounts", "GET /iserver/marketdata/snapshot?conids=14204&fields=31,84,86,6509"]); // Wechselkurs und Krypto nie bei IBKR
		const second = await feed.snapshot(["SAP.DE"]);
		expect(second.quotes[0]).toMatchObject({ symbol: "SAP.DE", name: "SAP SE", currency: "EUR", source: "ibkr", price: 205.1, bid: 205.05, ask: 205.15, delayed: false, marketTime: 1_760_000_000_000 });
		expect(calls.filter((c) => c === "GET /iserver/accounts")).toHaveLength(1);
	});

	it("delayed data is marked, a previous close or no subscription is not taken, seconds become ms", async () => {
		const feed = feedOf(new FakeMarket());
		await feed.snapshot(["SAP.DE"]); // Pre-Flight
		item = { "31": "204", "6509": "DpB", _updated: 1_760_000_000 };
		expect((await feed.snapshot(["SAP.DE"])).quotes[0]).toMatchObject({ source: "ibkr", price: 204, delayed: true, marketTime: 1_760_000_000_000, bid: null });
		item = { "31": "C200.5", "6509": "RpB" };
		expect((await feed.snapshot(["SAP.DE"])).quotes[0]).toMatchObject({ source: "fake", price: 201.25 });
		item = { "31": "204", "6509": "N" };
		expect((await feed.snapshot(["SAP.DE"])).quotes[0].source).toBe("fake");
	});

	it("a price far from the fallback (other contract or unit) is not taken", async () => {
		const feed = feedOf(new FakeMarket());
		await feed.snapshot(["SAP.DE"]);
		item = { "31": "20.12", "6509": "RpB" };
		expect((await feed.snapshot(["SAP.DE"])).quotes[0]).toMatchObject({ source: "fake", price: 201.25 });
	});

	it("falls back when the gateway fails, asks /iserver/accounts again after a 401", async () => {
		const feed = feedOf(new FakeMarket());
		fault = 401;
		expect((await feed.snapshot(["SAP.DE"])).quotes[0].source).toBe("fake");
		expect(feed.lastError).toContain("401");
		fault = 503;
		expect((await feed.snapshot(["SAP.DE"])).quotes[0].source).toBe("fake");
		fault = null;
		await feed.snapshot(["SAP.DE"]);
		expect((await feed.snapshot(["SAP.DE"])).quotes[0].source).toBe("ibkr");
		expect(feed.lastError).toBeNull();
		expect(calls.filter((c) => c === "GET /iserver/accounts").length).toBeGreaterThanOrEqual(2);
	});

	it("only talks to localhost", async () => {
		const feed = new IbkrQuoteFeed({ gateway: "https://example.com:5000", broker: resolver, fallback: new MarketFeed(new FakeMarket()) });
		expect((await feed.snapshot(["SAP.DE"])).quotes[0].source).toBe("fake");
		expect(feed.lastError).toContain("nur lokale Gateways");
	});
});

describe("config", () => {
	it("quotes default to yahoo; ibkr only when set", () => {
		const base = { home: "", dbFile: "", webDist: "", dev: false };
		expect(cleanConfig({}, base, {}).quotes).toBe("yahoo");
		expect(cleanConfig({ quotes: "ibkr" }, base, {}).quotes).toBe("ibkr");
		expect(cleanConfig({ quotes: "bloomberg" }, base, {}).quotes).toBe("yahoo");
	});
});

describe("quote source and age in the desk", () => {
	let fx: Fixture;
	let clock: number;
	afterEach(() => fx.cleanup());

	it("fake feed by default: source fake, age from the quote time, delay unknown", async () => {
		clock = new Date(2026, 9, 15, 11, 0).getTime();
		fx = await makeFixture({ now: () => clock });
		const w = fx.desk.watchlist().find((x) => x.symbol === "SAP.DE")!;
		expect(WatchItemSchema.parse(w).quote).toMatchObject({ source: "fake", ageSec: 60, delayed: null, bid: null }); // Fake-Kurszeit: eine Minute alt
		clock += 30_000;
		expect(fx.desk.scan().find((x) => x.symbol === "SAP.DE")!.quote!.ageSec).toBe(90);
		expect(ScanRowSchema.parse(fx.desk.scan()[0]).quote).not.toBeNull();
		expect(fx.desk.detail("tr").positions.every((p) => p.quote?.source === "fake")).toBe(true);
		expect(fx.desk.overview().quoteFeed).toBe("fake");
		expect(fx.desk.cockpit().quoteFeed).toBe("fake");
	});

	it("with the IBKR feed the desk stores IBKR prices with their source", async () => {
		clock = new Date(2026, 9, 15, 11, 0).getTime();
		fx = await makeFixture({ now: () => clock, feed: feedOf });
		await fx.desk.refresh(["SAP.DE"]); // nach dem Pre-Flight der Fixture
		const w = fx.desk.watchlist().find((x) => x.symbol === "SAP.DE")!;
		expect(w).toMatchObject({ price: 205.1, quote: { source: "ibkr", delayed: false, bid: 205.05, ask: 205.15 } });
		expect(fx.desk.overview().quoteFeed).toBe("ibkr");
		expect(fx.desk.watchlist().find((x) => x.symbol === "BTC-EUR")!.quote!.source).toBe("fake");
	});

	it("a push feed's quotes are stored between ticks", async () => {
		clock = new Date(2026, 9, 15, 11, 0).getTime();
		let push: ((q: Parameters<Parameters<QuoteFeed["onQuotes"]>[0]>[0]) => void) | null = null;
		fx = await makeFixture({
			now: () => clock,
			feed: (market) => {
				const base = new MarketFeed(market);
				return { source: "fake", subscribe: () => {}, snapshot: (s) => base.snapshot(s), onQuotes: (fn) => ((push = fn), () => (push = null)) };
			},
		});
		fx.desk.start();
		const [q] = (await new MarketFeed(fx.market).snapshot(["SAP.DE"])).quotes;
		push!([{ ...q, price: 210, delayed: false }]);
		expect(fx.desk.priced("SAP.DE")!.price).toBe(210);
		expect(fx.desk.quoteInfo("SAP.DE")!.delayed).toBe(false);
		fx.desk.stop();
		expect(push).toBeNull();
	});
});
