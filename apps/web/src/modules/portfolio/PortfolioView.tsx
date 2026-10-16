// Depots: Kennzahlen, Positionen, Verlauf, Trades. Manuelle Depots (Trade Republic): Trades erfassen, CSV-Import,
// Ein-/Auszahlungen. Eigene Papier- und Broker-Depots: Orders. Titel und Knöpfe kommen aus der Übersicht (sofort
// richtig nach dem Wechsel), die Details erst, wenn sie zum gewählten Depot gehören – nie die des vorigen.
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FileUp, Landmark, LineChart as LineIcon, Plus, ShoppingCart, Trash2 } from "lucide-react";
import type { AccountDetail, AccountSummary, Trade } from "@desk/shared";
import { sideLabel } from "@desk/shared";
import { useAccount, useOverview } from "@/lib/api";
import { date, dayLabel, eur, inputNumber, numberError, parseDe, pct, price, qty, signedEur, tone, qtyShort } from "@/lib/format";
import { LineChart } from "@/ui/charts";
import { Badge, Button, Card, Empty, Field, Input, Select, Skeleton, Stat, Table, Textarea, cn, hideBelow, td, th } from "@/ui/kit";
import { LoadError } from "@/ui/boundary";
import { FormDialog, useFormErrors } from "@/ui/overlay";
import { Page, PageHead, useAction } from "../common";
import { OrderTicket } from "../orders/OrderTicket";
import { BrokerPanel } from "./BrokerPanel";
import { de } from "@/i18n/de";

/** 5 Kennzahlen ohne leere Lücke: jede Reihe füllt sich ganz (4 + 1 breit statt 3 + 2 mit Loch). */
// fünf Kennzahlen ohne leere Plätze: eine Reihe, darunter 3 + 2, auf dem Handy 2 + 2 + 1 über die ganze Breite
const STATS = "grid grid-cols-5 gap-3 @max-[900px]:grid-cols-6 @max-[480px]:grid-cols-2";
const STAT = "min-w-0 @max-[900px]:col-span-2 @max-[900px]:[&:nth-child(n+4)]:col-span-3 @max-[480px]:col-span-1 @max-[480px]:[&:nth-child(n+4)]:col-span-1 @max-[480px]:last:col-span-2";

export default function PortfolioView() {
	const search = useSearch({ strict: false }) as { account?: string };
	const navigate = useNavigate();
	const { data: ov, error: ovError, refetch: refetchOv } = useOverview();
	const accounts = ov?.accounts ?? [];
	const accountId = search.account && accounts.some((a) => a.id === search.account) ? search.account : accounts[0]?.id;
	const { data: detail, error, refetch } = useAccount(accountId);
	const data = detail?.account.id === accountId ? detail : undefined;
	const [dialog, setDialog] = useState<"trade" | "import" | "cash" | "order" | null>(null);
	const [unknown, setUnknown] = useState<string | null>(null);
	const a = accounts.find((x) => x.id === accountId);

	// unbekanntes ?account=: Adresse auf das gezeigte Depot setzen und es sagen, statt still etwas anderes zu zeigen
	useEffect(() => {
		if (!ov || !accountId || search.account === accountId) return;
		if (search.account) setUnknown(search.account);
		void navigate({ to: "/portfolio", search: { account: accountId }, replace: true });
	}, [ov, accountId, search.account]); // eslint-disable-line react-hooks/exhaustive-deps

	if (ovError && !ov)
		return (
			<Page>
				<LoadError error={ovError} onRetry={() => void refetchOv()} />
			</Page>
		);
	return (
		<Page>
			<PageHead
				title={a?.name ?? de.portfolio.title}
				sub={
					a
						? a.kind === "manual"
							? de.portfolio.subManual(a.broker)
							: a.kind === "broker"
								? a.live
									? de.portfolio.subBrokerLive(a.broker)
									: de.portfolio.subBrokerPaper(a.broker)
								: a.owner === "user"
									? de.portfolio.subPaper
									: de.portfolio.agentPaperDepot(a.owner)
						: undefined
				}
				aside={
					<>
						<Select aria-label={de.portfolio.pickAccount} value={accountId ?? ""} onChange={(e) => void navigate({ to: "/portfolio", search: { account: e.target.value } })} className="w-56">
							<optgroup label={de.portfolio.groupMine}>
								{accounts.filter((x) => x.owner === "user").map((x) => (
									<option key={x.id} value={x.id}>
										{x.name}
									</option>
								))}
							</optgroup>
							<optgroup label={de.agents.title}>
								{accounts.filter((x) => x.owner !== "user").map((x) => (
									<option key={x.id} value={x.id}>
										{x.name}
									</option>
								))}
							</optgroup>
						</Select>
						{a?.kind === "manual" && (
							<>
								<Button variant="primary" onClick={() => setDialog("trade")}>
									<Plus className="size-4" aria-hidden />
									{de.portfolio.recordTrade}
								</Button>
								<Button onClick={() => setDialog("import")} title={de.portfolio.importCsv} aria-label={de.portfolio.importCsv}>
									<FileUp className="size-4" aria-hidden />
									<span className="@max-[1000px]:sr-only">{de.portfolio.importCsv}</span>
								</Button>
							</>
						)}
						{(a?.kind === "paper" || a?.kind === "broker") && a.owner === "user" && (
							<Button variant="primary" onClick={() => setDialog("order")}>
								<ShoppingCart className="size-4" aria-hidden />
								{de.portfolio.order}
							</Button>
						)}
						{a?.owner === "user" && (
							<Button onClick={() => setDialog("cash")} title={de.portfolio.cashMoveLong} aria-label={de.portfolio.cashMoveLong}>
								<Landmark className="size-4" aria-hidden />
								<span className="@max-[1000px]:sr-only">{de.portfolio.cashMoveShort}</span>
							</Button>
						)}
					</>
				}
			/>
			{unknown && (
				<p className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-fg-2" role="status">
					{de.portfolio.unknownAccount(unknown, a?.name ?? de.portfolio.firstAccount)}
					<button type="button" className="ml-auto text-fg-3 underline underline-offset-2 hover:text-fg" onClick={() => setUnknown(null)}>
						{de.portfolio.dismiss}
					</button>
				</p>
			)}
			{a?.kind === "broker" && <BrokerPanel account={a} />}
			{error && !data ? (
				<LoadError error={error} onRetry={() => void refetch()} />
			) : !data ? (
				<>
					<div className={STATS}>
						{[0, 1, 2, 3, 4].map((i) => (
							<Skeleton key={i} className={cn(STAT, "h-[92px]")} />
						))}
					</div>
					<Skeleton className="h-[320px]" />
				</>
			) : (
				<Detail d={data} />
			)}
			{a?.kind === "manual" && (
				<>
					<TradeDialog key={a.id} open={dialog === "trade"} onOpenChange={(o) => setDialog(o ? "trade" : null)} account={a} />
					<ImportDialog open={dialog === "import"} onOpenChange={(o) => setDialog(o ? "import" : null)} account={a} />
				</>
			)}
			{a && <CashDialog key={a.id} open={dialog === "cash"} onOpenChange={(o) => setDialog(o ? "cash" : null)} account={a} />}
			<OrderTicket open={dialog === "order"} onOpenChange={(o) => setDialog(o ? "order" : null)} accounts={accounts} accountId={accountId} />
		</Page>
	);
}

function Detail({ d }: { d: AccountDetail }) {
	const a = d.account;
	const { run } = useAction();
	const del = (t: Trade) =>
		run(`/api/accounts/${a.id}/trades/${t.id}`, "DELETE", {}, de.portfolio.deleted(sideLabel[t.side], qty(t.qty), t.symbol), {
			label: de.portfolio.undo,
			run: () => void run(`/api/accounts/${a.id}/trades/${t.id}/restore`, "POST", {}, de.portfolio.restored),
		});
	return (
		<>
			<div className={STATS}>
				<Stat className={STAT} label={de.portfolio.stat.equity} value={eur(a.equityCents)} sub={<span className={tone(a.dayChangeCents)}>{a.dayChangeCents === null ? "–" : de.portfolio.today(signedEur(a.dayChangeCents))}</span>} />
				<Stat className={STAT} label={de.portfolio.stat.cash} value={eur(a.cashCents)} sub={<span className="text-fg-3">{de.portfolio.stat.cashShare(a.equityCents ? pct((a.cashCents / a.equityCents) * 100, { signed: false }) : "–")}</span>} />
				<Stat className={STAT} label={de.portfolio.stat.unrealized} value={<span className={tone(a.unrealizedCents)}>{signedEur(a.unrealizedCents)}</span>} sub={<span className="text-fg-3">{de.portfolio.stat.onCost(eur(a.costCents, { short: true }))}</span>} />
				<Stat className={STAT} label={de.portfolio.stat.realized} value={<span className={tone(a.realizedCents)}>{signedEur(a.realizedCents)}</span>} sub={<span className="text-fg-3">{de.portfolio.stat.afterFees}</span>} />
				<Stat className={STAT} label={de.portfolio.stat.totalReturn} value={<span className={tone(a.returnPct)}>{pct(a.returnPct)}</span>} sub={<span className="text-fg-3">{de.portfolio.stat.fees(eur(a.feesCents))}</span>} />
			</div>
			<Card title={de.portfolio.positions.title} pad={false} aside={de.portfolio.positions.count(d.positions.length)}>
				{d.positions.length ? (
					<Table label={de.portfolio.positions.title}>
						<thead>
							<tr>
								<th className={th}>{de.portfolio.positions.security}</th>
								<th className={cn(th, "text-right", hideBelow.md)}>{de.portfolio.positions.qty}</th>
								<th className={cn(th, "text-right", hideBelow.lg)}>{de.portfolio.positions.cost}</th>
								<th className={cn(th, "text-right", hideBelow.sm)}>{de.portfolio.positions.price}</th>
								<th className={cn(th, "text-right", hideBelow.sm)}>{de.portfolio.positions.today}</th>
								<th className={cn(th, "text-right")}>{de.portfolio.positions.value}</th>
								<th className={cn(th, "text-right")}>{de.portfolio.positions.pnl}</th>
								<th className={cn(th, "text-right", hideBelow.xl)}>{de.portfolio.positions.weight}</th>
								<th className={cn(th, "text-right", hideBelow.lg)}>{de.portfolio.positions.stopTarget}</th>
							</tr>
						</thead>
						<tbody>
							{d.positions.map((p) => {
								const foreign = p.currency !== "EUR";
								const fx = p.price && p.nativePrice ? p.price / p.nativePrice : null;
								const inEur = (v: number | null) => (v === null ? "–" : foreign ? (fx ? `≈ ${price(v * fx)}` : "–") : price(v));
								return (
									<tr key={p.symbol} className="hover:bg-surface-2" data-testid="position" data-symbol={p.symbol}>
										<td className={cn(td, "max-w-[220px] @max-[560px]/table:max-w-[96px]")}>
											<Link to="/market" search={{ symbol: p.symbol }} className="flex min-w-0 flex-col leading-tight hover:underline">
												<span className="font-medium">{p.symbol}</span>
												<span className="truncate text-[11.5px] text-fg-3" title={p.name}>
													{p.name}
												</span>
											</Link>
										</td>
										<td className={cn(td, "text-right tnum", hideBelow.md)} title={qty(p.qty)}>{qtyShort(p.qty)}</td>
										<td className={cn(td, "text-right tnum text-fg-2", hideBelow.lg)}>{price(p.avgPrice)}</td>
										<td className={cn(td, "text-right tnum", hideBelow.sm)}>
											{p.price === null ? (
												<Badge variant="warn">{de.portfolio.positions.noQuote}</Badge>
											) : (
												<span className="flex flex-col leading-tight">
													<span>{price(p.price)}</span>
													{foreign && p.nativePrice !== null && <span className="text-[11px] text-fg-3">{price(p.nativePrice, p.currency)}</span>}
												</span>
											)}
										</td>
										<td className={cn(td, "text-right tnum", tone(p.dayChangePct), hideBelow.sm)}>{pct(p.dayChangePct)}</td>
										<td className={cn(td, "text-right tnum")}>
											<span className="flex flex-col leading-tight">
												<span className="font-medium">{eur(p.valueCents)}</span>
												{/* schmal: „Heute“ wandert unter den Wert statt in eine eigene Spalte */}
												<span className={cn("hidden text-[11px] @max-[560px]/table:block", tone(p.dayChangePct))}>{de.portfolio.today(pct(p.dayChangePct))}</span>
											</span>
										</td>
										<td className={cn(td, "text-right tnum", tone(p.unrealizedCents))}>
											<div className="leading-tight">
												<div>{signedEur(p.unrealizedCents)}</div>
												<div className="text-[11.5px]">{pct(p.unrealizedPct)}</div>
											</div>
										</td>
										<td className={cn(td, "text-right tnum text-fg-2", hideBelow.xl)}>{pct(p.weightPct, { signed: false })}</td>
										<td className={cn(td, "text-right tnum text-fg-3", hideBelow.lg)}>
											{p.stopLoss || p.takeProfit ? (
												<span className="flex flex-col leading-tight">
													<span>
														{inEur(p.stopLoss)} / {inEur(p.takeProfit)}
													</span>
													{foreign && (
														<span className="text-[11px]">
															{price(p.stopLoss, p.currency)} / {price(p.takeProfit, p.currency)}
														</span>
													)}
												</span>
											) : (
												"–"
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</Table>
				) : (
					<Empty>
						{de.portfolio.positions.empty}
						{a.kind === "manual" ? de.portfolio.positions.emptyManual : ""}
					</Empty>
				)}
			</Card>
			<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-4 @max-[1100px]:grid-cols-1">
				<Card title={de.portfolio.curve.title} icon={<LineIcon className="size-4" />}>
					{d.curve.length > 1 ? (
						<LineChart label={de.portfolio.curve.chartLabel(a.name)} xs={d.curve.map((p) => p.day)} xLabel={dayLabel} series={[{ id: "eq", label: de.portfolio.stat.equity, color: "var(--fg)", values: d.curve.map((p) => p.equityCents) }]} format={(v) => eur(v, { short: true })} area height={240} />
					) : (
						<Empty>{de.portfolio.curve.empty}</Empty>
					)}
				</Card>
				<Card title={de.portfolio.cash.title} pad={false} aside={de.portfolio.cash.start(eur(a.startCashCents, { short: true }))}>
					{d.cashMoves.length ? (
						<ul className="divide-y divide-line">
							{d.cashMoves.map((c) => (
								<li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
									<span className="w-20 text-fg-3 tnum">{date(c.time)}</span>
									<span className="min-w-0 flex-1 truncate text-fg-2">{c.note || (c.amountCents > 0 ? de.portfolio.cash.deposit : de.portfolio.cash.withdrawal)}</span>
									<span className={cn("tnum", tone(c.amountCents))}>{signedEur(c.amountCents)}</span>
								</li>
							))}
						</ul>
					) : (
						<Empty>{de.portfolio.cash.empty}</Empty>
					)}
				</Card>
			</div>
			<Card title={de.portfolio.trades.title} pad={false} aside={`${d.trades.length}`}>
				{d.trades.length ? (
					<Table label={de.portfolio.trades.title}>
						<thead>
							<tr>
								<th className={th}>{de.portfolio.trades.date}</th>
								<th className={th}>{de.portfolio.positions.security}</th>
								<th className={cn(th, "text-right", hideBelow.sm)}>{de.portfolio.positions.qty}</th>
								<th className={cn(th, "text-right", hideBelow.md)}>{de.portfolio.trades.price}</th>
								<th className={cn(th, "text-right")}>{de.portfolio.trades.amount}</th>
								<th className={cn(th, "text-right", hideBelow.lg)}>{de.portfolio.trades.fee}</th>
								<th className={cn(th, "text-right")}>{de.portfolio.trades.result}</th>
								<th className={cn(th, hideBelow.xl)}>{de.portfolio.trades.source}</th>
								{a.kind === "manual" && (
									<th className={th}>
										<span className="sr-only">{de.portfolio.trades.actions}</span>
									</th>
								)}
							</tr>
						</thead>
						<tbody>
							{d.trades.map((t) => (
								<tr key={t.id} className="hover:bg-surface-2">
									<td className={cn(td, "tnum text-fg-2")}>{date(t.time)}</td>
									<td className={td}>
										<span className="flex flex-col leading-tight">
											<span className="font-medium">{t.symbol}</span>
											<span className="text-[11.5px] text-fg-3">{sideLabel[t.side]}</span>
										</span>
									</td>
									<td className={cn(td, "text-right tnum", hideBelow.sm)}>{qty(t.qty)}</td>
									<td className={cn(td, "text-right tnum", hideBelow.md)}>{price(t.price, t.currency)}</td>
									<td className={cn(td, "text-right tnum")}>{eur(t.valueCents)}</td>
									<td className={cn(td, "text-right tnum text-fg-3", hideBelow.lg)}>{eur(t.feeCents)}</td>
									<td className={cn(td, "text-right tnum", tone(t.realizedCents))}>{t.realizedCents === null ? "" : signedEur(t.realizedCents)}</td>
									<td className={cn(td, "text-fg-3", hideBelow.xl)} title={t.note || undefined}>
										{de.portfolio.source[t.source]}
									</td>
									{a.kind === "manual" && (
										<td className={cn(td, "w-10 text-right")}>
											{(t.source === "manual" || t.source === "import") && (
												<Button variant="ghost" size="iconSm" aria-label={de.portfolio.trades.deleteLabel(sideLabel[t.side], t.symbol, date(t.time))} title={de.portfolio.trades.deleteTitle} onClick={() => void del(t)}>
													<Trash2 className="size-3.5" />
												</Button>
											)}
										</td>
									)}
								</tr>
							))}
						</tbody>
					</Table>
				) : (
					<Empty>{de.portfolio.trades.empty}</Empty>
				)}
			</Card>
		</>
	);
}

function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function TradeDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account: AccountSummary }) {
	const [f, setF] = useState({ symbol: "", side: "buy", qty: "", price: "", fee: inputNumber(account.feeCents / 100), day: today(), note: "" });
	const errs = useFormErrors(open);
	const { run, busy } = useAction();
	const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
	const submit = async () => {
		const q = parseDe(f.qty);
		const p = parseDe(f.price);
		const fee = parseDe(f.fee || "0");
		if (!f.symbol.trim()) return errs.fail("symbol", de.portfolio.tradeDialog.errSymbol);
		if (!(q > 0)) return errs.fail("qty", numberError(f.qty) ?? de.portfolio.tradeDialog.errQty);
		if (!(p > 0)) return errs.fail("price", numberError(f.price) ?? de.portfolio.tradeDialog.errPrice);
		if (f.fee && !(fee >= 0)) return errs.fail("fee", numberError(f.fee) ?? de.portfolio.tradeDialog.errFee);
		// ein geleertes Datum würde sonst als null gesendet und der Server bucht still „jetzt“
		if (!/^\d{4}-\d{2}-\d{2}$/.test(f.day)) return errs.fail("day", de.portfolio.tradeDialog.errDateMissing);
		if (f.day > today()) return errs.fail("day", de.portfolio.tradeDialog.errDateFuture);
		const [y, m, d] = f.day.split("-").map(Number);
		const time = f.day === today() ? Date.now() : new Date(y, m - 1, d, 12).getTime();
		const r = await run("/api/accounts/" + account.id + "/trades", "POST", { symbol: f.symbol, side: f.side, qty: q, price: p, feeEur: Number.isFinite(fee) ? fee : 0, time, note: f.note }, de.portfolio.tradeDialog.recorded(f.side === "buy" ? de.portfolio.tradeDialog.buy : de.portfolio.tradeDialog.sell, f.symbol.toUpperCase()));
		if (r) {
			setF({ ...f, symbol: "", qty: "", price: "", note: "" });
			onOpenChange(false);
		}
	};
	return (
		<FormDialog open={open} onOpenChange={onOpenChange} title={de.portfolio.tradeDialog.title(account.name)} description={de.portfolio.tradeDialog.description} submit={de.portfolio.tradeDialog.submit} onSubmit={() => void submit()} busy={busy} error={errs.general}>
			<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<Field label={de.portfolio.tradeDialog.symbol} hint={de.portfolio.tradeDialog.symbolHint} error={errs.at("symbol")}>
					{(id, a) => <Input id={id} {...a} value={f.symbol} onChange={set("symbol")} autoFocus autoCapitalize="characters" />}
				</Field>
				<Field label={de.portfolio.tradeDialog.kind}>
					{(id, a) => (
						<Select id={id} {...a} value={f.side} onChange={set("side")}>
							<option value="buy">{de.portfolio.tradeDialog.buy}</option>
							<option value="sell">{de.portfolio.tradeDialog.sell}</option>
						</Select>
					)}
				</Field>
				<Field label={de.portfolio.positions.qty} error={errs.at("qty")}>
					{(id, a) => <Input id={id} {...a} inputMode="decimal" value={f.qty} onChange={set("qty")} />}
				</Field>
				<Field label={de.portfolio.tradeDialog.price} error={errs.at("price")}>
					{(id, a) => <Input id={id} {...a} inputMode="decimal" value={f.price} onChange={set("price")} />}
				</Field>
				<Field label={de.portfolio.tradeDialog.fee} error={errs.at("fee")}>
					{(id, a) => <Input id={id} {...a} inputMode="decimal" value={f.fee} onChange={set("fee")} />}
				</Field>
				<Field label={de.portfolio.trades.date} error={errs.at("day")}>
					{(id, a) => <Input id={id} {...a} type="date" value={f.day} max={today()} onChange={set("day")} />}
				</Field>
			</div>
			<Field label={de.portfolio.tradeDialog.note}>{(id, a) => <Input id={id} {...a} value={f.note} maxLength={200} onChange={set("note")} />}</Field>
		</FormDialog>
	);
}

function ImportDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account: AccountSummary }) {
	const [csv, setCsv] = useState("");
	const errs = useFormErrors(open);
	const [report, setReport] = useState<string[] | null>(null);
	const { run, busy } = useAction();
	useEffect(() => {
		if (open) setReport(null);
	}, [open]);
	const submit = async () => {
		if (!csv.trim()) return errs.fail("csv", de.portfolio.importDialog.errEmpty);
		const r = await run<{ result: { imported: number; skipped: number; errors: string[] } }>(`/api/accounts/${account.id}/import`, "POST", { csv }, (r) => de.portfolio.importDialog.imported(r.result.imported, r.result.skipped));
		if (r) {
			setReport(r.result.errors);
			if (!r.result.errors.length) {
				setCsv("");
				onOpenChange(false);
			}
		}
	};
	return (
		<FormDialog open={open} onOpenChange={onOpenChange} title={de.portfolio.importDialog.title(account.name)} description={de.portfolio.importDialog.description} submit={de.portfolio.importDialog.submit} onSubmit={() => void submit()} busy={busy} error={errs.general} wide>
			<Field label={de.portfolio.importDialog.file} error={errs.at("file")}>
				{(id, a) => (
					<Input
						id={id}
						{...a}
						type="file"
						accept=".csv,text/csv,text/plain"
						className="h-auto py-1.5"
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (!file) return;
							if (file.size > 2_000_000) return errs.fail("file", de.portfolio.importDialog.errTooLarge);
							errs.clear();
							void file.text().then(setCsv);
						}}
					/>
				)}
			</Field>
			<Field label={de.portfolio.importDialog.content} hint={de.portfolio.importDialog.contentHint} error={errs.at("csv")}>
				{(id, a) => <Textarea id={id} {...a} value={csv} onChange={(e) => setCsv(e.target.value)} className="font-mono text-[12px]" placeholder={de.portfolio.importDialog.placeholder} rows={8} />}
			</Field>
			{report && report.length > 0 && (
				<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn">
					{report.map((r) => (
						<li key={r}>{r}</li>
					))}
				</ul>
			)}
		</FormDialog>
	);
}

function CashDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account: AccountSummary }) {
	const [amount, setAmount] = useState("");
	const [kind, setKind] = useState<"in" | "out">("in");
	const [note, setNote] = useState("");
	const errs = useFormErrors(open);
	const { run, busy } = useAction();
	const submit = async () => {
		const v = parseDe(amount);
		if (!(v > 0)) return errs.fail("amount", numberError(amount) ?? de.portfolio.cashDialog.errAmount);
		if (await run(`/api/accounts/${account.id}/cash`, "POST", { amountEur: kind === "in" ? v : -v, note }, de.portfolio.cashDialog.recorded(kind === "in" ? de.portfolio.cash.deposit : de.portfolio.cash.withdrawal, eur(Math.round(v * 100))))) {
			setAmount("");
			setNote("");
			onOpenChange(false);
		}
	};
	const v = parseDe(amount);
	return (
		<FormDialog open={open} onOpenChange={onOpenChange} title={de.portfolio.cashDialog.title(account.name)} description={de.portfolio.cashDialog.description(eur(account.cashCents))} submit={de.portfolio.tradeDialog.submit} onSubmit={() => void submit()} busy={busy} error={errs.general}>
			<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<Field label={de.portfolio.tradeDialog.kind}>
					{(id, a) => (
						<Select id={id} {...a} value={kind} onChange={(e) => setKind(e.target.value as "in" | "out")}>
							<option value="in">{de.portfolio.cash.deposit}</option>
							<option value="out">{de.portfolio.cash.withdrawal}</option>
						</Select>
					)}
				</Field>
				<Field label={de.portfolio.cashDialog.amount} hint={v > 0 ? `= ${eur(Math.round(v * 100))}` : de.portfolio.cashDialog.amountExample} error={errs.at("amount")}>
					{(id, a) => <Input id={id} {...a} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />}
				</Field>
			</div>
			<Field label={de.portfolio.tradeDialog.note}>{(id, a) => <Input id={id} {...a} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />}</Field>
		</FormDialog>
	);
}
