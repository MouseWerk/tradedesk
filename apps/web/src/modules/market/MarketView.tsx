// Markt: Watchlist mit Suche, Kerzenchart mit Zeitraum, Alarme, offene Limits und Agenten-Notizen zum Wert.
// Suche: Pfeiltasten wählen einen Treffer, Eingabe nimmt den markierten – erst, wenn die Treffer zur Eingabe passen.
import { Link, useNavigate, useSearch as useRouteSearch } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { Bell, Check, Plus, Search, ShoppingCart, Trash2, X } from "lucide-react";
import type { Alert, ChartRange, WatchItem } from "@desk/shared";
import { de } from "@/i18n/de";
import { useAgents, useChart, useCockpit, useOverview, useProposals, useSearch, useWatchlist } from "@/lib/api";
import { ago, date, dateTime, numberError, parseDe, pct, price, tone } from "@/lib/format";
import { CandleChart, type RefLine } from "@/ui/charts";
import { Badge, Button, Card, Empty, Field, Input, Segmented, Select, Skeleton, cn } from "@/ui/kit";
import { LoadError } from "@/ui/boundary";
import { FormDialog, useConfirm, useFormErrors } from "@/ui/overlay";
import { Page, QuoteTag, useAction } from "../common";
import { OrderTicket } from "../orders/OrderTicket";

const RANGES: { id: ChartRange; label: string }[] = (["1d", "1mo", "3mo", "6mo", "1y", "5y"] as const).map((id) => ({ id, label: de.market.range[id] }));

const alertLabel = (a: Pick<Alert, "op">) => de.market.op[a.op];

export default function MarketView() {
	const { symbol: wanted } = useRouteSearch({ strict: false }) as { symbol?: string };
	const navigate = useNavigate();
	const { data: watch, isLoading, error, refetch } = useWatchlist();
	const selected = watch?.find((w) => w.symbol === wanted) ?? watch?.[0];
	const [unknown, setUnknown] = useState<string | null>(null);
	const select = (s: string) => void navigate({ to: "/market", search: { symbol: s }, replace: true });
	// unbekanntes ?symbol=: Adresse auf den gezeigten Wert setzen und es sagen
	useEffect(() => {
		if (!watch || !selected || wanted === selected.symbol) return;
		if (wanted) setUnknown(wanted);
		select(selected.symbol);
	}, [watch, wanted, selected?.symbol]); // eslint-disable-line react-hooks/exhaustive-deps
	if (error && !watch)
		return (
			<Page>
				<LoadError error={error} onRetry={() => void refetch()} />
			</Page>
		);
	return (
		<Page>
			{unknown && (
				<p className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-fg-2" role="status">
					{de.market.unknown(unknown)}
					<button type="button" className="ml-auto text-fg-3 underline underline-offset-2 hover:text-fg" onClick={() => setUnknown(null)}>
						{de.market.hide}
					</button>
				</p>
			)}
			<div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-4 @max-[780px]:grid-cols-1">
				<Watchlist items={watch} loading={isLoading} selected={selected?.symbol} onSelect={select} />
				{selected ? (
					<Detail item={selected} />
				) : (
					!isLoading && (
						<Card>
							<Empty>{de.market.empty}</Empty>
						</Card>
					)
				)}
			</div>
		</Page>
	);
}

function Watchlist({ items, loading, selected, onSelect }: { items?: WatchItem[]; loading: boolean; selected?: string; onSelect: (s: string) => void }) {
	const [q, setQ] = useState("");
	const [debounced, setDebounced] = useState("");
	const [active, setActive] = useState(0);
	const [open, setOpen] = useState(false);
	const listId = useId();
	useEffect(() => {
		const t = setTimeout(() => setDebounced(q.trim()), 300);
		return () => clearTimeout(t);
	}, [q]);
	const { data: hits, isFetching } = useSearch(debounced);
	// Treffer gehören zur Eingabe erst, wenn die Pause vorbei ist und nichts mehr lädt – sonst nähme Eingabe den alten
	const current = debounced === q.trim() && !isFetching ? (hits ?? []) : [];
	const watched = new Set((items ?? []).filter((w) => w.watched).map((w) => w.symbol));
	useEffect(() => setActive(0), [debounced]);
	const { run, busy } = useAction();
	const add = async (symbol: string) => {
		if (watched.has(symbol)) {
			setQ("");
			return onSelect(symbol);
		}
		if (await run("/api/market/watchlist", "POST", { symbol }, de.market.added(symbol))) {
			setQ("");
			onSelect(symbol);
		}
	};
	const shown = open && q.trim().length >= 2;
	// ob ein Kurs zu alt ist, weiß der Server je Börse (Handelszeit); ohne Cockpit-Daten gilt keiner als alt
	const { data: cockpit } = useCockpit();
	const stale = new Set(cockpit?.scan.filter((r) => r.quoteStale).map((r) => r.symbol));
	return (
		<Card title={de.market.watchlist} pad={false} className="flex flex-col" aside={`${items?.length ?? 0}`}>
			<div className="relative border-b border-line p-3">
				<Search className="pointer-events-none absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
				<Input
					aria-label={de.market.searchLabel}
					placeholder={de.market.searchPlaceholder}
					className="pl-8"
					role="combobox"
					aria-expanded={shown}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={shown && current[active] ? `${listId}-${active}` : undefined}
					value={q}
					onChange={(e) => {
						setQ(e.target.value);
						setOpen(true);
					}}
					onFocus={() => setOpen(true)}
					onBlur={() => setOpen(false)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							if (q) e.stopPropagation();
							setQ("");
						} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							if (!current.length) return;
							e.preventDefault();
							setActive((i) => (i + (e.key === "ArrowDown" ? 1 : current.length - 1)) % current.length);
						} else if (e.key === "Enter") {
							e.preventDefault();
							if (current[active]) void add(current[active].symbol);
						}
					}}
				/>
				{shown && (
					<div id={listId} className="absolute inset-x-3 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-2xl scroll-thin" role="listbox" aria-label={de.market.results}>
						{!current.length && (isFetching || debounced !== q.trim()) ? (
							<div className="px-3 py-2 text-[12px] text-fg-3">{de.market.searching}</div>
						) : current.length ? (
							current.map((h, i) => {
								const on = watched.has(h.symbol);
								return (
									<div
										key={h.symbol}
										id={`${listId}-${i}`}
										role="option"
										aria-selected={i === active}
										aria-disabled={busy || undefined}
										className={cn("flex w-full cursor-default items-center gap-2 px-3 py-1.5 text-left", i === active ? "bg-surface-3" : "hover:bg-surface-2")}
										onMouseDown={(e) => e.preventDefault()}
										onMouseEnter={() => setActive(i)}
										onClick={() => !busy && void add(h.symbol)}
										data-testid="search-hit"
									>
										<span className="w-20 shrink-0 font-medium">{h.symbol}</span>
										<span className="min-w-0 flex-1 truncate text-fg-2">{h.name}</span>
										<span className="shrink-0 text-[11px] text-fg-3">{h.exchange}</span>
										{on ? (
											<span className="flex shrink-0 items-center gap-1 text-[11px] text-fg-3">
												<Check className="size-3.5" aria-hidden />
												{de.market.onWatchlist}
											</span>
										) : (
											<Plus className="size-3.5 shrink-0 text-fg-3" aria-label={de.market.add} />
										)}
									</div>
								);
							})
						) : (
							<div className="px-3 py-2 text-[12px] text-fg-3">{de.market.nothing}</div>
						)}
					</div>
				)}
			</div>
			<ul className="scroll-thin max-h-[calc(100vh-220px)] overflow-y-auto py-1 @max-[780px]:max-h-72" aria-label={de.market.symbols}>
				{loading && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="mx-3 my-2 h-9" />)}
				{items?.map((w) => {
					const on = w.symbol === selected;
					return (
						<li key={w.symbol}>
							<button
								type="button"
								onClick={() => onSelect(w.symbol)}
								aria-current={on ? "true" : undefined}
								className={cn("flex w-full items-center gap-3 px-4 py-2 text-left", on ? "bg-surface-3" : "hover:bg-surface-2")}
								data-testid="watch-item"
							>
								<span className="flex min-w-0 flex-1 flex-col leading-tight">
									<span className={cn("flex items-center gap-1.5", on && "font-semibold")}>
										{w.symbol}
										{w.held && <Badge className="h-4 px-1 text-[10px]">{de.market.held}</Badge>}
										{w.alerts.some((a) => !a.triggeredAt) && <Bell className="size-3 text-fg-3" aria-label={de.market.alertSet} />}
									</span>
									<span className="flex min-w-0 items-baseline gap-1.5 text-[11.5px] text-fg-3">
										<span className="truncate" title={w.name}>
											{w.name}
										</span>
									</span>
								</span>
								<span className="flex shrink-0 flex-col items-end leading-tight whitespace-nowrap tnum">
									<span className={cn(stale.has(w.symbol) && "text-fg-3")} data-stale={stale.has(w.symbol) || undefined}>
										{price(w.price, w.currency)}
									</span>
									<span className="flex items-baseline gap-1.5">
										<QuoteTag quote={w.quote} stale={stale.has(w.symbol)} className="text-[10.5px]" />
										<span className={cn("text-[11.5px]", stale.has(w.symbol) ? "text-fg-3" : tone(w.changePct))}>{pct(w.changePct)}</span>
									</span>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</Card>
	);
}

function Detail({ item }: { item: WatchItem }) {
	const [range, setRange] = useState<ChartRange>("6mo");
	const { data: shown, isLoading, error } = useChart(item.symbol, range);
	const chart = shown?.symbol === item.symbol ? shown : undefined;
	const { data: ov } = useOverview();
	const { data: proposals } = useProposals();
	const { data: agents } = useAgents();
	const { run } = useAction();
	const confirm = useConfirm();
	const [dialog, setDialog] = useState<"order" | "alert" | null>(null);
	const limits: RefLine[] = (proposals ?? []).filter((p) => p.symbol === item.symbol && p.status === "open" && p.limitPrice).map((p) => ({ value: p.limitPrice!, label: de.market.limitLine(de.market.side[p.side]) }));
	const alerts: RefLine[] = item.alerts.filter((a) => !a.triggeredAt).map((a) => ({ value: a.price, label: de.market.alertLine(alertLabel(a)) }));
	const notes = (agents?.journal ?? []).filter((j) => j.symbol === item.symbol);
	const intraday = range === "1d";
	const remove = async () => {
		if (await confirm({ title: de.market.removeTitle(item.symbol), body: item.held ? de.market.removeHeld : de.market.removeBody, confirm: de.market.remove, danger: true }))
			await run(`/api/market/watchlist/${encodeURIComponent(item.symbol)}`, "DELETE", {}, de.market.removed(item.symbol));
	};
	// Löschen sofort, mit Rückgängig: der Alarm wird mit denselben Werten neu angelegt
	const removeAlert = (a: Alert) =>
		run(`/api/market/alerts/${a.id}`, "DELETE", {}, de.market.alertDeleted(alertLabel(a), price(a.price, item.currency)), {
			label: de.portfolio.undo,
			run: () => void run("/api/market/alerts", "POST", { symbol: item.symbol, op: a.op, price: a.price }, de.market.alertRestored),
		});
	return (
		<div className="flex min-w-0 flex-col gap-4">
			<Card pad={false}>
				<div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-line px-4 py-3">
					<div className="min-w-0">
						<h1 className="truncate text-[16px] font-semibold" title={item.name}>
							{item.name}
						</h1>
						<p className="text-[12px] text-fg-3">
							{item.symbol} · {item.exchange === "CCC" ? de.market.crypto : item.exchange || "–"} · {item.currency} · {de.market.asOf(item.marketTime ? dateTime(item.marketTime) : "–")} · <QuoteTag quote={item.quote} className="text-[12px]" />
						</p>
					</div>
					<div className="flex items-baseline gap-2 tnum">
						<span className="text-[22px] font-semibold" data-testid="quote-price">
							{price(item.price, item.currency)}
						</span>
						<span className={tone(item.changePct)}>{pct(item.changePct)}</span>
					</div>
					<div className="ml-auto flex flex-wrap gap-2">
						<Button variant="primary" onClick={() => setDialog("order")}>
							<ShoppingCart className="size-4" aria-hidden />
							{de.palette.order}
						</Button>
						<Button onClick={() => setDialog("alert")}>
							<Bell className="size-4" aria-hidden />
							{de.market.alertAction}
						</Button>
						{item.watched && (
							<Button size="icon" variant="ghost" onClick={() => void remove()} aria-label={de.market.removeAria(item.symbol)} title={de.market.removeHint}>
								<Trash2 className="size-4" />
							</Button>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2 px-4 pt-3">
					<Segmented label={de.market.rangeLabel} items={RANGES} value={range} onChange={setRange} />
				</div>
				<div className="p-3 pt-2">
					{!chart && !error ? (
						<Skeleton className="h-[340px]" />
					) : error && !chart ? (
						<Empty className="h-[340px] content-center">{(error as Error).message}</Empty>
					) : chart && chart.candles.length ? (
						<CandleChart
							label={de.market.chartLabel(item.symbol, RANGES.find((r) => r.id === range)!.label)}
							candles={chart.candles}
							format={(v) => price(v, chart.currency)}
							timeLabel={(t, long) => (intraday ? new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : long ? date(t) : new Date(t).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }))}
							refs={[...limits, ...alerts]}
							height={340}
						/>
					) : (
						<Empty className="h-[340px] content-center">{isLoading ? de.market.loading : de.market.noCandles}</Empty>
					)}
				</div>
			</Card>
			<div className="grid grid-cols-2 gap-4 @max-[1100px]:grid-cols-1">
				<Card title={de.market.alerts} icon={<Bell className="size-4" />} pad={false}>
					{item.alerts.length ? (
						<ul className="divide-y divide-line">
							{item.alerts.map((a) => (
								<li key={a.id} className="flex items-center gap-3 px-4 py-2 text-[12.5px]">
									<span className="tnum">
										{alertLabel(a)} {price(a.price, item.currency)}
									</span>
									{a.triggeredAt ? <Badge variant="ok">{de.market.triggered(ago(a.triggeredAt))}</Badge> : <Badge>{de.market.active}</Badge>}
									<Button variant="ghost" size="iconSm" className="ml-auto" aria-label={de.market.deleteAlert(alertLabel(a), price(a.price, item.currency))} title={de.market.deleteTitle} onClick={() => void removeAlert(a)}>
										<X className="size-3.5" />
									</Button>
								</li>
							))}
						</ul>
					) : (
						<Empty>{de.market.noAlerts}</Empty>
					)}
				</Card>
				<Card title={de.market.notes} pad={false}>
					{notes.length ? (
						<ul className="divide-y divide-line">
							{notes.map((n) => (
								<li key={n.id} className="px-4 py-2.5 text-[12.5px]">
									<div className="flex items-center gap-2 text-fg-3">
										<span className="font-medium text-fg">{n.author}</span>
										<span>{ago(n.time)}</span>
									</div>
									<p className="mt-0.5 whitespace-pre-line text-fg-2">{n.text}</p>
								</li>
							))}
						</ul>
					) : (
						<Empty>
							{de.market.noNotes(item.symbol)}{" "}
							<Link to="/agents" className="underline">
								{de.market.toJournal}
							</Link>
						</Empty>
					)}
				</Card>
			</div>
			{ov && <OrderTicket open={dialog === "order"} onOpenChange={(o) => setDialog(o ? "order" : null)} accounts={ov.accounts} symbol={item.symbol} />}
			<AlertDialog open={dialog === "alert"} onOpenChange={(o) => setDialog(o ? "alert" : null)} item={item} />
		</div>
	);
}

function AlertDialog({ open, onOpenChange, item }: { open: boolean; onOpenChange: (o: boolean) => void; item: WatchItem }) {
	const [op, setOp] = useState<"above" | "below">("below");
	const [value, setValue] = useState("");
	const errs = useFormErrors(open);
	const { run, busy } = useAction();
	const submit = async () => {
		const v = parseDe(value);
		if (!(v > 0)) return errs.fail("price", numberError(value) ?? de.market.pricePositive);
		if (await run("/api/market/alerts", "POST", { symbol: item.symbol, op, price: v }, de.market.alertCreated(de.market.op[op], price(v, item.currency)))) {
			setValue("");
			onOpenChange(false);
		}
	};
	return (
		<FormDialog open={open} onOpenChange={onOpenChange} title={de.market.alertTitle(item.symbol)} description={de.market.alertDescription(price(item.price, item.currency))} submit={de.market.alertSubmit} onSubmit={() => void submit()} busy={busy} error={errs.general}>
			<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<Field label={de.market.when}>
					{(id, a) => (
						<Select id={id} {...a} value={op} onChange={(e) => setOp(e.target.value as "above" | "below")}>
							<option value="below">{de.market.fallsBelow}</option>
							<option value="above">{de.market.risesAbove}</option>
						</Select>
					)}
				</Field>
				<Field label={de.market.priceField(item.currency)} error={errs.at("price")}>
					{(id, a) => <Input id={id} {...a} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />}
				</Field>
			</div>
		</FormDialog>
	);
}
