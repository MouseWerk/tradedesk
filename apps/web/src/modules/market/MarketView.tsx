// Markt: Watchlist mit Suche, Kerzenchart mit Zeitraum, Alarme, offene Limits und Agenten-Notizen zum Wert.
// Suche: Pfeiltasten wählen einen Treffer, Eingabe nimmt den markierten – erst, wenn die Treffer zur Eingabe passen.
import { Link, useNavigate, useSearch as useRouteSearch } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { Bell, Check, Plus, Search, ShoppingCart, Trash2, X } from "lucide-react";
import type { Alert, ChartRange, WatchItem } from "@desk/shared";
import { useAgents, useChart, useCockpit, useOverview, useProposals, useSearch, useWatchlist } from "@/lib/api";
import { ago, date, dateTime, numberError, parseDe, pct, price, tone } from "@/lib/format";
import { CandleChart, type RefLine } from "@/ui/charts";
import { Badge, Button, Card, Empty, Field, Input, Segmented, Select, Skeleton, cn } from "@/ui/kit";
import { LoadError } from "@/ui/boundary";
import { FormDialog, useConfirm, useFormErrors } from "@/ui/overlay";
import { Page, QuoteTag, useAction } from "../common";
import { OrderTicket } from "../orders/OrderTicket";

const RANGES: { id: ChartRange; label: string }[] = [
	{ id: "1d", label: "1 T" },
	{ id: "1mo", label: "1 M" },
	{ id: "3mo", label: "3 M" },
	{ id: "6mo", label: "6 M" },
	{ id: "1y", label: "1 J" },
	{ id: "5y", label: "5 J" },
];

const alertLabel = (a: Pick<Alert, "op">) => (a.op === "above" ? "über" : "unter");

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
					„{unknown}“ ist nicht auf der Watchlist – links suchen und hinzufügen.
					<button type="button" className="ml-auto text-fg-3 underline underline-offset-2 hover:text-fg" onClick={() => setUnknown(null)}>
						Ausblenden
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
							<Empty>Die Watchlist ist leer – links ein Wertpapier suchen und hinzufügen.</Empty>
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
		if (await run("/api/market/watchlist", "POST", { symbol }, `${symbol} auf der Watchlist.`)) {
			setQ("");
			onSelect(symbol);
		}
	};
	const shown = open && q.trim().length >= 2;
	// ob ein Kurs zu alt ist, weiß der Server je Börse (Handelszeit); ohne Cockpit-Daten gilt keiner als alt
	const { data: cockpit } = useCockpit();
	const stale = new Set(cockpit?.scan.filter((r) => r.quoteStale).map((r) => r.symbol));
	return (
		<Card title="Watchlist" pad={false} className="flex flex-col" aside={`${items?.length ?? 0}`}>
			<div className="relative border-b border-line p-3">
				<Search className="pointer-events-none absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
				<Input
					aria-label="Wertpapier suchen"
					placeholder="Suchen: Name, Symbol, ISIN…"
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
					<div id={listId} className="absolute inset-x-3 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-2xl scroll-thin" role="listbox" aria-label="Suchergebnisse">
						{!current.length && (isFetching || debounced !== q.trim()) ? (
							<div className="px-3 py-2 text-[12px] text-fg-3">Suche…</div>
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
												auf der Watchlist
											</span>
										) : (
											<Plus className="size-3.5 shrink-0 text-fg-3" aria-label="hinzufügen" />
										)}
									</div>
								);
							})
						) : (
							<div className="px-3 py-2 text-[12px] text-fg-3">Nichts gefunden.</div>
						)}
					</div>
				)}
			</div>
			<ul className="scroll-thin max-h-[calc(100vh-220px)] overflow-y-auto py-1 @max-[780px]:max-h-72" aria-label="Werte">
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
										{w.held && <Badge className="h-4 px-1 text-[10px]">Depot</Badge>}
										{w.alerts.some((a) => !a.triggeredAt) && <Bell className="size-3 text-fg-3" aria-label="Alarm gesetzt" />}
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
	const limits: RefLine[] = (proposals ?? []).filter((p) => p.symbol === item.symbol && p.status === "open" && p.limitPrice).map((p) => ({ value: p.limitPrice!, label: `Limit ${p.side === "buy" ? "Kauf" : "Verkauf"}` }));
	const alerts: RefLine[] = item.alerts.filter((a) => !a.triggeredAt).map((a) => ({ value: a.price, label: `Alarm ${alertLabel(a)}` }));
	const notes = (agents?.journal ?? []).filter((j) => j.symbol === item.symbol);
	const intraday = range === "1d";
	const remove = async () => {
		if (await confirm({ title: `${item.symbol} von der Watchlist nehmen?`, body: item.held ? "Der Wert bleibt sichtbar, solange er in einem Depot liegt." : "Agenten können ihn danach nicht mehr vorschlagen.", confirm: "Entfernen", danger: true }))
			await run(`/api/market/watchlist/${encodeURIComponent(item.symbol)}`, "DELETE", {}, `${item.symbol} entfernt.`);
	};
	// Löschen sofort, mit Rückgängig: der Alarm wird mit denselben Werten neu angelegt
	const removeAlert = (a: Alert) =>
		run(`/api/market/alerts/${a.id}`, "DELETE", {}, `Alarm ${alertLabel(a)} ${price(a.price, item.currency)} gelöscht.`, {
			label: "Rückgängig",
			run: () => void run("/api/market/alerts", "POST", { symbol: item.symbol, op: a.op, price: a.price }, "Alarm wiederhergestellt."),
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
							{item.symbol} · {item.exchange === "CCC" ? "Krypto" : item.exchange || "–"} · {item.currency} · Stand {item.marketTime ? dateTime(item.marketTime) : "–"} · <QuoteTag quote={item.quote} className="text-[12px]" />
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
							Order…
						</Button>
						<Button onClick={() => setDialog("alert")}>
							<Bell className="size-4" aria-hidden />
							Alarm…
						</Button>
						{item.watched && (
							<Button size="icon" variant="ghost" onClick={() => void remove()} aria-label={`${item.symbol} von der Watchlist nehmen…`} title="Von der Watchlist nehmen…">
								<Trash2 className="size-4" />
							</Button>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2 px-4 pt-3">
					<Segmented label="Zeitraum" items={RANGES} value={range} onChange={setRange} />
				</div>
				<div className="p-3 pt-2">
					{!chart && !error ? (
						<Skeleton className="h-[340px]" />
					) : error && !chart ? (
						<Empty className="h-[340px] content-center">{(error as Error).message}</Empty>
					) : chart && chart.candles.length ? (
						<CandleChart
							label={`Kursverlauf ${item.symbol}, ${RANGES.find((r) => r.id === range)!.label}`}
							candles={chart.candles}
							format={(v) => price(v, chart.currency)}
							timeLabel={(t, long) => (intraday ? new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : long ? date(t) : new Date(t).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }))}
							refs={[...limits, ...alerts]}
							height={340}
						/>
					) : (
						<Empty className="h-[340px] content-center">{isLoading ? "Lade Kurse…" : "Für diesen Zeitraum gibt es keine Kurse."}</Empty>
					)}
				</div>
			</Card>
			<div className="grid grid-cols-2 gap-4 @max-[1100px]:grid-cols-1">
				<Card title="Alarme" icon={<Bell className="size-4" />} pad={false}>
					{item.alerts.length ? (
						<ul className="divide-y divide-line">
							{item.alerts.map((a) => (
								<li key={a.id} className="flex items-center gap-3 px-4 py-2 text-[12.5px]">
									<span className="tnum">
										{alertLabel(a)} {price(a.price, item.currency)}
									</span>
									{a.triggeredAt ? <Badge variant="ok">ausgelöst {ago(a.triggeredAt)}</Badge> : <Badge>aktiv</Badge>}
									<Button variant="ghost" size="iconSm" className="ml-auto" aria-label={`Alarm ${alertLabel(a)} ${price(a.price, item.currency)} löschen`} title="Löschen (mit Rückgängig)" onClick={() => void removeAlert(a)}>
										<X className="size-3.5" />
									</Button>
								</li>
							))}
						</ul>
					) : (
						<Empty>Kein Alarm. Ausgelöste Alarme erscheinen im Verlauf der Übersicht.</Empty>
					)}
				</Card>
				<Card title="Notizen der Agenten" pad={false}>
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
							Keine Notizen zu {item.symbol}.{" "}
							<Link to="/agents" className="underline">
								Zum Journal
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
		if (!(v > 0)) return errs.fail("price", numberError(value) ?? "Kurs größer als 0.");
		if (await run("/api/market/alerts", "POST", { symbol: item.symbol, op, price: v }, `Alarm ${op === "above" ? "über" : "unter"} ${price(v, item.currency)} gesetzt.`)) {
			setValue("");
			onOpenChange(false);
		}
	};
	return (
		<FormDialog open={open} onOpenChange={onOpenChange} title={`Alarm für ${item.symbol}`} description={`Jetzt ${price(item.price, item.currency)}. Der Alarm erscheint einmal im Verlauf.`} submit="Alarm setzen" onSubmit={() => void submit()} busy={busy} error={errs.general}>
			<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<Field label="Wenn der Kurs">
					{(id, a) => (
						<Select id={id} {...a} value={op} onChange={(e) => setOp(e.target.value as "above" | "below")}>
							<option value="below">fällt unter</option>
							<option value="above">steigt über</option>
						</Select>
					)}
				</Field>
				<Field label={`Kurs (${item.currency})`} error={errs.at("price")}>
					{(id, a) => <Input id={id} {...a} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />}
				</Field>
			</div>
		</FormDialog>
	);
}
