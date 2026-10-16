// Befehlspalette (Strg+K / Cmd+K oder der Such-Knopf oben): Module, Werte (öffnet Trading), Depots, offene Vorschläge
// (öffnet Orders) und Aktionen. Muster Combobox mit Listbox: der Fokus bleibt im Feld, Pfeiltasten bewegen die
// Markierung (aria-activedescendant), Eingabe nimmt sie – nie während einer IME-Eingabe. Escape schließt nur die Palette,
// der Fokus geht zurück, wo er war; eine gewählte Aktion läuft erst danach (ein Dialog merkt sich so den richtigen Auslöser).
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, CornerDownLeft, LogOut, MessageSquare, Moon, OctagonX, Search, ShoppingCart, Sun, Wallet, ListChecks, CandlestickChart } from "lucide-react";
import type { AccountSummary } from "@desk/shared";
import { sideLabel, statusLabel } from "@desk/shared";
import { useOverview, useProposals, useWatchlist } from "@/lib/api";
import { qty as fmtQty } from "@/lib/format";
import { rank } from "@/lib/fuzzy";
import { MODULES } from "@/modules/registry";
import { isActive } from "@/modules/common";
import { Kbd, cn } from "@/ui/kit";
import { restoreFocus, useOpener } from "@/ui/overlay";

export interface PaletteActions {
	order: () => void;
	kill: () => void;
	theme: () => void;
	chat: () => void;
	logout: () => void;
	dark: boolean;
	chatOpen: boolean;
}

type Group = "Module" | "Wartet" | "Aktionen" | "Depots" | "Werte";
interface Entry {
	id: string;
	group: Group;
	label: string;
	hint?: string;
	keywords?: string[];
	icon: ReactNode;
	run: () => void;
}

const GROUP_LABEL: Record<Group, string> = { Module: "Module", Wartet: "Offene Vorschläge", Aktionen: "Aktionen", Depots: "Depots", Werte: "Werte" };

function accountHint(a: AccountSummary): string {
	if (a.owner !== "user") return `Papierdepot von ${a.owner}`;
	return a.kind === "paper" ? "Papierdepot" : a.kind === "manual" ? `${a.broker} · manuell` : `${a.broker}${a.live ? " · echtes Geld" : " · Papierkonto"}`;
}

/** Nach dem Wechsel auf Orders: die Karte des Vorschlags zeigen und ihren ersten Knopf fokussieren. */
function focusProposal(id: number) {
	const t0 = performance.now();
	const tick = () => {
		const card = document.querySelector<HTMLElement>(`[data-testid="proposal"][data-id="${id}"]`);
		if (card) {
			card.scrollIntoView({ block: "center" });
			(card.querySelector<HTMLElement>("footer button") ?? card).focus({ preventScroll: true });
		} else if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

export function CommandPalette({ open, onOpenChange, actions }: { open: boolean; onOpenChange: (o: boolean) => void; actions: PaletteActions }) {
	const opener = useOpener(open);
	const pending = useRef<(() => void) | null>(null);
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)]" />
				<Dialog.Content
					className="fixed top-[12vh] left-1/2 z-50 flex max-h-[min(560px,76vh)] w-[640px] max-w-[calc(100vw-24px)] -translate-x-1/2 animate-enter flex-col overflow-hidden rounded-xl border border-line bg-surface text-[13px] text-fg shadow-2xl outline-none max-sm:top-2"
					aria-describedby={undefined}
					data-testid="palette"
					onCloseAutoFocus={(e) => {
						e.preventDefault();
						restoreFocus(opener.current);
						const run = pending.current;
						pending.current = null;
						run?.();
					}}
				>
					<Dialog.Title className="sr-only">Befehlspalette</Dialog.Title>
					{open && (
						<Body
							actions={actions}
							choose={(run) => {
								pending.current = run;
								onOpenChange(false);
							}}
						/>
					)}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function Body({ actions, choose }: { actions: PaletteActions; choose: (run: () => void) => void }) {
	const navigate = useNavigate();
	const { data: ov } = useOverview();
	const { data: watch } = useWatchlist();
	const { data: proposals } = useProposals();
	const [q, setQ] = useState("");
	const [active, setActive] = useState(0);
	const listId = useId();
	const list = useRef<HTMLDivElement>(null);

	const entries = useMemo<Entry[]>(() => {
		const accounts = ov?.accounts ?? [];
		const go = (to: string, search?: Record<string, string>) => () => void navigate({ to, search });
		return [
			...MODULES.map((m) => ({ id: `m-${m.id}`, group: "Module" as const, label: m.title, hint: `Taste ${m.hotkey}`, keywords: m.keywords, icon: <m.icon className="size-4" />, run: go(m.path) })),
			...(proposals ?? []).filter(isActive).map((p) => ({
				id: `p-${p.id}`,
				group: "Wartet" as const,
				label: `${sideLabel[p.side]} ${fmtQty(p.approvedQty ?? p.qty)} ${p.symbol}`,
				hint: `${p.author} für ${accounts.find((a) => a.id === p.accountId)?.name ?? p.accountId} · ${statusLabel[p.status]}`,
				keywords: [p.name, p.author, "Vorschlag", "Freigabe"],
				icon: <ListChecks className="size-4" />,
				run: () => {
					void navigate({ to: "/orders" });
					focusProposal(p.id);
				},
			})),
			{ id: "a-order", group: "Aktionen" as const, label: "Order…", hint: "Neue Order im Papier- oder Broker-Depot", keywords: ["kaufen", "verkaufen", "neue order", "ticket"], icon: <ShoppingCart className="size-4" />, run: actions.order },
			{ id: "a-kill", group: "Aktionen" as const, label: ov?.killSwitch ? "Not-Aus ausschalten" : "Not-Aus…", hint: ov?.killSwitch ? "Handel wieder freigeben" : "Alle Freigaben und Ausführungen stoppen", keywords: ["notaus", "stopp", "kill", "risiko"], icon: <OctagonX className="size-4" />, run: actions.kill },
			{ id: "a-theme", group: "Aktionen" as const, label: actions.dark ? "Helles Design" : "Dunkles Design", hint: "Design wechseln", keywords: ["theme", "hell", "dunkel", "farbe"], icon: actions.dark ? <Sun className="size-4" /> : <Moon className="size-4" />, run: actions.theme },
			{ id: "a-chat", group: "Aktionen" as const, label: actions.chatOpen ? "Chat schließen" : "Chat öffnen", hint: "Taste C", keywords: ["nachricht", "agenten"], icon: <MessageSquare className="size-4" />, run: actions.chat },
			{ id: "a-logout", group: "Aktionen" as const, label: "Abmelden", hint: "danach nur mit PIN wieder an Freigaben", keywords: ["logout", "pin", "sitzung"], icon: <LogOut className="size-4" />, run: actions.logout },
			...accounts.map((a) => ({ id: `d-${a.id}`, group: "Depots" as const, label: a.name, hint: accountHint(a), keywords: [a.broker, a.owner === "user" ? "Depot" : `Agent ${a.owner}`], icon: <Wallet className="size-4" />, run: go("/portfolio", { account: a.id }) })),
			...(watch ?? []).map((w) => ({ id: `s-${w.symbol}`, group: "Werte" as const, label: w.symbol, hint: `${w.name}${w.held ? " · im Depot" : ""}`, keywords: [w.name], icon: <CandlestickChart className="size-4" />, run: go("/trade", { symbol: w.symbol }) })),
		];
	}, [ov, watch, proposals, actions, navigate]);

	// leere Eingabe: Module, Offenes und Aktionen zuerst, von den Werten nur ein paar
	const shown = useMemo(() => (q.trim() ? rank(entries, q, 40) : [...entries.filter((e) => e.group !== "Werte"), ...entries.filter((e) => e.group === "Werte").slice(0, 6)]), [entries, q]);
	useEffect(() => setActive(0), [q]);
	const current = shown[Math.min(active, shown.length - 1)];
	useEffect(() => {
		if (current) document.getElementById(`${listId}-${current.id}`)?.scrollIntoView({ block: "nearest" });
	}, [current, listId]);

	const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
		// IME: Eingabe beendet erst die Komposition, sie wählt nichts
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (shown.length) setActive((i) => (Math.min(i, shown.length - 1) + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
		} else if (e.key === "PageDown" || e.key === "PageUp") {
			e.preventDefault();
			setActive((i) => Math.max(0, Math.min(shown.length - 1, i + (e.key === "PageDown" ? 8 : -8))));
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (current) choose(current.run);
		} else if (e.key === "Tab") e.preventDefault(); // eine Tab-Stelle: das Feld
	};

	const grouped = !q.trim();
	return (
		<>
			<div className="flex items-center gap-2.5 border-b border-line px-4">
				<Search className="size-4 shrink-0 text-fg-3" aria-hidden />
				<input
					autoFocus
					role="combobox"
					aria-expanded
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
					aria-label="Befehl, Modul, Wert oder Depot suchen"
					placeholder="Modul, Wert, Depot oder Aktion…"
					className="my-1.5 h-9 min-w-0 flex-1 rounded-md bg-transparent px-1 text-[14px] placeholder:text-fg-3 max-sm:h-11"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					onKeyDown={onKey}
					spellCheck={false}
					autoComplete="off"
					data-testid="palette-input"
				/>
				<Kbd className="max-sm:hidden">Esc</Kbd>
			</div>
			<div ref={list} id={listId} role="listbox" aria-label="Treffer" className="scroll-thin min-h-0 flex-1 overflow-y-auto py-1.5" data-testid="palette-list">
				{shown.length === 0 && <div className="px-4 py-6 text-center text-[12.5px] text-fg-3">Nichts gefunden für „{q.trim()}“.</div>}
				{shown.map((e, i) => {
					const on = e === current;
					const head = grouped && (i === 0 || shown[i - 1].group !== e.group);
					return (
						<div key={e.id} role="presentation">
							{head && (
								<div className="px-4 pt-2.5 pb-1 text-[11px] font-medium text-fg-3" role="presentation">
									{GROUP_LABEL[e.group]}
								</div>
							)}
							<div
								id={`${listId}-${e.id}`}
								role="option"
								aria-selected={on}
								className={cn("mx-1.5 flex h-10 cursor-default items-center gap-3 rounded-lg px-2.5 max-sm:h-12", on ? "bg-surface-3 text-fg" : "text-fg-2")}
								onMouseMove={() => i !== active && setActive(i)}
								onMouseDown={(ev) => ev.preventDefault()}
								onClick={() => choose(e.run)}
								data-testid="palette-option"
								data-id={e.id}
							>
								<span className={cn("shrink-0", on ? "text-fg" : "text-fg-3")} aria-hidden>
									{e.icon}
								</span>
								<span className={cn("truncate", on && "font-medium")}>{e.label}</span>
								{e.hint && <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{e.hint}</span>}
								{!grouped && <span className="ml-auto shrink-0 text-[11px] text-fg-3 max-sm:hidden">{GROUP_LABEL[e.group]}</span>}
								{on && (e.group === "Module" || e.group === "Werte" || e.group === "Depots" ? <ArrowRight className="size-3.5 shrink-0 text-fg-3" aria-hidden /> : <CornerDownLeft className="size-3.5 shrink-0 text-fg-3" aria-hidden />)}
							</div>
						</div>
					);
				})}
			</div>
			<div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-fg-3 max-sm:hidden">
				<span className="flex items-center gap-1">
					<Kbd>↑</Kbd>
					<Kbd>↓</Kbd> wählen
				</span>
				<span className="flex items-center gap-1">
					<Kbd>Eingabe</Kbd> öffnen
				</span>
				<span className="ml-auto flex items-center gap-1">
					<Kbd>Strg</Kbd>+<Kbd>K</Kbd> öffnet die Palette überall
				</span>
			</div>
		</>
	);
}
