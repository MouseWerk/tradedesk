// node apps/server/src/index.ts --selftest – ohne Port, ohne Netz, ohne echte Daten (Fixture mit Fake-Börse).
import type { AgentsData, Overview, Proposal, RiskData, WatchItem } from "@desk/shared";
import { AgentsDataSchema, OverviewSchema, ProposalSchema, RiskDataSchema, WatchItemSchema } from "@desk/shared";
import { createApp } from "./app.ts";
import { makeFixture } from "./fixture.ts";

export async function selftest(): Promise<number> {
	const fx = await makeFixture();
	const results: { name: string; ok: boolean; detail?: string }[] = [];
	const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	try {
		const app = createApp(fx.desk);
		const get = async <T>(p: string) => (await (await app.request(p)).json()) as T;
		const web = (p: string, method: string, body: unknown) => app.request(p, { method, headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:8095" }, body: JSON.stringify(body) });
		const cli = (p: string, body: unknown) => app.request(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

		const ov = await get<Overview>("/api/overview");
		check("overview matches its schema", OverviewSchema.safeParse(ov).success);
		check("five accounts (three yours incl. IBKR paper, two agents)", ov.accounts.length === 5 && ov.accounts.filter((a) => a.owner === "user").length === 3);
		check("four pending proposals from the fixture", ov.pending === 4, String(ov.pending));
		check("equity curve has 91 days", ov.curve.length === 91, String(ov.curve.length));
		const watch = await get<WatchItem[]>("/api/market/watchlist");
		check("watchlist matches its schema and has quotes", WatchItemSchema.array().safeParse(watch).success && watch.every((w) => w.price !== null));
		check("agents data matches its schema", AgentsDataSchema.safeParse(await get<AgentsData>("/api/agents")).success);
		check("risk data matches its schema", RiskDataSchema.safeParse(await get<RiskData>("/api/risk")).success);

		const invented = await cli("/api/proposals", { author: "Atlas", accountId: "agent-atlas", symbol: "TSLA", side: "buy", qty: 1, confidence: 0.9, thesis: "x" });
		check("invented symbol is not proposed", invented.status === 422);
		const stranger = await cli("/api/proposals", { author: "Mallory", accountId: "papier", symbol: "SAP.DE", side: "buy", qty: 1, confidence: 0.9, thesis: "x" });
		check("unknown agent is refused", stranger.status === 403);
		const approveCli = await cli("/api/proposals/1/approve", {});
		check("agents cannot approve", approveCli.status === 403);

		const pending = (await get<Proposal[]>("/api/proposals?status=pending")).find((p) => p.author === "Atlas" && p.symbol === "MSFT")!;
		check("proposal matches its schema", ProposalSchema.safeParse(pending).success);
		const bigger = await web(`/api/proposals/${pending.id}/approve`, "POST", { qty: pending.qty + 1 });
		check("approval may not enlarge the order", bigger.status === 400);
		const [a, b] = await Promise.all([web(`/api/proposals/${pending.id}/approve`, "POST", { qty: 2 }), web(`/api/proposals/${pending.id}/approve`, "POST", {})]);
		check("double click executes once", [a.status, b.status].sort().join() === "200,409", `${a.status},${b.status}`);
		const filled = await get<Proposal>(`/api/proposals/${pending.id}`);
		check("paper market order filled with the narrowed quantity", filled.status === "filled" && filled.approvedQty === 2, `${filled.status} ${filled.approvedQty}`);

		const manual = (await get<Proposal[]>("/api/proposals?status=pending")).find((p) => p.accountId === "tr")!;
		const placed = (await (await web(`/api/proposals/${manual.id}/approve`, "POST", {})).json()) as { proposal: Proposal };
		check("Trade Republic proposal waits for you at the broker", placed.proposal.status === "placed");
		await web(`/api/proposals/${manual.id}/fill`, "POST", { price: 104.5, feeEur: 1 });
		check("broker execution recorded", (await get<Proposal>(`/api/proposals/${manual.id}`)).status === "filled");

		await web("/api/risk/kill", "PUT", { on: true });
		const blocked = await web("/api/proposals", "POST", { accountId: "papier", symbol: "SAP.DE", side: "buy", qty: 1 });
		check("kill switch blocks your own orders too", blocked.status === 422);
		await web("/api/risk/kill", "PUT", { on: false });

		const foreign = await app.request("/api/risk/kill", { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ on: true }) });
		check("foreign origin is refused", foreign.status === 403);
	} catch (e) {
		check("selftest ran through", false, String((e as Error).stack ?? e));
	} finally {
		fx.cleanup();
	}
	for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : `  – ${r.detail}`}`);
	const failed = results.filter((r) => !r.ok).length;
	console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} ok`);
	return failed ? 1 : 0;
}
