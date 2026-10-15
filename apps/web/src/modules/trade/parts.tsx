// Teile des Cockpits: Session-Leiste mit Tagesergebnis, Positionen mit R, Tagesstatistik je Depot, News.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ExternalLink, Newspaper, OctagonX } from "lucide-react";
import type { Cockpit } from "@desk/shared";
import { useNews } from "@/lib/api";
import { ago, eur, hhmm, num, pct, price, qty, signedEur, tone } from "@/lib/format";
import { Badge, Button, Card, Empty, Segmented, Table, cn, td, th } from "@/ui/kit";
import { useConfirm } from "@/ui/overlay";
import { useAction } from "../common";

export const STATE_LABEL = { pre: "Vorbörse", open: "Offen", post: "Nachbörse", closed: "Geschlossen" } as const;

/** Punkt für den Börsenzustand – immer zusammen mit Text oder Tooltip, nie Farbe allein. */
export function SessionDot({ state }: { state: keyof typeof STATE_LABEL }) {
	return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", state === "open" ? "bg-ok" : state === "closed" ? "bg-fg-3" : "bg-warn")} title={STATE_LABEL[state]} aria-label={STATE_LABEL[state]} role="img" />;
}

export function SessionBar({ cockpit }: { cockpit: Cockpit }) {
	const mine = cockpit.days.filter((d) => d.owner === "user");
	const day = mine.reduce((s, d) => s + (d.dayChangeCents ?? 0), 0);
	const realized = mine.reduce((s, d) => s + d.stats.realizedCents, 0);
	const trades = mine.reduce((s, d) => s + d.stats.trades, 0);
	const closed = mine.reduce((s, d) => s + d.stats.closed, 0);
	const wins = mine.reduce((s, d) => s + d.stats.wins, 0);
	const worst = Math.max(0, ...mine.map((d) => d.dayLossPct ?? 0));
	const { run } = useAction();
	const confirm = useConfirm();
	const kill = async () => {
		if (await confirm({ title: "Not-Aus einschalten?", body: "Keine Freigaben und keine Ausführungen mehr, offene Limits ruhen.", confirm: "Not-Aus einschalten", danger: true })) await run("/api/risk/kill", "PUT", { on: true }, "Not-Aus ist an.");
	};
	return (
		<div className="flex flex-wrap items-stretch gap-3">
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-[var(--shadow)]" aria-label="Börsen">
				{cockpit.sessions.length === 0 && <span className="text-[12.5px] text-fg-3">Noch keine Handelszeiten – sie kommen mit den ersten Kursen.</span>}
				{cockpit.sessions.map((s) => (
					<div key={s.exchange} className="flex items-center gap-2 text-[12.5px]" data-testid="session">
						<SessionDot state={s.state} />
						<span className="font-medium">{s.exchange}</span>
						<span className="text-fg-3 tnum">
							{STATE_LABEL[s.state]}
							{s.state === "open" && s.regEnd ? ` bis ${hhmm(s.regEnd)}` : s.state === "pre" && s.regStart ? `, öffnet ${hhmm(s.regStart)}` : s.state === "post" && s.postEnd ? ` bis ${hhmm(s.postEnd)}` : ""}
						</span>
					</div>
				))}
				<span className="ml-auto text-[11.5px] text-fg-3 tnum" title={cockpit.marketError ?? undefined}>
					{cockpit.market === "error" ? "Kurse gestört – letzte Werte" : `Kurse ${ago(cockpit.quotesAt)} · alle ${cockpit.liveIntervalSec} s`}
				</span>
			</div>
			<div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-line bg-surface px-4 py-2.5 text-[12.5px] shadow-[var(--shadow)] tnum" aria-label="Dein Tag" data-testid="day-bar">
				<span>
					<span className="text-fg-3">Heute </span>
					<span className={cn("text-[15px] font-semibold", tone(day))}>{signedEur(day)}</span>
				</span>
				<span>
					<span className="text-fg-3">realisiert </span>
					<span className={tone(realized)}>{signedEur(realized)}</span>
				</span>
				<span>
					<span className="text-fg-3">Trades </span>
					{trades}
					{closed > 0 && <span className="text-fg-3"> · {Math.round((wins / closed) * 100)} % Treffer</span>}
				</span>
				{worst > 0 && <span className="text-warn">Tagesverlust {pct(worst, { signed: false })}</span>}
				<Button variant="danger" size="sm" onClick={() => void kill()} disabled={cockpit.killSwitch} title="Not-Aus: alle Freigaben und Ausführungen stoppen">
					<OctagonX className="size-3.5" aria-hidden />
					{cockpit.killSwitch ? "Not-Aus an" : "Not-Aus…"}
				</Button>
			</div>
		</div>
	);
}

export function Positions({ cockpit, onSelect }: { cockpit: Cockpit; onSelect: (s: string) => void }) {
	const [who, setWho] = useState<"mine" | "all">("mine");
	const owner = (id: string) => cockpit.days.find((d) => d.accountId === id);
	const list = cockpit.positions.filter((p) => who === "all" || owner(p.accountId)?.owner === "user");
	const { run } = useAction();
	const confirm = useConfirm();
	const close = async (p: (typeof list)[number]) => {
		const acc = owner(p.accountId)!;
		if (!(await confirm({ title: `${p.symbol} schließen?`, body: `Verkauf ${qty(p.qty)} Stück zum Marktkurs im ${acc.name}.`, confirm: "Verkaufen" }))) return;
		await run("/api/proposals", "POST", { accountId: p.accountId, symbol: p.symbol, side: "sell", qty: p.qty }, `${p.symbol} geschlossen.`);
	};
	return (
		<Card title="Positionen" pad={false} aside={<Segmented label="Positionen von" items={[{ id: "mine", label: "Deine" }, { id: "all", label: "Alle" }]} value={who} onChange={setWho} />}>
			{list.length ? (
				<Table label="Offene Positionen">
					<thead>
						<tr>
							<th className={th}>Wert</th>
							<th className={th}>Depot</th>
							<th className={cn(th, "text-right")}>Stück</th>
							<th className={cn(th, "text-right")}>Einstand</th>
							<th className={cn(th, "text-right")}>Kurs</th>
							<th className={cn(th, "text-right")}>G/V</th>
							<th className={cn(th, "text-right")}>R</th>
							<th className={cn(th, "text-right")}>Stop</th>
							<th className={th}>
								<span className="sr-only">Aktionen</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{list.map((p) => {
							const acc = owner(p.accountId);
							return (
								<tr key={`${p.accountId}-${p.symbol}`} className="hover:bg-surface-2">
									<td className={td}>
										<button type="button" className="inline-flex h-7 items-center font-medium hover:underline" onClick={() => onSelect(p.symbol)}>
											{p.symbol}
										</button>
										{p.openedToday && <Badge className="ml-2">heute</Badge>}
									</td>
									<td className={cn(td, "max-w-40 truncate text-fg-2")} title={acc?.name}>
										{acc?.name}
									</td>
									<td className={cn(td, "text-right tnum")}>{qty(p.qty)}</td>
									<td className={cn(td, "text-right tnum text-fg-2")}>{price(p.avgPrice)}</td>
									<td className={cn(td, "text-right tnum")}>{price(p.price)}</td>
									<td className={cn(td, "text-right tnum", tone(p.unrealizedCents))}>
										{signedEur(p.unrealizedCents)} <span className="text-[11px]">{pct(p.unrealizedPct)}</span>
									</td>
									<td className={cn(td, "text-right tnum", tone(p.r))}>{p.r === null ? "–" : `${p.r > 0 ? "+" : p.r < 0 ? "−" : ""}${num(Math.abs(p.r), 1)} R`}</td>
									<td className={cn(td, "text-right tnum text-fg-3")}>{p.stopLoss ? price(p.stopLoss, p.currency) : "–"}</td>
									<td className={cn(td, "w-24 text-right")}>
										{acc?.owner === "user" && acc.kind === "paper" && (
											<Button size="sm" variant="ghost" onClick={() => void close(p)}>
												Schließen…
											</Button>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</Table>
			) : (
				<Empty>Keine offenen Positionen.</Empty>
			)}
		</Card>
	);
}

export function DayTable({ cockpit }: { cockpit: Cockpit }) {
	return (
		<Card title="Tagesstatistik" pad={false} aside="heute, je Depot">
			<Table label="Tagesstatistik je Depot">
				<thead>
					<tr>
						<th className={th}>Depot</th>
						<th className={cn(th, "text-right")}>Tages-G/V</th>
						<th className={cn(th, "text-right")}>Realisiert</th>
						<th className={cn(th, "text-right")}>Trades</th>
						<th className={cn(th, "text-right")}>Treffer</th>
						<th className={cn(th, "text-right")}>Ø Gewinn</th>
						<th className={cn(th, "text-right")}>Ø Verlust</th>
						<th className={cn(th, "text-right")}>Profit-Faktor</th>
						<th className={cn(th, "text-right")}>Gebühren</th>
					</tr>
				</thead>
				<tbody>
					{cockpit.days.map((d) => (
						<tr key={d.accountId} className="hover:bg-surface-2">
							<td className={td}>
								<Link to="/portfolio" search={{ account: d.accountId }} className="font-medium hover:underline">
									{d.name}
								</Link>
							</td>
							<td className={cn(td, "text-right tnum", tone(d.dayChangeCents))}>{d.dayChangeCents === null ? "–" : signedEur(d.dayChangeCents)}</td>
							<td className={cn(td, "text-right tnum", tone(d.stats.realizedCents))}>{signedEur(d.stats.realizedCents)}</td>
							<td className={cn(td, "text-right tnum")}>{d.stats.trades}</td>
							<td className={cn(td, "text-right tnum")}>{d.stats.winRate === null ? "–" : `${Math.round(d.stats.winRate)} % (${d.stats.wins}/${d.stats.closed})`}</td>
							<td className={cn(td, "text-right tnum text-fg-2")}>{d.stats.avgWinCents === null ? "–" : eur(d.stats.avgWinCents)}</td>
							<td className={cn(td, "text-right tnum text-fg-2")}>{d.stats.avgLossCents === null ? "–" : eur(d.stats.avgLossCents)}</td>
							<td className={cn(td, "text-right tnum")}>{d.stats.profitFactor === null ? "–" : num(d.stats.profitFactor)}</td>
							<td className={cn(td, "text-right tnum text-fg-3")}>{eur(d.stats.feesCents)}</td>
						</tr>
					))}
				</tbody>
			</Table>
		</Card>
	);
}

export function NewsCard({ symbol }: { symbol: string }) {
	const { data, isLoading, error } = useNews(symbol);
	return (
		<Card title={`News ${symbol}`} icon={<Newspaper className="size-4" />} pad={false}>
			{isLoading ? (
				<Empty>Lade News…</Empty>
			) : error ? (
				<Empty>{(error as Error).message}</Empty>
			) : data?.length ? (
				<ul className="divide-y divide-line">
					{data.slice(0, 6).map((n) => (
						<li key={n.link}>
							<a href={n.link} target="_blank" rel="noopener noreferrer" className="flex gap-2 px-4 py-2.5 text-[12.5px] hover:bg-surface-2">
								<span className="min-w-0 flex-1">
									<span className="line-clamp-2 text-fg">{n.title}</span>
									<span className="text-[11.5px] text-fg-3">
										{n.publisher} · {ago(n.time)}
									</span>
								</span>
								<ExternalLink className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-label="öffnet in neuem Tab" />
							</a>
						</li>
					))}
				</ul>
			) : (
				<Empty>Keine aktuellen News.</Empty>
			)}
		</Card>
	);
}
