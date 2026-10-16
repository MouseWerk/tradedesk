// Scanner-Universum (langsamer Takt neben der Watchlist) und autoPaper (Agenten handeln ihr eigenes Papierdepot selbst).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MoversSchema } from "@desk/shared";
import { cleanConfig } from "../src/config.ts";
import { DEFAULT_UNIVERSE } from "../src/universe.ts";
import { makeFixture, type Fixture } from "../src/fixture.ts";
import { deskHttp } from "./owner.ts";

let fx: Fixture;
beforeEach(async () => {
	fx = await makeFixture();
});
afterEach(() => fx.cleanup());

const base = { home: "", dbFile: "", webDist: "", dev: false };

describe("config", () => {
	it("uses the default universe, a list replaces it, [] turns it off, garbage is dropped", () => {
		expect(cleanConfig({}, base).universe).toEqual([...DEFAULT_UNIVERSE]);
		expect(cleanConfig({ universe: ["sap.de", "SAP.DE", "bad symbol", 7, "AAPL"] }, base).universe).toEqual(["SAP.DE", "AAPL"]);
		expect(cleanConfig({ universe: [] }, base).universe).toEqual([]);
		expect(cleanConfig({ universeIntervalSec: 5 }, base).universeIntervalSec).toBe(120);
		expect(new Set(DEFAULT_UNIVERSE).size).toBe(DEFAULT_UNIVERSE.length);
		expect(cleanConfig({}, base).autoPaper).toBe(false);
	});
});

describe("universe", () => {
	beforeEach(() => {
		// ein Wert, der weder auf der Watchlist noch im Bestand ist
		fx.market.items.set("UNI.DE", { ...fx.market.items.get("SAP.DE")!, symbol: "UNI.DE", name: "Universum AG" });
		fx.cfg.universe = ["UNI.DE", "NOPE.XX", "SAP.DE"];
	});

	it("is fetched apart from the watchlist; a missing symbol is no market error", async () => {
		expect(fx.desk.universeSymbols()).toEqual(["UNI.DE", "NOPE.XX"]); // SAP.DE läuft schon im schnellen Takt
		expect(await fx.desk.refreshUniverse()).toBe(1);
		expect(fx.desk.cockpit().market).not.toBe("error");
		expect(fx.desk.cockpit().failedQuotes).toEqual([]);
		const m = MoversSchema.parse(await (await deskHttp(fx).get("/api/market/movers?limit=5")).json());
		expect(m.rows.map((r) => r.symbol)).toContain("UNI.DE");
		expect(m.rows.length).toBeLessThanOrEqual(5);
		const moves = m.rows.map((r) => Math.abs(r.changePct!));
		expect(moves).toEqual(moves.toSorted((x, y) => y - x));
	});

	it("lets agents propose a universe symbol, still nothing made up", async () => {
		await fx.desk.refreshUniverse();
		const ok = await fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "UNI.DE", side: "buy", qty: 1, stopLoss: 190, confidence: 0.7, thesis: "x" }, "cli", { dryRun: true });
		expect(ok.check.violations.join(" ")).not.toMatch(/Watchlist/);
		fx.cfg.universe = [];
		const no = await fx.desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "UNI.DE", side: "buy", qty: 1, stopLoss: 190, confidence: 0.7, thesis: "x" }, "cli", { dryRun: true });
		expect(no.ok).toBe(false);
	});
});

describe("autoPaper", () => {
	const order = (accountId: string) => fx.desk.submit({ author: "Atlas", accountId, symbol: "SAP.DE", side: "buy", qty: 1, stopLoss: 190, confidence: 0.7, thesis: "x" }, "cli");

	it("is off by default: the agent's paper trade waits for you", async () => {
		expect((await order("agent-atlas")).proposal!.status).toBe("pending");
	});

	it("trades the agent's own paper depot at once, never your depots", async () => {
		fx.cfg.autoPaper = true;
		const own = (await order("agent-atlas")).proposal!;
		expect(own.status).toBe("filled");
		expect(own.decidedBy).toBe("Automatik (Papier)");
		expect((await order("tr")).proposal!.status).toBe("pending");
		expect((await order("papier")).proposal!.status).toBe("pending");
		const nova = await fx.desk.submit({ author: "Nova", accountId: "agent-atlas", symbol: "SAP.DE", side: "buy", qty: 1, stopLoss: 190, confidence: 0.7, thesis: "x" }, "cli").catch((e: Error) => e);
		expect(nova).toBeInstanceOf(Error); // fremdes Agentendepot bleibt verboten
	});

	it("still runs the full risk check and the kill switch", async () => {
		fx.cfg.autoPaper = true;
		fx.desk.setKill(true);
		const r = await order("agent-atlas");
		expect(r.ok).toBe(false);
		expect(r.proposal).toBeNull();
	});
});

describe("agentDepots: false", () => {
	it("gives agents no paper depot; they still propose for yours and show up on the agents page", async () => {
		const cfg = cleanConfig({ accounts: [{ id: "revolut", kind: "manual", broker: "Revolut" }], agents: ["Atlas"], agentDepots: false }, base);
		expect(cfg.accounts.map((a) => a.id)).toEqual(["revolut"]);
		expect(cleanConfig({ agents: ["Atlas"] }, base).accounts.map((a) => a.id)).toContain("agent-atlas");
		fx.cfg.accounts = fx.cfg.accounts.filter((a) => a.owner === "user");
		const a = fx.desk.agentsData().agents.find((x) => x.name === "Atlas")!;
		expect(a).toMatchObject({ accountId: null, equityCents: 0, curve: [] });
		const r = await fx.desk.submit({ author: "Atlas", accountId: "tr", symbol: "SAP.DE", side: "buy", qty: 1, stopLoss: 190, confidence: 0.7, thesis: "x" }, "cli");
		expect(r.proposal!.status).toBe("pending");
	});
});
