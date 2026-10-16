// Depots: Kennzahlen, Positionen, Verlauf, Trades. Manuelle Depots (Trade Republic): Trades erfassen, CSV-Import,
// Ein-/Auszahlungen. Eigene Papierdepots: Orders.
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { FileUp, Landmark, LineChart as LineIcon, Plus, ShoppingCart, Trash2 } from "lucide-react";
import type { AccountDetail, AccountSummary, Trade } from "@desk/shared";
import { sideLabel } from "@desk/shared";
import { useAccount, useOverview } from "@/lib/api";
import { date, dayLabel, eur, parseDe, pct, price, qty, signedEur, tone } from "@/lib/format";
import { LineChart } from "@/ui/charts";
import { Badge, Button, Card, Empty, Field, Input, Select, Skeleton, Stat, Table, Textarea, cn, td, th } from "@/ui/kit";
import { FormDialog } from "@/ui/overlay";
import { Page, PageHead, useAction } from "../common";
import { OrderTicket } from "../orders/OrderTicket";
import { BrokerPanel } from "./BrokerPanel";

const SOURCE: Record<Trade["source"], string> = { manual: "erfasst", import: "Import", proposal: "Vorschlag", order: "Order" };

export default function PortfolioView() {
	const search = useSearch({ strict: false }) as { account?: string };
	const navigate = useNavigate();
	const { data: ov } = useOverview();
	const accounts = ov?.accounts ?? [];
	const accountId = search.account && accounts.some((a) => a.id === search.account) ? search.account : accounts[0]?.id;
	const { data, isLoading } = useAccount(accountId);
	const [dialog, setDialog] = useState<"trade" | "import" | "cash" | "order" | null>(null);
	const a = data?.account;

	return (
		<Page>
			<PageHead
				title={a?.name ?? "Depots"}
				sub={
					a
						? a.kind === "manual"
							? `${a.broker} · manuell geführt: du handelst in der App des Brokers und trägst hier ein`
							: a.kind === "broker"
								? `${a.broker} · Orders gehen nach deiner Freigabe über die API an den Broker${a.live ? " – echtes Geld" : " (Papierkonto)"}`
								: a.owner === "user"
									? "Papierdepot · Orders werden mit echten Kursen simuliert"
									: `Papierdepot von Agent ${a.owner}`
						: undefined
				}
				aside={
					<>
						<Select aria-label="Depot wählen" value={accountId ?? ""} onChange={(e) => void navigate({ to: "/portfolio", search: { account: e.target.value } })} className="w-56">
							<optgroup label="Deine Depots">
								{accounts.filter((x) => x.owner === "user").map((x) => (
									<option key={x.id} value={x.id}>
										{x.name}
									</option>
								))}
							</optgroup>
							<optgroup label="Agenten">
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
									Trade erfassen…
								</Button>
								<Button onClick={() => setDialog("import")}>
									<FileUp className="size-4" aria-hidden />
									<span className="max-md:sr-only">CSV importieren…</span>
								</Button>
							</>
						)}
						{(a?.kind === "paper" || a?.kind === "broker") && a.owner === "user" && (
							<Button variant="primary" onClick={() => setDialog("order")}>
								<ShoppingCart className="size-4" aria-hidden />
								Order…
							</Button>
						)}
						{a?.owner === "user" && (
							<Button onClick={() => setDialog("cash")} title="Ein- oder Auszahlung">
								<Landmark className="size-4" aria-hidden />
								<span className="max-md:sr-only">Ein-/Auszahlung…</span>
							</Button>
						)}
					</>
				}
			/>
			{a?.kind === "broker" && <BrokerPanel account={a} />}
			{isLoading || !data || !a ? (
				<>
					<div className="grid grid-cols-5 gap-3 max-lg:grid-cols-2">
						{[0, 1, 2, 3, 4].map((i) => (
							<Skeleton key={i} className="h-[92px]" />
						))}
					</div>
					<Skeleton className="h-[320px]" />
				</>
			) : (
				<Detail d={data} />
			)}
			{a?.kind === "manual" && (
				<>
					<TradeDialog open={dialog === "trade"} onOpenChange={(o) => setDialog(o ? "trade" : null)} account={a} />
					<ImportDialog open={dialog === "import"} onOpenChange={(o) => setDialog(o ? "import" : null)} account={a} />
				</>
			)}
			{a && <CashDialog open={dialog === "cash"} onOpenChange={(o) => setDialog(o ? "cash" : null)} account={a} />}
			<OrderTicket open={dialog === "order"} onOpenChange={(o) => setDialog(o ? "order" : null)} accounts={accounts} accountId={accountId} />
		</Page>
	);
}

function Detail({ d }: { d: AccountDetail }) {
	const a = d.account;
	const { run } = useAction();
	const del = (t: Trade) =>
		run(`/api/accounts/${a.id}/trades/${t.id}`, "DELETE", {}, `${sideLabel[t.side]} ${qty(t.qty)} ${t.symbol} gelöscht.`, {
			label: "Rückgängig",
			run: () => void run(`/api/accounts/${a.id}/trades/${t.id}/restore`, "POST", {}, "Wiederhergestellt."),
		});
	return (
		<>
			<div className="grid grid-cols-5 gap-3 @max-[1000px]:grid-cols-3 @max-[640px]:grid-cols-2">
				<Stat label="Depotwert" value={eur(a.equityCents)} sub={<span className={tone(a.dayChangeCents)}>{a.dayChangeCents === null ? "–" : `${signedEur(a.dayChangeCents)} heute`}</span>} />
				<Stat label="Cash" value={eur(a.cashCents)} sub={<span className="text-fg-3">{a.equityCents ? pct((a.cashCents / a.equityCents) * 100, { signed: false }) : "–"} des Depots</span>} />
				<Stat label="Unrealisiert" value={<span className={tone(a.unrealizedCents)}>{signedEur(a.unrealizedCents)}</span>} sub={<span className="text-fg-3">auf {eur(a.costCents, { short: true })} Einstand</span>} />
				<Stat label="Realisiert" value={<span className={tone(a.realizedCents)}>{signedEur(a.realizedCents)}</span>} sub={<span className="text-fg-3">nach Gebühren</span>} />
				<Stat label="Gesamtrendite" value={<span className={tone(a.returnPct)}>{pct(a.returnPct)}</span>} sub={<span className="text-fg-3">Gebühren {eur(a.feesCents)}</span>} />
			</div>
			<Card title="Positionen" pad={false} aside={`${d.positions.length} Werte`}>
				{d.positions.length ? (
					<Table label="Positionen">
						<thead>
							<tr>
								<th className={th}>Wertpapier</th>
								<th className={cn(th, "text-right")}>Stück</th>
								<th className={cn(th, "text-right")}>Einstand</th>
								<th className={cn(th, "text-right")}>Kurs</th>
								<th className={cn(th, "text-right")}>Heute</th>
								<th className={cn(th, "text-right")}>Wert</th>
								<th className={cn(th, "text-right")}>G/V</th>
								<th className={cn(th, "text-right")}>Anteil</th>
								<th className={cn(th, "text-right")}>Stop / Ziel</th>
							</tr>
						</thead>
						<tbody>
							{d.positions.map((p) => (
								<tr key={p.symbol} className="hover:bg-surface-2">
									<td className={cn(td, "max-w-[260px]")}>
										<Link to="/market" search={{ symbol: p.symbol }} className="flex min-w-0 flex-col leading-tight hover:underline">
											<span className="font-medium">{p.symbol}</span>
											<span className="truncate text-[11.5px] text-fg-3" title={p.name}>
												{p.name}
											</span>
										</Link>
									</td>
									<td className={cn(td, "text-right tnum")}>{qty(p.qty)}</td>
									<td className={cn(td, "text-right tnum text-fg-2")}>{price(p.avgPrice)}</td>
									<td className={cn(td, "text-right tnum")} title={p.currency !== "EUR" && p.nativePrice !== null ? price(p.nativePrice, p.currency) : undefined}>
										{p.price === null ? <Badge variant="warn">kein Kurs</Badge> : price(p.price)}
									</td>
									<td className={cn(td, "text-right tnum", tone(p.dayChangePct))}>{pct(p.dayChangePct)}</td>
									<td className={cn(td, "text-right tnum font-medium")}>{eur(p.valueCents)}</td>
									<td className={cn(td, "text-right tnum", tone(p.unrealizedCents))}>
										<div className="leading-tight">
											<div>{signedEur(p.unrealizedCents)}</div>
											<div className="text-[11.5px]">{pct(p.unrealizedPct)}</div>
										</div>
									</td>
									<td className={cn(td, "text-right tnum text-fg-2")}>{pct(p.weightPct, { signed: false })}</td>
									<td className={cn(td, "text-right tnum text-fg-3")}>{p.stopLoss || p.takeProfit ? `${price(p.stopLoss, p.currency)} / ${price(p.takeProfit, p.currency)}` : "–"}</td>
								</tr>
							))}
						</tbody>
					</Table>
				) : (
					<Empty>Noch keine Positionen.{a.kind === "manual" ? " Trades erfassen oder per CSV importieren." : ""}</Empty>
				)}
			</Card>
			<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 @max-[1100px]:grid-cols-1">
				<Card title="Verlauf" icon={<LineIcon className="size-4" />}>
					{d.curve.length > 1 ? (
						<LineChart label={`Depotwert ${a.name} je Tag`} xs={d.curve.map((p) => p.day)} xLabel={dayLabel} series={[{ id: "eq", label: "Depotwert", color: "var(--fg)", values: d.curve.map((p) => p.equityCents) }]} format={(v) => eur(v, { short: true })} area height={240} />
					) : (
						<Empty>Der Verlauf beginnt heute.</Empty>
					)}
				</Card>
				<Card title="Ein- und Auszahlungen" pad={false} aside={`Start ${eur(a.startCashCents, { short: true })}`}>
					{d.cashMoves.length ? (
						<ul className="divide-y divide-line">
							{d.cashMoves.map((c) => (
								<li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
									<span className="w-20 text-fg-3 tnum">{date(c.time)}</span>
									<span className="min-w-0 flex-1 truncate text-fg-2">{c.note || (c.amountCents > 0 ? "Einzahlung" : "Auszahlung")}</span>
									<span className={cn("tnum", tone(c.amountCents))}>{signedEur(c.amountCents)}</span>
								</li>
							))}
						</ul>
					) : (
						<Empty>Keine Ein- oder Auszahlungen.</Empty>
					)}
				</Card>
			</div>
			<Card title="Trades" pad={false} aside={`${d.trades.length}`}>
				{d.trades.length ? (
					<Table label="Trades">
						<thead>
							<tr>
								<th className={th}>Datum</th>
								<th className={th}>Art</th>
								<th className={th}>Wertpapier</th>
								<th className={cn(th, "text-right")}>Stück</th>
								<th className={cn(th, "text-right")}>Kurs</th>
								<th className={cn(th, "text-right")}>Betrag</th>
								<th className={cn(th, "text-right")}>Gebühr</th>
								<th className={cn(th, "text-right")}>Ergebnis</th>
								<th className={th}>Quelle</th>
								{a.kind === "manual" && <th className={th}>
									<span className="sr-only">Aktionen</span>
								</th>}
							</tr>
						</thead>
						<tbody>
							{d.trades.map((t) => (
								<tr key={t.id} className="hover:bg-surface-2">
									<td className={cn(td, "tnum text-fg-2")}>{date(t.time)}</td>
									<td className={td}>{sideLabel[t.side]}</td>
									<td className={cn(td, "font-medium")}>{t.symbol}</td>
									<td className={cn(td, "text-right tnum")}>{qty(t.qty)}</td>
									<td className={cn(td, "text-right tnum")}>{price(t.price, t.currency)}</td>
									<td className={cn(td, "text-right tnum")}>{eur(t.valueCents)}</td>
									<td className={cn(td, "text-right tnum text-fg-3")}>{eur(t.feeCents)}</td>
									<td className={cn(td, "text-right tnum", tone(t.realizedCents))}>{t.realizedCents === null ? "" : signedEur(t.realizedCents)}</td>
									<td className={cn(td, "text-fg-3")} title={t.note || undefined}>
										{SOURCE[t.source]}
									</td>
									{a.kind === "manual" && (
										<td className={cn(td, "w-10 text-right")}>
											{(t.source === "manual" || t.source === "import") && (
												<Button variant="ghost" size="iconSm" aria-label={`Trade ${t.symbol} vom ${date(t.time)} löschen`} title="Löschen (mit Rückgängig)" onClick={() => void del(t)}>
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
					<Empty>Noch keine Trades.</Empty>
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
	const [f, setF] = useState({ symbol: "", side: "buy", qty: "", price: "", fee: String(account.feeCents / 100).replace(".", ","), day: today(), note: "" });
	const [err, setErr] = useState<string | null>(null);
	const { run, busy } = useAction();
	const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
	const submit = async () => {
		const q = parseDe(f.qty);
		const p = parseDe(f.price);
		const fee = parseDe(f.fee || "0");
		if (!f.symbol.trim()) return setErr("Symbol fehlt (Yahoo-Schreibweise, z. B. SAP.DE).");
		if (!(q > 0)) return setErr("Stückzahl größer als 0.");
		if (!(p > 0)) return setErr("Kurs in EUR größer als 0.");
		const [y, m, d] = f.day.split("-").map(Number);
		const time = f.day === today() ? Date.now() : new Date(y, m - 1, d, 12).getTime();
		const r = await run("/api/accounts/" + account.id + "/trades", "POST", { symbol: f.symbol, side: f.side, qty: q, price: p, feeEur: Number.isFinite(fee) ? fee : 0, time, note: f.note }, `${f.side === "buy" ? "Kauf" : "Verkauf"} ${f.symbol.toUpperCase()} erfasst.`);
		if (r) {
			setF({ ...f, symbol: "", qty: "", price: "", note: "" });
			onOpenChange(false);
		}
	};
	return (
		<FormDialog open={open} onOpenChange={onOpenChange} title={`Trade in ${account.name} erfassen`} description="Was du in der App des Brokers ausgeführt hast – Beträge in EUR wie in der Abrechnung." submit="Erfassen" onSubmit={() => void submit()} busy={busy} error={err}>
			<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<Field label="Symbol" hint="Yahoo-Schreibweise: SAP.DE, AAPL, EUNL.DE, BTC-EUR">
					{(id) => <Input id={id} value={f.symbol} onChange={set("symbol")} autoFocus autoCapitalize="characters" />}
				</Field>
				<Field label="Art">
					{(id) => (
						<Select id={id} value={f.side} onChange={set("side")}>
							<option value="buy">Kauf</option>
							<option value="sell">Verkauf</option>
						</Select>
					)}
				</Field>
				<Field label="Stück">{(id) => <Input id={id} inputMode="decimal" value={f.qty} onChange={set("qty")} />}</Field>
				<Field label="Kurs je Stück (EUR)">{(id) => <Input id={id} inputMode="decimal" value={f.price} onChange={set("price")} />}</Field>
				<Field label="Gebühr (EUR)">{(id) => <Input id={id} inputMode="decimal" value={f.fee} onChange={set("fee")} />}</Field>
				<Field label="Datum">{(id) => <Input id={id} type="date" value={f.day} max={today()} onChange={set("day")} />}</Field>
			</div>
			<Field label="Notiz (optional)">{(id) => <Input id={id} value={f.note} maxLength={200} onChange={set("note")} />}</Field>
		</FormDialog>
	);
}

function ImportDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account: AccountSummary }) {
	const [csv, setCsv] = useState("");
	const [err, setErr] = useState<string | null>(null);
	const [report, setReport] = useState<string[] | null>(null);
	const { run, busy } = useAction();
	const submit = async () => {
		if (!csv.trim()) return setErr("Datei wählen oder Zeilen einfügen.");
		const r = await run<{ result: { imported: number; skipped: number; errors: string[] } }>(`/api/accounts/${account.id}/import`, "POST", { csv }, (r) => `${r.result.imported} Trades importiert${r.result.skipped ? `, ${r.result.skipped} schon vorhanden` : ""}.`);
		if (r) {
			setReport(r.result.errors);
			if (!r.result.errors.length) {
				setCsv("");
				onOpenChange(false);
			}
		}
	};
	return (
		<FormDialog open={open} onOpenChange={(o) => (setReport(null), setErr(null), onOpenChange(o))} title={`CSV in ${account.name} importieren`} description="Gleiche Zeilen werden beim zweiten Import erkannt und übersprungen." submit="Importieren" onSubmit={() => void submit()} busy={busy} error={err} wide>
			<Field label="Datei">
				{(id) => (
					<Input
						id={id}
						type="file"
						accept=".csv,text/csv,text/plain"
						className="h-auto py-1.5"
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (!file) return;
							if (file.size > 2_000_000) return setErr("Datei größer als 2 MB.");
							void file.text().then(setCsv);
						}}
					/>
				)}
			</Field>
			<Field label="Inhalt" hint="Kopfzeile Pflicht. Datum TT.MM.JJJJ oder JJJJ-MM-TT, Seite kauf/verkauf, Kurs je Stück in EUR.">
				{(id) => <Textarea id={id} value={csv} onChange={(e) => setCsv(e.target.value)} className="font-mono text-[12px]" placeholder={"datum;symbol;seite;stueck;kurs;gebuehr;notiz\n02.03.2026;SAP.DE;kauf;3;181,40;1,00;Sparplan"} rows={8} />}
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
	const [err, setErr] = useState<string | null>(null);
	const { run, busy } = useAction();
	const submit = async () => {
		const v = parseDe(amount);
		if (!(v > 0)) return setErr("Betrag größer als 0.");
		if (await run(`/api/accounts/${account.id}/cash`, "POST", { amountEur: kind === "in" ? v : -v, note }, `${kind === "in" ? "Einzahlung" : "Auszahlung"} erfasst.`)) {
			setAmount("");
			setNote("");
			onOpenChange(false);
		}
	};
	return (
		<FormDialog open={open} onOpenChange={onOpenChange} title={`Ein- oder Auszahlung – ${account.name}`} description={`Cash jetzt ${eur(account.cashCents)}.`} submit="Erfassen" onSubmit={() => void submit()} busy={busy} error={err}>
			<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<Field label="Art">
					{(id) => (
						<Select id={id} value={kind} onChange={(e) => setKind(e.target.value as "in" | "out")}>
							<option value="in">Einzahlung</option>
							<option value="out">Auszahlung</option>
						</Select>
					)}
				</Field>
				<Field label="Betrag (EUR)">{(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />}</Field>
			</div>
			<Field label="Notiz (optional)">{(id) => <Input id={id} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />}</Field>
		</FormDialog>
	);
}
