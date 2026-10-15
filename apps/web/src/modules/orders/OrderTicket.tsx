// Deine eigene Order im Papierdepot: dieselbe Risikoprüfung wie für Agenten, vorab live als Probelauf angezeigt.
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { AccountSummary, Check, OrderType, Side } from "@desk/shared";
import { useWatchlist } from "@/lib/api";
import { eur, parseDe, price } from "@/lib/format";
import { Field, Input, Segmented, Select } from "@/ui/kit";
import { FormDialog } from "@/ui/overlay";
import { useAction } from "../common";

export function OrderTicket({ open, onOpenChange, accounts, accountId, symbol: initialSymbol, side: initialSide = "buy" }: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	accounts: AccountSummary[];
	accountId?: string;
	symbol?: string;
	side?: Side;
}) {
	const paper = accounts.filter((a) => a.owner === "user" && a.kind === "paper");
	const { data: watch } = useWatchlist();
	const [acc, setAcc] = useState(accountId && paper.some((a) => a.id === accountId) ? accountId : (paper[0]?.id ?? ""));
	const [symbol, setSymbol] = useState(initialSymbol ?? "");
	const [side, setSide] = useState<Side>(initialSide);
	const [type, setType] = useState<OrderType>("market");
	const [qtyText, setQtyText] = useState("1");
	const [limitText, setLimitText] = useState("");
	const [check, setCheck] = useState<Check | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const { run, busy } = useAction();
	const sym = symbol || watch?.[0]?.symbol || "";
	const item = watch?.find((w) => w.symbol === sym);
	const body = { accountId: acc, symbol: sym, side, qty: parseDe(qtyText), orderType: type, limitPrice: type === "limit" ? parseDe(limitText) : undefined };

	useEffect(() => {
		if (open) {
			setSymbol(initialSymbol ?? "");
			setSide(initialSide);
			setErr(null);
		}
	}, [open, initialSymbol, initialSide]);

	// Probelauf: der Server prüft genau so, wie er beim Absenden prüfen würde
	useEffect(() => {
		if (!open || !acc || !sym || !(body.qty > 0) || (type === "limit" && !(body.limitPrice! > 0))) return setCheck(null);
		const ctl = new AbortController();
		const t = setTimeout(() => {
			fetch("/api/proposals?dryRun=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal })
				.then((r) => r.json())
				.then((j: { check?: Check }) => setCheck(j.check ?? null))
				.catch(() => undefined);
		}, 250);
		return () => {
			clearTimeout(t);
			ctl.abort();
		};
	}, [open, acc, sym, side, type, qtyText, limitText]); // eslint-disable-line react-hooks/exhaustive-deps

	const submit = async () => {
		if (!(body.qty > 0)) return setErr("Stückzahl größer als 0 eintragen.");
		if (type === "limit" && !(body.limitPrice! > 0)) return setErr("Limitkurs eintragen.");
		const r = await run("/api/proposals", "POST", body, type === "limit" ? `Limit-Order ${sym} angelegt.` : `${side === "buy" ? "Kauf" : "Verkauf"} ${sym} ausgeführt.`);
		if (r) onOpenChange(false);
	};

	if (!paper.length)
		return (
			<FormDialog open={open} onOpenChange={onOpenChange} title="Neue Order" submit="OK" onSubmit={() => onOpenChange(false)}>
				<p className="text-[13px] text-fg-2">Du hast kein eigenes Papierdepot. Lege eines in config.json an („kind": „paper“). Für Trade Republic erfasst du ausgeführte Trades unter Depots.</p>
			</FormDialog>
		);

	return (
		<FormDialog open={open} onOpenChange={onOpenChange} title="Neue Order (Papier)" description="Wird sofort zum aktuellen Kurs ausgeführt, eine Limit-Order sobald das Limit erreicht ist." submit={side === "buy" ? "Kaufen" : "Verkaufen"} onSubmit={() => void submit()} busy={busy || (check !== null && !check.ok)} error={err}>
			<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<Field label="Depot">
					{(id) => (
						<Select id={id} value={acc} onChange={(e) => setAcc(e.target.value)}>
							{paper.map((a) => (
								<option key={a.id} value={a.id}>
									{a.name}
								</option>
							))}
						</Select>
					)}
				</Field>
				<Field label="Wertpapier" hint={item ? `${item.name} · ${price(item.price, item.currency)}` : "Nur Werte von der Watchlist"}>
					{(id) => (
						<Select id={id} value={sym} onChange={(e) => setSymbol(e.target.value)}>
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
				<Segmented label="Seite" items={[{ id: "buy", label: "Kauf" }, { id: "sell", label: "Verkauf" }]} value={side} onChange={setSide} />
				<Segmented label="Orderart" items={[{ id: "market", label: "Market" }, { id: "limit", label: "Limit" }]} value={type} onChange={setType} />
			</div>
			<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
				<Field label="Stück">{(id) => <Input id={id} inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} autoFocus />}</Field>
				{type === "limit" && <Field label={`Limit (${item?.currency ?? "EUR"})`}>{(id) => <Input id={id} inputMode="decimal" value={limitText} onChange={(e) => setLimitText(e.target.value)} />}</Field>}
			</div>
			{check && (
				<div className="flex flex-col gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px]" data-testid="order-check">
					<span className="tnum">
						Orderwert ≈ {eur(check.estimateCents)} + {eur(check.feeCents)} Gebühr
					</span>
					{[...check.violations, ...check.warnings].map((v, i) => (
						<span key={v} className={i < check.violations.length ? "flex gap-2 text-err" : "flex gap-2 text-warn"}>
							<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
							{v}
						</span>
					))}
				</div>
			)}
		</FormDialog>
	);
}
