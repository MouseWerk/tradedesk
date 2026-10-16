// Teile des Cockpits: Session-Leiste mit Tagesergebnis, Positionen mit R, Tagesstatistik je Depot, News.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ExternalLink, Newspaper, OctagonX } from "lucide-react";
import type { Cockpit, Proposal } from "@desk/shared";
import { useNews, useOverview, useRisk } from "@/lib/api";
import { ago, eur, hhmm, num, pct, price, qty, signedEur, tone, qtyShort } from "@/lib/format";
import { orderResultText } from "@/lib/orders";
import { Badge, Button, Card, Empty, Segmented, Table, cn, hideBelow, td, th } from "@/ui/kit";
import { useConfirm } from "@/ui/overlay";
import { de } from "@/i18n/de";
import { useAction } from "../common";

/** Börsenkürzel von Yahoo, die niemand lesen muss. */
export const exchangeLabel = (x: string) => de.trade.exchange[x] ?? x;

/** Punkt für den Börsenzustand – immer zusammen mit Text oder Tooltip, nie Farbe allein. */
export function SessionDot({ state }: { state: keyof typeof de.trade.state }) {
	return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", state === "open" ? "bg-ok" : state === "closed" ? "bg-fg-3" : "bg-warn")} title={de.trade.state[state]} aria-label={de.trade.state[state]} role="img" />;
}

export function Sessions({ cockpit }: { cockpit: Pick<Cockpit, "sessions"> }) {
	if (cockpit.sessions.length === 0) return <span className="text-[12.5px] text-fg-3">{de.trade.noSessions}</span>;
	return (
		<>
			{cockpit.sessions.map((s) => (
				<div key={s.exchange} className="flex items-center gap-2 text-[12.5px]" data-testid="session">
					<SessionDot state={s.state} />
					<span className="font-medium">{exchangeLabel(s.exchange)}</span>
					<span className="text-fg-3 tnum">
						{de.trade.state[s.state]}
						{s.state === "open" && s.regEnd ? de.trade.until(hhmm(s.regEnd)) : s.state === "pre" && s.regStart ? de.trade.opens(hhmm(s.regStart)) : s.state === "post" && s.postEnd ? de.trade.until(hhmm(s.postEnd)) : ""}
					</span>
				</div>
			))}
		</>
	);
}

export function SessionBar({ cockpit }: { cockpit: Cockpit }) {
	const mine = cockpit.days.filter((d) => d.owner === "user");
	const day = mine.reduce((s, d) => s + (d.dayChangeCents ?? 0), 0);
	const realized = mine.reduce((s, d) => s + d.stats.realizedCents, 0);
	const trades = mine.reduce((s, d) => s + d.stats.trades, 0);
	const closed = mine.reduce((s, d) => s + d.stats.closed, 0);
	const wins = mine.reduce((s, d) => s + d.stats.wins, 0);
	const { data: risk } = useRisk();
	// Tagesverlust-Stopp immer zeigen, nicht erst nach einem Verlust: das Depot, das ihm am nächsten ist
	const stops = mine
		.map((d) => ({ d, limit: risk?.accounts.find((x) => x.account.id === d.accountId)?.limits.dailyLossPct ?? 0 }))
		.filter((x) => x.limit > 0)
		.map((x) => ({ ...x, loss: x.d.dayLossPct ?? 0 }))
		.sort((a, b) => b.loss / b.limit - a.loss / a.limit);
	const near = stops[0];
	const { run } = useAction();
	const confirm = useConfirm();
	const kill = async () => {
		if (await confirm({ title: de.proposal.kill.title, body: de.proposal.kill.body, confirm: de.proposal.kill.confirm, danger: true })) await run("/api/risk/kill", "PUT", { on: true }, de.proposal.kill.on);
	};
	return (
		<div className="flex flex-wrap items-stretch gap-3">
			<div className="flex min-w-0 flex-[2_1_440px] flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-[var(--shadow)] [&_*]:whitespace-nowrap" aria-label={de.trade.exchanges}>
				<Sessions cockpit={cockpit} />
				<span className="ml-auto text-[11.5px] text-fg-3 tnum" title={cockpit.marketError ?? undefined}>
					{cockpit.market === "error" ? de.trade.quotesError : de.trade.quotesAt(ago(cockpit.quotesAt), cockpit.liveIntervalSec)}
				</span>
			</div>
			<div className="flex min-w-0 flex-[1_1_360px] flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-line bg-surface px-4 py-2.5 text-[12.5px] shadow-[var(--shadow)] tnum" aria-label={de.trade.yourDay} data-testid="day-bar">
				<span>
					<span className="text-fg-3">{de.trade.today} </span>
					<span className={cn("text-[15px] font-semibold", tone(day))}>{signedEur(day)}</span>
				</span>
				<span>
					<span className="text-fg-3">{de.analytics.calendar.realized} </span>
					<span className={tone(realized)}>{signedEur(realized)}</span>
				</span>
				<span>
					<span className="text-fg-3">{de.analytics.col.trades} </span>
					{trades}
					{closed > 0 && <span className="text-fg-3">{de.trade.hitRate(Math.round((wins / closed) * 100))}</span>}
				</span>
				{near && (
					<span className={near.loss > 0 && near.loss >= near.limit * 0.75 ? "font-medium text-warn" : undefined} title={de.trade.dayLossTitle(pct(near.limit, { signed: false }), near.d.name, near.d.dayLossHeadroomCents !== null ? eur(near.d.dayLossHeadroomCents) : null)} data-testid="day-loss">
						<span className="text-fg-3">{de.trade.dayLoss} </span>
						{pct(near.loss, { signed: false })} <span className="text-fg-3">{de.trade.ofLimit(pct(near.limit, { signed: false }))}</span>
					</span>
				)}

				<Button variant="danger" size="sm" onClick={() => void kill()} disabled={cockpit.killSwitch} title={de.trade.killButtonTitle}>
					<OctagonX className="size-3.5" aria-hidden />
					{cockpit.killSwitch ? de.trade.killOn : de.trade.killAction}
				</Button>
			</div>
		</div>
	);
}

/**
 * Positionen. Beträge (Kurs, Einstand, G/V) in Euro wie im Buch, der Stop wird mit dem aktuellen Kurs in Euro
 * umgerechnet (gesetzt ist er in der Wertpapierwährung – die steht als zweite Zeile daneben, wie im Scanner).
 */
export function Positions({ cockpit, onSelect }: { cockpit: Cockpit; onSelect: (s: string) => void }) {
	const [who, setWho] = useState<"mine" | "all">("mine");
	const owner = (id: string) => cockpit.days.find((d) => d.accountId === id);
	const { data: ov } = useOverview();
	const liveIds = new Set((ov?.accounts ?? []).filter((a) => a.live).map((a) => a.id));
	const list = cockpit.positions.filter((p) => who === "all" || owner(p.accountId)?.owner === "user");
	const openRisk = cockpit.days.filter((d) => who === "all" || d.owner === "user").reduce((sum, d) => sum + d.openRiskCents, 0);
	const { run } = useAction();
	const confirm = useConfirm();
	const close = async (p: (typeof list)[number]) => {
		const acc = owner(p.accountId)!;
		const live = liveIds.has(acc.accountId);
		const broker = ov?.accounts.find((a) => a.id === acc.accountId)?.broker;
		if (!(await confirm({ title: de.trade.closeTitle(p.symbol), body: de.trade.closeBody(qty(p.qty), acc.name, p.price !== null ? eur(Math.round(p.qty * p.price * 100)) : null, acc.kind === "broker" ? (live ? "live" : "paper") : null), confirm: live ? de.trade.sellLive : de.calc.act.sell, danger: live }))) return;
		await run<{ proposal: Proposal }>("/api/proposals", "POST", { accountId: p.accountId, symbol: p.symbol, side: "sell", qty: p.qty }, (res) =>
			orderResultText(res.proposal, { label: de.calc.label.sell(qty(p.qty), p.symbol), broker, kind: acc.kind, filled: de.trade.closed(p.symbol) }),
		);
	};
	const fx = (p: (typeof list)[number]) => (p.price && p.nativePrice ? p.price / p.nativePrice : null);
	return (
		<Card
			title={de.trade.positions}
			pad={false}
			aside={
				<>
					<span className="whitespace-nowrap tnum" title={de.trade.openRiskTitle} data-testid="open-risk">
						{de.trade.openRisk(eur(openRisk, { short: true }))}
					</span>
					<Segmented label={de.trade.positionsOf} items={[{ id: "mine", label: de.trade.yours }, { id: "all", label: de.trade.all }]} value={who} onChange={setWho} />
				</>
			}
		>
			{list.length ? (
				<Table label={de.trade.openPositions}>
					<thead>
						<tr>
							<th className={th}>{de.analytics.col.symbol}</th>
							<th className={cn(th, "text-right", hideBelow.sm)}>{de.analytics.col.qty}</th>
							<th className={cn(th, "text-right", hideBelow.md)}>{de.trade.col.avgEur}</th>
							<th className={cn(th, "text-right")}>{de.trade.col.priceEur}</th>
							<th className={cn(th, "text-right")}>{de.trade.col.pnl}</th>
							<th className={cn(th, "text-right", hideBelow.sm)}>{de.analytics.r}</th>
							<th className={cn(th, "text-right", hideBelow.md)}>{de.trade.col.stopEur}</th>
							<th className={th}>
								<span className="sr-only">{de.trade.col.actions}</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{list.map((p) => {
							const acc = owner(p.accountId);
							const f = fx(p);
							const foreign = p.currency !== "EUR";
							return (
								<tr key={`${p.accountId}-${p.symbol}`} className="hover:bg-surface-2" data-testid="position" data-symbol={p.symbol}>
									<td className={cn(td, "max-w-44")}>
										<span className="flex min-w-0 flex-col leading-tight">
											<span className="flex items-center gap-2">
												<button type="button" className="inline-flex h-6 items-center font-medium hover:underline" onClick={() => onSelect(p.symbol)} aria-label={de.trade.showInChart(p.symbol)}>
													{p.symbol}
												</button>
												{p.openedToday && <Badge>{de.trade.openedToday}</Badge>}
											</span>
											<span className="truncate text-[11.5px] text-fg-3" title={acc?.name}>
												{acc?.name}
											</span>
										</span>
									</td>
									<td className={cn(td, "text-right tnum", hideBelow.sm)} title={qty(p.qty)}>{qtyShort(p.qty)}</td>
									<td className={cn(td, "text-right tnum text-fg-2", hideBelow.md)}>{price(p.avgPrice)}</td>
									<td className={cn(td, "text-right tnum")}>
										<span className="flex flex-col leading-tight">
											<span>{price(p.price)}</span>
											{foreign && p.nativePrice !== null && <span className="text-[11px] text-fg-3">{price(p.nativePrice, p.currency)}</span>}
										</span>
									</td>
									<td className={cn(td, "text-right tnum", tone(p.unrealizedCents))}>
										<span className="flex flex-col leading-tight">
											<span>{signedEur(p.unrealizedCents)}</span>
											<span className="text-[11px]">{pct(p.unrealizedPct)}</span>
										</span>
									</td>
									<td className={cn(td, "text-right tnum", tone(p.r), hideBelow.sm)}>{p.r === null ? "–" : de.analytics.rValue(`${p.r > 0 ? "+" : p.r < 0 ? "−" : ""}${num(Math.abs(p.r), 1)}`)}</td>
									<td className={cn(td, "text-right tnum text-fg-3", hideBelow.md)} title={p.stopLoss ? de.trade.stopSet(p.currency) : de.trade.noStopSet}>
										{p.stopLoss ? (
											<span className="flex flex-col leading-tight">
												<span>{foreign ? (f ? `≈ ${price(p.stopLoss * f)}` : "–") : price(p.stopLoss)}</span>
												{foreign && <span className="text-[11px]">{price(p.stopLoss, p.currency)}</span>}
											</span>
										) : (
											"–"
										)}
									</td>
									<td className={cn(td, "w-24 text-right")}>
										{acc?.owner === "user" && acc.kind !== "manual" && (
											<Button size="sm" variant="ghost" onClick={() => void close(p)} aria-label={de.trade.closeAria(p.symbol)}>
												{de.trade.closeAction}
											</Button>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</Table>
			) : (
				<Empty>{de.trade.noPositions}</Empty>
			)}
		</Card>
	);
}

export function DayTable({ cockpit }: { cockpit: Cockpit }) {
	return (
		<Card title={de.trade.dayStats} pad={false} aside={de.trade.dayStatsAside}>
			<Table label={de.trade.dayStatsTable}>
				<thead>
					<tr>
						<th className={th}>{de.analytics.col.depot}</th>
						<th className={cn(th, "text-right")}>{de.trade.col.dayPnl}</th>
						<th className={cn(th, "text-right")}>{de.analytics.col.realized}</th>
						<th className={cn(th, "text-right", hideBelow.sm)}>{de.analytics.col.trades}</th>
						<th className={cn(th, "text-right", hideBelow.md)}>{de.analytics.col.hits}</th>
						<th className={cn(th, "text-right", hideBelow.lg)}>{de.analytics.col.avgWin}</th>
						<th className={cn(th, "text-right", hideBelow.lg)}>{de.analytics.col.avgLoss}</th>
						<th className={cn(th, "text-right", hideBelow.xl)}>{de.analytics.col.profitFactor}</th>
						<th className={cn(th, "text-right", hideBelow.xl)}>{de.analytics.col.fees}</th>
					</tr>
				</thead>
				<tbody>
					{cockpit.days.map((d) => (
						<tr key={d.accountId} className="hover:bg-surface-2">
							<td className={cn(td, "max-w-48 truncate")}>
								<Link to="/portfolio" search={{ account: d.accountId }} className="font-medium hover:underline" title={d.name}>
									{d.name}
								</Link>
							</td>
							<td className={cn(td, "text-right tnum", tone(d.dayChangeCents))}>{d.dayChangeCents === null ? "–" : signedEur(d.dayChangeCents)}</td>
							<td className={cn(td, "text-right tnum", tone(d.stats.realizedCents))}>{signedEur(d.stats.realizedCents)}</td>
							<td className={cn(td, "text-right tnum", hideBelow.sm)}>{d.stats.trades}</td>
							<td className={cn(td, "text-right tnum", hideBelow.md)}>{d.stats.winRate === null ? "–" : de.trade.winRateCell(Math.round(d.stats.winRate), d.stats.wins, d.stats.closed)}</td>
							<td className={cn(td, "text-right tnum text-fg-2", hideBelow.lg)}>{d.stats.avgWinCents === null ? "–" : signedEur(d.stats.avgWinCents)}</td>
							<td className={cn(td, "text-right tnum text-fg-2", hideBelow.lg)}>{d.stats.avgLossCents === null ? "–" : signedEur(d.stats.avgLossCents)}</td>
							<td className={cn(td, "text-right tnum", hideBelow.xl)}>{d.stats.profitFactor === null ? "–" : num(d.stats.profitFactor)}</td>
							<td className={cn(td, "text-right tnum text-fg-3", hideBelow.xl)}>{eur(d.stats.feesCents)}</td>
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
		<Card title={de.trade.news(symbol)} icon={<Newspaper className="size-4" />} pad={false}>
			{isLoading ? (
				<Empty>{de.trade.newsLoading}</Empty>
			) : error ? (
				<Empty>{(error as Error).message}</Empty>
			) : data?.length ? (
				<ul className="divide-y divide-line">
					{data.slice(0, 6).map((n, i) => (
						<li key={`${n.link}-${i}`}>
							<a href={n.link} target="_blank" rel="noopener noreferrer" className="flex gap-2 px-4 py-2.5 text-[12.5px] hover:bg-surface-2">
								<span className="min-w-0 flex-1">
									<span className="line-clamp-2 text-fg">{n.title}</span>
									<span className="text-[11.5px] text-fg-3">
										{n.publisher} · {ago(n.time)}
									</span>
								</span>
								<ExternalLink className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-label={de.trade.newTab} />
							</a>
						</li>
					))}
				</ul>
			) : (
				<Empty>{de.trade.noNews}</Empty>
			)}
		</Card>
	);
}
