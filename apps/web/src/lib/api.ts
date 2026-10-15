// Daten: TanStack Query über die API (jede Antwort gegen das gemeinsame Schema geprüft), Live über einen SSE-Stream.
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { z } from "zod";
import type { ChartRange } from "@desk/shared";
import { AccountDetailSchema, AgentsDataSchema, ChartSchema, OverviewSchema, ProposalSchema, RiskDataSchema, SearchHitSchema, WatchItemSchema } from "@desk/shared";

export const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1, placeholderData: (prev: unknown) => prev } },
});

export async function getChecked<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
	const r = await fetch(url, { headers: { Accept: "application/json" } });
	const body = (await r.json().catch(() => null)) as unknown;
	if (!r.ok) throw new Error((body as { msg?: string } | null)?.msg ?? `${url}: ${r.status}`);
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		const i = parsed.error.issues[0];
		console.warn("desk: API-Antwort passt nicht zum Schema", url, parsed.error.issues.slice(0, 5));
		throw new Error(`Server und App passen nicht zusammen (${url}: ${i?.path.join(".") || "?"} – ${i?.message ?? "ungültig"}). Seite neu laden.`);
	}
	return parsed.data;
}

/** Änderungen: immer JSON (der Server verlangt es), Fehlermeldung des Servers als Error. */
export async function send<T = unknown>(url: string, method: "POST" | "PUT" | "DELETE", body: unknown = {}): Promise<T> {
	const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const data = (await r.json().catch(() => ({ msg: `${r.status}` }))) as T & { msg?: string };
	if (!r.ok) throw new Error(data.msg ?? `${url}: ${r.status}`);
	return data;
}

export const keys = {
	overview: ["overview"] as const,
	account: (id: string) => ["account", id] as const,
	watchlist: ["watchlist"] as const,
	chart: (symbol: string, range: ChartRange) => ["chart", symbol, range] as const,
	search: (q: string) => ["search", q] as const,
	proposals: ["proposals"] as const,
	agents: ["agents"] as const,
	risk: ["risk"] as const,
};

export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => getChecked("/api/overview", OverviewSchema), refetchInterval: 60_000 });
export const useAccount = (id: string | undefined) => useQuery({ queryKey: keys.account(id ?? ""), queryFn: () => getChecked(`/api/accounts/${encodeURIComponent(id!)}`, AccountDetailSchema), enabled: !!id });
export const useWatchlist = () => useQuery({ queryKey: keys.watchlist, queryFn: () => getChecked("/api/market/watchlist", WatchItemSchema.array()), refetchInterval: 60_000 });
export const useChart = (symbol: string | undefined, range: ChartRange) =>
	useQuery({ queryKey: keys.chart(symbol ?? "", range), queryFn: () => getChecked(`/api/market/chart/${encodeURIComponent(symbol!)}?range=${range}`, ChartSchema), enabled: !!symbol, staleTime: 60_000 });
export const useSearch = (q: string) =>
	useQuery({ queryKey: keys.search(q), queryFn: () => getChecked(`/api/market/search?q=${encodeURIComponent(q)}`, SearchHitSchema.array()), enabled: q.trim().length >= 2, staleTime: 300_000, placeholderData: undefined });
export const useProposals = () => useQuery({ queryKey: keys.proposals, queryFn: () => getChecked("/api/proposals?limit=300", ProposalSchema.array()) });
export const useAgents = () => useQuery({ queryKey: keys.agents, queryFn: () => getChecked("/api/agents", AgentsDataSchema) });
export const useRisk = () => useQuery({ queryKey: keys.risk, queryFn: () => getChecked("/api/risk", RiskDataSchema) });

export type LiveState = "connecting" | "live" | "offline";

/** Ein EventSource für die ganze App: jede Änderung lädt die betroffenen Daten neu. */
export function useLive(): LiveState {
	const qc = useQueryClient();
	const [state, setState] = useState<LiveState>("connecting");
	useEffect(() => {
		const es = new EventSource("/api/stream");
		let timer: ReturnType<typeof setTimeout> | null = null;
		const refresh = () => {
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				void qc.invalidateQueries({ predicate: (q) => !["chart", "search"].includes(String(q.queryKey[0])) });
			}, 150);
		};
		es.addEventListener("open", () => setState("live"));
		es.addEventListener("hello", () => setState("live"));
		es.addEventListener("error", () => setState(es.readyState === EventSource.CLOSED ? "offline" : "connecting"));
		es.addEventListener("tick", refresh);
		es.addEventListener("event", refresh);
		return () => {
			if (timer) clearTimeout(timer);
			es.close();
		};
	}, [qc]);
	return state;
}
