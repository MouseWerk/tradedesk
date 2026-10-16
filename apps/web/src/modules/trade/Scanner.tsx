// Scanner: Watchlist und Bestände, sortierbar nach Änderung, Gap, relativem Volumen und ATR. Die Sortierung liegt im
// Cockpit, damit Pfeil hoch/runter genau der Reihenfolge folgt, die du siehst. Eine Tab-Stelle für die ganze Liste.
import { useEffect, useRef } from "react";
import { Bell, Wallet } from "lucide-react";
import type { ScanRow } from "@desk/shared";
import { pct, price, tone } from "@/lib/format";
import { quoteLabel } from "@/lib/quotes";
import { Card, Segmented, cn } from "@/ui/kit";
import { SessionDot } from "./parts";

export type Sort = "change" | "gap" | "relvol" | "atr";

const val = (r: ScanRow, s: Sort) => (s === "change" ? Math.abs(r.changePct ?? 0) : s === "gap" ? Math.abs(r.gapPct ?? 0) : s === "relvol" ? (r.relVolume ?? 0) : (r.atrPct ?? 0));

/** Sichtbare Reihenfolge: stärkste Werte oben, bei Gleichstand alphabetisch (stabil zwischen zwei Ticks). */
export function sortRows(rows: ScanRow[], sort: Sort): ScanRow[] {
	return [...rows].sort((a, b) => val(b, sort) - val(a, sort) || a.symbol.localeCompare(b.symbol));
}

export function Scanner({ rows, sort, onSort, selected, onSelect, listClassName }: { rows: ScanRow[]; sort: Sort; onSort: (s: Sort) => void; selected?: string; onSelect: (s: string) => void; listClassName?: string }) {
	const list = useRef<HTMLUListElement>(null);
	// gewählte Zeile in der Liste sichtbar halten – nur die Liste scrollt, nicht die Seite
	useEffect(() => {
		const ul = list.current;
		const row = ul?.querySelector<HTMLElement>(`[data-symbol="${CSS.escape(selected ?? "")}"]`);
		if (!ul || !row) return;
		const top = row.offsetTop; // ul ist „relative“, also der offsetParent der Zeile
		if (top < ul.scrollTop) ul.scrollTop = top;
		else if (top + row.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = top + row.offsetHeight - ul.clientHeight;
	}, [selected, sort]);
	return (
		<Card title="Scanner" pad={false} aside={`${rows.length} Werte`} className="flex flex-col">
			<div className="border-b border-line px-3 py-2">
				<Segmented
					label="Sortieren nach"
					items={[{ id: "change", label: "Änderung" }, { id: "gap", label: "Gap" }, { id: "relvol", label: "Rel. Vol." }, { id: "atr", label: "ATR" }]}
					value={sort}
					onChange={onSort}
				/>
			</div>
			<ul ref={list} className={cn("scroll-thin relative max-h-[calc(100vh-260px)] min-h-40 overflow-y-auto py-1", listClassName)} aria-label="Werte im Scanner – Pfeil hoch und runter wechselt den Wert" data-scanner>
				{rows.map((r) => {
					const on = r.symbol === selected;
					const q = quoteLabel(r.quote, r.quoteStale);
					return (
						<li key={r.symbol}>
							<button
								type="button"
								onClick={() => onSelect(r.symbol)}
								aria-current={on ? "true" : undefined}
								tabIndex={on || (!selected && r === rows[0]) ? 0 : -1}
								className={cn("flex w-full flex-col gap-1 px-3 py-2 text-left", on ? "bg-surface-3" : "hover:bg-surface-2")}
								data-testid="scan-row"
								data-symbol={r.symbol}
							>
								<span className="flex w-full items-center gap-2">
									<SessionDot state={r.state} />
									<span className={cn("min-w-0 truncate", on ? "font-semibold" : "font-medium")} title={`${r.symbol} – ${r.name}`}>
										{r.symbol}
									</span>
									{r.held && <Wallet className="size-3 shrink-0 text-fg-3" aria-label="im Depot" />}
									{r.alerts > 0 && <Bell className="size-3 shrink-0 text-fg-3" aria-label="Alarm gesetzt" />}
									{/* Beträge brechen nie um; weichen muss das Symbol (mit Tooltip) */}
									{/* Herkunft und Alter im Tooltip; ein alter Kurs ist gedimmt (nie ein farbiger Rahmen) */}
									<span className={cn("ml-auto shrink-0 whitespace-nowrap tnum", q.stale && "text-fg-3")} title={q.title} data-testid="scan-price" data-stale={q.stale || undefined}>
										{price(r.price, r.currency)}
										{q.stale && <span className="sr-only"> (veraltet)</span>}
									</span>
									<span className={cn("w-[60px] shrink-0 text-right whitespace-nowrap tnum", q.stale ? "text-fg-3" : tone(r.changePct))}>{pct(r.changePct)}</span>
								</span>
								<span className="flex w-full items-center gap-3 text-[11px] whitespace-nowrap text-fg-3 tnum">
									<span title="Gap: Eröffnung gegen Vortagesschluss">Gap {pct(r.gapPct)}</span>
									<span title="Volumen gegen den Schnitt der letzten 20 Tage, zeitanteilig" className={cn((r.relVolume ?? 0) >= 2 && "font-semibold text-fg-2")}>
										RV {r.relVolume === null ? "–" : `${r.relVolume.toLocaleString("de-DE", { maximumFractionDigits: 1 })}×`}
									</span>
									<span title="Durchschnittliche Tagesspanne (ATR 14) in % des Kurses">ATR {pct(r.atrPct, { signed: false })}</span>
									<RangeBar pos={r.rangePos} />
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</Card>
	);
}

/** Lage im Tagesbereich: links Tagestief, rechts Tageshoch. */
export function RangeBar({ pos, className }: { pos: number | null; className?: string }) {
	if (pos === null) return <span className={cn("ml-auto w-14 shrink-0", className)} />;
	return (
		<span className={cn("relative ml-auto h-1.5 w-14 shrink-0 rounded-full bg-surface-3", className)} role="meter" aria-label="Lage im Tagesbereich" aria-valuenow={Math.round(pos * 100)} aria-valuemin={0} aria-valuemax={100} title={`${Math.round(pos * 100)} % zwischen Tagestief und -hoch`}>
			<span className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg" style={{ left: `${pos * 100}%` }} />
		</span>
	);
}
