// GET /api/analytics gegen eine leere Fixture mit von Hand gerechneten Trades und Tagesständen, dazu das Budget mit
// 5 000 Trades. Die reinen Rechnungen (Lose, R, Drawdown, Tage, Zeitumstellung) prüft packages/shared/src/analytics.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsSchema, orderValueCents } from "@desk/shared";
import { makeFixture, type Fixture } from "../src/fixture.ts";
import { deskHttp } from "./owner.ts";

let fx: Fixture;
let clock: number;
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

beforeEach(async () => {
	clock = at(11, 12);
	fx = await makeFixture({ seed: false, now: () => clock });
	fx.db.run("INSERT INTO instrument (symbol, name, currency, exchange, type) VALUES ('SAP.DE','SAP SE','EUR','XETRA','EQUITY'), ('AAPL','Apple Inc.','USD','NasdaqGS','EQUITY')");
});
afterEach(() => fx.cleanup());

function proposal(account: string, author: string, symbol: string, stop: number | null, time: number): number {
	return fx.db.run(
		`INSERT INTO proposal (account_id, author, symbol, side, qty, order_type, stop_loss, confidence, thesis, status, quote_price, created_at, decided_at, decided_by, approved_qty, expires_at, fill_price)
		 VALUES (?,?,?,'buy',10,'market',?,0.7,'x','filled',100,?,?,'Maurice',10,?,100)`,
		account, author, symbol, stop, time, time, time + 86_400_000,
	).lastId;
}

function trade(account: string, symbol: string, side: "buy" | "sell", qty: number, price: number, time: number, o: { currency?: string; fx?: number; fee?: number; proposal?: number | null } = {}) {
	const fxRate = o.fx ?? 1;
	fx.db.run(
		"INSERT INTO trade (account_id, symbol, side, qty, price, currency, fx, value_cents, fee_cents, time, source, proposal_id, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'')",
		account, symbol, side, qty, price, o.currency ?? "EUR", fxRate, orderValueCents(qty, price, fxRate), o.fee ?? 100, time, o.proposal ? "proposal" : "order", o.proposal ?? null,
	);
}

function snapshot(account: string, day: string, equity: number, deposits = 2_000_000) {
	fx.db.run("INSERT OR REPLACE INTO snapshot (account_id, day, equity_cents, deposits_cents) VALUES (?,?,?,?)", account, day, equity, deposits);
}

/** Papierdepot (deins, 20 000 €): SAP über zwei Lose mit Teilverkauf, AAPL in USD; Tagesstände mit Lücke am 08. */
function handCase() {
	trade("papier", "SAP.DE", "buy", 10, 100, at(5, 10), { proposal: proposal("papier", "Atlas", "SAP.DE", 95, at(5, 9)) });
	trade("papier", "SAP.DE", "buy", 10, 120, at(6, 15, 30));
	trade("papier", "SAP.DE", "sell", 15, 130, at(7, 11));
	trade("papier", "AAPL", "buy", 10, 200, at(8, 16), { currency: "USD", fx: 0.9, proposal: proposal("papier", "Nova", "AAPL", 190, at(8, 15)) });
	trade("papier", "AAPL", "sell", 10, 210, at(9, 17), { currency: "USD", fx: 0.92 });
	snapshot("papier", "2026-10-04", 2_000_000);
	snapshot("papier", "2026-10-05", 1_999_900);
	snapshot("papier", "2026-10-06", 2_010_000);
	snapshot("papier", "2026-10-07", 2_030_000);
	snapshot("papier", "2026-10-09", 2_025_000);
	snapshot("papier", "2026-10-10", 2_040_000);
}

describe("GET /api/analytics", () => {
	it("closed trades, R, stats, groups, curve and days for a hand-computed week", async () => {
		handCase();
		const r = await deskHttp(fx).get("/api/analytics?account=papier&from=2026-10-05&to=2026-10-10");
		expect(r.status).toBe(200);
		const a = AnalyticsSchema.parse(await r.json());
		expect(a).toMatchObject({ scope: "papier", accountIds: ["papier"], from: "2026-10-05", to: "2026-10-10", timezone: "Europe/Berlin", tradesTotal: 3 });
		// neueste zuerst: AAPL, dann die beiden Teile des SAP-Verkaufs
		expect(a.trades.map((t) => [t.symbol, t.author, t.qty, t.costCents, t.proceedsCents, t.pnlCents, t.riskCents])).toEqual([
			["AAPL", "Nova", 10, 180_100, 193_100, 13_000, 9_200], // Risiko 10 × 10 USD × 0,9 + 2 × 1 €
			["SAP.DE", "Atlas", 10, 100_100, 129_933, 29_833, 5_167], // Risiko 10 × 5 € + 1 € Kauf- + 0,67 € Verkaufsgebühr
			["SAP.DE", "Maurice", 5, 60_050, 64_967, 4_917, null], // Kauf von Hand: kein Stop, kein R
		]);
		expect(a.trades[0].r).toBeCloseTo(13_000 / 9_200, 12);
		expect(a.trades[1].r).toBeCloseTo(29_833 / 5_167, 12);
		expect(a.trades[1]).toMatchObject({ entryTime: at(5, 10), exitTime: at(7, 11), entryPrice: 100, exitPrice: 130, holdMs: at(7, 11) - at(5, 10), stopLoss: 95, feesCents: 167 });
		expect(a.stats).toMatchObject({ trades: 3, wins: 3, losses: 0, winRate: 100, pnlCents: 47_750, profitFactor: null, expectancyCents: 15_917, rTrades: 2 });
		expect(a.stats.expectancyR).toBeCloseTo((13_000 / 9_200 + 29_833 / 5_167) / 2, 12);
		expect(a.rBuckets.filter((b) => b.trades).map((b) => [b.from, b.to])).toEqual([[1, 2], [3, null]]);
		// Wochentag und Stunde des Einstiegs: Mo 10 Uhr, Di 15 Uhr, Do 16 Uhr
		expect(a.byWeekday.map((w) => w.trades)).toEqual([1, 1, 0, 1, 0, 0, 0]);
		expect(a.byHour.filter((h) => h.trades).map((h) => h.hour)).toEqual([10, 15, 16]);
		expect(a.byHour).toHaveLength(24);
		expect(a.byAuthor.map((x) => [x.author, x.pnlCents])).toEqual([["Maurice", 4_917], ["Atlas", 29_833], ["Nova", 13_000]]);
		expect(a.bySymbol.map((x) => [x.symbol, x.name, x.trades, x.pnlCents])).toEqual([["SAP.DE", "SAP SE", 2, 34_750], ["AAPL", "Apple Inc.", 1, 13_000]]);
		// Ergebnis −100, 10 000, 30 000, 25 000, 40 000: Rückgang am 09. um 50 € von der Spitze am 07., erholt am 10.
		expect(a.curve.map((p) => p.day)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-09", "2026-10-10"]);
		expect(a.maxDrawdown).toMatchObject({ cents: -5_000, peakDay: "2026-10-07", troughDay: "2026-10-09", recoveryDay: "2026-10-10" });
		expect(a.maxDrawdown!.pct).toBeCloseTo((-5_000 / 2_030_000) * 100, 10);
		expect(a.days).toEqual([
			{ day: "2026-10-05", realizedCents: 0, trades: 0, resultCents: -100, unrealizedChangeCents: -100, sinceDay: "2026-10-04" },
			{ day: "2026-10-06", realizedCents: 0, trades: 0, resultCents: 10_100, unrealizedChangeCents: 10_100, sinceDay: "2026-10-05" },
			{ day: "2026-10-07", realizedCents: 34_750, trades: 2, resultCents: 20_000, unrealizedChangeCents: -14_750, sinceDay: "2026-10-06" },
			{ day: "2026-10-09", realizedCents: 13_000, trades: 1, resultCents: -5_000, unrealizedChangeCents: -18_000, sinceDay: "2026-10-07" },
			{ day: "2026-10-10", realizedCents: 0, trades: 0, resultCents: 15_000, unrealizedChangeCents: 15_000, sinceDay: "2026-10-09" },
		]);
	});

	it("the range filters trades by their exit day; mine and all combine accounts", () => {
		handCase();
		trade("agent-atlas", "SAP.DE", "buy", 1, 100, at(8, 10));
		trade("agent-atlas", "SAP.DE", "sell", 1, 90, at(8, 11));
		expect(fx.desk.analytics({ account: "papier", from: "2026-10-08", to: "2026-10-10" }).trades.map((t) => t.symbol)).toEqual(["AAPL"]);
		expect(fx.desk.analytics({ account: "mine" }).tradesTotal).toBe(3);
		const all = fx.desk.analytics({ account: "all" });
		expect(all.tradesTotal).toBe(4);
		expect(all.byAuthor.find((x) => x.author === "Atlas")!.trades).toBe(2); // eigener Kauf im Agentendepot zählt für Atlas
		expect(fx.desk.analytics().scope).toBe("mine");
	});

	it("refuses bad dates and unknown accounts", async () => {
		const http = deskHttp(fx);
		expect((await http.get("/api/analytics?from=2026-02-30")).status).toBe(400);
		expect((await http.get("/api/analytics?from=2026-10-10&to=2026-10-01")).status).toBe(400);
		expect((await http.get("/api/analytics?to=10.10.2026")).status).toBe(400);
		expect((await http.get("/api/analytics?account=nope")).status).toBe(404);
	});

	it("an empty account has zero stats, all weekdays and hours and no drawdown", () => {
		const a = AnalyticsSchema.parse(fx.desk.analytics({ account: "agent-nova" }));
		expect(a).toMatchObject({ tradesTotal: 0, trades: [], maxDrawdown: null, stats: { trades: 0, winRate: null } });
		expect(a.byWeekday).toHaveLength(7);
		expect(a.byAuthor.map((x) => x.author)).toEqual(["Maurice", "Atlas", "Nova"]);
		expect(a.curve.at(-1)!.day).toBe("2026-10-11"); // heute mit dem Live-Wert
	});
});

describe("budget: analytics with 5 000 trades", () => {
	it("stays under 50 ms", async () => {
		// 2 500 Käufe mit Stop über ein Jahr, je ein Verkauf; 365 Tagesstände
		const symbols = ["SAP.DE", "AAPL"];
		fx.db.tx(() => {
			for (let i = 0; i < 2_500; i++) {
				const t = clock - 365 * 86_400_000 + i * 3 * 3_600_000;
				const symbol = symbols[i % 2];
				const usd = symbol === "AAPL";
				trade("papier", symbol, "buy", 2, 100, t, { currency: usd ? "USD" : "EUR", fx: usd ? 0.9 : 1, proposal: proposal("papier", i % 3 ? "Atlas" : "Nova", symbol, 95, t) });
				trade("papier", symbol, "sell", 2, 100 + ((i % 7) - 3), t + 3_600_000, { currency: usd ? "USD" : "EUR", fx: usd ? 0.9 : 1 });
			}
			for (let d = 1; d <= 365; d++) snapshot("papier", new Date(clock - d * 86_400_000).toISOString().slice(0, 10), 2_000_000 + ((d * 7919) % 50_000) - 25_000);
		});
		const runs: number[] = [];
		const t0 = performance.now();
		let a = fx.desk.analytics({ account: "papier" }); // erster Aufruf baut das Buch (danach aus dem Zwischenspeicher)
		const first = performance.now() - t0;
		for (let i = 0; i < 5; i++) {
			const t = performance.now();
			a = fx.desk.analytics({ account: "papier" });
			runs.push(performance.now() - t);
		}
		const best = Math.min(...runs);
		console.log(`budget: analytics 5 000 trades ${best.toFixed(1)} ms, first call ${first.toFixed(1)} ms (runs ${runs.map((r) => r.toFixed(1)).join(", ")})`);
		expect(a.tradesTotal).toBe(2_500);
		expect(a.stats.rTrades).toBe(2_500);
		expect(best).toBeLessThan(50);
		expect(first).toBeLessThan(250);
	});
});
