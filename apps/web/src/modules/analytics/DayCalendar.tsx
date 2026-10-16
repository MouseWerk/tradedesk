// Kalender der Tagesergebnisse: ein Monat je Block (Mo–So), Farbe divergierend um eine neutrale Mitte (Gewinn petrol,
// Verlust rot, genau 0 grau, kein Tagesstand nur als Umriss). Werte nie nur über Farbe: Tooltip bei Hover und Tastatur
// (eine Tab-Stelle, Pfeiltasten wandern über die Tage), Monatssumme als Text, und die Tabellenansicht daneben.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DayResult } from "@desk/shared";
import { addDays, calendarMonths, heatScale, LEVELS, type HeatCell } from "@/lib/heatmap";
import { dayLabel, signedEur, signedEurShort, tone } from "@/lib/format";
import { cn } from "@/ui/kit";

export type DayMode = "result" | "realized";

const POS = ["bg-div-pos-1", "bg-div-pos-2", "bg-div-pos-3", "bg-div-pos-4"];
const NEG = ["bg-div-neg-1", "bg-div-neg-2", "bg-div-neg-3", "bg-div-neg-4"];
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const NO_DATA = "shadow-[inset_0_0_0_1px_var(--line-strong)]";

export function levelClass(cell: Pick<HeatCell, "value" | "level">): string {
	if (cell.value === null) return NO_DATA;
	if (cell.level === 0) return "bg-div-mid";
	return cell.level > 0 ? POS[cell.level - 1] : NEG[-cell.level - 1];
}

/** Wert eines Tages je Ansicht: Ergebnis (inkl. offener Positionen) oder nur realisiert. */
export function dayValue(d: DayResult, mode: DayMode): number | null {
	if (mode === "result") return d.resultCents;
	return d.trades > 0 || d.realizedCents !== 0 || d.resultCents !== null ? d.realizedCents : null;
}

const longDay = (day: string) => {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(y, m - 1, d).toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
};
const monthLabel = (y: number, m: number) => new Date(y, m - 1, 1).toLocaleDateString("de-DE", { month: "short", year: "numeric" });

export function DayCalendar({ days, from, to, mode }: { days: DayResult[]; from: string; to: string; mode: DayMode }) {
	const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
	const values = useMemo(() => new Map(days.map((d) => [d.day, dayValue(d, mode)])), [days, mode]);
	const months = useMemo(() => calendarMonths(values, from, to), [values, from, to]);
	const scale = useMemo(() => heatScale([...values.values()].filter((v): v is number => v !== null)), [values]);
	const box = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState<{ day: string; x: number; y: number } | null>(null);
	const show = (day: string) => {
		const el = box.current?.querySelector<HTMLElement>(`[data-day="${day}"]`);
		const b = box.current?.getBoundingClientRect();
		if (!el || !b) return setActive(null);
		const r = el.getBoundingClientRect();
		setActive({ day, x: r.left - b.left + r.width / 2, y: r.bottom - b.top });
	};
	const onKey = (e: KeyboardEvent) => {
		const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
		if (e.key === "Escape") return setActive(null);
		if (e.key === "Home" || e.key === "End") {
			e.preventDefault();
			return show(e.key === "Home" ? from : to);
		}
		if (step === undefined) return;
		e.preventDefault();
		const next = active ? addDays(active.day, step) : to;
		show(next < from ? from : next > to ? to : next);
	};
	const d = active ? byDay.get(active.day) : undefined;
	const v = active ? (values.get(active.day) ?? null) : null;
	const width = box.current?.clientWidth ?? 0;
	return (
		<div className="flex flex-col gap-3">
			<div
				ref={box}
				className="relative flex flex-wrap gap-x-6 gap-y-4 outline-none focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
				tabIndex={0}
				role="group"
				aria-label={`Kalender ${mode === "result" ? "Ergebnis" : "realisiertes Ergebnis"} je Tag, ${dayLabel(from)} bis ${dayLabel(to)} – Pfeiltasten wählen einen Tag`}
				onKeyDown={onKey}
				onBlur={() => setActive(null)}
				onPointerLeave={() => setActive(null)}
				data-testid="day-calendar"
			>
				{months.map((m) => (
					<div key={m.key} className="flex flex-col gap-1.5">
						<div className="flex items-baseline justify-between gap-2 text-[11.5px]">
							<span className="font-medium text-fg-2">{monthLabel(m.year, m.month)}</span>
							<span className={cn("tnum", tone(m.sum))}>{m.days ? signedEurShort(m.sum) : ""}</span>
						</div>
						<div className="grid grid-cols-[repeat(7,18px)] gap-[3px]" aria-hidden>
							{WEEKDAYS.map((w) => (
								<span key={w} className="text-center text-[10px] leading-4 text-fg-3">
									{w}
								</span>
							))}
							{m.weeks.flat().map((c, i) =>
								c ? (
									<span
										key={c.day}
										data-day={c.day}
										data-level={c.value === null ? "none" : c.level}
										data-testid="heat-cell"
										className={cn("size-[18px] rounded-[4px]", levelClass(c), active?.day === c.day && "outline-2 outline-offset-1 outline-[var(--fg-2)]")}
										onPointerEnter={() => show(c.day)}
										onPointerDown={() => show(c.day)}
									/>
								) : (
									<span key={`${m.key}-${i}`} className="size-[18px]" />
								),
							)}
						</div>
					</div>
				))}
				{active && (
					<div
						className="pointer-events-none absolute z-10 min-w-44 rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] shadow-[var(--shadow)]"
						style={{ top: active.y + 6, ...(active.x > width / 2 ? { right: Math.max(0, width - active.x - 20) } : { left: Math.max(0, active.x - 20) }) }}
						role="status"
						data-testid="heat-tip"
					>
						<div className="mb-1 text-fg-3">{longDay(active.day)}</div>
						{v === null ? (
							<div className="text-fg-2">{mode === "result" ? "Kein Tagesstand gespeichert" : "Kein Wert"}</div>
						) : (
							<div className="flex items-baseline gap-2">
								<span className={cn("font-semibold tnum", tone(v))}>{signedEur(v)}</span>
								<span className="text-fg-3">{mode === "result" ? "Ergebnis" : "realisiert"}</span>
							</div>
						)}
						{d && (d.trades > 0 || mode === "result") && (
							<div className="mt-0.5 text-fg-2 tnum">
								{d.trades === 0 ? "kein Trade geschlossen" : `${d.trades === 1 ? "1 Trade" : `${d.trades} Trades`} geschlossen, ${signedEur(d.realizedCents)}`}
							</div>
						)}
						{mode === "result" && d?.unrealizedChangeCents !== null && d?.unrealizedChangeCents !== undefined && <div className="text-fg-2 tnum">offene Positionen {signedEur(d.unrealizedChangeCents)}</div>}
						{mode === "result" && d?.sinceDay && d.sinceDay !== addDays(d.day, -1) && <div className="text-fg-3">seit dem Stand vom {dayLabel(d.sinceDay)}</div>}
					</div>
				)}
			</div>
			<Legend max={scale.max} />
		</div>
	);
}

function Legend({ max }: { max: number }) {
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-fg-3" aria-label="Legende">
			<span className="flex items-center gap-1.5">
				<span className="tnum">{max ? `${signedEurShort(-max)} und weniger` : "Verlust"}</span>
				<span className="flex gap-[3px]" aria-hidden>
					{[...NEG].reverse().map((c) => (
						<span key={c} className={cn("size-3 rounded-[3px]", c)} />
					))}
					<span className="size-3 rounded-[3px] bg-div-mid" />
					{POS.map((c) => (
						<span key={c} className={cn("size-3 rounded-[3px]", c)} />
					))}
				</span>
				<span className="tnum">{max ? `${signedEurShort(max)} und mehr` : "Gewinn"}</span>
			</span>
			<span className="flex items-center gap-1.5">
				<span className="size-3 rounded-[3px] bg-div-mid" aria-hidden />
				±0
			</span>
			<span className="flex items-center gap-1.5">
				<span className={cn("size-3 rounded-[3px]", NO_DATA)} aria-hidden />
				kein Tagesstand
			</span>
			<span className="sr-only">{LEVELS} Stufen je Richtung</span>
		</div>
	);
}
