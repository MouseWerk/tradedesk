// App-Rahmen: Seitenleiste mit Modulen und deinen Depots, eingelassene Arbeitsfläche, Not-Aus-Hinweis über allem.
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronRight, Moon, OctagonX, Radio, Sun } from "lucide-react";
import { MODULES, moduleForPath } from "@/modules/registry";
import { useLive, useOverview, type LiveState } from "@/lib/api";
import { ago, eur, pct, tone } from "@/lib/format";
import { Badge, Button, Kbd, cn } from "@/ui/kit";
import { Boundary } from "@/ui/boundary";

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

export function Shell() {
	const live = useLive();
	const [dark, toggleTheme] = useTheme();
	const navigate = useNavigate();
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement;
			if (e.ctrlKey || e.metaKey || e.altKey || t.closest("input, textarea, select, [contenteditable=true], [role=dialog]") || document.querySelector("[role=dialog]")) return;
			const m = MODULES.find((x) => x.hotkey === e.key);
			if (m) void navigate({ to: m.path });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [navigate]);
	return (
		<div className="flex h-screen gap-2 bg-bg p-2 text-[13px] text-fg max-md:gap-1 max-md:p-1">
			<Boundary name="Navigation" compact>
				<Sidebar live={live} />
			</Boundary>
			<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow)]">
				<TopBar dark={dark} toggleTheme={toggleTheme} />
				<KillBanner />
				<div className="@container scroll-thin flex-1 overflow-auto" id="main">
					<Outlet />
				</div>
			</main>
		</div>
	);
}

function Sidebar({ live }: { live: LiveState }) {
	const path = useRouterState({ select: (s) => s.location.pathname });
	const active = moduleForPath(path)?.id;
	const { data } = useOverview();
	const mine = data?.accounts.filter((a) => a.owner === "user") ?? [];
	useEffect(() => {
		document.title = data?.pending ? `(${data.pending}) Tradedesk` : "Tradedesk";
	}, [data?.pending]);
	return (
		<aside className="flex w-[232px] shrink-0 flex-col px-2 py-1.5 max-lg:w-12 max-lg:px-0.5" aria-label="Navigation">
			<div className="flex h-10 items-center gap-2.5 px-2">
				<span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-fg" aria-hidden>
					<svg viewBox="0 0 16 16" className="size-3.5">
						<path d="M2 11l3.5-3.5 2.5 2.5 6-6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</span>
				<div className="min-w-0 leading-tight max-lg:hidden">
					<div className="truncate text-[13px] font-semibold">Tradedesk</div>
					<div className="truncate text-[11px] text-fg-3">{data ? `${data.user} · ${data.accounts.length - mine.length} Agenten` : "lokal"}</div>
				</div>
			</div>
			<nav className="mt-5 flex flex-col gap-px" aria-label="Module">
				<div className="mb-1 px-2 text-[11px] font-medium text-fg-3 max-lg:sr-only">Module</div>
				{MODULES.map((m) => {
					const on = m.id === active;
					return (
						<Link
							key={m.id}
							to={m.path}
							title={`${m.title} (${m.hotkey})`}
							className={cn("group flex h-8 items-center gap-2.5 rounded-lg px-2 text-fg-2 max-lg:justify-center", on ? "bg-surface-3 font-medium text-fg" : "hover:bg-surface-2")}
							aria-current={on ? "page" : undefined}
						>
							<span className="relative">
								<m.icon className={cn("size-4", on ? "text-fg" : "text-fg-3")} strokeWidth={1.75} aria-hidden />
								{m.id === "orders" && !!data?.pending && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warn lg:hidden" aria-hidden />}
							</span>
							<span className="max-lg:sr-only">{m.title}</span>
							{m.id === "orders" && !!data?.pending ? (
								<Badge variant="warn" className="ml-auto tnum max-lg:sr-only" data-testid="pending-badge" title={`${data.pending} Vorschläge warten auf dich`}>
									{data.pending}
								</Badge>
							) : (
								<Kbd className="ml-auto opacity-0 group-hover:opacity-100 max-lg:hidden">{m.hotkey}</Kbd>
							)}
						</Link>
					);
				})}
			</nav>
			<div className="mt-6 px-2 text-[11px] font-medium text-fg-3 max-lg:hidden">Deine Depots</div>
			<div className="mt-1 flex flex-col gap-px max-lg:hidden">
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
			<div className="mt-auto flex flex-col gap-2 px-1">
				<p className="px-1 text-[10.5px] leading-snug text-fg-3 max-lg:hidden">Keine Anlageberatung. Kurse von Yahoo Finance, oft verzögert.</p>
				<div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] text-fg-2 max-lg:justify-center max-lg:border-0 max-lg:bg-transparent max-lg:px-0" role="status" title={data?.marketError ?? undefined}>
					<Radio className={cn("size-3.5 shrink-0", live === "live" && data?.market !== "error" ? "text-ok" : live === "connecting" ? "text-warn" : "text-err")} aria-hidden />
					<span className="min-w-0 truncate max-lg:sr-only">
						{live !== "live" ? (live === "connecting" ? "Verbinde…" : "Offline") : data?.market === "error" ? "Kurse gestört" : data?.market === "off" ? "Kurse aus" : `Kurse ${ago(data?.quotesAt ?? null)}`}
					</span>
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

function TopBar({ dark, toggleTheme }: { dark: boolean; toggleTheme: () => void }) {
	const path = useRouterState({ select: (s) => s.location.pathname });
	const mod = moduleForPath(path);
	const { data } = useOverview();
	return (
		<header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-5 max-md:px-3">
			<span className="flex min-w-0 items-center gap-2">
				<span className="text-fg-3 max-sm:hidden">Tradedesk</span>
				<ChevronRight className="size-3.5 text-fg-3 max-sm:hidden" aria-hidden />
				<span className="truncate font-medium">{mod?.title ?? "Übersicht"}</span>
			</span>
			<div className="ml-auto flex items-center gap-1.5">
				<Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={dark ? "Helles Design" : "Dunkles Design"} title={dark ? "Helles Design" : "Dunkles Design"}>
					{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
				</Button>
				<Link to="/orders" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-fg hover:opacity-90">
					<span className="max-sm:sr-only">Vorschläge</span>
					<span className="tnum">{data?.pending ?? 0}</span>
				</Link>
			</div>
		</header>
	);
}
