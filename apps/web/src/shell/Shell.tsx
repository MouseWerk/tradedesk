// App-Rahmen: Seitenleiste mit Modulen und deinen Depots, eingelassene Arbeitsfläche, Not-Aus-Hinweis über allem.
// Platz: Ist der Chat angedockt und das Fenster schmaler als 1600 px, wird die Seitenleiste zur Symbolleiste – sonst
// bleiben auf einem 1440er-Laptop keine 800 px für Chart und Order-Rechner. Unter 1280 px ist der Chat ein modaler
// Dialog (Fokus hinein, Escape schließt, Fokus zurück auf den Chat-Knopf, Modul-Tasten ruhen).
import * as Dialog from "@radix-ui/react-dialog";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, ChevronRight, ListChecks, MessageSquare, Moon, OctagonX, Radio, Sun } from "lucide-react";
import { MODULES, moduleForPath } from "@/modules/registry";
import { notifyEnabled, setNotify, useChat, useLive, useOverview, type LiveState } from "@/lib/api";
import { ago, eur, hhmm, pct, tone } from "@/lib/format";
import { Badge, Button, Kbd, cn } from "@/ui/kit";
import { Boundary } from "@/ui/boundary";
import { useToast } from "@/ui/overlay";
import { ChatPanel } from "./ChatPanel";

function useTheme(): [boolean, () => void] {
	const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
	const toggle = () => {
		const next = !dark;
		document.documentElement.classList.toggle("dark", next);
		try {
			localStorage.setItem("desk.theme", next ? "dark" : "light");
		} catch {
			// privater Modus
		}
		setDark(next);
	};
	return [dark, toggle];
}

function useStored(key: string, initial: boolean): [boolean, (v: boolean) => void] {
	const [v, setV] = useState(() => {
		try {
			const s = localStorage.getItem(key);
			return s === null ? initial : s === "1";
		} catch {
			return initial;
		}
	});
	const set = (next: boolean) => {
		setV(next);
		try {
			localStorage.setItem(key, next ? "1" : "0");
		} catch {
			// privater Modus
		}
	};
	return [v, set];
}

function useMedia(query: string) {
	const [match, setMatch] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const mq = window.matchMedia(query);
		const on = () => setMatch(mq.matches);
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, [query]);
	return match;
}

const SEEN_KEY = "desk.chatSeen";

/**
 * Ungelesene Chat-Nachrichten an dich oder an alle, solange der Chat zu ist. Im frischen Browser gilt alles vor dem
 * ersten Laden als gelesen – sonst zählte das Abzeichen den ganzen Verlauf („48 ungelesen“).
 */
function useUnread(visible: boolean, user: string) {
	const { data } = useChat();
	const [seen, setSeen] = useState<number | null>(() => {
		try {
			const s = localStorage.getItem(SEEN_KEY);
			return s === null ? null : Number(s);
		} catch {
			return null;
		}
	});
	const markSeen = useCallback((id: number) => {
		setSeen((s) => {
			if (s !== null && id <= s) return s;
			try {
				localStorage.setItem(SEEN_KEY, String(id));
			} catch {
				// privater Modus
			}
			return id;
		});
	}, []);
	const lastId = data?.at(-1)?.id;
	useEffect(() => {
		if (seen === null && data) markSeen(lastId ?? 0);
	}, [seen, data, lastId, markSeen]);
	const unread = visible || seen === null ? 0 : (data ?? []).filter((m) => m.id > seen && m.author !== user && (m.to.length === 0 || m.to.includes(user))).length;
	return { unread, markSeen };
}

export function Shell() {
	const live = useLive();
	const [dark, toggleTheme] = useTheme();
	const navigate = useNavigate();
	const { data: ov } = useOverview();
	const wide = useMedia("(min-width: 1280px)");
	const lg = useMedia("(min-width: 1024px)");
	const roomy = useMedia("(min-width: 1600px)");
	const [chatWide, setChatWide] = useStored("desk.chat", true);
	const [drawer, setDrawer] = useState(false);
	const chatOpen = wide ? chatWide : drawer;
	const rail = !lg || (wide && chatWide && !roomy);
	const toggleChat = useCallback(() => (wide ? setChatWide(!chatWide) : setDrawer((d) => !d)), [wide, chatWide, setChatWide]);
	const { unread, markSeen } = useUnread(chatOpen, ov?.user ?? "");
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement;
			if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || t.closest("input, textarea, select, [contenteditable=true], [role=dialog]") || document.querySelector("[role=dialog]")) return;
			const m = MODULES.find((x) => x.hotkey === e.key);
			// preventDefault: sonst landet das „c“ im Nachrichtenfeld, das beim Öffnen den Fokus bekommt
			if (m) (e.preventDefault(), void navigate({ to: m.path }));
			else if (e.key === "c") (e.preventDefault(), toggleChat());
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [navigate, toggleChat]);
	useEffect(() => {
		if (wide) setDrawer(false);
	}, [wide]);
	const chatInput = () => document.querySelector<HTMLTextAreaElement>('[data-testid="chat"] textarea')?.focus();
	return (
		<div className="flex h-screen gap-2 bg-bg p-2 text-[13px] text-fg max-md:gap-1 max-md:p-1">
			<a href="#main" className="sr-only rounded-lg bg-primary px-3 py-2 text-[13px] font-medium text-primary-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70]" onClick={(e) => (e.preventDefault(), document.getElementById("main")?.focus())}>
				Zum Inhalt
			</a>
			<Boundary name="Navigation" compact>
				<Sidebar live={live} rail={rail} />
			</Boundary>
			<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow)]">
				<TopBar dark={dark} toggleTheme={toggleTheme} chatOpen={chatOpen} toggleChat={toggleChat} unread={unread} />
				<KillBanner />
				<div className="@container scroll-thin flex-1 overflow-auto outline-none" id="main" tabIndex={-1}>
					<Outlet />
				</div>
			</main>
			{wide && chatWide && (
				<Boundary name="Chat" compact>
					<ChatPanel onSeen={markSeen} />
				</Boundary>
			)}
			<Dialog.Root open={!wide && drawer} onOpenChange={setDrawer}>
				<Dialog.Portal>
					<Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--overlay)]" />
					<Dialog.Content
						className="fixed top-2 right-2 bottom-2 z-40 flex w-[min(380px,calc(100vw-16px))] animate-enter outline-none"
						aria-describedby={undefined}
						onOpenAutoFocus={(e) => {
							e.preventDefault();
							chatInput();
						}}
						onCloseAutoFocus={(e) => {
							e.preventDefault();
							document.querySelector<HTMLElement>('[data-testid="chat-toggle"]')?.focus();
						}}
					>
						<Dialog.Title className="sr-only">Chat</Dialog.Title>
						<Boundary name="Chat" compact>
							<ChatPanel className="w-full shadow-2xl" onClose={() => setDrawer(false)} onSeen={markSeen} />
						</Boundary>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>
		</div>
	);
}

function Sidebar({ live, rail }: { live: LiveState; rail: boolean }) {
	const path = useRouterState({ select: (s) => s.location.pathname });
	const active = moduleForPath(path)?.id;
	const { data, error, dataUpdatedAt } = useOverview();
	const mine = data?.accounts.filter((a) => a.owner === "user") ?? [];
	useEffect(() => {
		document.title = data?.pending ? `(${data.pending}) Tradedesk` : "Tradedesk";
	}, [data?.pending]);
	// Daten da, aber der letzte Abruf schlug fehl: sagen, wie alt sie sind, statt still alte Kurse zu zeigen
	const stale = !!error;
	const status = stale
		? data
			? `Server nicht erreichbar · Stand ${hhmm(dataUpdatedAt)}`
			: "Server nicht erreichbar"
		: live !== "live"
			? live === "connecting"
				? "Verbinde…"
				: "Offline – verbinde neu…"
			: data?.market === "error"
				? "Kurse gestört"
				: data?.market === "off"
					? "Kurse aus"
					: `Kurse ${ago(data?.quotesAt ?? null)}`;
	return (
		<aside className={cn("flex shrink-0 flex-col py-1.5", rail ? "w-12 px-0.5" : "w-[232px] px-2")} aria-label="Navigation" data-rail={rail || undefined}>
			<div className="flex h-10 items-center gap-2.5 px-2">
				<span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-fg" aria-hidden>
					<svg viewBox="0 0 16 16" className="size-3.5">
						<path d="M2 11l3.5-3.5 2.5 2.5 6-6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</span>
				<div className={cn("min-w-0 leading-tight", rail && "hidden")}>
					<div className="truncate text-[13px] font-semibold">Tradedesk</div>
					<div className="truncate text-[11px] text-fg-3">{data ? `${data.user} · ${data.accounts.length - mine.length} Agenten` : "lokal"}</div>
				</div>
			</div>
			<nav className="mt-5 flex flex-col gap-px" aria-label="Module">
				<div className={cn("mb-1 px-2 text-[11px] font-medium text-fg-3", rail && "sr-only")}>Module</div>
				{MODULES.map((m) => {
					const on = m.id === active;
					return (
						<Link
							key={m.id}
							to={m.path}
							title={`${m.title} (${m.hotkey})`}
							className={cn("group flex h-8 items-center gap-2.5 rounded-lg px-2 text-fg-2", rail && "justify-center", on ? "bg-surface-3 font-medium text-fg" : "hover:bg-surface-2")}
							aria-current={on ? "page" : undefined}
						>
							<span className="relative">
								<m.icon className={cn("size-4", on ? "text-fg" : "text-fg-3")} strokeWidth={1.75} aria-hidden />
								{m.id === "orders" && !!data?.pending && rail && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warn" aria-hidden />}
							</span>
							<span className={cn(rail && "sr-only")}>{m.title}</span>
							{m.id === "orders" && !!data?.pending ? (
								<Badge variant="warn" className={cn("ml-auto tnum", rail && "sr-only")} data-testid="pending-badge" title={`${data.pending} Vorschläge warten auf dich`}>
									{data.pending}
								</Badge>
							) : (
								<Kbd className={cn("ml-auto opacity-0 group-hover:opacity-100", rail && "hidden")}>{m.hotkey}</Kbd>
							)}
						</Link>
					);
				})}
			</nav>
			{!rail && (
				<>
					<div className="mt-6 px-2 text-[11px] font-medium text-fg-3">Deine Depots</div>
					<div className="mt-1 flex flex-col gap-px">
						{mine.map((a) => (
							<Link key={a.id} to="/portfolio" search={{ account: a.id }} className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
								<span className="truncate text-fg-2">{a.name}</span>
								<span className="flex items-baseline gap-2 tnum">
									<span className="font-medium">{eur(a.equityCents, { short: true })}</span>
									<span className={cn("ml-auto text-[11.5px]", tone(a.dayChangeCents))} title="heute">
										{a.dayChangeCents === null || a.depositsCents === 0 ? "" : pct((a.dayChangeCents / Math.max(1, a.equityCents - a.dayChangeCents)) * 100)}
									</span>
								</span>
							</Link>
						))}
					</div>
				</>
			)}
			<div className="mt-auto flex flex-col gap-2 px-1">
				<p className={cn("px-1 text-[10.5px] leading-snug text-fg-3", rail && "hidden")}>Keine Anlageberatung. Kurse von Yahoo Finance, oft verzögert.</p>
				<div className={cn("flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] text-fg-2", rail && "justify-center border-0 bg-transparent px-0")} role="status" title={rail ? status : (data?.marketError ?? undefined)} data-testid="live-status">
					<Radio className={cn("size-3.5 shrink-0", !stale && live === "live" && data?.market !== "error" ? "text-ok" : !stale && live === "connecting" ? "text-warn" : "text-err")} aria-hidden />
					<span className={cn("min-w-0 truncate", rail && "sr-only")}>{status}</span>
				</div>
			</div>
		</aside>
	);
}

function KillBanner() {
	const { data } = useOverview();
	if (!data?.killSwitch) return null;
	return (
		<div className="flex items-center gap-2 bg-err/10 px-5 py-2 text-[12.5px] text-err max-md:px-3" role="alert" data-testid="kill-banner">
			<OctagonX className="size-4 shrink-0" aria-hidden />
			<span className="min-w-0 flex-1">Not-Aus ist an: keine Freigaben, keine Ausführungen, offene Limits ruhen.</span>
			<Link to="/risk" className="shrink-0 font-medium underline underline-offset-2">
				Zum Risiko
			</Link>
		</div>
	);
}

function TopBar({ dark, toggleTheme, chatOpen, toggleChat, unread }: { dark: boolean; toggleTheme: () => void; chatOpen: boolean; toggleChat: () => void; unread: number }) {
	const path = useRouterState({ select: (s) => s.location.pathname });
	const mod = moduleForPath(path);
	const { data } = useOverview();
	const toast = useToast();
	const [notify, setNotifyState] = useState(notifyEnabled);
	const canNotify = typeof Notification !== "undefined";
	// Erlaubnis kann in den Website-Einstellungen entzogen werden: beim Zurückkommen neu lesen
	const resync = useRef(() => setNotifyState(notifyEnabled()));
	useEffect(() => {
		const on = resync.current;
		window.addEventListener("focus", on);
		document.addEventListener("visibilitychange", on);
		return () => {
			window.removeEventListener("focus", on);
			document.removeEventListener("visibilitychange", on);
		};
	}, []);
	const toggleNotify = async () => {
		const r = await setNotify(!notify);
		if (r === "blocked") {
			toast({ text: "Benachrichtigungen sind im Browser blockiert – in den Website-Einstellungen für diese Seite erlauben.", tone: "error" });
			return setNotifyState(false);
		}
		if (!notify && !r) toast({ text: "Benachrichtigungen nicht erlaubt – der Browser hat nicht zugestimmt.", tone: "error" });
		setNotifyState(r === true);
	};
	const pending = data ? String(data.pending) : "–";
	return (
		<header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-5 max-md:px-3">
			<span className="flex min-w-0 items-center gap-2">
				<span className="text-fg-3 max-sm:hidden">Tradedesk</span>
				<ChevronRight className="size-3.5 text-fg-3 max-sm:hidden" aria-hidden />
				<span className="truncate font-medium">{mod?.title ?? "Übersicht"}</span>
			</span>
			<div className="ml-auto flex items-center gap-1.5">
				{canNotify && (
					<Button
						variant="ghost"
						size="icon"
						onClick={() => void toggleNotify()}
						aria-pressed={notify}
						aria-label={notify ? "Benachrichtigungen aus" : "Benachrichtigungen an (Vorschläge, Alarme, Stops, wenn das Fenster im Hintergrund ist)"}
						title={notify ? "Benachrichtigungen aus" : "Benachrichtigungen an"}
						data-testid="notify-toggle"
					>
						{notify ? <Bell className="size-4" /> : <BellOff className="size-4" />}
					</Button>
				)}
				<Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={dark ? "Helles Design" : "Dunkles Design"} title={dark ? "Helles Design" : "Dunkles Design"}>
					{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
				</Button>
				<Button variant="ghost" size="icon" onClick={toggleChat} aria-pressed={chatOpen} aria-label={unread ? `Chat (C), ${unread} ungelesen` : "Chat (C)"} title="Chat (C)" className="relative" data-testid="chat-toggle">
					<MessageSquare className="size-4" />
					{unread > 0 && <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-warn px-1 text-[10px] font-semibold text-primary-fg tnum">{unread > 99 ? "99+" : unread}</span>}
				</Button>
				<Link to="/orders" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-fg hover:opacity-90" aria-label={data ? `Vorschläge, ${data.pending} warten auf dich` : "Vorschläge"} data-testid="pending-link">
					<ListChecks className="size-4 sm:hidden" aria-hidden />
					<span className="max-sm:hidden">Vorschläge</span>
					<span className="tnum">{pending}</span>
				</Link>
			</div>
		</header>
	);
}
