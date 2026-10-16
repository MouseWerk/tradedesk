// Neue Felder für die Oberfläche (Risiko je Vorschlag, offenes Risiko und Spielraum bis zum Tagesverlust-Stopp) und
// D10: ein Depot nur mit Cash zeigt keinen erfundenen Tagesgewinn.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CockpitSchema, ProposalSchema, cents } from "@desk/shared";
import { makeFixture, type Fixture } from "../src/fixture.ts";

let fx: Fixture;
let clock: number;

beforeEach(async () => {
	clock = new Date(2026, 9, 15, 16, 0).getTime();
	fx = await makeFixture({ now: () => clock });
});
afterEach(() => fx.cleanup());

const day = (id: string) => fx.desk.cockpit().days.find((d) => d.accountId === id)!;

describe("proposal risk fields", () => {
	it("risk to the stop incl. both fees, its share of the account and the target in R", () => {
		const p = fx.desk.proposals({ status: "pending" }).find((x) => x.author === "Atlas" && x.symbol === "MSFT")!;
		expect(ProposalSchema.safeParse(p).success).toBe(true);
		const risk = cents(4 * (418.9 - 395) * 0.92) + 2 * 100;
		expect(p.riskCents).toBe(risk);
		expect(p.riskPct).toBeCloseTo((risk / fx.desk.summary(fx.desk.account("agent-atlas")).equityCents) * 100, 6);
		expect(p.targetR).toBeCloseTo((470 - 418.9) / (418.9 - 395), 6);
	});

	it("are null without a stop", () => {
		const p = fx.desk.proposals({ status: "pending" }).find((x) => x.author === "Atlas" && x.symbol === "ALV.DE")!;
		expect(p).toMatchObject({ riskCents: null, riskPct: null, targetR: null });
	});

	it("targetR is null without a target", async () => {
		const r = await fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "ALV.DE", side: "buy", qty: 1, stopLoss: 345, confidence: 0.7, thesis: "x" }, "cli");
		expect(r.proposal).toMatchObject({ riskCents: cents(352.1 - 345) + 200, targetR: null });
	});
});

describe("cockpit risk fields", () => {
	it("open risk counts reserved orders and positions with a stop", async () => {
		expect(CockpitSchema.safeParse(fx.desk.cockpit()).success).toBe(true);
		expect(day("agent-atlas").openRiskCents).toBe(0); // Bestände der Fixture ohne Stop
		const r = await fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "ALV.DE", side: "buy", qty: 2, orderType: "limit", limitPrice: 350, stopLoss: 340, confidence: 0.7, thesis: "x" }, "cli");
		await fx.desk.approve(r.proposal!.id, {});
		expect(day("agent-atlas").openRiskCents).toBe(cents(2 * 10) + 200); // reserviert: Limit bis Stop + beide Gebühren
		fx.market.set("ALV.DE", 349);
		await fx.desk.tick();
		expect(fx.desk.proposal(r.proposal!.id).status).toBe("filled");
		expect(day("agent-atlas").openRiskCents).toBe(cents(2 * (349 - 340)) + 100); // Position: Kurs bis Stop + Verkaufsgebühr
	});

	it("daily loss limit and the headroom left until it", () => {
		fx.desk.setLimits("agent-atlas", { dailyLossPct: 5 });
		const prev = fx.db.get<{ equity_cents: number }>("SELECT equity_cents FROM snapshot WHERE account_id = 'agent-atlas' AND day < ? ORDER BY day DESC LIMIT 1", "2026-10-15")!.equity_cents;
		const d = day("agent-atlas");
		expect(d.dayLossLimitCents).toBe(cents((prev / 100) * 0.05));
		const loss = Math.max(0, -(d.dayChangeCents ?? 0));
		expect(d.dayLossHeadroomCents).toBe(Math.max(0, d.dayLossLimitCents! - loss));
		fx.desk.setLimits("agent-atlas", { dailyLossPct: 0 });
		expect(day("agent-atlas")).toMatchObject({ dayLossLimitCents: null, dayLossHeadroomCents: null });
	});

	it("headroom is 0 once the loss reached the limit", () => {
		fx.desk.setLimits("agent-atlas", { dailyLossPct: 1 });
		fx.db.run("UPDATE snapshot SET equity_cents = equity_cents * 2 WHERE account_id = 'agent-atlas'");
		expect(day("agent-atlas").dayLossHeadroomCents).toBe(0);
	});
});

describe("D10: an account with only cash", () => {
	it("has no day change and a flat curve", () => {
		const ib = fx.desk.summary(fx.desk.account("ibkr"));
		expect(ib.positions).toBe(0);
		expect(ib.dayChangeCents).toBe(0);
		expect(new Set(fx.desk.curve(fx.desk.account("ibkr")).map((p) => p.equityCents)).size).toBe(1);
		expect(fx.desk.overview().curve.length).toBe(91);
	});
});
