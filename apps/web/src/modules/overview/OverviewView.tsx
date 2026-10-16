// Übersicht: Handelszeiten und Not-Aus, dein Vermögen als große Zahl mit Zeitraum (Ergebnis ohne Ein- und
// Auszahlungen – das ist, was deine Entscheidungen gebracht haben; die reine Wertänderung steht daneben, wenn sie
// abweicht), Verlauf im selben Zeitraum, was auf dich wartet, Risiko der offenen Positionen, Aufteilung nach
// Anlageklasse (ein gestapelter Balken, Anteil am Ganzen) und nach Wert (Balken), alle Depots, Verlauf der Ereignisse.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Activity, ArrowRight, ChartPie, LineChart as LineIcon, ListChecks, OctagonX, ShieldAlert, ShieldCheck, Wallet } from "lucide-react";
import type { AccountSummary, Allocation, AssetClass, Cockpit, EquityChange, EquityRange, Overview } from "@desk/shared";
import { useCockpit, useOverview, useProposals } from "@/lib/api";
import { ago, dateTime, dayLabel, eur, pct, price, signedEur, tone } from "@/lib/format";
import { LineChart } from "@/ui/charts";
import { Badge, Card, Empty, Segmented, Skeleton, Table, cn, hideBelow, td, th } from "@/ui/kit";
import { LoadError } from "@/ui/boundary";
import { Page, PageHead, ProposalRow, needsYou } from "../common";
import { Sessions } from "../trade/parts";
import { de } from "@/i18n/de";

const SHOWN = 5;
const ROW = "grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4 @max-[1100px]:grid-cols-1";
const RANGE_KEY = "desk.overviewRange";
const RANGES: { id: EquityRange; label: string; long: string }[] = (["1W", "1M", "3M", "YTD", "1Y", "all"] as const).map((id) => ({ id, label: de.overview.range[id].label, long: de.overview.range[id].long }));

/** Farbe folgt der Anlageklasse, nie dem Rang: feste Reihenfolge der validierten Reihen, Cash neutral. */
export const CLASS_META: Record<AssetClass, { label: string; color: string }> = {
	equity: { label: de.overview.assetClass.equity, color: "var(--series-1)" },
	etf: { label: de.overview.assetClass.etf, color: "var(--series-2)" },
	crypto: { label: de.overview.assetClass.crypto, color: "var(--series-3)" },
	cash: { label: de.overview.assetClass.cash, color: "var(--fg-3)" },
	other: { label: de.overview.assetClass.other, color: "var(--series-4)" },
};

function kindLabel(a: AccountSummary): string {
	if (a.owner !== "user") return de.portfolio.agentPaperDepot(a.owner);
	if (a.kind === "paper") return de.common.paperDepot;
	if (a.kind === "manual") return de.overview.accounts.manual(a.broker);
	return de.overview.accounts.broker(a.broker, a.live ? de.common.liveMoney : de.common.paperAccount);
}

function storedRange(): EquityRange {
	try {
		const v = localStorage.getItem(RANGE_KEY);
		return RANGES.some((r) => r.id === v) ? (v as EquityRange) : "1M";
	} catch {
		return "1M";
	}
}

export default function OverviewView() {
	const { data, error, refetch } = useOverview();
	const { data: proposals } = useProposals();
	const { data: cockpit } = useCockpit();
	if (error && !data)
		return (
			<Page>
				<LoadError error={error} onRetry={() => void refetch()} />
			</Page>
		);
	if (!data)
		return (
			<Page>
				<Skeleton className="h-[45px] w-64" />
				<Skeleton className="h-[42px]" />
				<div className={ROW}>
					<Skeleton className="h-[420px]" />
					<Skeleton className="h-[420px]" />
				</div>
			</Page>
		);
	const mine = data.accounts.filter((a) => a.owner === "user");
	const waiting = (proposals ?? []).filter((p) => needsYou(p, data.accounts));
	const missing = [...new Set(mine.flatMap((a) => a.missingQuotes))];

	return (
		<Page>
			<PageHead title={de.overview.greeting(data.user)} sub={de.overview.sub(mine.length, data.accounts.length - mine.length, ago(data.quotesAt))} />
			<div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-[var(--shadow)]" aria-label={de.overview.sessionLabel} data-testid="overview-session">
				{data.killSwitch ? (
					<Link to="/risk" className="flex items-center gap-1.5 text-[12.5px] font-medium text-err">
						<OctagonX className="size-3.5" aria-hidden />
						{de.overview.killOn}
					</Link>
				) : (
					<span className="flex items-center gap-1.5 text-[12.5px] text-fg-2">
						<ShieldCheck className="size-3.5 text-ok" aria-hidden />
						{de.overview.tradingActive}
					</span>
				)}
				{cockpit ? <Sessions cockpit={cockpit} /> : <span className="text-[12.5px] text-fg-3">{de.overview.sessionsLoading}</span>}
			</div>
			{data.market === "error" && (
				<p className="rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-warn" role="alert">
					{de.overview.marketError(data.marketError ?? "")}
				</p>
			)}
			<div className={ROW}>
				<Wealth data={data} />
				<div className="flex min-w-0 flex-col gap-4">
					<Card
						title={de.overview.waiting.title}
						icon={<ListChecks className="size-4" />}
						label={de.overview.waiting.label(waiting.length)}
						aside={
							<>
								<span className={cn("font-semibold tnum", waiting.length ? "text-warn" : "text-fg-2")} data-testid="waiting-count">
									{proposals ? waiting.length : "–"}
								</span>
								<Link to="/orders" className="-mr-2 inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-surface-3 hover:text-fg">
									{de.overview.waiting.all} <ArrowRight className="size-3.5" aria-hidden />
								</Link>
							</>
						}
						pad={false}
					>
						{!proposals ? (
							<div className="flex flex-col gap-2 p-4">
								<Skeleton className="h-10" />
								<Skeleton className="h-10" />
							</div>
						) : waiting.length ? (
							<ul className="divide-y divide-line" data-testid="overview-waiting">
								{waiting.slice(0, SHOWN).map((p) => (
									<ProposalRow key={p.id} p={p} accounts={data.accounts} />
								))}
								{waiting.length > SHOWN && (
									<li className="px-4 py-2.5 text-[12.5px]">
										<Link to="/orders" className="text-fg-2 underline underline-offset-2 hover:text-fg" data-testid="overview-more">
											{de.overview.waiting.more(waiting.length - SHOWN, waiting.length)}
										</Link>
									</li>
								)}
							</ul>
						) : (
							<Empty>{de.overview.waiting.empty}</Empty>
						)}
					</Card>
					<RiskBlock cockpit={cockpit} />
				</div>
			</div>
			{missing.length > 0 && (
				<p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-fg-2">
					{de.overview.missingQuotes(missing.join(", "))}
				</p>
			)}
			<AllocationCard allocation={data.allocation} />
			<div className={ROW}>
				<Card title={de.portfolio.title} icon={<Wallet className="size-4" />} pad={false}>
					<Table label={de.portfolio.title}>
						<thead>
							<tr>
								<th className={th}>{de.overview.accounts.account}</th>
								<th className={cn(th, "text-right")}>{de.portfolio.positions.value}</th>
								<th className={cn(th, "text-right", hideBelow.md)}>{de.portfolio.stat.cash}</th>
								<th className={cn(th, "text-right")}>{de.portfolio.positions.today}</th>
								<th className={cn(th, "text-right", hideBelow.sm)}>{de.overview.accounts.total}</th>
							</tr>
						</thead>
						<tbody>
							{data.accounts.map((a) => (
								<tr key={a.id} className="hover:bg-surface-2">
									<td className={cn(td, "max-w-[220px] py-1.5 @max-[560px]/table:max-w-[130px]")}>
										<span className="flex min-w-0 flex-col leading-tight">
											<span className="flex min-w-0 items-center gap-2">
												<Link to="/portfolio" search={{ account: a.id }} className="truncate font-medium hover:underline" title={a.name}>
													{a.name}
												</Link>
												{a.live && <Badge variant="err">{de.common.liveMoney}</Badge>}
											</span>
											<span className="truncate text-[11.5px] text-fg-3">{kindLabel(a)}</span>
										</span>
									</td>
									<td className={cn(td, "text-right tnum")}>{eur(a.equityCents)}</td>
									<td className={cn(td, "text-right tnum text-fg-2", hideBelow.md)}>{eur(a.cashCents)}</td>
									<td className={cn(td, "text-right tnum", tone(a.dayChangeCents))}>{a.dayChangeCents === null ? "–" : signedEur(a.dayChangeCents)}</td>
									<td className={cn(td, "text-right tnum", tone(a.returnPct), hideBelow.sm)}>{pct(a.returnPct)}</td>
								</tr>
							))}
						</tbody>
					</Table>
				</Card>
				<Card title={de.portfolio.curve.title} icon={<Activity className="size-4" />} pad={false}>
					<ol className="scroll-thin flex max-h-[360px] flex-col overflow-y-auto py-1">
						{data.events.length ? (
							data.events.map((e) => (
								<li key={e.id} className="flex gap-3 px-4 py-2 text-[12.5px]">
									<span className="w-[84px] shrink-0 text-fg-3 tnum" title={dateTime(e.time)}>
										{ago(e.time)}
									</span>
									<span className="min-w-0 break-words text-fg-2">
										<span className="font-medium text-fg">{e.actor}</span> {e.text}
									</span>
								</li>
							))
						) : (
							<Empty>{de.overview.eventsEmpty}</Empty>
						)}
					</ol>
				</Card>
			</div>
		</Page>
	);
}

/** Vermögen als große Zahl, Ergebnis im gewählten Zeitraum, Kurve desselben Zeitraums, Heute/Gesamt/Cash darunter. */
function Wealth({ data }: { data: Overview }) {
	const [range, setRangeState] = useState<EquityRange>(storedRange);
	const setRange = (r: EquityRange) => {
		setRangeState(r);
		try {
			localStorage.setItem(RANGE_KEY, r);
		} catch {
			// privater Modus
		}
	};
	const mine = data.accounts.filter((a) => a.owner === "user");
	const equity = mine.reduce((s, a) => s + a.equityCents, 0);
	const deposits = mine.reduce((s, a) => s + a.depositsCents, 0);
	const cash = mine.reduce((s, a) => s + a.cashCents, 0);
	const hasDay = mine.some((a) => a.dayChangeCents !== null);
	const day = mine.reduce((s, a) => s + (a.dayChangeCents ?? 0), 0);
	const ch: EquityChange | undefined = data.changes.find((c) => c.range === range);
	const meta = RANGES.find((r) => r.id === range)!;
	const curve = ch?.fromDay ? data.curve.filter((p) => p.day >= ch.fromDay!) : data.curve;
	const first = data.curve[0]?.day;
	return (
		<Card
			title={de.overview.wealth.title}
			icon={<LineIcon className="size-4" />}
			aside={<Segmented label={de.overview.wealth.rangeLabel} items={RANGES} value={range} onChange={setRange} />}
			label={de.overview.wealth.label}
		>
			<div className="flex flex-wrap items-end gap-x-6 gap-y-2">
				<div className="min-w-0" data-testid="stat-equity">
					<div className="text-[12px] text-fg-3">{de.overview.wealth.total}</div>
					<div className="text-[40px] leading-[1.1] font-semibold tracking-tight whitespace-nowrap @max-[700px]:text-[30px]">{eur(equity)}</div>
				</div>
				<div className="min-w-0 pb-1" data-testid="overview-change">
					{ch && ch.resultCents !== null ? (
						<>
							<div className={cn("text-[17px] font-semibold whitespace-nowrap tnum", tone(ch.resultCents))}>
								{signedEur(ch.resultCents)} <span className="text-[14px] font-medium">({pct(ch.resultPct)})</span>
							</div>
							<div className="text-[12px] text-fg-3">
								{de.overview.wealth.result(meta.long, dayLabel(ch.fromDay!))}
								{ch.changeCents !== null && ch.changeCents !== ch.resultCents && de.overview.wealth.valueChange(signedEur(ch.changeCents))}
							</div>
						</>
					) : (
						<div className="text-[12.5px] text-fg-3">{first ? de.overview.wealth.noState(meta.long, dayLabel(first)) : de.overview.wealth.startsToday}</div>
					)}
				</div>
			</div>
			<div className="mt-3">
				{curve.length > 1 ? (
					<LineChart
						label={de.overview.wealth.chartLabel(meta.long)}
						xs={curve.map((p) => p.day)}
						xLabel={dayLabel}
						series={[{ id: "eq", label: de.overview.wealth.title, color: "var(--fg)", values: curve.map((p) => p.equityCents) }]}
						format={(v) => eur(v, { short: true })}
						area
						height={220}
					/>
				) : (
					<Empty>{de.overview.wealth.startsToday}</Empty>
				)}
			</div>
			<dl className="mt-3 grid grid-cols-3 gap-4 border-t border-line pt-3 text-[12.5px] @max-[560px]:grid-cols-1 @max-[560px]:gap-2">
				<div>
					<dt className="text-fg-3">{de.portfolio.positions.today}</dt>
					<dd className={cn("font-medium tnum", tone(day))}>{hasDay ? `${signedEur(day)} (${pct((day / Math.max(1, equity - day)) * 100)})` : de.overview.wealth.noPrevDay}</dd>
				</div>
				<div>
					<dt className="text-fg-3">{de.overview.wealth.sinceStart}</dt>
					<dd className="tnum">
						<span className={cn("font-medium", tone(equity - deposits))}>{signedEur(equity - deposits)}</span>
						<span className="text-fg-3">{de.overview.wealth.onDeposits(deposits ? pct(((equity - deposits) / deposits) * 100) : "–", eur(deposits, { short: true }))}</span>
					</dd>
				</div>
				<div>
					<dt className="text-fg-3">{de.portfolio.stat.cash}</dt>
					<dd className="tnum">
						<span className="font-medium">{eur(cash)}</span>
						<span className="text-fg-3"> · {equity > 0 ? pct((cash / equity) * 100, { signed: false, digits: 0 }) : "–"}</span>
					</dd>
				</div>
			</dl>
		</Card>
	);
}

/** Risiko der offenen Positionen deiner Depots: bis zu den Stops, Luft bis zum Tagesverlust-Stopp, was ohne Stop läuft. */
function RiskBlock({ cockpit }: { cockpit?: Cockpit }) {
	if (!cockpit)
		return (
			<Card title={de.overview.risk.title} icon={<ShieldAlert className="size-4" />}>
				<Skeleton className="h-24" />
			</Card>
		);
	const mineIds = new Set(cockpit.days.filter((d) => d.owner === "user").map((d) => d.accountId));
	const days = cockpit.days.filter((d) => mineIds.has(d.accountId));
	const pos = cockpit.positions.filter((p) => mineIds.has(p.accountId));
	const risk = days.reduce((s, d) => s + d.openRiskCents, 0);
	const equity = days.reduce((s, d) => s + d.equityCents, 0);
	const tight = days.filter((d) => d.dayLossHeadroomCents !== null).sort((a, b) => a.dayLossHeadroomCents! - b.dayLossHeadroomCents!)[0];
	const noStop = [...new Set(pos.filter((p) => p.stopLoss === null).map((p) => p.symbol))];
	// Abstand zum Stop in Wertpapierwährung (Stop steht dort), nächster zuerst
	const near = pos
		.filter((p) => p.stopLoss !== null && p.nativePrice)
		.map((p) => ({ p, dist: ((p.nativePrice! - p.stopLoss!) / p.nativePrice!) * 100 }))
		.sort((a, b) => a.dist - b.dist)
		.slice(0, 3);
	return (
		<Card
			title={de.overview.risk.title}
			icon={<ShieldAlert className="size-4" />}
			pad={false}
			aside={
				<Link to="/risk" className="-mr-2 inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-surface-3 hover:text-fg">
					{de.risk.title} <ArrowRight className="size-3.5" aria-hidden />
				</Link>
			}
		>
			<div className="flex flex-col gap-3 px-4 py-3 text-[12.5px]" data-testid="overview-risk">
				{pos.length === 0 ? (
					<p className="text-fg-3">{de.overview.risk.none}</p>
				) : (
					<>
						<dl className="grid grid-cols-2 gap-3">
							<div>
								<dt className="text-fg-3">{de.overview.risk.toStops}</dt>
								<dd className="font-medium tnum">
									{eur(risk)}
									<span className="font-normal text-fg-3"> · {equity > 0 ? pct((risk / equity) * 100, { signed: false, digits: 2 }) : "–"}</span>
								</dd>
							</div>
							<div>
								<dt className="text-fg-3">{de.overview.risk.toDayLoss}</dt>
								<dd className="font-medium tnum">{tight ? <span className={cn(tight.dayLossHeadroomCents === 0 && "text-err")}>{eur(tight.dayLossHeadroomCents!)}</span> : <span className="font-normal text-fg-3">{de.overview.risk.noLimit}</span>}</dd>
								{tight && <dd className="truncate text-[11.5px] text-fg-3">{tight.name}</dd>}
							</div>
						</dl>
						{noStop.length > 0 && (
							<p className="text-fg-2">
								<span className="font-medium text-fg">{de.overview.risk.noStop(noStop.length)}</span> {de.overview.risk.noStopAfter(noStop.join(", "))}
							</p>
						)}
						{near.length > 0 && (
							<ul className="flex flex-col gap-1.5" aria-label={de.overview.risk.nearest}>
								{near.map(({ p, dist }) => (
									<li key={`${p.accountId}-${p.symbol}`} className="flex items-baseline gap-2 tnum">
										<Link to="/trade" search={{ symbol: p.symbol }} className="font-medium hover:underline">
											{p.symbol}
										</Link>
										<span className="text-fg-3">{de.overview.risk.stop(price(p.stopLoss, p.currency))}</span>
										<span className="ml-auto text-fg-2">{de.overview.risk.toStop(pct(-dist, { digits: 1 }))}</span>
									</li>
								))}
							</ul>
						)}
					</>
				)}
			</div>
		</Card>
	);
}

/** Aufteilung: Anlageklassen als ein Balken (Teil des Ganzen, 2 px Lücke), Werte als Balken mit Betrag und Anteil. */
function AllocationCard({ allocation }: { allocation: Allocation }) {
	const classes = allocation.byClass.filter((c) => c.valueCents > 0);
	const top = allocation.bySymbol.slice(0, 8);
	const rest = allocation.bySymbol.slice(8);
	const restCents = rest.reduce((s, r) => s + r.valueCents, 0);
	const max = Math.max(1, ...top.map((r) => r.valueCents));
	const share = (p: number | null) => (p === null ? "–" : pct(p, { signed: false }));
	return (
		<Card title={de.overview.allocation.title} icon={<ChartPie className="size-4" />} label={de.overview.allocation.label} aside={de.overview.allocation.aside(eur(allocation.totalCents, { short: true }))}>
			{allocation.totalCents <= 0 ? (
				<Empty>{de.overview.allocation.empty}</Empty>
			) : (
				<div className="grid grid-cols-2 gap-x-8 gap-y-5 @max-[900px]:grid-cols-1">
					<section aria-label={de.overview.allocation.byClass} data-testid="allocation-class">
						<h3 className="mb-2 text-[12px] font-medium text-fg-3">{de.overview.allocation.byClass}</h3>
						<div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label={classes.map((c) => `${CLASS_META[c.assetClass].label} ${share(c.pct)}`).join(", ")}>
							{classes.map((c) => (
								<span key={c.assetClass} className="h-full min-w-[3px]" style={{ flexGrow: c.valueCents, flexBasis: 0, background: CLASS_META[c.assetClass].color }} title={`${CLASS_META[c.assetClass].label}: ${eur(c.valueCents)} (${share(c.pct)})`} />
							))}
						</div>
						<ul className="mt-3 flex flex-col gap-1.5 text-[12.5px]">
							{classes.map((c) => (
								<li key={c.assetClass} className="flex items-center gap-2 tnum">
									<span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: CLASS_META[c.assetClass].color }} aria-hidden />
									<span className="text-fg-2">{CLASS_META[c.assetClass].label}</span>
									<span className="ml-auto">{eur(c.valueCents)}</span>
									<span className="w-14 text-right text-fg-3">{share(c.pct)}</span>
								</li>
							))}
						</ul>
					</section>
					<section aria-label={de.overview.allocation.byValue} data-testid="allocation-symbol">
						<h3 className="mb-2 text-[12px] font-medium text-fg-3">{de.overview.allocation.byValueHeading}</h3>
						{top.length === 0 ? (
							<p className="text-[12.5px] text-fg-3">{de.overview.allocation.onlyCash}</p>
						) : (
							<ul className="flex flex-col gap-2 text-[12.5px]">
								{top.map((r) => (
									<li key={r.symbol} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-center gap-3 tnum @max-[560px]:grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)_auto]">
										<Link to="/trade" search={{ symbol: r.symbol }} className="truncate font-medium hover:underline" title={`${r.symbol} – ${r.name}`}>
											{r.symbol}
										</Link>
										<span className="h-2.5 min-w-0" aria-hidden>
											<span className="block h-full rounded-r-[4px]" style={{ width: `${Math.max(1.5, (r.valueCents / max) * 100)}%`, background: CLASS_META[r.assetClass].color }} />
										</span>
										<span className="text-right whitespace-nowrap">
											{eur(r.valueCents, { short: true })} <span className="inline-block w-12 text-fg-3">{share(r.pct)}</span>
										</span>
									</li>
								))}
								{rest.length > 0 && (
									<li className="text-fg-3 tnum">
										{de.overview.allocation.rest(rest.length, eur(restCents, { short: true }))}
									</li>
								)}
							</ul>
						)}
					</section>
				</div>
			)}
		</Card>
	);
}
