// Scanner: Watchlist und Bestände, sortierbar nach Änderung, Gap, relativem Volumen und ATR.
import { useState } from "react";
import { Bell } from "lucide-react";
import type { ScanRow } from "@desk/shared";
import { pct, price, tone } from "@/lib/format";
import { Card, Segmented, cn } from "@/ui/kit";
import { SessionDot } from "./parts";

type Sort = "change" | "gap" | "relvol" | "atr";

const val = (r: ScanRow, s: Sort) => (s === "change" ? Math.abs(r.changePct ?? 0) : s === "gap" ? Math.abs(r.gapPct ?? 0) : s === "relvol" ? (r.relVolume ?? 0) : (r.atrPct ?? 0));

export function Scanner({ rows, selected, onSelect }: { rows: ScanRow[]; selected?: string; onSelect: (s: string) => void }) {
	const [sort, setSort] = useState<Sort>("change");
	const sorted = [...rows].sort((a, b) => val(b, sort) - val(a, sort));
	return (
		<Card title="Scanner" pad={false} aside={`${rows.length} Werte`} className="flex flex-col">
			<div className="border-b border-line px-3 py-2">
				<Segmented
					label="Sortieren nach"
					items={[{ id: "change", label: "Änderung" }, { id: "gap", label: "Gap" }, { id: "relvol", label: "Rel. Vol." }, { id: "atr", label: "ATR" }]}
					value={sort}
					onChange={setSort}
				/>
			</div>
			<ul className="scroll-thin max-h-[calc(100vh-260px)] min-h-40 overflow-y-auto py-1 @max-[900px]:max-h-80" aria-label="Werte im Scanner">
				{sorted.map((r) => {
					const on = r.symbol === selected;
					return (
						<li key={r.symbol}>
							<button
								type="button"
								onClick={() => onSelect(r.symbol)}
								aria-current={on ? "true" : undefined}
								className={cn("flex w-full flex-col gap-1 px-3 py-2 text-left", on ? "bg-surface-3" : "hover:bg-surface-2")}
								data-testid="scan-row"
							>
								<span className="flex w-full items-center gap-2">
									<SessionDot state={r.state} />
									<span className={cn("min-w-0 truncate", on ? "font-semibold" : "font-medium")} title={r.name}>
										{r.symbol}
									</span>
									{r.held && <span className="rounded bg-surface-3 px-1 text-[10px] text-fg-2">Depot</span>}
									{r.alerts > 0 && <Bell className="size-3 shrink-0 text-fg-3" aria-label="Alarm gesetzt" />}
									<span className="ml-auto tnum">{price(r.price, r.currency)}</span>
									<span className={cn("w-16 text-right tnum", tone(r.changePct))}>{pct(r.changePct)}</span>
								</span>
								<span className="flex w-full items-center gap-3 text-[11px] text-fg-3 tnum">
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
	if (pos === null) return <span className={cn("ml-auto w-14", className)} />;
	return (
		<span className={cn("relative ml-auto h-1.5 w-14 rounded-full bg-surface-3", className)} role="meter" aria-label="Lage im Tagesbereich" aria-valuenow={Math.round(pos * 100)} aria-valuemin={0} aria-valuemax={100} title={`${Math.round(pos * 100)} % zwischen Tagestief und -hoch`}>
			<span className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg" style={{ left: `${pos * 100}%` }} />
		</span>
	);
}
