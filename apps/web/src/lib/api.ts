// Daten: TanStack Query über die API (jede Antwort gegen das gemeinsame Schema geprüft), Live über einen SSE-Stream.
import { QueryClient, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { z } from "zod";
import type { ChartRange, ChatMessage, DeskEvent } from "@desk/shared";
import { AccountDetailSchema, AgentsDataSchema, AnalysisSchema, AnalyticsSchema, BrokerStatusSchema, ChartSchema, ChatMessageSchema, CockpitSchema, EventSchema, NewsItemSchema, OverviewSchema, ProposalSchema, RiskDataSchema, SearchHitSchema, WatchItemSchema } from "@desk/shared";

// Kein globales placeholderData: ein Schlüssel für ein anderes Symbol oder Depot zeigte sonst die Daten des vorigen
// unter der neuen Überschrift (Kennzahlen von SAP unter NVDA). Wo es passt, setzt die Abfrage es selbst.
export const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
});

/*
 * Sitzung: das Token liegt im localStorage dieser Seite und geht als Header mit. Kein Cookie – Browser trennen Cookies
 * nicht nach Port, ein fremder Server auf 127.0.0.1:<anderer Port> bekäme es sonst geschenkt (Review q1 M1).
 */
const SESSION_KEY = "desk.session";
export const SESSION_HEADER = "X-Desk-Session";

export function sessionToken(): string | null {
	try {
		return localStorage.getItem(SESSION_KEY);
	} catch {
		return null;
	}
}

export function setSessionToken(token: string | null) {
	try {
		if (token) localStorage.setItem(SESSION_KEY, token);
		else localStorage.removeItem(SESSION_KEY);
	} catch {
		// privater Modus: dann gilt die Anmeldung nur bis zum Neuladen nicht – der Desk fragt erneut
	}
}

/** fetch mit Sitzungs-Header und deutscher Meldung, wenn der Server gar nicht antwortet (statt „Failed to fetch“). */
export async function request(url: string, init: RequestInit = {}): Promise<Response> {
	const token = sessionToken();
	const headers = new Headers(init.headers);
	if (token) headers.set(SESSION_HEADER, token);
	try {
		return await fetch(url, { ...init, headers });
	} catch (e) {
		if ((e as Error).name === "AbortError") throw e;
		throw new Error("Desk nicht erreichbar – läuft der Server noch?");
	}
}

/** Ereignis, wenn der Server „nicht angemeldet“ meldet (abgelaufene Sitzung): der Anmeldebildschirm übernimmt. */
export const AUTH_EVENT = "desk:auth";

function authRequired(url: string, status: number, body: unknown) {
	if (status === 401 && (body as { code?: string } | null)?.code === "auth" && !url.startsWith("/api/auth")) {
		setSessionToken(null);
		window.dispatchEvent(new Event(AUTH_EVENT));
	}
}

export async function getAuth(): Promise<{ pinSet: boolean; authenticated: boolean }> {
	const r = await request("/api/auth", { headers: { Accept: "application/json" } });
	if (!r.ok) throw new Error(`Desk antwortet nicht (${r.status}).`);
	return (await r.json()) as { pinSet: boolean; authenticated: boolean };
}

export async function getChecked<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
	const r = await request(url, { headers: { Accept: "application/json" } });
	const body = (await r.json().catch(() => null)) as unknown;
	authRequired(url, r.status, body);
	if (!r.ok) throw new Error((body as { msg?: string } | null)?.msg ?? `Server antwortet nicht wie erwartet (${r.status}). Läuft der Desk?`);
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		const i = parsed.error.issues[0];
		console.warn("desk: API-Antwort passt nicht zum Schema", url, parsed.error.issues.slice(0, 5));
		throw new Error(`Server und App passen nicht zusammen (${url}: ${i?.path.join(".") || "?"} – ${i?.message ?? "ungültig"}). Seite neu laden.`);
	}
	return parsed.data;
}

/** Änderungen: immer JSON (der Server verlangt es), Fehlermeldung des Servers als Error. */
export async function send<T = unknown>(url: string, method: "POST" | "PUT" | "DELETE", body: unknown = {}, signal?: AbortSignal): Promise<T> {
	const r = await request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
	const data = (await r.json().catch(() => ({ msg: `Server antwortet nicht (${r.status}).` }))) as T & { msg?: string };
	authRequired(url, r.status, data);
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
	cockpit: ["cockpit"] as const,
	analysis: (symbol: string) => ["analysis", symbol] as const,
	news: (symbol: string) => ["news", symbol] as const,
	chat: ["chat"] as const,
	brokers: ["brokers"] as const,
	analytics: (account: string, from: string | null, to: string | null) => ["analytics", account, from ?? "", to ?? ""] as const,
};

/** Was ein Tick des Desks neu lädt: alles Angezeigte außer Kerzen (eigener Takt), Suche, News und Chat (kommt als Nachricht). */
export const refreshable = (q: Query) => !["chart", "search", "news", "chat"].includes(String(q.queryKey[0]));

export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => getChecked("/api/overview", OverviewSchema), refetchInterval: 60_000 });
export const useAccount = (id: string | undefined) => useQuery({ queryKey: keys.account(id ?? ""), queryFn: () => getChecked(`/api/accounts/${encodeURIComponent(id!)}`, AccountDetailSchema), enabled: !!id });
export const useWatchlist = () => useQuery({ queryKey: keys.watchlist, queryFn: () => getChecked("/api/market/watchlist", WatchItemSchema.array()), refetchInterval: 60_000 });
/** live: Sekunden zwischen zwei Abrufen (Intraday-Chart im Cockpit), sonst nur bei Bedarf. */
export const useChart = (symbol: string | undefined, range: ChartRange, live?: number) =>
	useQuery({
		queryKey: keys.chart(symbol ?? "", range),
		queryFn: () => getChecked(`/api/market/chart/${encodeURIComponent(symbol!)}?range=${range}`, ChartSchema),
		enabled: !!symbol,
		staleTime: live ? live * 1000 : 60_000,
		refetchInterval: live ? live * 1000 : false,
		// beim Wechsel des Zeitraums die alten Kerzen desselben Werts stehen lassen, nie die eines anderen Werts
		placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === symbol ? prev : undefined),
	});
export const useSearch = (q: string) => useQuery({ queryKey: keys.search(q), queryFn: () => getChecked(`/api/market/search?q=${encodeURIComponent(q)}`, SearchHitSchema.array()), enabled: q.trim().length >= 2, staleTime: 300_000 });
export const useProposals = () => useQuery({ queryKey: keys.proposals, queryFn: () => getChecked("/api/proposals?limit=300", ProposalSchema.array()) });
export const useAgents = () => useQuery({ queryKey: keys.agents, queryFn: () => getChecked("/api/agents", AgentsDataSchema) });
export const useRisk = () => useQuery({ queryKey: keys.risk, queryFn: () => getChecked("/api/risk", RiskDataSchema) });

export const useCockpit = () => useQuery({ queryKey: keys.cockpit, queryFn: () => getChecked("/api/cockpit", CockpitSchema), refetchInterval: 30_000 });
export const useAnalysis = (symbol: string | undefined) =>
	useQuery({ queryKey: keys.analysis(symbol ?? ""), queryFn: () => getChecked(`/api/market/analysis/${encodeURIComponent(symbol!)}`, AnalysisSchema), enabled: !!symbol, refetchInterval: 30_000 });
export const useNews = (symbol: string | undefined) =>
	useQuery({ queryKey: keys.news(symbol ?? ""), queryFn: () => getChecked(`/api/market/news/${encodeURIComponent(symbol!)}`, NewsItemSchema.array()), enabled: !!symbol, staleTime: 300_000 });
export const useBrokers = () => useQuery({ queryKey: keys.brokers, queryFn: () => getChecked("/api/brokers", BrokerStatusSchema.array()), refetchInterval: 30_000 });
/**
 * Auswertung: Auswahl (mine, all oder Depot-ID) und Zeitraum. Beim Wechsel bleiben die vorigen Zahlen gedimmt
 * stehen, bis die neuen da sind (kein Skelett-Blitz) – die Filterzeile zeigt dabei schon die neue Auswahl.
 */
export const useAnalytics = (account: string, from: string | null, to: string | null) =>
	useQuery({
		queryKey: keys.analytics(account, from, to),
		queryFn: () => getChecked(`/api/analytics?${new URLSearchParams({ account, ...(from ? { from } : {}), ...(to ? { to } : {}) })}`, AnalyticsSchema),
		placeholderData: (prev) => prev,
	});
export const useChat = () => useQuery({ queryKey: keys.chat, queryFn: () => getChecked("/api/chat?limit=300", ChatMessageSchema.array()), staleTime: Number.POSITIVE_INFINITY });

/* ------------------------------------------------------------ Browser-Benachrichtigungen (nur nach deiner Zustimmung) */

const NOTIFY_KEY = "desk.notify";
const NOTIFY_KINDS = new Set(["proposal.new", "alert", "stop", "target", "close", "trade.fill"]);

export function notifyEnabled(): boolean {
	try {
		return typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem(NOTIFY_KEY) === "on";
	} catch {
		return false;
	}
}

/** an/aus; "blocked": der Browser hat die Erlaubnis verweigert (nur in den Website-Einstellungen änderbar). */
export async function setNotify(on: boolean): Promise<boolean | "blocked"> {
	if (typeof Notification === "undefined") return false;
	if (on && Notification.permission === "denied") return "blocked";
	if (on && Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return Notification.permission === "denied" ? "blocked" : false;
	try {
		localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
	} catch {
		// privater Modus
	}
	return on;
}

function notify(title: string, body: string, tag: string) {
	if (!notifyEnabled() || document.visibilityState === "visible") return;
	try {
		// eigener Tag je Ereignis: ein zweiter Vorschlag desselben Agenten ersetzt den ersten nicht
		new Notification(title, { body, tag });
	} catch {
		// manche Browser erlauben Benachrichtigungen nur über einen Service Worker
	}
}

/* ------------------------------------------------------------ Live-Stream */

export type LiveState = "connecting" | "live" | "offline";

/** Letztes Lebenszeichen des Streams (Tick, Ereignis, Chat) – Aktionen laden nur selbst neu, wenn keins kommt. */
export const live = { state: "connecting" as LiveState, signalAt: 0 };

function parse(data: unknown): unknown {
	try {
		return JSON.parse(String(data));
	} catch {
		return null;
	}
}

const BACKOFF = [1_000, 2_000, 5_000, 10_000];

/**
 * Ein EventSource für die ganze App: jede Änderung lädt die betroffenen Daten neu. Nach einem Wiederverbinden lädt
 * alles neu (auch der Chat – was während der Lücke kam, fehlte sonst). Schließt der Browser den Stream endgültig
 * (HTTP-Fehler statt Netzfehler), baut die App ihn mit wachsender Pause neu auf, statt für immer „Offline“ zu zeigen.
 */
export function useLive(): LiveState {
	const qc = useQueryClient();
	const [state, setState] = useState<LiveState>("connecting");
	useEffect(() => {
		let es: EventSource | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let retry: ReturnType<typeof setTimeout> | null = null;
		let attempt = 0;
		let gap = false; // seit dem letzten Öffnen gab es einen Fehler: beim nächsten Öffnen alles neu laden
		let stopped = false;
		const set = (s: LiveState) => {
			live.state = s;
			setState(s);
		};
		const refresh = () => {
			live.signalAt = Date.now();
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				// cancelRefetch false: schnelle Ticks brechen laufende Abrufe nicht ab (langsame Endpunkte verhungern sonst)
				void qc.invalidateQueries({ predicate: refreshable }, { cancelRefetch: false });
			}, 150);
		};
		const onOpen = () => {
			attempt = 0;
			set("live");
			// nach einer Lücke: alles neu, auch der Chat
			if (gap) void qc.invalidateQueries();
			gap = false;
		};
		const connect = () => {
			if (stopped) return;
			// EventSource kann keine Header: das Token für den (nur lesenden) Stream in der Adresse
			const token = sessionToken();
			es = new EventSource(token ? `/api/stream?session=${encodeURIComponent(token)}` : "/api/stream");
			es.addEventListener("open", onOpen);
			es.addEventListener("hello", () => set("live"));
			es.addEventListener("error", () => {
				gap = true;
				if (es?.readyState !== EventSource.CLOSED) return set("connecting");
				set("offline");
				es.close();
				retry = setTimeout(connect, BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
			});
			es.addEventListener("tick", refresh);
			es.addEventListener("event", (e) => {
				refresh();
				const parsed = EventSchema.safeParse(parse((e as MessageEvent).data));
				if (parsed.success && NOTIFY_KINDS.has(parsed.data.kind)) notify(`Tradedesk – ${parsed.data.actor}`, (parsed.data as DeskEvent).text, `event-${parsed.data.id}-${parsed.data.time}`);
			});
			es.addEventListener("chat", (e) => {
				live.signalAt = Date.now();
				const parsed = ChatMessageSchema.safeParse(parse((e as MessageEvent).data));
				if (!parsed.success) return;
				const m: ChatMessage = parsed.data;
				qc.setQueryData<ChatMessage[]>(keys.chat, (old) => (old && !old.some((x) => x.id === m.id) ? [...old, m].slice(-500) : old));
				if (m.role === "agent") notify(`${m.author} im Chat`, m.text.slice(0, 160), `chat-${m.id}`);
			});
		};
		connect();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			if (retry) clearTimeout(retry);
			es?.close();
		};
	}, [qc]);
	return state;
}
