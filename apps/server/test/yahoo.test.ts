// Vertrag mit Yahoo Finance gegen einen lokalen Fake-Server (kein Netz): Form der Antwort, Symbol-Umbenennung, Pence.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { YahooMarket } from "../src/market.ts";

let server: Server;
let base = "";
const chart = (symbol: string, currency: string, price: number) => ({
	chart: { result: [{ meta: { symbol, currency, longName: symbol, fullExchangeName: "X", instrumentType: "EQUITY", regularMarketPrice: price, chartPreviousClose: price * 0.99, regularMarketTime: 1_700_000_000 }, timestamp: [1_700_000_000], indicators: { quote: [{ open: [price], high: [price], low: [price], close: [price], volume: [1] }] } }], error: null },
});

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url!, "http://x");
		const sym = decodeURIComponent(url.pathname.split("/").pop()!);
		res.setHeader("Content-Type", "application/json");
		if (sym === "USDEUR=X") return res.end(JSON.stringify(chart("EUR=X", "EUR", 0.9))); // so antwortet Yahoo wirklich
		if (sym === "VOD.L") return res.end(JSON.stringify(chart("VOD.L", "GBp", 7000)));
		if (sym === "NOPE") return res.end(JSON.stringify({ chart: { result: null, error: { description: "No data found" } } }));
		res.end(JSON.stringify(chart(sym, "USD", 100)));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("YahooMarket", () => {
	it("keeps the requested symbol when Yahoo renames it (USDEUR=X → EUR=X)", async () => {
		const { quotes } = await new YahooMarket(base).quotes(["USDEUR=X"]);
		expect(quotes[0]).toMatchObject({ symbol: "USDEUR=X", price: 0.9 });
	});

	it("converts pence to pounds", async () => {
		const { quotes } = await new YahooMarket(base).quotes(["VOD.L"]);
		expect(quotes[0]).toMatchObject({ currency: "GBP", price: 70 });
	});

	it("drops unknown symbols without failing the others", async () => {
		const r = await new YahooMarket(base).quotes(["NOPE", "AAPL"]);
		expect(r.quotes.map((q) => q.symbol)).toEqual(["AAPL"]);
		expect(r.error).toBeNull();
	});
});
