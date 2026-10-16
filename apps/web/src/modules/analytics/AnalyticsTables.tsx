// Tabellen der Auswertung: Kennzahlen je Autor und je Wert, geschlossene Trades (sortierbar, mit R). Die Trade-Liste
// zeigt 100 Zeilen und lädt auf Wunsch weitere – 1 000 Trades sortieren bleibt schnell, gezeichnet wird nur, was du siehst.
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { AccountSummary, ClosedTrade, TradeStats } from "@desk/shared";
import { dateTime, duration, eur, num, pct, price, qtyShort, signedEur, tone } from "@/lib/format";
import { Button, Table, cn, hideBelow, td, th } from "@/ui/kit";

export const rText = (r: number | null | undefined) => (r === null || r === undefined ? "–" : `${r > 0 ? "+" : r < 0 ? "−" : "±"}${num(Math.abs(r), 2)} R`);
export const pfText = (s: TradeStats) => (s.profitFactor === null ? (s.wins ? "∞" : "–") : num(s.profitFactor, 2));

/** Kennzahlen je Gruppe (Autor oder Wert); Gruppen ohne Trades bleiben stehen, mit Strichen. */
export function GroupTable<T extends TradeStats>({ rows, label, name, testId }: { rows: T[]; label: string; name: (r: T) => { title: string; sub?: string; to?: string }; testId: string }) {
	return (
		<Table label={label}>
			<thead>
				<tr>
					<th className={th}>{label}</th>
					<th className={cn(th, "text-right")}>Trades</th>
					<th className={cn(th, "text-right", hideBelow.sm)}>Treffer</th>
					<th className={cn(th, "text-right")}>Ergebnis</th>
					<th className={cn(th, "text-right", hideBelow.md)}>Profit-Faktor</th>
					<th className={cn(th, "text-right", hideBelow.md)}>Ø R</th>
					<th className={cn(th, "text-right", hideBelow.lg)}>Ø Haltedauer</th>
				</tr>
			</thead>
			<tbody data-testid={testId}>
				{rows.map((r) => {
					const n = name(r);
					return (
						<tr key={n.title} className={cn("hover:bg-surface-2", !r.trades && "text-fg-3")}>
							<td className={cn(td, "max-w-[220px] py-1.5 @max-[560px]/table:max-w-[140px]")}>
								<span className="flex min-w-0 flex-col leading-tight">
									{n.to ? (
										<Link to="/trade" search={{ symbol: n.title }} className="truncate font-medium hover:underline" title={n.sub ? `${n.title} – ${n.sub}` : n.title}>
											{n.title}
										</Link>
									) : (
										<span className="truncate font-medium">{n.title}</span>
									)}
									{n.sub && <span className="truncate text-[11.5px] text-fg-3">{n.sub}</span>}
								</span>
							</td>
							<td className={cn(td, "text-right tnum")}>{r.trades}</td>
							<td className={cn(td, "text-right tnum", hideBelow.sm)}>{r.winRate === null ? "–" : pct(r.winRate, { signed: false, digits: 0 })}</td>
							<td className={cn(td, "text-right font-medium tnum", tone(r.pnlCents))}>{r.trades ? signedEur(r.pnlCents) : "–"}</td>
							<td className={cn(td, "text-right tnum", hideBelow.md)}>{r.trades ? pfText(r) : "–"}</td>
							<td className={cn(td, "text-right tnum", hideBelow.md)} title={r.rTrades ? `${r.rTrades} von ${r.trades} Trades mit Stop` : undefined}>
								{rText(r.expectancyR)}
							</td>
							<td className={cn(td, "text-right tnum text-fg-2", hideBelow.lg)}>{duration(r.avgHoldMs)}</td>
						</tr>
					);
				})}
			</tbody>
		</Table>
	);
}

type Key = "exit" | "symbol" | "author" | "account" | "qty" | "entryPrice" | "exitPrice" | "hold" | "pnl" | "r";
const COLUMNS: { key: Key; label: string; right?: boolean; hide?: string }[] = [
	{ key: "exit", label: "Ausstieg" },
	{ key: "symbol", label: "Wert" },
	{ key: "author", label: "Autor", hide: hideBelow.md },
	{ key: "account", label: "Depot", hide: hideBelow.xl },
	{ key: "qty", label: "Stück", right: true, hide: hideBelow.lg },
	{ key: "entryPrice", label: "Einstieg (€)", right: true, hide: hideBelow.lg },
	{ key: "exitPrice", label: "Ausstieg (€)", right: true, hide: hideBelow.lg },
	{ key: "hold", label: "Haltedauer", right: true, hide: hideBelow.md },
	{ key: "pnl", label: "Ergebnis", right: true },
	{ key: "r", label: "R", right: true, hide: hideBelow.sm },
];
const PAGE = 100;

const sortValue = (t: ClosedTrade, k: Key, accountName: (id: string) => string): number | string => {
	switch (k) {
		case "exit":
			return t.exitTime;
		case "symbol":
			return t.symbol;
		case "author":
			return t.author;
		case "account":
			return accountName(t.accountId);
		case "qty":
			return t.qty;
		case "entryPrice":
			return t.entryPrice;
		case "exitPrice":
			return t.exitPrice;
		case "hold":
			return t.holdMs;
		case "pnl":
			return t.pnlCents;
		case "r":
			return t.r ?? Number.NEGATIVE_INFINITY;
	}
};

/** Sortieren ohne die Eingabe zu ändern; Gleichstand nach Ausstieg, neueste zuerst. Texte nach deutscher Ordnung. */
export function sortTrades(trades: ClosedTrade[], key: Key, dir: "asc" | "desc", accountName: (id: string) => string = (id) => id): ClosedTrade[] {
	const f = dir === "asc" ? 1 : -1;
	return trades
		.map((t, i) => ({ t, i, v: sortValue(t, key, accountName) }))
		.sort((a, b) => {
			const c = typeof a.v === "string" ? a.v.localeCompare(b.v as string, "de") : (a.v as number) - (b.v as number);
			return c * f || b.t.exitTime - a.t.exitTime || a.i - b.i;
		})
		.map((x) => x.t);
}

export function TradesTable({ trades, total, accounts }: { trades: ClosedTrade[]; total: number; accounts: AccountSummary[] }) {
	const [sort, setSort] = useState<{ key: Key; dir: "asc" | "desc" }>({ key: "exit", dir: "desc" });
	const [shown, setShown] = useState(PAGE);
	const names = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
	const accountName = (id: string) => names.get(id) ?? id;
	const sorted = useMemo(() => sortTrades(trades, sort.key, sort.dir, (id) => names.get(id) ?? id), [trades, sort, names]);
	const rows = sorted.slice(0, shown);
	const toggle = (key: Key) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "symbol" || key === "author" || key === "account" ? "asc" : "desc" }));
	return (
		<>
			<Table label="Geschlossene Trades">
				<thead>
					<tr>
						{COLUMNS.map((c) => {
							const on = sort.key === c.key;
							return (
								<th key={c.key} className={cn(th, c.right && "text-right", c.hide)} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
									<button type="button" onClick={() => toggle(c.key)} className={cn("-mx-1 inline-flex h-7 items-center gap-1 rounded-md px-1 hover:bg-surface-3 hover:text-fg", on && "font-semibold text-fg")} data-testid={`sort-${c.key}`}>
										{c.label}
										{on && (sort.dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}
									</button>
								</th>
							);
						})}
					</tr>
				</thead>
				<tbody>
					{rows.map((t) => (
						<tr key={`${t.sellTradeId}-${t.buyTradeId}`} className="hover:bg-surface-2" data-testid="trade-row">
							<td className={cn(td, "tnum text-fg-2")} title={`Einstieg ${dateTime(t.entryTime)}`}>
								{dateTime(t.exitTime)}
							</td>
							<td className={cn(td, "max-w-[180px] @max-[560px]/table:max-w-[110px]")}>
								<Link to="/trade" search={{ symbol: t.symbol }} className="block truncate font-medium hover:underline" title={`${t.symbol} – ${t.name}`}>
									{t.symbol}
								</Link>
							</td>
							<td className={cn(td, "text-fg-2", hideBelow.md)}>{t.author}</td>
							<td className={cn(td, "max-w-[160px] truncate text-fg-2", hideBelow.xl)} title={accountName(t.accountId)}>
								{accountName(t.accountId)}
							</td>
							<td className={cn(td, "text-right tnum", hideBelow.lg)} title={String(t.qty)}>
								{qtyShort(t.qty)}
							</td>
							<td className={cn(td, "text-right tnum", hideBelow.lg)}>{price(t.entryPrice)}</td>
							<td className={cn(td, "text-right tnum", hideBelow.lg)}>{price(t.exitPrice)}</td>
							<td className={cn(td, "text-right tnum text-fg-2", hideBelow.md)}>{duration(t.holdMs)}</td>
							<td className={cn(td, "text-right font-medium tnum", tone(t.pnlCents))} title={`Einstand ${eur(t.costCents)} · Erlös ${eur(t.proceedsCents)} · Gebühren ${eur(t.feesCents)}`}>
								{signedEur(t.pnlCents)}
							</td>
							<td className={cn(td, "text-right tnum", tone(t.r), hideBelow.sm)} title={t.riskCents !== null ? `Risiko bis Stop ${eur(t.riskCents)}` : "ohne Stop im Vorschlag – kein R"}>
								{rText(t.r)}
							</td>
						</tr>
					))}
				</tbody>
			</Table>
			<div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2.5 text-[12px] text-fg-3">
				<span className="tnum">
					{rows.length === trades.length ? `${trades.length === 1 ? "1 Trade" : `${trades.length.toLocaleString("de-DE")} Trades`}` : `${rows.length.toLocaleString("de-DE")} von ${trades.length.toLocaleString("de-DE")}`}
					{total > trades.length ? ` · die neuesten ${trades.length.toLocaleString("de-DE")} von ${total.toLocaleString("de-DE")} im Zeitraum (Kennzahlen zählen alle)` : ""}
				</span>
				{rows.length < trades.length && (
					<Button size="sm" className="ml-auto" onClick={() => setShown((n) => n + PAGE)} data-testid="trades-more">
						{Math.min(PAGE, trades.length - rows.length)} weitere zeigen
					</Button>
				)}
			</div>
		</>
	);
}
