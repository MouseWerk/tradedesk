// Intraday-Chart: 1-Minuten-Kerzen (oder 5 Min., 1 Std., Tage) mit EMA 9/21, VWAP und Volumen, Linien für Einstand,
// Stop, Ziel, offene Limits und Alarme. Kennzahlen darüber, alles live im Takt des Desks.
import { useState } from "react";
import type { ChartRange, Cockpit, Proposal, ScanRow } from "@desk/shared";
import { dayKey, ema, vwap } from "@desk/shared";
import { useAnalysis, useChart, useWatchlist } from "@/lib/api";
import { compact, date, hhmm, num, pct, price, tone } from "@/lib/format";
import { CandleChart, type Overlay, type RefLine } from "@/ui/charts";
import { Card, Empty, Segmented, Skeleton } from "@/ui/kit";
import { RangeBar } from "./Scanner";
import { SessionDot, STATE_LABEL, exchangeLabel } from "./parts";

// kurze Beschriftung, damit alle fünf auch auf dem Handy passen; das Kerzenintervall steht in RANGE_LONG
const RANGES: { id: ChartRange; label: string }[] = [
	{ id: "1d", label: "1 T" },
	{ id: "5d", label: "5 T" },
	{ id: "1mo", label: "1 M" },
	{ id: "6mo", label: "6 M" },
	{ id: "1y", label: "1 J" },
];
const RANGE_LONG: Partial<Record<ChartRange, string>> = { "1d": "1 Tag, 1-Minuten-Kerzen", "5d": "5 Tage, 5-Minuten-Kerzen", "1mo": "1 Monat, Stundenkerzen", "6mo": "6 Monate, Tageskerzen", "1y": "1 Jahr, Tageskerzen" };

export function IntradayChart({ row, cockpit, proposals, small }: { row: ScanRow; cockpit: Cockpit; proposals: Proposal[]; small?: boolean }) {
	const [range, setRange] = useState<ChartRange>("1d");
	const intraday = range === "1d" || range === "5d";
	const { data: shown, isLoading, error } = useChart(row.symbol, range, range === "1d" ? cockpit.liveIntervalSec : undefined);
	// nie Kerzen oder Kennzahlen eines anderen Werts unter dieser Überschrift (beim Wechsel, solange die neuen laden)
	const chart = shown?.symbol === row.symbol ? shown : undefined;
	const { data: analysis } = useAnalysis(row.symbol);
	const a = analysis?.symbol === row.symbol ? analysis : undefined;
	const height = small ? 340 : 420;
	const { data: watch } = useWatchlist();
	const candles = chart?.candles ?? [];
	const closes = candles.map((c) => c.c);
	const overlays: Overlay[] = candles.length
		? [
				{ id: "ema9", label: "EMA 9", color: "var(--series-1)", values: ema(closes, 9) },
				{ id: "ema21", label: "EMA 21", color: "var(--series-5)", values: ema(closes, 21) },
				...(intraday ? [{ id: "vwap", label: "VWAP", color: "var(--series-4)", values: vwap(candles, dayKey) }] : []),
			]
		: [];
	const pos = cockpit.positions.filter((p) => p.symbol === row.symbol && cockpit.days.find((d) => d.accountId === p.accountId)?.owner === "user");
	const fx = row.price && pos[0]?.price ? pos[0].price / (pos[0].nativePrice ?? row.price) : 1;
	const refs: RefLine[] = [
		...pos.map((p) => ({ value: p.avgPrice / (fx || 1), label: "Einstand" })),
		...pos.filter((p) => p.stopLoss).map((p) => ({ value: p.stopLoss!, label: "Stop" })),
		...pos.filter((p) => p.takeProfit).map((p) => ({ value: p.takeProfit!, label: "Ziel" })),
		...proposals.filter((p) => p.symbol === row.symbol && p.status === "open" && p.limitPrice).map((p) => ({ value: p.limitPrice!, label: p.side === "buy" ? "Limit Kauf" : "Limit Verkauf" })),
		...(watch?.find((w) => w.symbol === row.symbol)?.alerts.filter((x) => !x.triggeredAt).map((x) => ({ value: x.price, label: x.op === "above" ? "Alarm über" : "Alarm unter" })) ?? []),
	];
	const lastOf = (o: Overlay) => [...o.values].reverse().find((v) => v !== null) ?? null;
	const fmt = (v: number) => price(v, row.currency);

	return (
		<Card pad={false} label={`Chart ${row.symbol}`}>
			<div className="flex flex-wrap items-end gap-x-5 gap-y-2 border-b border-line px-4 py-3">
				<div className="min-w-0">
					<h1 className="truncate text-[16px] font-semibold" title={row.name}>
						{row.symbol} <span className="font-normal text-fg-3">{row.name}</span>
					</h1>
					<p className="flex items-center gap-1.5 text-[12px] text-fg-3">
						<SessionDot state={row.state} />
						{exchangeLabel(row.exchange)} · {STATE_LABEL[row.state]} · Stand {hhmm(row.marketTime)}
					</p>
				</div>
				<div className="flex items-baseline gap-2 tnum">
					<span className="text-[24px] font-semibold" data-testid="quote-price">
						{price(row.price, row.currency)}
					</span>
					<span className={tone(row.changePct)}>{pct(row.changePct)}</span>
				</div>
				<dl className="flex min-w-0 basis-full flex-wrap gap-x-5 gap-y-1 text-[12px] tnum">
					<Kv k="Tag" v={`${num(row.dayLow)} – ${num(row.dayHigh)}`} extra={<RangeBar pos={row.rangePos} className="ml-2" />} />
					<Kv k="Gap" v={pct(row.gapPct)} />
					<Kv k="Volumen" v={`${compact(row.volume)}${row.relVolume ? ` · ${row.relVolume.toLocaleString("de-DE", { maximumFractionDigits: 1 })}×` : ""}`} />
					<Kv k="ATR 14" v={a?.atr14 ? `${num(a.atr14)} (${pct(row.atrPct, { signed: false })})` : "–"} />
					<Kv k="VWAP" v={num(a?.vwap)} hint={a?.vwap && row.price ? (row.price >= a.vwap ? "Kurs darüber" : "Kurs darunter") : undefined} />
					<Kv k="EMA 9 / 21" v={`${num(a?.ema9)} / ${num(a?.ema21)}`} hint={a?.ema9 && a.ema21 ? (a.ema9 >= a.ema21 ? "9 über 21" : "9 unter 21") : undefined} />
					<Kv k="RSI 14" v={a?.rsi14 === null || a?.rsi14 === undefined ? "–" : num(a.rsi14, 0)} hint={a?.rsi14 ? (a.rsi14 >= 70 ? "überkauft" : a.rsi14 <= 30 ? "überverkauft" : undefined) : undefined} />
					<Kv k="Vortag" v={num(a?.prevClose)} />
				</dl>
			</div>
			<div className="flex flex-wrap items-center gap-3 px-4 pt-3">
				<Segmented label="Zeitraum und Kerzen" items={RANGES} value={range} onChange={setRange} />
				<span className="text-[11.5px] whitespace-nowrap text-fg-3">{RANGE_LONG[range]}</span>
				<ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]" aria-label="Legende">
					{overlays.map((o) => (
						<li key={o.id} className="flex items-center gap-1.5">
							<span className="h-0.5 w-4 rounded-full" style={{ background: o.color }} aria-hidden />
							<span className="text-fg-2">{o.label}</span>
							<span className="font-medium tnum">{num(lastOf(o))}</span>
						</li>
					))}
				</ul>
			</div>
			<div className="p-3 pt-2">
				{(isLoading || (!chart && !error)) && !chart ? (
					<Skeleton className="w-full" style={{ height }} />
				) : error && !chart ? (
					<Empty className="grid place-items-center" style={{ height }}>
						{(error as Error).message}
					</Empty>
				) : candles.length ? (
					<CandleChart
						label={`Kursverlauf ${row.symbol}, ${RANGE_LONG[range]}`}
						candles={candles}
						overlays={overlays}
						volume
						refs={refs}
						format={fmt}
						timeLabel={(t, long) => (intraday ? (long ? `${date(t)} ${hhmm(t)}` : range === "5d" ? new Date(t).toLocaleDateString("de-DE", { weekday: "short" }) + " " + hhmm(t) : hhmm(t)) : date(t))}
						height={height}
					/>
				) : (
					<Empty className="grid place-items-center" style={{ height }}>Heute noch keine Kerzen – die Börse ist {STATE_LABEL[row.state].toLowerCase()}. Zeitraum „5 T“ zeigt die letzten Tage.</Empty>
				)}
			</div>
		</Card>
	);
}

function Kv({ k, v, hint, extra }: { k: string; v: string; hint?: string; extra?: React.ReactNode }) {
	return (
		<div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap" title={hint}>
			<dt className="text-fg-3">{k}</dt>
			<dd className="font-medium">{v}</dd>
			{hint && <dd className="text-fg-3">· {hint}</dd>}
			{extra}
		</div>
	);
}
