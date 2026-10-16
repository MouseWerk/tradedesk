// Trading-Cockpit für den Tageshandel: Börsen-Sessions und Tagesergebnis oben, darunter Chart und Order-Rechner
// nebeneinander. Breit (ab 1300 px Inhalt): Scanner links, Chart mit Positionen Mitte, Rechner, Vorschläge und News
// rechts. Mittel (Laptop mit Chat): Chart links, rechts Rechner, Scanner, Vorschläge, News. Schmal: alles untereinander,
// Rechner direkt unter dem Chart. Chart und Rechner bleiben dabei im selben Eltern-Element (Eingaben gehen nicht verloren).
// Tasten: Pfeil hoch/runter wechselt den Wert in der sichtbaren Reihenfolge des Scanners – nur, wenn kein anderes
// Bedienelement den Fokus hat (Reiter, Chart und Felder behalten ihre Pfeiltasten); B/S öffnet den Rechner.
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useState } from "react";
import { ListChecks } from "lucide-react";
import type { Side } from "@desk/shared";
import { useCockpit, useOverview, useProposals } from "@/lib/api";
import { Card, Empty, Skeleton, cn } from "@/ui/kit";
import { LoadError } from "@/ui/boundary";
import { de } from "@/i18n/de";
import { Page, ProposalRow, isActive, needsYou } from "../common";
import { DayTable, NewsCard, Positions, SessionBar } from "./parts";
import { Scanner, sortRows, type Sort } from "./Scanner";
import { IntradayChart } from "./IntradayChart";
import { OrderCalc } from "./OrderCalc";

type Mode = "wide" | "split" | "stack";
const modeFor = (w: number): Mode => (w >= 1300 ? "wide" : w >= 700 ? "split" : "stack");

/** Breite des Inhalts → Anordnung. Schon beim ersten Zeichnen aus der Breite von #main, damit nichts springt. */
function useMode(): [(el: HTMLDivElement | null) => void, Mode] {
	// Callback-Ref: Skelett und Inhalt sind verschiedene Elemente, beobachtet wird immer das aktuelle
	const [el, setEl] = useState<HTMLDivElement | null>(null);
	const [mode, setMode] = useState<Mode>(() => modeFor((document.getElementById("main")?.clientWidth ?? 1200) - 40));
	useLayoutEffect(() => {
		if (!el) return;
		const ro = new ResizeObserver(([e]) => setMode(modeFor(e.contentRect.width)));
		ro.observe(el);
		setMode(modeFor(el.getBoundingClientRect().width));
		return () => ro.disconnect();
	}, [el]);
	return [setEl, mode];
}

const GRID: Record<Mode, string> = { wide: "grid-cols-[300px_minmax(0,1fr)_340px]", split: "grid-cols-[minmax(0,1fr)_320px]", stack: "grid-cols-1" };

export default function TradeView() {
	const { symbol: wanted } = useSearch({ strict: false }) as { symbol?: string };
	const navigate = useNavigate();
	const { data, error, refetch } = useCockpit();
	const { data: ov, error: ovError, refetch: refetchOv } = useOverview();
	const { data: proposals } = useProposals();
	const [side, setSide] = useState<Side>("buy");
	const [sort, setSort] = useState<Sort>("change");
	const [focusCalc, setFocusCalc] = useState(0);
	const [unknown, setUnknown] = useState<string | null>(null);
	const [ref, mode] = useMode();
	const rows = data?.scan ?? [];
	const sorted = sortRows(rows, sort);
	const selected = rows.find((r) => r.symbol === wanted) ?? sorted[0];
	const select = (s: string) => void navigate({ to: "/trade", search: { symbol: s }, replace: true });

	// Adresse zeigt immer den Wert, den du siehst: ohne Symbol der erste, ein unbekanntes wird ersetzt (mit Hinweis)
	useEffect(() => {
		if (!data || !selected || wanted === selected.symbol) return;
		if (wanted) setUnknown(wanted);
		select(selected.symbol);
	}, [data, wanted, selected?.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement;
			if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || document.querySelector("[role=dialog]")) return;
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				// nur ohne fokussiertes Bedienelement oder in der Scanner-Liste selbst
				const inScanner = !!t.closest("[data-scanner]");
				if (!(inScanner || t === document.body || t.id === "main") || !sorted.length || !selected) return;
				e.preventDefault();
				const i = sorted.findIndex((r) => r.symbol === selected.symbol);
				const next = sorted[Math.max(0, Math.min(sorted.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].symbol;
				select(next);
				if (inScanner) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-scanner] [data-symbol="${CSS.escape(next)}"]`)?.focus());
			} else if ((e.key === "b" || e.key === "s") && !t.closest("input, textarea, select, [contenteditable=true]")) {
				e.preventDefault();
				setSide(e.key === "b" ? "buy" : "sell");
				setFocusCalc((n) => n + 1);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	if ((error && !data) || (ovError && !ov))
		return (
			<Page>
				<LoadError error={error ?? ovError} onRetry={() => void (refetch(), refetchOv())} />
			</Page>
		);
	if (!data || !ov)
		return (
			<Page className="max-w-none">
				<Skeleton className="h-[52px]" />
				<div ref={ref} className={cn("grid items-start gap-4", GRID[mode])}>
					{mode === "wide" && <Skeleton className="h-[520px]" />}
					<Skeleton className="h-[560px]" />
					<Skeleton className="h-[440px]" />
				</div>
			</Page>
		);

	const active = (proposals ?? []).filter(isActive);
	const stack = mode === "stack";
	const scanner = <Scanner rows={sorted} sort={sort} onSort={setSort} selected={selected?.symbol} onSelect={select} listClassName={mode === "wide" ? undefined : "max-h-[340px]"} />;
	return (
		<Page className="max-w-none">
			<SessionBar cockpit={data} />
			{unknown && (
				<p className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-fg-2" role="status">
					{de.trade.unknownSymbol(unknown, selected?.symbol ?? null)}
					<button type="button" className="ml-auto text-fg-3 underline underline-offset-2 hover:text-fg" onClick={() => setUnknown(null)}>
						{de.trade.hide}
					</button>
				</p>
			)}
			{rows.length === 0 ? (
				<Card>
					<Empty>{de.trade.emptyWatchlist}</Empty>
				</Card>
			) : (
				<div ref={ref} className={cn("grid items-start gap-4", GRID[mode])} data-layout={mode}>
					{mode === "wide" && scanner}
					<div className={cn("flex min-w-0 flex-col gap-4", stack && "contents")}>
						<div className="order-1 min-w-0">{selected && <IntradayChart row={selected} cockpit={data} proposals={active} small={stack} />}</div>
						<div className="order-5 min-w-0">
							<Positions cockpit={data} onSelect={select} />
						</div>
					</div>
					<div className={cn("flex min-w-0 flex-col gap-4", stack && "contents")}>
						<div className="order-2 min-w-0">{selected && <OrderCalc row={selected} cockpit={data} proposals={proposals ?? []} accounts={ov.accounts} side={side} onSide={setSide} focusSignal={focusCalc} />}</div>
						{mode !== "wide" && <div className="order-3 min-w-0">{scanner}</div>}
						<div className="order-4 min-w-0">
							<Waiting proposals={active} accounts={ov.accounts} symbol={selected?.symbol} />
						</div>
						<div className="order-6 min-w-0">{selected && <NewsCard symbol={selected.symbol} />}</div>
					</div>
				</div>
			)}
			<DayTable cockpit={data} />
		</Page>
	);
}

/** Alles, was auf dich wartet – für alle Werte, nicht nur den gewählten; offene Orders zum gewählten Wert dazu. */
function Waiting({ proposals, accounts, symbol }: { proposals: Parameters<typeof needsYou>[0][]; accounts: Parameters<typeof needsYou>[1]; symbol?: string }) {
	const waiting = proposals.filter((p) => needsYou(p, accounts));
	const list = [...waiting, ...proposals.filter((p) => !needsYou(p, accounts) && p.symbol === symbol)].sort((a, b) => Number(b.symbol === symbol) - Number(a.symbol === symbol));
	const shown = list.slice(0, 6);
	return (
		<Card
			title={de.trade.waiting}
			icon={<ListChecks className="size-4" />}
			pad={false}
			label={de.trade.waitingLabel(waiting.length)}
			aside={
				<Link to="/orders" className="-mr-2 inline-flex h-7 items-center rounded-md px-2 tnum hover:bg-surface-3 hover:text-fg">
					{waiting.length ? de.trade.waitingOpen(waiting.length) : de.trade.orders}
				</Link>
			}
		>
			{shown.length ? (
				<ul className="divide-y divide-line" data-testid="cockpit-waiting">
					{shown.map((p) => (
						<ProposalRow key={p.id} p={p} accounts={accounts} />
					))}
					{list.length > shown.length && (
						<li className="px-4 py-2 text-[12px]">
							<Link to="/orders" className="text-fg-2 underline underline-offset-2 hover:text-fg">
								{de.trade.allInOrders(list.length)}
							</Link>
						</li>
					)}
				</ul>
			) : (
				<Empty>{de.trade.nothingWaiting}</Empty>
			)}
		</Card>
	);
}
