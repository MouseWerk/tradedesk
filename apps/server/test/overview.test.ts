// Übersicht (Neugestaltung): Aufteilung deiner Depots nach Symbol und Anlageklasse, Veränderung je Zeitraum aus den
// Tagesständen. Von Hand gerechnet gegen eine leere Fixture; die Zeiträume selbst prüft packages/shared/src/analytics.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverviewSchema, orderValueCents } from "@desk/shared";
import { makeFixture, type Fixture } from "../src/fixture.ts";
import { deskHttp } from "./owner.ts";

let fx: Fixture;
let clock: number;

beforeEach(async () => {
	clock = new Date(2026, 9, 15, 11, 0).getTime();
	fx = await makeFixture({ seed: false, now: () => clock });
	await fx.desk.refresh(["SAP.DE", "EUNL.DE", "BTC-EUR", "NVDA"]);
});
afterEach(() => fx.cleanup());

const buy = (account: string, symbol: string, qty: number, price: number) =>
	fx.db.run("INSERT INTO trade (account_id, symbol, side, qty, price, currency, fx, value_cents, fee_cents, time, source, note) VALUES (?,?,'buy',?,?,'EUR',1,?,100,?,'order','')", account, symbol, qty, price, orderValueCents(qty, price, 1), clock - 86_400_000);

describe("overview allocation", () => {
	it("by symbol and asset class over your accounts, valued like the accounts", async () => {
		buy("papier", "SAP.DE", 10, 200);
		buy("papier", "EUNL.DE", 1, 100);
		buy("papier", "BTC-EUR", 0.01, 60_000);
		buy("agent-atlas", "NVDA", 1, 100); // Agentendepot: zählt nicht
		const ov = OverviewSchema.parse(await (await deskHttp(fx).get("/api/overview")).json());
		// Cash: Papier 20 000 € − 2 001 € − 101 € − 601 €, IBKR 25 000 €, Trade Republic 0 €
		const cash = 2_000_000 - 200_100 - 10_100 - 60_100 + 2_500_000;
		const total = cash + 201_250 + 10_432 + 61_250; // Kurse der Fake-Börse: 201,25 / 104,32 / 61 250
		expect(ov.allocation.totalCents).toBe(total);
		expect(total).toBe(ov.accounts.filter((a) => a.owner === "user").reduce((s, a) => s + a.equityCents, 0));
		expect(ov.allocation.byClass.map((c) => [c.assetClass, c.valueCents])).toEqual([["equity", 201_250], ["etf", 10_432], ["crypto", 61_250], ["cash", cash], ["other", 0]]);
		expect(ov.allocation.byClass.reduce((s, c) => s + c.pct!, 0)).toBeCloseTo(100, 10);
		expect(ov.allocation.bySymbol.map((s) => [s.symbol, s.name, s.assetClass, s.valueCents])).toEqual([
			["SAP.DE", "SAP SE", "equity", 201_250],
			["BTC-EUR", "Bitcoin EUR", "crypto", 61_250],
			["EUNL.DE", "iShares Core MSCI World UCITS ETF", "etf", 10_432],
		]);
		expect(ov.allocation.bySymbol[0].pct).toBeCloseTo((201_250 / total) * 100, 10);
	});

	it("without positions: everything is cash", () => {
		const a = fx.desk.overview().allocation;
		expect(a.bySymbol).toEqual([]);
		expect(a.byClass.find((c) => c.assetClass === "cash")).toEqual({ assetClass: "cash", valueCents: 4_500_000, pct: 100 });
	});
});

describe("overview equity changes", () => {
	it("per range from your accounts' snapshots, null where none reaches back", () => {
		const snap = (account: string, day: string, equity: number, deposits: number) => fx.db.run("INSERT INTO snapshot (account_id, day, equity_cents, deposits_cents) VALUES (?,?,?,?)", account, day, equity, deposits);
		// heute: 45 000 € (Papier 20 000 + IBKR 25 000, Einzahlungen ebenso)
		snap("papier", "2026-10-08", 1_900_000, 2_000_000);
		snap("ibkr", "2026-10-08", 2_500_000, 2_500_000);
		snap("papier", "2026-09-10", 1_000_000, 1_000_000); // seitdem 10 000 € eingezahlt
		snap("agent-atlas", "2026-01-01", 1, 1); // Agentendepot: zählt nicht
		const c = Object.fromEntries(fx.desk.overview().changes.map((x) => [x.range, x]));
		expect(c["1W"]).toEqual({ range: "1W", fromDay: "2026-10-08", changeCents: 100_000, changePct: (100_000 / 4_400_000) * 100, resultCents: 100_000, resultPct: (100_000 / 4_400_000) * 100 });
		// am 10.09. nur Papier: 10 000 €; heute 45 000 € bei 35 000 € mehr Einzahlungen (IBKR kam später dazu)
		expect(c["1M"]).toMatchObject({ fromDay: "2026-09-10", changeCents: 3_500_000, resultCents: 0, resultPct: 0 });
		expect(c.all).toMatchObject({ fromDay: "2026-09-10", changeCents: 3_500_000 });
		for (const r of ["3M", "YTD", "1Y"]) expect(c[r]).toMatchObject({ fromDay: null, changeCents: null, resultCents: null });
	});
});
