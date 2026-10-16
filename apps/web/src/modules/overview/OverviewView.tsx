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

const SHOWN = 5;
const ROW = "grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4 @max-[1100px]:grid-cols-1";
const RANGE_KEY = "desk.overviewRange";
const RANGES: { id: EquityRange; label: string; long: string }[] = [
	{ id: "1W", label: "1W", long: "1 Woche" },
	{ id: "1M", label: "1M", long: "1 Monat" },
	{ id: "3M", label: "3M", long: "3 Monate" },
	{ id: "YTD", label: "YTD", long: "seit Jahresbeginn" },
	{ id: "1Y", label: "1J", long: "1 Jahr" },
	{ id: "all", label: "Alles", long: "seit Beginn" },
];

/** Farbe folgt der Anlageklasse, nie dem Rang: feste Reihenfolge der validierten Reihen, Cash neutral. */
export const CLASS_META: Record<AssetClass, { label: string; color: string }> = {
	equity: { label: "Aktien", color: "var(--series-1)" },
	etf: { label: "ETFs", color: "var(--series-2)" },
	crypto: { label: "Krypto", color: "var(--series-3)" },
	cash: { label: "Cash", color: "var(--fg-3)" },
	other: { label: "Sonstiges", color: "var(--series-4)" },
};

function kindLabel(a: AccountSummary): string {
	if (a.owner !== "user") return `Papierdepot von Agent ${a.owner}`;
	if (a.kind === "paper") return "Papierdepot";
	if (a.kind === "manual") return `${a.broker} · manuell`;
	return `${a.broker} · ${a.live ? "echtes Geld" : "Papierkonto"}`;
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
			<PageHead title={`Hallo ${data.user}`} sub={`${mine.length} eigene Depots, ${data.accounts.length - mine.length} Agenten-Papierdepots · Kurse ${ago(data.quotesAt)}`} />
			<div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-[var(--shadow)]" aria-label="Handel" data-testid="overview-session">
				{data.killSwitch ? (
					<Link to="/risk" className="flex items-center gap-1.5 text-[12.5px] font-medium text-err">
						<OctagonX className="size-3.5" aria-hidden />
						Not-Aus an
					</Link>
				) : (
					<span className="flex items-center gap-1.5 text-[12.5px] text-fg-2">
						<ShieldCheck className="size-3.5 text-ok" aria-hidden />
						Handel aktiv
					</span>
				)}
				{cockpit ? <Sessions cockpit={cockpit} /> : <span className="text-[12.5px] text-fg-3">Handelszeiten laden…</span>}
			</div>
			{data.market === "error" && (
				<p className="rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-warn" role="alert">
					Kurse konnten nicht geladen werden ({data.marketError}). Es gelten die letzten bekannten Kurse; der Desk versucht es jede Minute neu.
				</p>
			)}
			<div className={ROW}>
				<Wealth data={data} />
				<div className="flex min-w-0 flex-col gap-4">
					<Card
						title="Wartet auf dich"
						icon={<ListChecks className="size-4" />}
						label={`Wartet auf dich: ${waiting.length}`}
						aside={
							<>
								<span className={cn("font-semibold tnum", waiting.length ? "text-warn" : "text-fg-2")} data-testid="waiting-count">
									{proposals ? waiting.length : "–"}
								</span>
								<Link to="/orders" className="-mr-2 inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-surface-3 hover:text-fg">
									Alle <ArrowRight className="size-3.5" aria-hidden />
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
											{waiting.length - SHOWN === 1 ? "1 weiterer" : `${waiting.length - SHOWN} weitere`} – alle {waiting.length} unter Orders
										</Link>
									</li>
								)}
							</ul>
						) : (
							<Empty>Nichts offen. Agenten schlagen über cli/desk.py vor.</Empty>
						)}
					</Card>
					<RiskBlock cockpit={cockpit} />
				</div>
			</div>
			{missing.length > 0 && (
				<p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-fg-2">
					Ohne Kurs, zum Einstand bewertet: {missing.join(", ")}. Das Symbol in Yahoo-Schreibweise erfassen (z. B. SAP.DE), dann kommen Kurse.
				</p>
			)}
			<AllocationCard allocation={data.allocation} />
			<div className={ROW}>
				<Card title="Depots" icon={<Wallet className="size-4" />} pad={false}>
					<Table label="Depots">
						<thead>
							<tr>
								<th className={th}>Depot</th>
								<th className={cn(th, "text-right")}>Wert</th>
								<th className={cn(th, "text-right", hideBelow.md)}>Cash</th>
								<th className={cn(th, "text-right")}>Heute</th>
								<th className={cn(th, "text-right", hideBelow.sm)}>Gesamt</th>
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
												{a.live && <Badge variant="err">echtes Geld</Badge>}
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
				<Card title="Verlauf" icon={<Activity className="size-4" />} pad={false}>
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
							<Empty>Noch nichts passiert.</Empty>
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
			title="Vermögen"
			icon={<LineIcon className="size-4" />}
			aside={<Segmented label="Zeitraum" items={RANGES} value={range} onChange={setRange} />}
			label="Vermögen deiner Depots"
		>
			<div className="flex flex-wrap items-end gap-x-6 gap-y-2">
				<div className="min-w-0" data-testid="stat-equity">
					<div className="text-[12px] text-fg-3">Deine Depots zusammen</div>
					<div className="text-[40px] leading-[1.1] font-semibold tracking-tight whitespace-nowrap @max-[700px]:text-[30px]">{eur(equity)}</div>
				</div>
				<div className="min-w-0 pb-1" data-testid="overview-change">
					{ch && ch.resultCents !== null ? (
						<>
							<div className={cn("text-[17px] font-semibold whitespace-nowrap tnum", tone(ch.resultCents))}>
								{signedEur(ch.resultCents)} <span className="text-[14px] font-medium">({pct(ch.resultPct)})</span>
							</div>
							<div className="text-[12px] text-fg-3">
								Ergebnis {meta.long} · seit {dayLabel(ch.fromDay!)}, ohne Ein- und Auszahlungen
								{ch.changeCents !== null && ch.changeCents !== ch.resultCents && <> · Wert {signedEur(ch.changeCents)} inkl. Einzahlungen</>}
							</div>
						</>
					) : (
						<div className="text-[12.5px] text-fg-3">{first ? `Für „${meta.long}“ gibt es noch keinen Stand – der Verlauf beginnt am ${dayLabel(first)}.` : "Der Verlauf beginnt heute – ab morgen steht hier jeden Tag ein Punkt."}</div>
					)}
				</div>
			</div>
			<div className="mt-3">
				{curve.length > 1 ? (
					<LineChart
						label={`Vermögen deiner Depots je Tag, ${meta.long}`}
						xs={curve.map((p) => p.day)}
						xLabel={dayLabel}
						series={[{ id: "eq", label: "Vermögen", color: "var(--fg)", values: curve.map((p) => p.equityCents) }]}
						format={(v) => eur(v, { short: true })}
						area
						height={220}
					/>
				) : (
					<Empty>Der Verlauf beginnt heute – ab morgen steht hier jeden Tag ein Punkt.</Empty>
				)}
			</div>
			<dl className="mt-3 grid grid-cols-3 gap-4 border-t border-line pt-3 text-[12.5px] @max-[560px]:grid-cols-1 @max-[560px]:gap-2">
				<div>
					<dt className="text-fg-3">Heute</dt>
					<dd className={cn("font-medium tnum", tone(day))}>{hasDay ? `${signedEur(day)} (${pct((day / Math.max(1, equity - day)) * 100)})` : "ab morgen mit Vortag"}</dd>
				</div>
				<div>
					<dt className="text-fg-3">Gesamt seit Start</dt>
					<dd className="tnum">
						<span className={cn("font-medium", tone(equity - deposits))}>{signedEur(equity - deposits)}</span>
						<span className="text-fg-3"> · {deposits ? pct(((equity - deposits) / deposits) * 100) : "–"} auf {eur(deposits, { short: true })}</span>
					</dd>
				</div>
				<div>
					<dt className="text-fg-3">Cash</dt>
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
			<Card title="Offene Positionen" icon={<ShieldAlert className="size-4" />}>
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
			title="Offene Positionen"
			icon={<ShieldAlert className="size-4" />}
			pad={false}
			aside={
				<Link to="/risk" className="-mr-2 inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-surface-3 hover:text-fg">
					Risiko <ArrowRight className="size-3.5" aria-hidden />
				</Link>
			}
		>
			<div className="flex flex-col gap-3 px-4 py-3 text-[12.5px]" data-testid="overview-risk">
				{pos.length === 0 ? (
					<p className="text-fg-3">Keine offene Position in deinen Depots.</p>
				) : (
					<>
						<dl className="grid grid-cols-2 gap-3">
							<div>
								<dt className="text-fg-3">Risiko bis zu den Stops</dt>
								<dd className="font-medium tnum">
									{eur(risk)}
									<span className="font-normal text-fg-3"> · {equity > 0 ? pct((risk / equity) * 100, { signed: false, digits: 2 }) : "–"}</span>
								</dd>
							</div>
							<div>
								<dt className="text-fg-3">Bis zum Tagesverlust-Stopp</dt>
								<dd className="font-medium tnum">{tight ? <span className={cn(tight.dayLossHeadroomCents === 0 && "text-err")}>{eur(tight.dayLossHeadroomCents!)}</span> : <span className="font-normal text-fg-3">keine Grenze</span>}</dd>
								{tight && <dd className="truncate text-[11.5px] text-fg-3">{tight.name}</dd>}
							</div>
						</dl>
						{noStop.length > 0 && (
							<p className="text-fg-2">
								<span className="font-medium text-fg">{noStop.length === 1 ? "1 Wert ohne Stop" : `${noStop.length} Werte ohne Stop`}:</span> {noStop.join(", ")} – Risiko nicht begrenzt.
							</p>
						)}
						{near.length > 0 && (
							<ul className="flex flex-col gap-1.5" aria-label="Nächste Stops">
								{near.map(({ p, dist }) => (
									<li key={`${p.accountId}-${p.symbol}`} className="flex items-baseline gap-2 tnum">
										<Link to="/trade" search={{ symbol: p.symbol }} className="font-medium hover:underline">
											{p.symbol}
										</Link>
										<span className="text-fg-3">Stop {price(p.stopLoss, p.currency)}</span>
										<span className="ml-auto text-fg-2">{pct(-dist, { digits: 1 })} bis Stop</span>
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
		<Card title="Aufteilung" icon={<ChartPie className="size-4" />} label="Aufteilung deiner Depots" aside={`${eur(allocation.totalCents, { short: true })} zum aktuellen Kurs`}>
			{allocation.totalCents <= 0 ? (
				<Empty>Noch nichts aufzuteilen – mit der ersten Einzahlung oder dem ersten Kauf steht hier, worin dein Geld liegt.</Empty>
			) : (
				<div className="grid grid-cols-2 gap-x-8 gap-y-5 @max-[900px]:grid-cols-1">
					<section aria-label="Nach Anlageklasse" data-testid="allocation-class">
						<h3 className="mb-2 text-[12px] font-medium text-fg-3">Nach Anlageklasse</h3>
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
					<section aria-label="Nach Wert" data-testid="allocation-symbol">
						<h3 className="mb-2 text-[12px] font-medium text-fg-3">Nach Wert (Anteil am Depotwert)</h3>
						{top.length === 0 ? (
							<p className="text-[12.5px] text-fg-3">Nur Cash – noch keine Position.</p>
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
										{rest.length === 1 ? "1 weiterer Wert" : `${rest.length} weitere Werte`} · {eur(restCents, { short: true })}
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
