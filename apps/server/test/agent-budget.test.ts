// Agenten-Budget für echtes Geld (config "agentBudgetEur"): alle Agenten zusammen binden in deinen Depots mit echtem
// Geld höchstens so viel – wartende, freigegebene und gehaltene Käufe. Papierdepots zählen nicht.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanConfig } from "../src/config.ts";
import { makeFixture, type Fixture } from "../src/fixture.ts";

let fx: Fixture;
beforeEach(async () => {
	fx = await makeFixture();
});
afterEach(() => fx.cleanup());

/** die wartende Nova-Order aus der Fixture: 10 EUNL.DE in Trade Republic */
const pendingNova = () => fx.desk.proposals({ status: "pending" }).find((p) => p.accountId === "tr" && p.author === "Nova")!;
/** Agenten-Kauf EUNL.DE mit Stop 3 % unter dem Kurs */
const buy = (qty: number, accountId = "tr", dryRun = true) => fx.desk.submit({ author: "Atlas", accountId, symbol: "EUNL.DE", side: "buy", qty, stopLoss: Math.round(fx.market.items.get("EUNL.DE")!.price * 97) / 100, confidence: 0.7, thesis: "x" }, "cli", { dryRun });

describe("config", () => {
	it("takes a positive amount in EUR, anything else means no budget", () => {
		const base = { home: "", dbFile: "", webDist: "", dev: false };
		expect(cleanConfig({ agentBudgetEur: 100 }, base).agentBudgetCents).toBe(10_000);
		for (const v of [0, -5, "100", null, Number.NaN]) expect(cleanConfig({ agentBudgetEur: v }, base).agentBudgetCents).toBeNull();
		expect(fx.desk.risk().agentBudget).toBeNull();
	});
});

describe("with a budget", () => {
	beforeEach(() => {
		fx.cfg.agentBudgetCents = 10_000; // 100 €
		fx.desk.reject(pendingNova().id, "x");
		fx.desk.setLimits("tr", { dailyLossPct: 50 }); // die Testkurse fallen weit, der Tagesverlust-Stopp soll hier nicht greifen
	});

	it("counts only real-money depots and shows the same numbers in risk and cockpit", () => {
		const b = fx.desk.risk().agentBudget!;
		expect(b).toEqual({ budgetCents: 10_000, usedCents: 0, freeCents: 10_000, unpriced: false, accounts: ["tr"] });
		expect(fx.desk.cockpit().agentBudget).toEqual(b);
	});

	it("blocks an agent buy that does not fit, lets one that fits through", async () => {
		const big = await buy(1);
		expect(big.ok).toBe(false); // 1 EUNL ≈ 104 € + 1 € Gebühr
		expect(big.check.violations.join(" ")).toMatch(/Agenten-Budget.*frei sind noch 100,00 € von 100,00 €/);
		fx.market.set("EUNL.DE", 90);
		await fx.desk.tick();
		expect((await buy(1)).ok).toBe(true);
	});

	it("waiting, approved and held buys use it up; a sale frees it again", async () => {
		fx.market.set("EUNL.DE", 45);
		await fx.desk.tick();
		const first = await buy(1, "tr", false); // 45 € + 1 € Gebühr, wartet
		expect(first.check.violations).toEqual([]);
		expect(fx.desk.risk().agentBudget!.usedCents).toBe(4_600);
		expect((await buy(2)).ok).toBe(false); // 2 × 45 + 1 > 54 €
		await fx.desk.approve(first.proposal!.id, {});
		fx.desk.fill(first.proposal!.id, { price: 45 });
		expect(fx.desk.risk().agentBudget!.usedCents).toBe(4_600); // jetzt gehalten, zum Einstand
		await fx.desk.recordTrade("tr", { symbol: "EUNL.DE", side: "sell", qty: fx.desk.detail("tr").positions.find((p) => p.symbol === "EUNL.DE")!.qty, price: 46 });
		expect(fx.desk.risk().agentBudget!.usedCents).toBe(0);
	});

	it("is checked again on approval, without counting the order itself", async () => {
		fx.market.set("EUNL.DE", 45);
		await fx.desk.tick();
		const p = await buy(2, "tr", false); // 91 € von 100 €
		expect(p.ok).toBe(true);
		await fx.desk.approve(p.proposal!.id, {});
		expect(fx.desk.proposal(p.proposal!.id).status).not.toBe("rejected");
	});

	it("does not limit paper depots or your own orders", async () => {
		expect((await buy(5, "agent-atlas")).ok).toBe(true);
		expect((await buy(5, "papier")).ok).toBe(true);
		expect((await fx.desk.submit({ accountId: "papier", symbol: "EUNL.DE", side: "buy", qty: 5 }, "web", { dryRun: true })).ok).toBe(true);
	});
});
