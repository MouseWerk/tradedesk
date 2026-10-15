// Übersicht: dein Vermögen über alle eigenen Depots, was auf dich wartet, alle Depots im Vergleich, Verlauf.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Activity, ArrowRight, LineChart as LineIcon, ListChecks, Wallet } from "lucide-react";
import { useOverview, useProposals } from "@/lib/api";
import { ago, dayLabel, eur, pct, signedEur, tone } from "@/lib/format";
import { LineChart } from "@/ui/charts";
import { Badge, Card, Empty, Segmented, Skeleton, Stat, Table, cn, td, th } from "@/ui/kit";
import { Page, PageHead, ProposalCard } from "../common";

type Span = "30" | "90" | "all";

export default function OverviewView() {
	const { data, isLoading } = useOverview();
	const { data: proposals } = useProposals();
	const [span, setSpan] = useState<Span>("90");
	if (isLoading || !data)
		return (
			<Page>
				<Skeleton className="h-8 w-48" />
				<div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
					{[0, 1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-[92px]" />
					))}
				</div>
				<Skeleton className="h-[300px]" />
			</Page>
		);
	const mine = data.accounts.filter((a) => a.owner === "user");
	const equity = mine.reduce((s, a) => s + a.equityCents, 0);
	const deposits = mine.reduce((s, a) => s + a.depositsCents, 0);
	const cash = mine.reduce((s, a) => s + a.cashCents, 0);
	const hasDay = mine.some((a) => a.dayChangeCents !== null);
	const day = mine.reduce((s, a) => s + (a.dayChangeCents ?? 0), 0);
	const curve = span === "all" ? data.curve : data.curve.slice(-Number(span) - 1);
	const pending = (proposals ?? []).filter((p) => p.status === "pending" || p.status === "placed");
	const missing = [...new Set(mine.flatMap((a) => a.missingQuotes))];

	return (
		<Page>
			<PageHead title={`Hallo ${data.user}`} sub={`${mine.length} eigene Depots, ${data.accounts.length - mine.length} Agenten-Papierdepots · Kurse ${ago(data.quotesAt)}`} />
			{data.market === "error" && (
				<p className="rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-warn" role="alert">
					Kurse konnten nicht geladen werden ({data.marketError}). Es gelten die letzten bekannten Kurse; der Desk versucht es jede Minute neu.
				</p>
			)}
			<div className="grid grid-cols-4 gap-3 @max-[900px]:grid-cols-2">
				<Stat testId="stat-equity" label="Vermögen (deine Depots)" value={eur(equity)} sub={<span className="text-fg-3">davon Cash {eur(cash, { short: true })}</span>} />
				<Stat label="Heute" value={<span className={tone(day)}>{hasDay ? signedEur(day) : "–"}</span>} sub={<span className="text-fg-3">{hasDay ? pct((day / Math.max(1, equity - day)) * 100) : "ab morgen mit Vortag"}</span>} />
				<Stat label="Gesamt" value={<span className={tone(equity - deposits)}>{signedEur(equity - deposits)}</span>} sub={<span className={tone(equity - deposits)}>{deposits ? pct(((equity - deposits) / deposits) * 100) : "–"} auf {eur(deposits, { short: true })} eingezahlt</span>} />
				<Stat label="Wartet auf dich" value={<span className={cn(pending.length ? "text-warn" : "")}>{pending.length}</span>} sub={<Link to="/orders" className="text-fg-2 hover:text-fg">Vorschläge ansehen</Link>} />
			</div>
			{missing.length > 0 && (
				<p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-fg-2">
					Ohne Kurs, zum Einstand bewertet: {missing.join(", ")}. Das Symbol in Yahoo-Schreibweise erfassen (z. B. SAP.DE), dann kommen Kurse.
				</p>
			)}
			<div className="grid grid-cols-[minmax(0,1fr)_380px] gap-4 @max-[1100px]:grid-cols-1">
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
				<Card title="Wartet auf dich" icon={<ListChecks className="size-4" />} aside={<Link to="/orders" className="-mr-2 inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-surface-3 hover:text-fg">Alle <ArrowRight className="size-3.5" aria-hidden /></Link>} pad={false}>
					<div className="flex max-h-[340px] flex-col gap-3 overflow-y-auto p-3 scroll-thin">
						{pending.length ? pending.slice(0, 3).map((p) => <ProposalCard key={p.id} p={p} accounts={data.accounts} user={data.user} compact />) : <Empty>Nichts offen. Agenten schlagen über cli/desk.py vor.</Empty>}
					</div>
				</Card>
			</div>
			<div className="grid grid-cols-[minmax(0,1fr)_380px] gap-4 @max-[1100px]:grid-cols-1">
				<Card title="Depots" icon={<Wallet className="size-4" />} pad={false}>
					<Table label="Depots">
						<thead>
							<tr>
								<th className={th}>Depot</th>
								<th className={th}>Art</th>
								<th className={cn(th, "text-right")}>Wert</th>
								<th className={cn(th, "text-right")}>Cash</th>
								<th className={cn(th, "text-right")}>Heute</th>
								<th className={cn(th, "text-right")}>Gesamt</th>
							</tr>
						</thead>
						<tbody>
							{data.accounts.map((a) => (
								<tr key={a.id} className="hover:bg-surface-2">
									<td className={td}>
										<Link to="/portfolio" search={{ account: a.id }} className="font-medium hover:underline">
											{a.name}
										</Link>
									</td>
									<td className={td}>
										<Badge>{a.kind === "manual" ? a.broker : a.owner === "user" ? "Papier" : `Agent ${a.owner}`}</Badge>
									</td>
									<td className={cn(td, "text-right tnum")}>{eur(a.equityCents)}</td>
									<td className={cn(td, "text-right tnum text-fg-2")}>{eur(a.cashCents)}</td>
									<td className={cn(td, "text-right tnum", tone(a.dayChangeCents))}>{a.dayChangeCents === null ? "–" : signedEur(a.dayChangeCents)}</td>
									<td className={cn(td, "text-right tnum", tone(a.returnPct))}>{pct(a.returnPct)}</td>
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
									<span className="w-16 shrink-0 text-fg-3 tnum">{ago(e.time).replace("vor ", "")}</span>
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
