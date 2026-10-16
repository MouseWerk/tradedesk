// Order-Rechner: Stückzahl aus Risiko-Budget und Stop (inkl. beider Gebühren), Ziel in R, Probelauf der Risikoprüfung.
// Papierdepot: Order nach einer Bestätigung. Broker-Depot: dieselbe Bestätigung mit allen Angaben (startet auf
// „Abbrechen“), echtes Geld steht dabei. Manuelles Depot (Trade Republic): zeigt, was du in der App eingibst.
// Der Probelauf gehört zu den Eingaben, für die er kam: solange er für die aktuellen noch läuft, ist Senden gesperrt.
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Calculator, TriangleAlert } from "lucide-react";
import type { AccountSummary, Cockpit, Proposal, ScanRow, Side } from "@desk/shared";
import { orderValueCents, positionSize, riskToStopCents } from "@desk/shared";
import { useRisk } from "@/lib/api";
import { eur, hhmm, inputNumber, num, parseDe, price, priceDigits, qty as fmtQty } from "@/lib/format";
import { fxFromCheck, fxFromData, orderResultText, sizingReason, useDryRun, type OrderBody } from "@/lib/orders";
import { Button, Card, Field, Input, Segmented, Select } from "@/ui/kit";
import { useConfirm } from "@/ui/overlay";
import { de } from "@/i18n/de";
import { useAction } from "../common";

const PROBE_QTY = 1000; // Probelauf nur für den Wechselkurs: große Menge, damit die Rundung auf Cent nicht ins Gewicht fällt

export function OrderCalc({ row, cockpit, proposals, accounts, side, onSide, focusSignal }: { row: ScanRow; cockpit: Cockpit; proposals: Proposal[]; accounts: AccountSummary[]; side: Side; onSide: (s: Side) => void; focusSignal: number }) {
	const mine = accounts.filter((a) => a.owner === "user");
	const { data: risk } = useRisk();
	const [accId, setAccId] = useState(mine.find((a) => a.kind === "paper")?.id ?? mine[0]?.id ?? "");
	const acc = mine.find((a) => a.id === accId) ?? mine[0];
	const limits = risk?.accounts.find((x) => x.account.id === acc?.id)?.limits;
	const position = cockpit.positions.find((p) => p.symbol === row.symbol && p.accountId === acc?.id);
	const held = position?.qty ?? 0;
	const atrAbs = row.atrPct && row.price ? (row.atrPct / 100) * row.price : null;
	const digits = priceDigits(row.price ?? 1);
	const [entry, setEntry] = useState("");
	const [entryOwn, setEntryOwn] = useState(false);
	const [stop, setStop] = useState("");
	const [budget, setBudget] = useState("");
	const [qtyText, setQtyText] = useState("");
	const [orderType, setOrderType] = useState<"market" | "limit">("market");
	const { run, busy } = useAction();
	const confirm = useConfirm();
	const qtyRef = useRef<HTMLInputElement>(null);

	// neuer Wert: Einstieg = Kurs, Stop = Kurs − halbe ATR (Tagesspanne), Budget = Risiko-Grenze des Depots
	useEffect(() => {
		setEntry(inputNumber(row.price, digits));
		setEntryOwn(false);
		setStop(row.price ? inputNumber(row.price - (atrAbs ? atrAbs * 0.5 : row.price * 0.01), digits) : "");
		setQtyText("");
		setOrderType("market");
	}, [row.symbol]); // eslint-disable-line react-hooks/exhaustive-deps
	// Market: der Einstieg folgt dem Kurs, bis du ihn selbst änderst – sonst rechnen Größe und Risiko mit einem alten Kurs
	useEffect(() => {
		if (!entryOwn && orderType === "market" && row.price) setEntry(inputNumber(row.price, priceDigits(row.price)));
	}, [row.price, entryOwn, orderType]);
	useEffect(() => {
		if (acc && limits) setBudget(inputNumber(((limits.maxRiskPct || 1) / 100) * (acc.equityCents / 100), 0));
	}, [acc?.id, limits?.maxRiskPct]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (focusSignal) qtyRef.current?.focus();
	}, [focusSignal]);

	// Wechselkurs: aus vorhandenen Daten (Position, Vorschlag in derselben Währung), sonst aus einem Probelauf
	const knownFx = fxFromData(row.currency, cockpit, proposals);
	const probeAcc = acc?.kind !== "manual" ? acc : mine.find((a) => a.kind !== "manual");
	const probe = useDryRun(!knownFx && probeAcc && row.price ? { accountId: probeAcc.id, symbol: row.symbol, side: "buy", qty: PROBE_QTY, orderType: "market" } : null, 0);
	const fx = knownFx ?? fxFromCheck(probe.check, PROBE_QTY, probe.check?.price ?? 0);

	const e = parseDe(entry);
	const s = parseDe(stop);
	const budgetCents = Math.round(parseDe(budget) * 100);
	// Obergrenze aus Orderwert-Grenze und Positionsgröße (Anteil am Depot nach dem Kauf)
	const heldValueCents = position?.price ? Math.round(position.price * held * 100) : 0;
	const posCap = limits?.maxPositionPct && acc ? Math.max(0, (limits.maxPositionPct / 100) * acc.equityCents - heldValueCents) : 0;
	const caps = [limits?.maxOrderCents || 0, posCap].filter((c) => c > 0);
	const sizing = acc && fx && side === "buy" ? positionSize({ budgetCents, entry: e, stop: s, fx, feeCents: acc.feeCents, cashCents: acc.cashCents, fractional: row.currency === "EUR" && row.exchange === "CCC", maxValueCents: caps.length ? Math.min(...caps) : undefined }) : null;
	const q = qtyText ? parseDe(qtyText) : side === "sell" ? held : (sizing?.qty ?? Number.NaN);
	const r1 = e - s;
	const targets = r1 > 0 ? [1, 2, 3].map((k) => e + k * r1) : [];
	const target = side === "buy" && targets[1] ? Number(targets[1].toFixed(4)) : undefined;
	// Wert und Verlust bis Stop für die Menge, die wirklich gesendet wird – nicht für den Rechner-Vorschlag
	const valueCents = fx && q > 0 && e > 0 ? orderValueCents(q, e, fx) : null;
	const riskCents = acc && fx && side === "buy" && q > 0 ? riskToStopCents(q, e, s, fx) : null;
	const lossCents = riskCents !== null && acc ? riskCents + 2 * acc.feeCents : null;

	const body: OrderBody | null =
		acc && acc.kind !== "manual" && q > 0
			? { accountId: acc.id, symbol: row.symbol, side, qty: q, orderType, limitPrice: orderType === "limit" ? e : undefined, stopLoss: side === "buy" && s > 0 ? s : undefined, takeProfit: target }
			: null;
	const { check, pending, failed } = useDryRun(body);

	const submit = async () => {
		if (!acc || !body || pending || !check?.ok) return;
		const sent = body;
		const label = de.calc.label[side](fmtQty(q), row.symbol);
		const broker = acc.kind === "broker";
		const ok = await confirm({
			title: de.calc.confirmTitle(label, acc.name),
			body: (
				<span className="flex flex-col gap-1.5 tnum" data-testid="calc-confirm">
					<span>
						{orderType === "limit" ? de.calc.limitAt(price(e, row.currency)) : de.calc.marketNow(price(row.price, row.currency))}
						{broker ? de.calc.dayOrderTo(acc.broker) : ""}
					</span>
					<span>{de.calc.estimate(eur(check.estimateCents), eur(check.feeCents))}</span>
					{side === "buy" && (
						<span>
							{s > 0 ? de.calc.stopAt(price(s, row.currency)) : de.calc.noStopRisk}
							{lossCents !== null ? de.calc.riskToStop(eur(lossCents)) : ""}
							{target ? de.calc.targetAt(price(target, row.currency)) : ""}
						</span>
					)}
					{acc.live ? <span className="font-medium text-err">{de.calc.liveWarning}</span> : broker ? <span className="text-fg-3">{de.calc.paperAt(acc.broker)}</span> : null}
				</span>
			),
			confirm: broker ? (acc.live ? de.common.sendLive : de.calc.sendTo(acc.broker)) : de.calc.act[side],
			danger: acc.live,
		});
		if (!ok) return;
		const r = await run<{ proposal: Proposal }>("/api/proposals", "POST", sent, (res) => orderResultText(res.proposal, { label, broker: acc.broker, kind: acc.kind }));
		if (r) setQtyText("");
	};

	if (!acc) return null;
	const canSend = !busy && q > 0 && !pending && !!check?.ok;
	return (
		<Card title={de.calc.title} icon={<Calculator className="size-4" />} aside={<span className="tnum">{de.calc.cash(eur(acc.cashCents, { short: true }))}</span>} label={de.calc.title}>
			<div className="flex flex-col gap-3" data-testid="order-calc">
				<div className="flex flex-col gap-2">
					<Select aria-label={de.analytics.col.depot} value={acc.id} onChange={(ev) => setAccId(ev.target.value)}>
						{mine.map((a) => (
							<option key={a.id} value={a.id}>
								{a.name}
								{a.live ? ` – ${de.common.liveMoney}` : ""}
							</option>
						))}
					</Select>
					<Segmented label={de.calc.sideLabel} items={[{ id: "buy", label: de.calc.sideItems.buy }, { id: "sell", label: de.calc.sideItems.sell }]} value={side} onChange={onSide} />
				</div>
				<div className="grid grid-cols-2 gap-3">
					<Field
						label={de.calc.entry(row.currency)}
						hint={
							orderType === "market" ? (
								entryOwn ? (
									<button type="button" className="underline underline-offset-2 hover:text-fg" onClick={() => setEntryOwn(false)}>
										{de.calc.takePrice}
									</button>
								) : (
									de.calc.followsPrice(hhmm(row.marketTime))
								)
							) : undefined
						}
					>
						{(id, a) => (
							<Input
								id={id}
								{...a}
								inputMode="decimal"
								value={entry}
								onChange={(ev) => {
									setEntry(ev.target.value);
									setEntryOwn(true);
								}}
							/>
						)}
					</Field>
					{side === "buy" ? (
						<Field label={de.calc.stop(row.currency)} hint={atrAbs ? de.calc.halfAtr(num(atrAbs / 2, digits)) : undefined}>
							{(id, a) => <Input id={id} {...a} inputMode="decimal" value={stop} onChange={(ev) => setStop(ev.target.value)} />}
						</Field>
					) : (
						<Field label={de.calc.inDepot}>{(id, a) => <Input id={id} {...a} value={de.calc.qtyValue(fmtQty(held))} readOnly />}</Field>
					)}
					{side === "buy" && (
						<Field label={de.calc.risk} hint={limits?.maxRiskPct ? de.calc.riskLimit(num(limits.maxRiskPct, 1), eur(Math.round((limits.maxRiskPct / 100) * acc.equityCents), { short: true })) : undefined}>
							{(id, a) => <Input id={id} {...a} inputMode="decimal" value={budget} onChange={(ev) => setBudget(ev.target.value)} />}
						</Field>
					)}
					<Field
						label={de.analytics.col.qty}
						hint={side === "buy" ? (sizing ? de.calc.sized(fmtQty(sizing.qty), sizing.limitedBy) : sizingReason({ fx, currency: row.currency, entry: e, stop: s, budgetCents, feeCents: acc.feeCents, cashCents: acc.cashCents })) : undefined}
					>
						{(id, a) => <Input id={id} {...a} ref={qtyRef} inputMode="decimal" value={qtyText} placeholder={Number.isFinite(q) ? inputNumber(q, q % 1 ? 6 : 0) : ""} onChange={(ev) => setQtyText(ev.target.value)} />}
					</Field>
				</div>
				{side === "buy" && targets.length > 0 && (
					<dl className="grid grid-cols-3 gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] tnum">
						{targets.map((t, i) => (
							<div key={i} className="min-w-0">
								<dt className="text-fg-3">{de.calc.target(i + 1)}</dt>
								<dd className="truncate font-medium" title={price(t, row.currency)}>
									{price(t, row.currency)}
								</dd>
							</div>
						))}
					</dl>
				)}
				{q > 0 && valueCents !== null && (
					<p className="text-[12px] text-fg-2 tnum" data-testid="calc-risk">
						{de.calc.riskLine(fmtQty(q), eur(valueCents))}
						{side === "buy" && (lossCents !== null ? de.calc.lossToStop(eur(lossCents)) : de.calc.withoutStop)}
					</p>
				)}
				{acc.kind === "paper" || acc.kind === "broker" ? (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<Segmented label={de.calc.orderType} items={[{ id: "market", label: de.calc.types.market }, { id: "limit", label: de.calc.types.limit }]} value={orderType} onChange={setOrderType} />
						</div>
						<div aria-live="polite" className="contents">
							{q > 0 && pending && <p className="text-[12px] text-fg-3">{de.calc.checking}</p>}
							{failed && <p className="text-[12px] text-err">{failed}</p>}
							{check && (check.violations.length > 0 || check.warnings.length > 0) && (
								<ul className="flex flex-col gap-1 text-[12px]" data-testid="calc-check">
									{[...check.violations, ...check.warnings].map((v, i) => (
										<li key={v} className={i < check.violations.length ? "flex gap-2 text-err" : "flex gap-2 text-warn"}>
											<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
											{v}
										</li>
									))}
								</ul>
							)}
						</div>
						<Button variant={acc.live ? "danger" : side === "buy" ? "primary" : "outline"} onClick={() => void submit()} disabled={!canSend} className="w-full" data-testid="calc-submit">
							{acc.kind === "broker" ? de.calc.submitBroker(de.calc.side[side], acc.broker, acc.live) : de.calc.actDialog[side]}
						</Button>
					</>
				) : (
					<div className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-fg-2">
						{de.calc.manualEnter(acc.broker)}{" "}
						<span className="font-medium text-fg tnum">{de.calc.label[side](Number.isFinite(q) ? fmtQty(q) : "–", row.symbol)}</span>
						{side === "buy" && s > 0 && <span className="tnum">{de.calc.stopOrderAt(price(s, row.currency))}</span>}
						{de.calc.manualThen}{" "}
						<Link to="/portfolio" search={{ account: acc.id }} className="underline underline-offset-2">
							{de.analytics.depots}
						</Link>{" "}
						{de.calc.manualRecord}
					</div>
				)}
			</div>
		</Card>
	);
}
