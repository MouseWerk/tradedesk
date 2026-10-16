// Auswertung: wie gut du und die Agenten handeln. Eine Filterzeile (Depots, Zeitraum) gilt für alles darunter.
// Kennzahlen aus geschlossenen Trades (FIFO), Kurve und Drawdown aus den Tagesständen (Ergebnis = Wert − Einzahlungen,
// in zwei Feldern untereinander statt zwei Achsen), Kalender je Tag, R-Verteilung, Wochentag und Stunde, Tabellen.
// Jede Grafik hat eine Tabellenansicht; beim Filterwechsel bleiben die alten Zahlen gedimmt stehen, bis die neuen da sind.
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, ChartColumn, ChartSpline, Clock3, ListOrdered, Users } from "lucide-react";
import type { Analytics, EquityRange } from "@desk/shared";
import { R_EDGES, dayKey, rangeStart } from "@desk/shared";
import { useAnalytics, useOverview } from "@/lib/api";
import { dayLabel, duration, eur, num, pct, signedEur, signedEurShort, tone } from "@/lib/format";
import { ColumnChart, LineChart, type Column } from "@/ui/charts";
import { Button, Card, Empty, Field, Input, Segmented, Select, Skeleton, Stat, Table, cn, td, th } from "@/ui/kit";
import { LoadError } from "@/ui/boundary";
import { Page, PageHead } from "../common";
import { de } from "@/i18n/de";
import { DayCalendar, dayValue, type DayMode } from "./DayCalendar";
import { GroupTable, TradesTable, pfText, rText } from "./AnalyticsTables";

type Range = "1M" | "3M" | "YTD" | "1Y" | "all" | "custom";
const RANGES: { id: Range; label: string }[] = [
	{ id: "1M", label: de.analytics.ranges["1M"] },
	{ id: "3M", label: de.analytics.ranges["3M"] },
	{ id: "YTD", label: de.analytics.ranges.YTD },
	{ id: "1Y", label: de.analytics.ranges["1Y"] },
	{ id: "all", label: de.analytics.ranges.all },
	{ id: "custom", label: de.analytics.ranges.custom },
];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY = de.analytics.weekdays;

const KPIS = "grid grid-cols-6 gap-3 @max-[1250px]:grid-cols-3 @max-[560px]:grid-cols-2";
const PAIR = "grid grid-cols-2 items-start gap-4 @max-[1000px]:grid-cols-1";

/** Zeitraum → from/to für die API; ein eigener Zeitraum nur mit gültigen Tagen in der richtigen Reihenfolge. */
function rangeWindow(range: Range, today: string, from?: string, to?: string): { from: string | null; to: string | null; error: string | null } {
	if (range === "all") return { from: null, to: null, error: null };
	if (range === "YTD") return { from: `${today.slice(0, 4)}-01-01`, to: null, error: null };
	if (range !== "custom") return { from: rangeStart(today, range as Exclude<EquityRange, "all" | "1W" | "YTD">), to: null, error: null };
	const f = from && DAY.test(from) ? from : null;
	const t = to && DAY.test(to) ? to : null;
	if (f && t && f > t) return { from: f, to: t, error: de.analytics.fromAfterTo };
	return { from: f, to: t, error: null };
}

export default function AnalyticsView() {
	const search = useSearch({ strict: false }) as { account?: string; range?: string; from?: string; to?: string };
	const navigate = useNavigate();
	const { data: ov } = useOverview();
	const scope = search.account ?? "mine";
	const range = (RANGES.some((r) => r.id === search.range) ? search.range : "3M") as Range;
	const today = dayKey(Date.now());
	const win = rangeWindow(range, today, search.from, search.to);
	const unknownAccount = !!ov && scope !== "mine" && scope !== "all" && !ov.accounts.some((a) => a.id === scope);
	const query = useAnalytics(unknownAccount ? "mine" : scope, win.error ? null : win.from, win.error ? null : win.to);
	const { data, error, refetch, isPlaceholderData } = query;
	const set = (p: Partial<{ account: string; range: Range; from: string; to: string }>) =>
		void navigate({ to: "/analytics", search: (s: Record<string, string | undefined>) => ({ ...s, ...p }), replace: true });

	const filters = (
		<div className="flex flex-wrap items-end gap-2" role="search" aria-label={de.analytics.filters} data-testid="analytics-filters">
			<Select aria-label={de.analytics.depots} value={unknownAccount ? "mine" : scope} onChange={(e) => set({ account: e.target.value })} className="w-56 max-sm:w-full" data-testid="analytics-account">
				<option value="mine">{de.analytics.yourDepots}</option>
				{ov?.accounts.map((a) => (
					<option key={a.id} value={a.id}>
						{a.owner === "user" ? a.name : de.analytics.agentDepot(a.name)}
					</option>
				))}
				<option value="all">{de.analytics.allDepots}</option>
			</Select>
			<Segmented label={de.analytics.range} items={RANGES} value={range} onChange={(r) => set(r === "custom" ? { range: r, from: search.from ?? win.from ?? rangeStart(today, "1M"), to: search.to ?? today } : { range: r })} />
			{range === "custom" && (
				<>
					<Field label={de.analytics.from} className="w-36" error={win.error}>
						{(id, a) => <Input id={id} {...a} type="date" value={search.from ?? ""} max={today} onChange={(e) => set({ from: e.target.value })} />}
					</Field>
					<Field label={de.analytics.to} className="w-36">
						{(id, a) => <Input id={id} {...a} type="date" value={search.to ?? ""} max={today} onChange={(e) => set({ to: e.target.value })} />}
					</Field>
				</>
			)}
		</div>
	);

	return (
		<Page>
			<PageHead title={de.analytics.title} sub={de.analytics.sub} />
			{filters}
			{unknownAccount && (
				<p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-fg-2" role="status">
					{de.analytics.unknownDepot(scope)}
				</p>
			)}
			{error && !data ? (
				<LoadError error={error} onRetry={() => void refetch()} />
			) : !data || !ov ? (
				<>
					<div className={KPIS}>
						{[0, 1, 2, 3, 4, 5].map((i) => (
							<Skeleton key={i} className="h-[92px]" />
						))}
					</div>
					<Skeleton className="h-[420px]" />
				</>
			) : (
				<div className={cn("flex flex-col gap-4 transition-opacity", isPlaceholderData && "opacity-60")} aria-busy={isPlaceholderData || undefined} data-testid="analytics">
					<Body data={data} user={ov.user} accounts={ov.accounts} onWider={range !== "all" ? () => set({ range: "all" }) : undefined} onAll={data.scope === "mine" ? () => set({ account: "all" }) : undefined} />
				</div>
			)}
		</Page>
	);
}

function Body({ data, user, accounts, onWider, onAll }: { data: Analytics; user: string; accounts: Parameters<typeof TradesTable>[0]["accounts"]; onWider?: () => void; onAll?: () => void }) {
	const s = data.stats;
	const first = data.curve[0];
	const last = data.curve.at(-1);
	const curveResult = first && last && data.curve.length > 1 ? last.resultCents - first.resultCents : null;
	const dd = data.maxDrawdown;
	const noTrades = data.tradesTotal === 0;
	const empty = (
		<div className="flex flex-col items-center gap-3 px-4 py-8 text-center" data-testid="analytics-empty">
			<p className="max-w-md text-[13px] text-fg-2">{de.analytics.empty}</p>
			<div className="flex flex-wrap justify-center gap-2">
				{onWider && <Button onClick={onWider}>{de.analytics.showAll}</Button>}
				{onAll && <Button onClick={onAll}>{de.analytics.withAgents}</Button>}
				<Link to="/trade" className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium text-fg-2 hover:bg-surface-3 hover:text-fg">
					{de.analytics.toTrading}
				</Link>
			</div>
		</div>
	);
	return (
		<>
			<div className={KPIS} data-testid="analytics-kpis">
				<Stat
					testId="kpi-result"
					label={de.analytics.kpi.result}
					value={<span className={tone(s.pnlCents)}>{signedEur(s.pnlCents)}</span>}
					sub={<span className="text-fg-3">{curveResult === null ? de.analytics.kpi.tradesFees(s.trades, eur(s.feesCents)) : <>{de.analytics.kpi.depotsTotal} <span className={tone(curveResult)}>{signedEur(curveResult)}</span> {de.analytics.kpi.inclOpen}</>}</span>}
				/>
				<Stat testId="kpi-winrate" label={de.analytics.kpi.winRate} value={s.winRate === null ? "–" : pct(s.winRate, { signed: false, digits: 0 })} sub={<span className="text-fg-3">{s.trades ? de.analytics.kpi.winsLosses(s.wins, s.losses) : de.analytics.kpi.noTradeYet}</span>} />
				<Stat testId="kpi-pf" label={de.analytics.col.profitFactor} value={s.trades ? pfText(s) : "–"} sub={<span className="text-fg-3">{s.trades ? de.analytics.kpi.pfSub(eur(s.grossProfitCents, { short: true }), eur(-s.grossLossCents, { short: true })) : de.analytics.kpi.pfHint}</span>} />
				<Stat
					testId="kpi-expectancy"
					label={de.analytics.kpi.expectancy}
					value={<span className={tone(s.expectancyCents)}>{s.expectancyCents === null ? "–" : signedEur(s.expectancyCents)}</span>}
					sub={<span className="text-fg-3">{s.expectancyR === null ? de.analytics.kpi.noRTrade : de.analytics.kpi.expectancyR(rText(s.expectancyR), s.rTrades, s.trades)}</span>}
				/>
				<Stat
					testId="kpi-drawdown"
					label={de.analytics.kpi.drawdown}
					value={<span className={dd ? "text-err" : ""}>{dd ? signedEur(dd.cents) : "–"}</span>}
					sub={<span className="text-fg-3">{dd ? de.analytics.kpi.ddSub(pct(dd.pct), dayLabel(dd.peakDay), dayLabel(dd.troughDay), dd.recoveryDay ? dayLabel(dd.recoveryDay) : null) : data.curve.length > 1 ? de.analytics.kpi.noDecline : de.analytics.kpi.needsTwoDays}</span>}
				/>
				<Stat testId="kpi-hold" label={de.analytics.col.avgHold} value={duration(s.avgHoldMs)} sub={<span className="text-fg-3">{s.avgWinCents !== null || s.avgLossCents !== null ? de.analytics.kpi.avgWinLoss(s.avgWinCents === null ? "–" : eur(s.avgWinCents, { short: true }), s.avgLossCents === null ? "–" : eur(s.avgLossCents, { short: true })) : de.analytics.kpi.holdHint}</span>} />
			</div>
			<CurveCard data={data} />
			<div className={PAIR}>
				<DaysCard data={data} />
				<RCard data={data} noTrades={noTrades} empty={empty} />
			</div>
			{noTrades ? (
				<Card title={de.analytics.col.trades} icon={<ListOrdered className="size-4" />} pad={false}>
					{empty}
				</Card>
			) : (
				<>
					<div className={PAIR}>
						<TimeCard data={data} kind="weekday" />
						<TimeCard data={data} kind="hour" />
					</div>
					<div className={PAIR}>
						<Card title={de.analytics.byAuthor} icon={<Users className="size-4" />} pad={false} aside={de.analytics.byAuthorAside}>
							<GroupTable rows={data.byAuthor} label={de.analytics.col.author} testId="by-author" name={(r) => ({ title: r.author === user ? de.analytics.you(user) : r.author, sub: r.author === user ? de.analytics.ownDecisions : de.analytics.agent })} />
						</Card>
						<Card title={de.analytics.bySymbol} icon={<ChartColumn className="size-4" />} pad={false} aside={de.scanner.values(data.bySymbol.length)}>
							<GroupTable rows={data.bySymbol} label={de.analytics.col.symbol} testId="by-symbol" name={(r) => ({ title: r.symbol, sub: r.name, to: "/trade" })} />
						</Card>
					</div>
					<Card title={de.analytics.closedTrades} icon={<ListOrdered className="size-4" />} pad={false} aside={de.analytics.inRange(data.tradesTotal)}>
						<TradesTable trades={data.trades} total={data.tradesTotal} accounts={accounts} />
					</Card>
				</>
			)}
		</>
	);
}

type View = "chart" | "table";
const VIEWS: { id: View; label: string }[] = [
	{ id: "chart", label: de.analytics.views.chart },
	{ id: "table", label: de.analytics.views.table },
];
function ViewSwitch({ value, onChange, label }: { value: View; onChange: (v: View) => void; label: string }) {
	return <Segmented label={de.analytics.viewSwitch(label)} items={VIEWS} value={value} onChange={onChange} />;
}

function CurveCard({ data }: { data: Analytics }) {
	const [view, setView] = useState<View>("chart");
	const [cursor, setCursor] = useState<number | null>(null);
	const c = data.curve;
	const base = c[0]?.resultCents ?? 0;
	return (
		<Card title={de.analytics.curve.title} icon={<ChartSpline className="size-4" />} aside={<ViewSwitch value={view} onChange={setView} label={de.analytics.curve.title} />} label={de.analytics.curve.title}>
			{c.length < 2 ? (
				<Empty>{de.analytics.curve.empty}</Empty>
			) : view === "chart" ? (
				<div className="flex flex-col gap-1" data-testid="curve">
					<div className="text-[12px] text-fg-3">{de.analytics.curve.since(dayLabel(c[0].day))}</div>
					<LineChart
						label={de.analytics.curve.chartLabel(dayLabel(c[0].day))}
						xs={c.map((p) => p.day)}
						xLabel={dayLabel}
						series={[{ id: "result", label: de.analytics.col.result, color: "var(--fg)", values: c.map((p) => p.resultCents - base) }]}
						format={signedEurShort}
						baseline={0}
						area
						height={220}
						cursor={cursor}
						onCursor={setCursor}
					/>
					<div className="mt-2 text-[12px] text-fg-3">{de.analytics.curve.ddHint}</div>
					<LineChart
						label={de.analytics.curve.ddLabel}
						xs={c.map((p) => p.day)}
						xLabel={dayLabel}
						series={[{ id: "dd", label: de.analytics.col.drawdown, color: "var(--div-neg-3)", values: c.map((p) => p.drawdownCents) }]}
						format={signedEurShort}
						area
						areaTo={0}
						height={130}
						cursor={cursor}
						onCursor={setCursor}
					/>
				</div>
			) : (
				<div className="scroll-thin -mx-4 -mb-4 max-h-[360px] overflow-y-auto">
					<Table label={de.analytics.curve.table}>
						<thead>
							<tr>
								<th className={th}>{de.analytics.col.day}</th>
								<th className={cn(th, "text-right")}>{de.analytics.col.equity}</th>
								<th className={cn(th, "text-right")}>{de.analytics.col.result}</th>
								<th className={cn(th, "text-right")}>{de.analytics.col.drawdown}</th>
							</tr>
						</thead>
						<tbody>
							{[...c].reverse().map((p) => (
								<tr key={p.day}>
									<td className={cn(td, "tnum")}>{dayLabel(p.day)}</td>
									<td className={cn(td, "text-right tnum")}>{eur(p.equityCents)}</td>
									<td className={cn(td, "text-right tnum", tone(p.resultCents - base))}>{signedEur(p.resultCents - base)}</td>
									<td className={cn(td, "text-right tnum", p.drawdownCents < 0 && "text-err")}>
										{p.drawdownCents ? `${signedEur(p.drawdownCents)} (${pct(p.drawdownPct)})` : "–"}
									</td>
								</tr>
							))}
						</tbody>
					</Table>
				</div>
			)}
		</Card>
	);
}

function DaysCard({ data }: { data: Analytics }) {
	const [view, setView] = useState<View>("chart");
	const [mode, setMode] = useState<DayMode>("result");
	const from = data.from ?? data.days[0]?.day ?? data.curve[0]?.day ?? data.to;
	// höchstens die letzten 24 Monate im Kalender; die Tabelle zeigt alles
	const shownFrom = from < monthsBack(data.to, 23) ? monthsBack(data.to, 23) : from;
	const rows = useMemo(() => [...data.days].reverse().filter((d) => dayValue(d, mode) !== null || d.trades > 0), [data.days, mode]);
	return (
		<Card
			title={de.analytics.days.title}
			icon={<CalendarDays className="size-4" />}
			label={de.analytics.days.title}
			aside={
				<>
					<Segmented label={de.analytics.days.valuePerDay} items={[{ id: "result", label: de.analytics.days.total }, { id: "realized", label: de.analytics.col.realized }]} value={mode} onChange={setMode} />
					<ViewSwitch value={view} onChange={setView} label={de.analytics.days.title} />
				</>
			}
		>
			{!data.days.length ? (
				<Empty>{de.analytics.days.empty}</Empty>
			) : view === "chart" ? (
				<>
					<DayCalendar days={data.days} from={shownFrom} to={data.to} mode={mode} />
					{shownFrom !== from && <p className="mt-2 text-[11.5px] text-fg-3">{de.analytics.days.calendarCut}</p>}
				</>
			) : (
				<div className="scroll-thin -mx-4 -mb-4 max-h-[360px] overflow-y-auto">
					<Table label={de.analytics.days.title}>
						<thead>
							<tr>
								<th className={th}>{de.analytics.col.day}</th>
								<th className={cn(th, "text-right")}>{mode === "result" ? de.analytics.col.result : de.analytics.col.realized}</th>
								<th className={cn(th, "text-right")}>{de.analytics.col.trades}</th>
								<th className={cn(th, "text-right")}>{mode === "result" ? de.analytics.col.realized : de.analytics.col.result}</th>
							</tr>
						</thead>
						<tbody data-testid="day-table">
							{rows.map((d) => {
								const v = dayValue(d, mode);
								const other = mode === "result" ? d.realizedCents : d.resultCents;
								return (
									<tr key={d.day}>
										<td className={cn(td, "tnum")}>
											{WEEKDAY[(new Date(`${d.day}T12:00:00`).getDay() + 6) % 7].slice(0, 2)}, {dayLabel(d.day)}
										</td>
										<td className={cn(td, "text-right font-medium tnum", tone(v))}>{v === null ? "–" : signedEur(v)}</td>
										<td className={cn(td, "text-right tnum")}>{d.trades || "–"}</td>
										<td className={cn(td, "text-right tnum text-fg-2")}>{other === null ? "–" : signedEur(other)}</td>
									</tr>
								);
							})}
						</tbody>
					</Table>
				</div>
			)}
		</Card>
	);
}

function monthsBack(day: string, n: number): string {
	const [y, m] = day.split("-").map(Number);
	const t = y * 12 + (m - 1) - n;
	return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
}

const polarity = (v: number) => (v > 0 ? "var(--div-pos-3)" : "var(--div-neg-3)");

function rLabel(from: number | null, to: number | null): string {
	const f = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v)}`;
	if (from === null) return `≤${f(to!)}`;
	if (to === null) return `>${f(from)}`;
	return `${f(from)}…${f(to)}`;
}

function RCard({ data, noTrades, empty }: { data: Analytics; noTrades: boolean; empty: ReactNode }) {
	const [view, setView] = useState<View>("chart");
	const s = data.stats;
	const columns: Column[] = data.rBuckets.map((b, i) => ({
		key: String(i),
		label: rLabel(b.from, b.to),
		value: b.trades,
		color: b.to !== null && b.to <= 0 ? "var(--div-neg-3)" : "var(--div-pos-3)", // R ≤ 0: Verlust
		tip: (
			<>
				<div className="mb-1 text-fg-3">{b.from === null ? de.analytics.rDist.upTo(num(b.to!, 0)) : b.to === null ? de.analytics.rDist.above(num(b.from, 0)) : de.analytics.rDist.between(num(b.from, 0), num(b.to, 0))}</div>
				<div className="font-semibold tnum">{de.analytics.trades(b.trades)}</div>
				<div className={cn("tnum", tone(b.pnlCents))}>{signedEur(b.pnlCents)}</div>
			</>
		),
	}));
	return (
		<Card title={de.analytics.rDist.title} icon={<ChartColumn className="size-4" />} label={de.analytics.rDist.title} aside={s.rTrades > 0 && <ViewSwitch value={view} onChange={setView} label={de.analytics.rDist.title} />}>
			{noTrades ? (
				empty
			) : s.rTrades === 0 ? (
				<Empty>{de.analytics.rDist.noStop(s.trades)}</Empty>
			) : view === "chart" ? (
				<>
					<ColumnChart columns={columns} format={(v) => num(v, 0)} valueLabels height={220} label={de.analytics.rDist.chartLabel(s.rTrades, R_EDGES.join(", "))} testId="r-chart" />
					<p className="mt-2 text-[12px] text-fg-3 tnum">
						{de.analytics.rDist.note(de.analytics.withStop(s.rTrades, s.trades), rText(s.expectancyR))}
					</p>
				</>
			) : (
				<div className="-mx-4 -mb-4">
					<Table label={de.analytics.rDist.title}>
						<thead>
							<tr>
								<th className={th}>{de.analytics.r}</th>
								<th className={cn(th, "text-right")}>{de.analytics.col.trades}</th>
								<th className={cn(th, "text-right")}>{de.analytics.col.result}</th>
							</tr>
						</thead>
						<tbody>
							{data.rBuckets.map((b, i) => (
								<tr key={i}>
									<td className={cn(td, "tnum")}>{rLabel(b.from, b.to)}</td>
									<td className={cn(td, "text-right tnum")}>{b.trades}</td>
									<td className={cn(td, "text-right tnum", tone(b.pnlCents))}>{b.trades ? signedEur(b.pnlCents) : "–"}</td>
								</tr>
							))}
						</tbody>
					</Table>
				</div>
			)}
		</Card>
	);
}

function TimeCard({ data, kind }: { data: Analytics; kind: "weekday" | "hour" }) {
	const [view, setView] = useState<View>("chart");
	const title = de.analytics.time.title[kind];
	const rows = useMemo(() => {
		if (kind === "weekday") return data.byWeekday.filter((d) => d.weekday <= 5 || d.trades > 0).map((d) => ({ ...d, key: String(d.weekday), short: WEEKDAY[d.weekday - 1].slice(0, 2), long: WEEKDAY[d.weekday - 1] }));
		const used = data.byHour.filter((h) => h.trades > 0).map((h) => h.hour);
		const lo = Math.min(8, ...used);
		const hi = Math.max(22, ...used);
		return data.byHour.filter((h) => h.hour >= lo && h.hour <= hi).map((h) => ({ ...h, key: String(h.hour), short: String(h.hour), long: de.analytics.time.hourRange(h.hour) }));
	}, [data, kind]);
	const columns: Column[] = rows.map((r) => ({
		key: r.key,
		label: r.short,
		value: r.pnlCents,
		color: polarity(r.pnlCents),
		tip: (
			<>
				<div className="mb-1 text-fg-3">{r.long}</div>
				<div className={cn("font-semibold tnum", tone(r.pnlCents))}>{r.trades ? signedEur(r.pnlCents) : de.analytics.time.noTrade}</div>
				{r.trades > 0 && (
					<div className="text-fg-2 tnum">
						{de.analytics.time.tradesHits(r.trades, pct(r.winRate, { signed: false, digits: 0 }))}
					</div>
				)}
			</>
		),
	}));
	return (
		<Card title={title} icon={kind === "weekday" ? <CalendarDays className="size-4" /> : <Clock3 className="size-4" />} label={de.analytics.time.result[kind]} aside={<ViewSwitch value={view} onChange={setView} label={title} />}>
			{view === "chart" ? (
				<>
					<ColumnChart columns={columns} format={signedEurShort} valueLabels={kind === "weekday"} height={200} label={de.analytics.time.chartLabel[kind]} testId={`${kind}-chart`} />
					<p className="mt-2 text-[12px] text-fg-3">{de.analytics.time.byEntry}</p>
				</>
			) : (
				<div className="-mx-4 -mb-4">
					<Table label={title}>
						<thead>
							<tr>
								<th className={th}>{kind === "weekday" ? de.analytics.col.day : de.analytics.col.hour}</th>
								<th className={cn(th, "text-right")}>{de.analytics.col.trades}</th>
								<th className={cn(th, "text-right")}>{de.analytics.col.hits}</th>
								<th className={cn(th, "text-right")}>{de.analytics.col.result}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.key}>
									<td className={td}>{r.long}</td>
									<td className={cn(td, "text-right tnum")}>{r.trades}</td>
									<td className={cn(td, "text-right tnum")}>{r.winRate === null ? "–" : pct(r.winRate, { signed: false, digits: 0 })}</td>
									<td className={cn(td, "text-right tnum", tone(r.pnlCents))}>{r.trades ? signedEur(r.pnlCents) : "–"}</td>
								</tr>
							))}
						</tbody>
					</Table>
				</div>
			)}
		</Card>
	);
}
