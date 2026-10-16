// Charts in SVG ohne Bibliothek: Linien (Vermögen, Vergleich) und Kerzen. Fadenkreuz rastet auf den nächsten Punkt,
// ein Tooltip zeigt alle Reihen; Pfeiltasten bewegen das Fadenkreuz (Fokus wie Maus). Raster und Achsen zurückhaltend,
// Text in Texttönen, Farbe nur in den Linien und Kerzenkörpern.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Candle } from "@desk/shared";
import { cn } from "./kit";
import { niceScale, tickCount } from "./scale";

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
	const ref = useRef<T>(null);
	const [w, setW] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
		ro.observe(el);
		setW(Math.floor(el.getBoundingClientRect().width));
		return () => ro.disconnect();
	}, []);
	return [ref, w];
}

export { niceTicks } from "./scale";

function useCursor(n: number) {
	const [idx, setIdx] = useState<number | null>(null);
	const onKey = (e: KeyboardEvent) => {
		if (!n) return;
		if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
			e.preventDefault();
			setIdx((i) => Math.max(0, Math.min(n - 1, (i ?? n - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
		} else if (e.key === "Home") setIdx(0);
		else if (e.key === "End") setIdx(n - 1);
		else if (e.key === "Escape") setIdx(null);
	};
	return { idx, setIdx, onKey };
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
	const left = x > width / 2;
	return (
		<div
			className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] shadow-[var(--shadow)]"
			style={left ? { right: width - x + 10 } : { left: x + 10 }}
			role="status"
		>
			{children}
		</div>
	);
}

export interface LineSeries {
	id: string;
	label: string;
	color: string; // CSS-Farbe, z. B. var(--series-1) oder var(--fg)
	values: (number | null)[]; // je x ein Wert
}

/** Liniendiagramm mit einer Achse. x sind Beschriftungen (Tage), alle Reihen teilen sie. */
export function LineChart({ xs, xLabel, series, format, height = 220, area = false, baseline, label, className }: {
	xs: string[];
	xLabel: (x: string) => string;
	series: LineSeries[];
	format: (v: number) => string;
	height?: number;
	area?: boolean;
	baseline?: number; // gestrichelte Bezugslinie (z. B. Einzahlungen, 0 %)
	label: string;
	className?: string;
}) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const { idx, setIdx, onKey } = useCursor(xs.length);
	const pad = { l: 8, r: 64, t: 10, b: 22 };
	const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
	if (baseline !== undefined) all.push(baseline);
	const iw = Math.max(1, width - pad.l - pad.r);
	const ih = height - pad.t - pad.b;
	const { lo, hi, ticks } = niceScale(Math.min(...all), Math.max(...all), tickCount(ih));
	const x = (i: number) => pad.l + (xs.length < 2 ? iw / 2 : (i / (xs.length - 1)) * iw);
	const y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
	const paths = series.map((s) => {
		let d = "";
		let started = false;
		s.values.forEach((v, i) => {
			if (v === null) {
				started = false;
				return;
			}
			d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
			started = true;
		});
		return d;
	});
	const labelIdx = xs.length > 1 ? [0, Math.round((xs.length - 1) / 2), xs.length - 1] : [0];
	const onMove = (e: React.PointerEvent) => {
		const r = (e.currentTarget as SVGElement).getBoundingClientRect();
		const rel = (e.clientX - r.left - pad.l) / iw;
		setIdx(Math.max(0, Math.min(xs.length - 1, Math.round(rel * (xs.length - 1)))));
	};
	return (
		<div ref={ref} className={cn("relative w-full select-none", className)} style={{ height }}>
			{width > 0 && xs.length > 0 && (
				<svg
					width={width}
					height={height}
					className="block touch-none outline-none focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
					role="img"
					aria-label={label}
					tabIndex={0}
					onKeyDown={onKey}
					onPointerMove={onMove}
					onPointerLeave={() => setIdx(null)}
					onBlur={() => setIdx(null)}
				>
					{ticks.map((t) => (
						<g key={t}>
							<line x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} stroke="var(--line)" />
							<text x={pad.l + iw + 6} y={y(t)} dy="0.32em" fontSize={11} fill="var(--fg-3)" className="tnum">
								{format(t)}
							</text>
						</g>
					))}
					{baseline !== undefined && <line x1={pad.l} x2={pad.l + iw} y1={y(baseline)} y2={y(baseline)} stroke="var(--fg-3)" strokeDasharray="3 3" />}
					{labelIdx.map((i, k) => (
						<text key={i} x={x(i)} y={height - 6} fontSize={11} fill="var(--fg-3)" textAnchor={k === 0 ? "start" : k === labelIdx.length - 1 ? "end" : "middle"}>
							{xLabel(xs[i])}
						</text>
					))}
					{series.map((s, si) => (
						<g key={s.id}>
							{area && series.length === 1 && <path d={`${paths[si]}L${x(xs.length - 1)},${pad.t + ih}L${x(0)},${pad.t + ih}Z`} fill={s.color} opacity={0.08} />}
							<path d={paths[si]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
						</g>
					))}
					{idx !== null && (
						<g>
							<line x1={x(idx)} x2={x(idx)} y1={pad.t} y2={pad.t + ih} stroke="var(--fg-3)" strokeWidth={1} />
							{series.map((s) => {
								const v = s.values[idx];
								return v === null ? null : <circle key={s.id} cx={x(idx)} cy={y(v)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />;
							})}
						</g>
					)}
				</svg>
			)}
			{idx !== null && width > 0 && (
				<Tooltip x={x(idx)} width={width}>
					<div className="mb-1 text-fg-3">{xLabel(xs[idx])}</div>
					{series.map((s) => (
						<div key={s.id} className="flex items-center gap-2">
							{series.length > 1 && <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />}
							<span className="font-semibold tnum">{s.values[idx] === null ? "–" : format(s.values[idx]!)}</span>
							{series.length > 1 && <span className="truncate text-fg-3">{s.label}</span>}
						</div>
					))}
				</Tooltip>
			)}
		</div>
	);
}

export interface RefLine {
	value: number;
	label: string;
}

export interface Overlay {
	id: string;
	label: string;
	color: string;
	values: (number | null)[]; // je Kerze
}

/**
 * Kerzenchart: Körper gefüllt (steigend ok, fallend err), Docht 1 px. Linien (EMA, VWAP) über den Kerzen, Volumen
 * als eigenes Feld darunter (eigene Skala, keine zweite Achse im Kursfeld). Hilfslinien z. B. Einstand, Limit, Stop.
 */
export function CandleChart({ candles, format, timeLabel, height = 320, refs = [], overlays = [], volume = false, label }: {
	candles: Candle[];
	format: (v: number) => string;
	timeLabel: (t: number, long?: boolean) => string;
	height?: number;
	refs?: RefLine[];
	overlays?: Overlay[];
	volume?: boolean;
	label: string;
}) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const { idx, setIdx, onKey } = useCursor(candles.length);
	const pad = { l: 8, r: 72, t: 12, b: 22 };
	const volH = volume ? Math.round(height * 0.16) : 0;
	const gap = volume ? 8 : 0;
	const overlayVals = overlays.flatMap((o) => o.values.filter((v): v is number => v !== null));
	const cLo = Math.min(...candles.map((c) => c.l), ...overlayVals);
	const cHi = Math.max(...candles.map((c) => c.h), ...overlayVals);
	// Hilfslinien dehnen die Skala nur, wenn sie nahe am Kursbereich liegen; weit entfernte stehen als Hinweis am Rand
	const near = (v: number) => v >= cLo - (cHi - cLo) * 0.35 && v <= cHi + (cHi - cLo) * 0.35;
	const visibleRefs = refs.filter((r) => r.value > 0 && near(r.value));
	const farRefs = refs.filter((r) => r.value > 0 && !near(r.value));
	const iw = Math.max(1, width - pad.l - pad.r);
	const ih = height - pad.t - pad.b - volH - gap;
	// bis zum nächsten Teilstrich über dem Hoch und unter dem Tief: jeder Kurs liegt zwischen zwei beschrifteten Werten
	const { lo, hi, ticks } = niceScale(Math.min(cLo, ...visibleRefs.map((r) => r.value)), Math.max(cHi, ...visibleRefs.map((r) => r.value)), tickCount(ih));
	const step = iw / Math.max(1, candles.length);
	const body = Math.max(1, Math.min(14, step - 2)); // 2 px Abstand zwischen Kerzen
	const x = (i: number) => pad.l + step * (i + 0.5);
	const y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
	const maxVol = Math.max(1, ...candles.map((c) => c.v));
	const volTop = pad.t + ih + gap;
	const labelIdx = candles.length > 1 ? [0, Math.round((candles.length - 1) / 2), candles.length - 1] : [0];
	const c = idx !== null ? candles[idx] : null;
	const line = (vals: (number | null)[]) => {
		let d = "";
		let on = false;
		vals.forEach((v, i) => {
			if (v === null) return void (on = false);
			d += `${on ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
			on = true;
		});
		return d;
	};
	return (
		<div ref={ref} className="relative w-full select-none" style={{ height }}>
			{width > 0 && candles.length > 0 && (
				<svg
					width={width}
					height={height}
					className="block touch-none outline-none focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
					role="img"
					aria-label={label}
					tabIndex={0}
					onKeyDown={onKey}
					onPointerMove={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						setIdx(Math.max(0, Math.min(candles.length - 1, Math.floor((e.clientX - r.left - pad.l) / step))));
					}}
					onPointerLeave={() => setIdx(null)}
					onBlur={() => setIdx(null)}
				>
					{ticks.map((t) => (
						<g key={t}>
							<line x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} stroke="var(--line)" />
							<text x={pad.l + iw + 6} y={y(t)} dy="0.32em" fontSize={11} fill="var(--fg-3)" className="tnum">
								{format(t)}
							</text>
						</g>
					))}
					{labelIdx.map((i, k) => (
						<text key={i} x={x(i)} y={height - 6} fontSize={11} fill="var(--fg-3)" textAnchor={k === 0 ? "start" : k === labelIdx.length - 1 ? "end" : "middle"}>
							{timeLabel(candles[i].t)}
						</text>
					))}
					{volume && (
						<g aria-hidden>
							<text x={pad.l + iw + 6} y={volTop + 9} fontSize={10.5} fill="var(--fg-3)">
								Volumen
							</text>
							{candles.map((k, i) => {
								const h = Math.max(1, (k.v / maxVol) * volH);
								return <rect key={k.t} x={x(i) - body / 2} y={volTop + volH - h} width={body} height={h} fill={k.c >= k.o ? "var(--ok)" : "var(--err)"} opacity={idx === i ? 0.7 : 0.3} />;
							})}
						</g>
					)}
					{candles.map((k, i) => {
						const up = k.c >= k.o;
						const top = y(Math.max(k.o, k.c));
						const h = Math.max(1, Math.abs(y(k.o) - y(k.c)));
						return (
							<g key={k.t} fill={up ? "var(--ok)" : "var(--err)"} opacity={idx === null || idx === i ? 1 : 0.55}>
								<rect x={x(i) - 0.5} y={y(k.h)} width={1} height={Math.max(1, y(k.l) - y(k.h))} />
								<rect x={x(i) - body / 2} y={top} width={body} height={h} rx={body >= 6 ? 1.5 : 0} />
							</g>
						);
					})}
					{overlays.map((o) => (
						<path key={o.id} d={line(o.values)} fill="none" stroke={o.color} strokeWidth={1.75} strokeLinejoin="round" />
					))}
					{visibleRefs.map((r, k) => (
						<g key={`${r.label}-${r.value}-${k}`}>
							<line x1={pad.l} x2={pad.l + iw} y1={y(r.value)} y2={y(r.value)} stroke="var(--fg-2)" strokeDasharray="4 3" />
							<text x={pad.l + 4} y={y(r.value) - 4} fontSize={11} fill="var(--fg-2)">
								{r.label} {format(r.value)}
							</text>
						</g>
					))}
					{farRefs.map((r, k) => {
						const above = r.value > hi;
						return (
							<text key={`${r.label}-${r.value}-${k}`} x={pad.l + iw - 4} y={pad.t + 12 + k * 14} fontSize={11} fill="var(--fg-2)" textAnchor="end">
								{r.label} {format(r.value)} ({above ? "außerhalb, höher" : "außerhalb, tiefer"})
							</text>
						);
					})}
					{idx !== null && <line x1={x(idx)} x2={x(idx)} y1={pad.t} y2={volume ? volTop + volH : pad.t + ih} stroke="var(--fg-3)" />}
				</svg>
			)}
			{c && idx !== null && (
				<Tooltip x={x(idx)} width={width}>
					<div className="mb-1 text-fg-3">{timeLabel(c.t, true)}</div>
					<div className="grid grid-cols-[auto_auto] gap-x-3 tnum">
						<span className="text-fg-3">Eröffnung</span>
						<span className="text-right">{format(c.o)}</span>
						<span className="text-fg-3">Hoch</span>
						<span className="text-right">{format(c.h)}</span>
						<span className="text-fg-3">Tief</span>
						<span className="text-right">{format(c.l)}</span>
						<span className="text-fg-3">Schluss</span>
						<span className="text-right font-semibold">{format(c.c)}</span>
						{volume && (
							<>
								<span className="text-fg-3">Volumen</span>
								<span className="text-right">{c.v.toLocaleString("de-DE")}</span>
							</>
						)}
						{overlays.map((o) =>
							o.values[idx] === null ? null : (
								<span key={o.id} className="contents">
									<span className="flex items-center gap-1.5 text-fg-3">
										<span className="h-0.5 w-3 rounded-full" style={{ background: o.color }} aria-hidden />
										{o.label}
									</span>
									<span className="text-right">{format(o.values[idx]!)}</span>
								</span>
							),
						)}
					</div>
				</Tooltip>
			)}
		</div>
	);
}

/** Kleine Verlaufslinie ohne Achsen (Watchlist, Agentenkarten); Wert steht immer daneben als Text. */
export function Sparkline({ values, className, color = "currentColor" }: { values: number[]; className?: string; color?: string }) {
	if (values.length < 2) return <div className={className} />;
	const w = 100;
	const h = 28;
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	const pts = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * w).toFixed(2)},${(h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4)).toFixed(2)}`).join(" ");
	return (
		<svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("overflow-visible", className)} aria-hidden>
			<path d={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
		</svg>
	);
}
