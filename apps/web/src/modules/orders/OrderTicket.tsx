// Deine eigene Order im Papier- oder Broker-Depot: dieselbe Risikoprüfung wie für Agenten, vorab live als Probelauf.
// Das Depot kommt bei jedem Öffnen von der Seite (Depots, Markt), nie aus dem ersten Rendern. An einen Broker geht
// die Order erst nach einer zweiten Bestätigung, die auf „Abbrechen“ startet – Eingabe im Dialog sendet nichts.
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { AccountSummary, OrderType, Proposal, Side } from "@desk/shared";
import { sideLabel } from "@desk/shared";
import { de } from "@/i18n/de";
import { useWatchlist } from "@/lib/api";
import { eur, numberError, parseDe, price, qty as fmtQty } from "@/lib/format";
import { orderResultText, useDryRun } from "@/lib/orders";
import { Field, Input, Segmented, Select } from "@/ui/kit";
import { FormDialog, useConfirm, useFormErrors } from "@/ui/overlay";
import { useAction } from "../common";

export function OrderTicket({ open, onOpenChange, accounts, accountId, symbol: initialSymbol, side: initialSide = "buy" }: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	accounts: AccountSummary[];
	accountId?: string;
	symbol?: string;
	side?: Side;
}) {
	const tradable = accounts.filter((a) => a.owner === "user" && (a.kind === "paper" || a.kind === "broker"));
	const { data: watch } = useWatchlist();
	const [acc, setAcc] = useState("");
	const [symbol, setSymbol] = useState(initialSymbol ?? "");
	const [side, setSide] = useState<Side>(initialSide);
	const [type, setType] = useState<OrderType>("market");
	const [qtyText, setQtyText] = useState("1");
	const [limitText, setLimitText] = useState("");
	const errs = useFormErrors(open);
	const { run, busy } = useAction();
	const confirm = useConfirm();
	const selected = tradable.find((a) => a.id === acc);
	const sym = symbol || watch?.[0]?.symbol || "";
	const item = watch?.find((w) => w.symbol === sym);
	const qtyNum = parseDe(qtyText);
	const limitNum = parseDe(limitText);
	const preferred = accountId && tradable.some((a) => a.id === accountId) ? accountId : (tradable[0]?.id ?? "");

	// bei jedem Öffnen: Depot, Wert und Seite von der Seite, die den Dialog öffnet
	useEffect(() => {
		if (!open) return;
		setAcc(preferred);
		setSymbol(initialSymbol ?? "");
		setSide(initialSide);
	}, [open, preferred, initialSymbol, initialSide]);

	const body = selected && sym && qtyNum > 0 && (type === "market" || limitNum > 0) ? { accountId: selected.id, symbol: sym, side, qty: qtyNum, orderType: type, limitPrice: type === "limit" ? limitNum : undefined } : null;
	const { check, pending, failed } = useDryRun(open ? body : null);
	const broker = selected?.kind === "broker";
	const label = `${sideLabel[side]} ${Number.isFinite(qtyNum) ? fmtQty(qtyNum) : "–"} ${sym}`;

	const submit = async () => {
		if (!selected) return errs.fail(null, de.orders.ticket.noAccount);
		if (!(qtyNum > 0)) return errs.fail("qty", numberError(qtyText) ?? de.proposal.qtyPositive);
		if (type === "limit" && !(limitNum > 0)) return errs.fail("limit", numberError(limitText) ?? de.orders.ticket.limitMissing);
		if (!body || pending || !check) return errs.fail(null, de.orders.ticket.checkRunning);
		if (!check.ok) return errs.fail(null, check.violations[0] ?? de.orders.ticket.checkBlocked);
		const sent = body;
		if (broker) {
			const ok = await confirm({
				title: de.proposal.send.title(label, selected.broker),
				body: (
					<span className="flex flex-col gap-1.5 tnum" data-testid="broker-confirm">
						<span>
							{label} · {de.proposal.send.dayOrder(type === "limit" ? de.proposal.limitAt(price(limitNum, item?.currency)) : de.proposal.orderType.market, selected.name)}
						</span>
						<span>{de.proposal.send.estimate(eur(check.estimateCents), eur(check.feeCents))}</span>
						{side === "buy" && <span>{de.orders.ticket.noStop}</span>}
						{selected.live ? <span className="font-medium text-err">{de.proposal.send.liveNow}</span> : <span className="text-fg-3">{de.proposal.send.paperAt(selected.broker)}</span>}
					</span>
				),
				confirm: selected.live ? de.common.sendLive : de.proposal.send.to(selected.broker),
				danger: selected.live,
			});
			if (!ok) return;
		}
		const r = await run<{ proposal: Proposal }>("/api/proposals", "POST", sent, (res) => (res.proposal.status === "rejected" ? null : orderResultText(res.proposal, { label, broker: selected.broker, kind: selected.kind })));
		if (r?.proposal.status === "rejected") return errs.fail(null, r.proposal.reason);
		if (r) onOpenChange(false);
	};

	if (!tradable.length)
		return (
			<FormDialog open={open} onOpenChange={onOpenChange} title={de.orders.ticket.title} submit={de.orders.ticket.ok} onSubmit={() => onOpenChange(false)}>
				<p className="text-[13px] text-fg-2">{de.orders.ticket.noDepot}</p>
			</FormDialog>
		);

	return (
		<FormDialog
			open={open}
			onOpenChange={onOpenChange}
			title={broker ? de.orders.ticket.titleBroker(selected!.broker) : de.orders.ticket.titlePaper}
			description={
				broker
					? de.orders.ticket.descBroker(selected!.broker, selected!.live)
					: de.orders.ticket.descPaper
			}
			submit={broker ? de.proposal.send.toEllipsis(selected!.broker) : side === "buy" ? de.orders.ticket.buy : de.orders.ticket.sell}
			submitVariant={selected?.live ? "danger" : "primary"}
			onSubmit={() => void submit()}
			busy={busy || !selected || pending || (check !== null && !check.ok)}
			error={errs.general}
		>
			<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<Field label={de.orders.ticket.depot}>
					{(id, a) => (
						<Select id={id} {...a} value={acc} onChange={(e) => setAcc(e.target.value)} data-testid="ticket-account">
							{tradable.map((x) => (
								<option key={x.id} value={x.id}>
									{x.name}
									{x.live ? de.orders.ticket.liveSuffix : ""}
								</option>
							))}
						</Select>
					)}
				</Field>
				<Field label={de.orders.ticket.security} hint={item ? `${item.name} · ${price(item.price, item.currency)}` : de.orders.ticket.watchlistOnly}>
					{(id, a) => (
						<Select id={id} {...a} value={sym} onChange={(e) => setSymbol(e.target.value)}>
							{(watch ?? []).map((w) => (
								<option key={w.symbol} value={w.symbol}>
									{w.symbol} – {w.name}
								</option>
							))}
						</Select>
					)}
				</Field>
			</div>
			<div className="flex flex-wrap gap-3">
				<Segmented label={de.orders.ticket.side} items={[{ id: "buy", label: sideLabel.buy }, { id: "sell", label: sideLabel.sell }]} value={side} onChange={setSide} />
				<Segmented label={de.orders.ticket.orderType} items={[{ id: "market", label: de.proposal.orderType.market }, { id: "limit", label: de.proposal.orderType.limit }]} value={type} onChange={setType} />
			</div>
			<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<Field label={de.proposal.qty} error={errs.at("qty")}>
					{(id, a) => <Input id={id} {...a} inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} autoFocus />}
				</Field>
				{type === "limit" && (
					<Field label={de.orders.ticket.limit(item?.currency ?? "EUR")} error={errs.at("limit")}>
						{(id, a) => <Input id={id} {...a} inputMode="decimal" value={limitText} onChange={(e) => setLimitText(e.target.value)} />}
					</Field>
				)}
			</div>
			<div className="flex min-h-[38px] flex-col gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px]" data-testid="order-check" aria-live="polite">
				{!body ? (
					<span className="text-fg-3">{de.orders.ticket.enterQty(type === "limit")}</span>
				) : pending || !check ? (
					<span className="text-fg-3">{failed ?? de.orders.ticket.checking}</span>
				) : (
					<>
						<span className="tnum">{de.orders.ticket.orderValue(eur(check.estimateCents), eur(check.feeCents))}</span>
						{[...check.violations, ...check.warnings].map((v, i) => (
							<span key={v} className={i < check.violations.length ? "flex gap-2 text-err" : "flex gap-2 text-warn"}>
								<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
								{v}
							</span>
						))}
					</>
				)}
			</div>
		</FormDialog>
	);
}
