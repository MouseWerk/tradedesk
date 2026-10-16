// Übersicht: Handelszeiten und Not-Aus, dein Vermögen über alle eigenen Depots, was auf dich wartet (alles, kompakt),
// alle Depots im Vergleich, Verlauf.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Activity, ArrowRight, LineChart as LineIcon, ListChecks, OctagonX, ShieldCheck, Wallet } from "lucide-react";
import type { AccountSummary } from "@desk/shared";
import { useCockpit, useOverview, useProposals } from "@/lib/api";
import { ago, dateTime, dayLabel, eur, pct, signedEur, tone } from "@/lib/format";
import { LineChart } from "@/ui/charts";
import { Badge, Card, Empty, Segmented, Skeleton, Stat, Table, cn, hideBelow, td, th } from "@/ui/kit";
import { LoadError } from "@/ui/boundary";
import { Page, PageHead, ProposalRow, needsYou } from "../common";
import { Sessions } from "../trade/parts";

type Span = "30" | "90" | "all";
const SHOWN = 5;

const STATS = "grid grid-cols-4 gap-3 @max-[900px]:grid-cols-2";
const ROW = "grid grid-cols-[minmax(0,1fr)_380px] gap-4 @max-[1100px]:grid-cols-1";

function kindLabel(a: AccountSummary): string {
	if (a.owner !== "user") return `Papierdepot von Agent ${a.owner}`;
	if (a.kind === "paper") return "Papierdepot";
	if (a.kind === "manual") return `${a.broker} · manuell`;
	return `${a.broker} · ${a.live ? "echtes Geld" : "Papierkonto"}`;
}

export default function OverviewView() {
	const { data, error, refetch } = useOverview();
	const { data: proposals } = useProposals();
	const { data: cockpit } = useCockpit();
	const [span, setSpan] = useState<Span>("90");
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
				<div className={STATS}>
					{[0, 1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-[92px]" />
					))}
				</div>
				<div className={ROW}>
					<Skeleton className="h-[330px]" />
					<Skeleton className="h-[330px]" />
				</div>
			</Page>
		);
	const mine = data.accounts.filter((a) => a.owner === "user");
	const equity = mine.reduce((s, a) => s + a.equityCents, 0);
	const deposits = mine.reduce((s, a) => s + a.depositsCents, 0);
	const cash = mine.reduce((s, a) => s + a.cashCents, 0);
	const hasDay = mine.some((a) => a.dayChangeCents !== null);
	const day = mine.reduce((s, a) => s + (a.dayChangeCents ?? 0), 0);
	const curve = span === "all" ? data.curve : data.curve.slice(-Number(span) - 1);
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
			<div className={STATS}>
				<Stat testId="stat-equity" label="Vermögen" value={eur(equity)} sub={<span className="text-fg-3">deine Depots · Cash {eur(cash, { short: true })}</span>} />
				<Stat label="Heute" value={<span className={tone(day)}>{hasDay ? signedEur(day) : "–"}</span>} sub={<span className="text-fg-3">{hasDay ? pct((day / Math.max(1, equity - day)) * 100) : "ab morgen mit Vortag"}</span>} />
				<Stat label="Gesamt" value={<span className={tone(equity - deposits)}>{signedEur(equity - deposits)}</span>} sub={<span className={tone(equity - deposits)}>{deposits ? pct(((equity - deposits) / deposits) * 100) : "–"} auf {eur(deposits, { short: true })} eingezahlt</span>} />
				<Stat testId="stat-waiting" label="Wartet auf dich" value={<span className={cn(waiting.length ? "text-warn" : "")}>{proposals ? waiting.length : "–"}</span>} sub={<Link to="/orders" className="text-fg-2 hover:text-fg">Vorschläge ansehen</Link>} />
			</div>
			{missing.length > 0 && (
				<p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-fg-2">
					Ohne Kurs, zum Einstand bewertet: {missing.join(", ")}. Das Symbol in Yahoo-Schreibweise erfassen (z. B. SAP.DE), dann kommen Kurse.
				</p>
			)}
			<div className={ROW}>
				<Card title="Vermögen" icon={<LineIcon className="size-4" />} aside={<Segmented label="Zeitraum" items={[{ id: "30", label: "30 T" }, { id: "90", label: "90 T" }, { id: "all", label: "Alles" }]} value={span} onChange={setSpan} />}>
					{curve.length > 1 ? (
						<LineChart
							label="Vermögen deiner Depots je Tag"
							xs={curve.map((p) => p.day)}
							xLabel={dayLabel}
							series={[{ id: "eq", label: "Vermögen", color: "var(--fg)", values: curve.map((p) => p.equityCents) }]}
							format={(v) => eur(v, { short: true })}
							area
							height={260}
						/>
					) : (
						<Empty>Der Verlauf beginnt heute – ab morgen steht hier jeden Tag ein Punkt.</Empty>
					)}
				</Card>
				<Card
					title="Wartet auf dich"
					icon={<ListChecks className="size-4" />}
					label={`Wartet auf dich: ${waiting.length}`}
					aside={
						<Link to="/orders" className="-mr-2 inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-surface-3 hover:text-fg">
							Alle <ArrowRight className="size-3.5" aria-hidden />
						</Link>
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
			</div>
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
