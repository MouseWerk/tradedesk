// Order-Rechner: Stückzahl aus Risiko-Budget und Stop (inkl. beider Gebühren), Ziel in R, Probelauf der Risikoprüfung.
// Papierdepot: Order direkt. Manuelles Depot (Trade Republic): zeigt, was du in der App eingibst.
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Calculator, TriangleAlert } from "lucide-react";
import type { AccountSummary, Check, Cockpit, ScanRow, Side } from "@desk/shared";
import { positionSize } from "@desk/shared";
import { useRisk } from "@/lib/api";
import { eur, num, parseDe, price, qty as fmtQty } from "@/lib/format";
import { Button, Card, Field, Input, Segmented, Select } from "@/ui/kit";
import { useConfirm } from "@/ui/overlay";
import { useAction } from "../common";

const de = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "" : v.toFixed(d).replace(".", ","));

export function OrderCalc({ row, cockpit, accounts, side, onSide, focusSignal }: { row: ScanRow; cockpit: Cockpit; accounts: AccountSummary[]; side: Side; onSide: (s: Side) => void; focusSignal: number }) {
	const mine = accounts.filter((a) => a.owner === "user");
	const { data: risk } = useRisk();
	const [accId, setAccId] = useState(mine.find((a) => a.kind === "paper")?.id ?? mine[0]?.id ?? "");
	const acc = mine.find((a) => a.id === accId) ?? mine[0];
	const limits = risk?.accounts.find((x) => x.account.id === acc?.id)?.limits;
	const fx = acc && row.price ? (cockpit.positions.find((p) => p.symbol === row.symbol && p.nativePrice)?.price ?? 0) / (cockpit.positions.find((p) => p.symbol === row.symbol && p.nativePrice)?.nativePrice ?? 1) || (row.currency === "EUR" ? 1 : null) : null;
	const held = cockpit.positions.find((p) => p.symbol === row.symbol && p.accountId === acc?.id)?.qty ?? 0;
	const atrAbs = row.atrPct && row.price ? (row.atrPct / 100) * row.price : null;
	const [entry, setEntry] = useState("");
	const [stop, setStop] = useState("");
	const [budget, setBudget] = useState("");
	const [qtyText, setQtyText] = useState("");
	const [orderType, setOrderType] = useState<"market" | "limit">("market");
	const [check, setCheck] = useState<Check | null>(null);
	const { run, busy } = useAction();
	const confirm = useConfirm();
	const qtyRef = useRef<HTMLInputElement>(null);

	// neuer Wert: Einstieg = Kurs, Stop = Kurs − halbe ATR (Tagesspanne), Budget = Risiko-Grenze des Depots
	useEffect(() => {
		setEntry(de(row.price));
		setStop(row.price ? de(row.price - (atrAbs ? atrAbs * 0.5 : row.price * 0.01)) : "");
		setQtyText("");
		setOrderType("market");
	}, [row.symbol]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (acc && limits) setBudget(de(((limits.maxRiskPct || 1) / 100) * (acc.equityCents / 100), 0));
	}, [acc?.id, limits?.maxRiskPct]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (focusSignal) qtyRef.current?.focus();
	}, [focusSignal]);

	const e = parseDe(entry);
	const s = parseDe(stop);
	// Obergrenze aus Orderwert-Grenze und Positionsgröße (Anteil am Depot nach dem Kauf)
	const heldValue = cockpit.positions.find((p) => p.symbol === row.symbol && p.accountId === acc?.id)?.price ?? 0;
	const posCap = limits?.maxPositionPct ? Math.max(0, (limits.maxPositionPct / 100) * acc!.equityCents - Math.round(heldValue * held * 100)) : 0;
	const caps = [limits?.maxOrderCents || 0, posCap].filter((c) => c > 0);
	const sizing =
		acc && fx && side === "buy"
			? positionSize({ budgetCents: Math.round(parseDe(budget) * 100), entry: e, stop: s, fx, feeCents: acc.feeCents, cashCents: acc.cashCents, fractional: row.currency === "EUR" && row.exchange === "CCC", maxValueCents: caps.length ? Math.min(...caps) : undefined })
			: null;
	const q = qtyText ? parseDe(qtyText) : side === "sell" ? held : (sizing?.qty ?? Number.NaN);
	const r1 = e - s;
	const targets = r1 > 0 ? [1, 2, 3].map((k) => e + k * r1) : [];

	// Probelauf beim Server: dieselbe Prüfung wie beim Absenden
	useEffect(() => {
		if (!acc || acc.kind === "manual" || !(q > 0)) return setCheck(null);
		const ctl = new AbortController();
		const t = setTimeout(() => {
			fetch("/api/proposals?dryRun=1", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ accountId: acc.id, symbol: row.symbol, side, qty: q, orderType, limitPrice: orderType === "limit" ? e : undefined, stopLoss: side === "buy" && s > 0 ? s : undefined }),
				signal: ctl.signal,
			})
				.then((r) => r.json())
				.then((j: { check?: Check }) => setCheck(j.check ?? null))
				.catch(() => undefined);
		}, 250);
		return () => {
			clearTimeout(t);
			ctl.abort();
		};
	}, [acc?.id, row.symbol, side, q, orderType, entry, stop]); // eslint-disable-line react-hooks/exhaustive-deps

	const submit = async () => {
		if (!acc || !(q > 0)) return;
		const label = `${side === "buy" ? "Kauf" : "Verkauf"} ${fmtQty(q)} ${row.symbol}`;
		const ok = await confirm({
			title: `${label} im ${acc.name}?`,
			body: (
				<span className="tnum">
					{orderType === "limit" ? `Limit ${price(e, row.currency)}` : `Market zu etwa ${price(row.price, row.currency)}`}
					{side === "buy" && s > 0 ? ` · Stop ${price(s, row.currency)}` : ""} · {eur(check?.estimateCents ?? 0)} + {eur(acc.feeCents)} Gebühr
				</span>
			),
			confirm: acc.kind === "broker" ? (acc.live ? "Mit echtem Geld senden" : `An ${acc.broker} senden`) : side === "buy" ? "Kaufen" : "Verkaufen",
			danger: acc.live,
		});
		if (!ok) return;
		const r = await run<{ proposal: { status: string; reason: string } }>(
			"/api/proposals",
			"POST",
			{ accountId: acc.id, symbol: row.symbol, side, qty: q, orderType, limitPrice: orderType === "limit" ? e : undefined, stopLoss: side === "buy" && s > 0 ? s : undefined, takeProfit: side === "buy" && targets[1] ? Number(targets[1].toFixed(4)) : undefined },
			(res) =>
				res.proposal.status === "rejected"
					? `${label}: ${res.proposal.reason}`
					: acc.kind === "broker"
						? res.proposal.status === "confirm"
							? `${label}: ${acc.broker} fragt nach – unter Orders bestätigen.`
							: `${label} an ${acc.broker} gesendet.`
						: orderType === "limit"
							? `${label}: Limit angelegt.`
							: `${label} ausgeführt.`,
		);
		if (r) setQtyText("");
	};

	if (!acc) return null;
	return (
		<Card title="Order-Rechner" icon={<Calculator className="size-4" />} aside={<span className="tnum">Cash {eur(acc.cashCents, { short: true })}</span>}>
			<div className="flex flex-col gap-3">
				<div className="flex flex-col gap-2">
					<Select aria-label="Depot" value={acc.id} onChange={(ev) => setAccId(ev.target.value)}>
						{mine.map((a) => (
							<option key={a.id} value={a.id}>
								{a.name}
							</option>
						))}
					</Select>
					<Segmented label="Seite" items={[{ id: "buy", label: "Kauf (B)" }, { id: "sell", label: "Verkauf (S)" }]} value={side} onChange={onSide} />
				</div>
				<div className="grid grid-cols-2 gap-3">
					<Field label={`Einstieg (${row.currency})`}>{(id) => <Input id={id} inputMode="decimal" value={entry} onChange={(ev) => setEntry(ev.target.value)} />}</Field>
					{side === "buy" ? (
						<Field label={`Stop (${row.currency})`} hint={atrAbs ? `½ ATR = ${num(atrAbs / 2)}` : undefined}>
							{(id) => <Input id={id} inputMode="decimal" value={stop} onChange={(ev) => setStop(ev.target.value)} />}
						</Field>
					) : (
						<Field label="Im Depot">{(id) => <Input id={id} value={`${fmtQty(held)} Stk.`} readOnly />}</Field>
					)}
					{side === "buy" && (
						<Field label="Risiko (EUR)" hint={limits?.maxRiskPct ? `Grenze ${num(limits.maxRiskPct, 1)} % = ${eur(Math.round((limits.maxRiskPct / 100) * acc.equityCents), { short: true })}` : undefined}>
							{(id) => <Input id={id} inputMode="decimal" value={budget} onChange={(ev) => setBudget(ev.target.value)} />}
						</Field>
					)}
					<Field label="Stück" hint={side === "buy" ? (sizing ? `Rechner: ${fmtQty(sizing.qty)}${sizing.limitedBy === "value" ? " (Depot-Grenze)" : sizing.limitedBy === "cash" ? " (Cash)" : ""}` : "Stop unter Einstieg setzen") : undefined}>
						{(id) => <Input id={id} ref={qtyRef} inputMode="decimal" value={qtyText} placeholder={Number.isFinite(q) ? de(q, q % 1 ? 6 : 0) : ""} onChange={(ev) => setQtyText(ev.target.value)} />}
					</Field>
				</div>
				{side === "buy" && targets.length > 0 && (
					<dl className="grid grid-cols-3 gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] tnum">
						{targets.map((t, i) => (
							<div key={i}>
								<dt className="text-fg-3">Ziel {i + 1} R</dt>
								<dd className="font-medium">{num(t)}</dd>
							</div>
						))}
					</dl>
				)}
				{sizing && side === "buy" && (
					<p className="text-[12px] text-fg-2 tnum">
						{fmtQty(sizing.qty)} Stk. ≈ {eur(sizing.valueCents)}, Verlust bis Stop {eur(sizing.riskCents)} inkl. Gebühren
					</p>
				)}
				{acc.kind === "paper" || acc.kind === "broker" ? (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<Segmented label="Orderart" items={[{ id: "market", label: "Market" }, { id: "limit", label: "Limit = Einstieg" }]} value={orderType} onChange={setOrderType} />
						</div>
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
						<Button variant={acc.live ? "danger" : side === "buy" ? "primary" : "outline"} onClick={() => void submit()} disabled={busy || !(q > 0) || (check !== null && !check.ok)} className="w-full">
							{acc.kind === "broker" ? `${side === "buy" ? "Kauf" : "Verkauf"} an ${acc.broker}${acc.live ? " (echtes Geld)" : ""}…` : side === "buy" ? "Kaufen…" : "Verkaufen…"}
						</Button>
					</>
				) : (
					<div className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-fg-2">
						In {acc.broker} eingeben:{" "}
						<span className="font-medium text-fg tnum">
							{side === "buy" ? "Kauf" : "Verkauf"} {Number.isFinite(q) ? fmtQty(q) : "–"} {row.symbol}
						</span>
						{side === "buy" && s > 0 && <span className="tnum">, Stop-Order bei {price(s, row.currency)}</span>}. Danach unter{" "}
						<Link to="/portfolio" search={{ account: acc.id }} className="underline underline-offset-2">
							Depots
						</Link>{" "}
						erfassen.
					</div>
				)}
			</div>
		</Card>
	);
}
