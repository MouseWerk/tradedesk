// Gemeinsames der Module: Seitenrahmen, Aktionen mit Meldung, Vorschlagskarte mit Freigabe-Dialogen.
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Bot, Check, Clock, OctagonX, TriangleAlert, User, X } from "lucide-react";
import type { AccountSummary, Proposal, ProposalStatus } from "@desk/shared";
import { movePct, sideLabel, statusLabel } from "@desk/shared";
import { send } from "@/lib/api";
import { ago, dateTime, eur, parseDe, pct, price, qty as fmtQty } from "@/lib/format";
import { Badge, Button, Field, Input, Textarea, cn } from "@/ui/kit";
import { FormDialog, useToast } from "@/ui/overlay";

export function Page({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-5 max-md:p-3", className)}>{children}</div>;
}

export function PageHead({ title, sub, aside }: { title: string; sub?: ReactNode; aside?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-end gap-3">
			<div className="min-w-0">
				<h1 className="text-[18px] font-semibold">{title}</h1>
				{sub && <p className="mt-0.5 text-[12.5px] text-fg-3">{sub}</p>}
			</div>
			{aside && <div className="ml-auto flex flex-wrap items-center gap-2">{aside}</div>}
		</div>
	);
}

/** Änderung senden, Daten neu laden, Ergebnis als Meldung. Gibt null bei Fehler zurück (Meldung ist dann schon da). */
export function useAction() {
	const qc = useQueryClient();
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const run = async <T,>(url: string, method: "POST" | "PUT" | "DELETE", body: unknown, ok?: string | ((r: T) => string | null), undo?: { label: string; run: () => void }): Promise<T | null> => {
		setBusy(true);
		try {
			const r = await send<T>(url, method, body);
			const text = typeof ok === "function" ? ok(r) : ok;
			if (text) toast({ text, tone: "info", action: undo });
			return r;
		} catch (e) {
			toast({ text: (e as Error).message, tone: "error" });
			return null;
		} finally {
			setBusy(false);
			void qc.invalidateQueries({ predicate: (q) => !["chart", "search"].includes(String(q.queryKey[0])) });
		}
	};
	return { run, busy };
}

const STATUS_VARIANT: Record<ProposalStatus, "warn" | "ok" | "err" | "soft"> = {
	pending: "warn",
	open: "soft",
	placed: "warn",
	filled: "ok",
	rejected: "err",
	stale: "soft",
	expired: "soft",
	cancelled: "soft",
};

export function StatusBadge({ status }: { status: ProposalStatus }) {
	return (
		<Badge variant={STATUS_VARIANT[status]} data-status={status}>
			{status === "filled" ? <Check className="size-3" aria-hidden /> : status === "rejected" ? <X className="size-3" aria-hidden /> : status === "pending" || status === "placed" ? <Clock className="size-3" aria-hidden /> : null}
			{statusLabel[status]}
		</Badge>
	);
}

export function ProposalCard({ p, accounts, user, compact }: { p: Proposal; accounts: AccountSummary[]; user: string; compact?: boolean }) {
	const acc = accounts.find((a) => a.id === p.accountId);
	const { run, busy } = useAction();
	const [dialog, setDialog] = useState<"approve" | "reject" | "fill" | null>(null);
	const [qtyText, setQtyText] = useState(String(p.qty).replace(".", ","));
	const [reason, setReason] = useState("");
	const [fillPrice, setFillPrice] = useState("");
	const [fillFee, setFillFee] = useState(acc ? String(acc.feeCents / 100).replace(".", ",") : "1");
	const [err, setErr] = useState<string | null>(null);
	const moved = p.price !== null ? movePct(p.quotePrice, p.price) : 0;
	const isAgent = p.author !== user;
	const manual = acc?.kind === "manual";
	const qtyNum = parseDe(qtyText);
	const label = `${sideLabel[p.side]} ${fmtQty(p.approvedQty ?? p.qty)} ${p.symbol}`;

	const approve = async () => {
		if (!(qtyNum > 0) || qtyNum > p.qty) return setErr(`Zwischen 0 und ${fmtQty(p.qty)} Stück – mehr als vorgeschlagen geht nicht.`);
		const r = await run<{ proposal: Proposal }>(`/api/proposals/${p.id}/approve`, "POST", qtyNum === p.qty ? {} : { qty: qtyNum }, (r) => {
			const done = `${sideLabel[p.side]} ${fmtQty(r.proposal.approvedQty ?? p.qty)} ${p.symbol}`;
			return r.proposal.status === "placed" ? `${done} freigegeben – jetzt in ${acc?.broker ?? "deinem Broker"} ausführen und eintragen.` : r.proposal.status === "open" ? `${done}: Limit offen.` : `${done} ausgeführt.`;
		});
		if (r) setDialog(null);
	};
	const reject = async () => {
		if (await run(`/api/proposals/${p.id}/reject`, "POST", { reason }, `${label} abgelehnt.`)) setDialog(null);
	};
	const fill = async () => {
		const pr = parseDe(fillPrice);
		const fee = parseDe(fillFee || "0");
		if (!(pr > 0)) return setErr("Ausführungskurs in EUR eintragen, wie in der Abrechnung.");
		if (!(qtyNum > 0)) return setErr("Stückzahl fehlt.");
		if (await run(`/api/proposals/${p.id}/fill`, "POST", { qty: qtyNum, price: pr, feeEur: Number.isFinite(fee) ? fee : undefined }, `${label} als ausgeführt eingetragen.`)) setDialog(null);
	};
	const cancel = () => run(`/api/proposals/${p.id}/cancel`, "POST", {}, `${label} storniert.`);
	const open = (d: "approve" | "reject" | "fill") => {
		setErr(null);
		setQtyText(String(p.approvedQty ?? p.qty).replace(".", ","));
		setDialog(d);
	};

	return (
		<article className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--shadow)]" aria-label={`${label} von ${p.author}`} data-testid="proposal" data-id={p.id}>
			<header className="flex flex-wrap items-center gap-2">
				<span className="flex items-center gap-1.5 text-fg-2">
					{isAgent ? <Bot className="size-3.5 text-fg-3" aria-hidden /> : <User className="size-3.5 text-fg-3" aria-hidden />}
					<span className="font-medium text-fg">{p.author}</span>
					<span className="text-fg-3">für {acc?.name ?? p.accountId}</span>
				</span>
				<span className="ml-auto flex items-center gap-2">
					<StatusBadge status={p.status} />
					<span className="text-[11.5px] text-fg-3" title={dateTime(p.createdAt)}>
						{ago(p.createdAt)}
					</span>
				</span>
			</header>
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<span className="text-[15px] font-semibold">
					{sideLabel[p.side]} {fmtQty(p.approvedQty ?? p.qty)} {p.symbol}
				</span>
				<span className="min-w-0 truncate text-fg-3" title={p.name}>
					{p.name}
				</span>
				<span className="ml-auto tnum text-fg-2">≈ {eur(p.estimateCents)}</span>
			</div>
			<dl className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-x-4 gap-y-2 text-[12px]">
				<div>
					<dt className="text-fg-3">Art</dt>
					<dd className="tnum">{p.orderType === "limit" ? `Limit ${price(p.limitPrice, p.currency)}` : "Market"}</dd>
				</div>
				<div>
					<dt className="text-fg-3">Kurs Vorschlag → jetzt</dt>
					<dd className="tnum">
						{price(p.quotePrice, p.currency)} → {price(p.price, p.currency)}
						{p.status === "pending" && moved > 0.5 && <span className="ml-1 text-warn">({pct(moved, { signed: false })})</span>}
					</dd>
				</div>
				{isAgent && (
					<div>
						<dt className="text-fg-3">Zuversicht</dt>
						<dd className="tnum">{Math.round(p.confidence * 100)} %</dd>
					</div>
				)}
				{(p.stopLoss || p.takeProfit) && (
					<div>
						<dt className="text-fg-3">Stop / Ziel</dt>
						<dd className="tnum">
							{price(p.stopLoss, p.currency)} / {price(p.takeProfit, p.currency)}
						</dd>
					</div>
				)}
				{p.fillPrice !== null && (
					<div>
						<dt className="text-fg-3">Ausgeführt zu</dt>
						<dd className="tnum">{price(p.fillPrice, manual ? "EUR" : p.currency)}</dd>
					</div>
				)}
			</dl>
			{!compact && p.thesis && <p className="text-[12.5px] leading-relaxed whitespace-pre-line text-fg-2">{p.thesis}</p>}
			{p.warnings.length > 0 && p.status === "pending" && (
				<ul className="flex flex-col gap-1 rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn">
					{p.warnings.map((w) => (
						<li key={w} className="flex gap-2">
							<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
							{w}
						</li>
					))}
				</ul>
			)}
			{p.reason && p.status !== "pending" && <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-fg-2">{p.reason}</p>}
			{p.status === "placed" && (
				<p className="flex gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-fg-2">
					<OctagonX className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-hidden />
					Öffne {acc?.broker ?? "deinen Broker"}, führe „{label}“ dort aus und trage danach Kurs und Gebühr aus der Abrechnung ein.
				</p>
			)}
			{(p.status === "pending" || p.status === "placed" || p.status === "open") && (
				<footer className="flex flex-wrap gap-2">
					{p.status === "pending" && (
						<>
							<Button variant="primary" onClick={() => open("approve")} disabled={busy}>
								<Check className="size-3.5" aria-hidden />
								Freigeben…
							</Button>
							<Button onClick={() => open("reject")} disabled={busy}>
								Ablehnen…
							</Button>
						</>
					)}
					{p.status === "placed" && (
						<Button variant="primary" onClick={() => open("fill")} disabled={busy}>
							Ausführung eintragen…
						</Button>
					)}
					{(p.status === "placed" || p.status === "open") && (
						<Button variant="ghost" onClick={() => void cancel()} disabled={busy}>
							Stornieren
						</Button>
					)}
					<span className="ml-auto self-center text-[11.5px] text-fg-3">gilt bis {dateTime(p.expiresAt)}</span>
				</footer>
			)}

			<FormDialog
				open={dialog === "approve"}
				onOpenChange={(o) => !o && setDialog(null)}
				title={`${sideLabel[p.side]} ${p.symbol} freigeben`}
				description={manual ? `Der Desk führt nichts aus: Danach gibst du die Order selbst in ${acc?.broker} auf.` : `Wird sofort im ${acc?.name ?? "Papierdepot"} ausgeführt${p.orderType === "limit" ? ", sobald das Limit erreicht ist" : " zum aktuellen Kurs"}.`}
				submit={manual ? "Freigeben" : p.orderType === "limit" ? "Limit freigeben" : "Freigeben und ausführen"}
				onSubmit={() => void approve()}
				busy={busy}
				error={err}
			>
				<Field label="Stück" hint={`Höchstens ${fmtQty(p.qty)} – du kannst nur verkleinern.`}>
					{(id) => <Input id={id} inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} autoFocus />}
				</Field>
				<p className="text-[12.5px] text-fg-2 tnum">
					Kurs jetzt {price(p.price, p.currency)} · geschätzt {eur(p.price !== null && qtyNum > 0 ? Math.round((p.estimateCents * qtyNum) / (p.approvedQty ?? p.qty)) : p.estimateCents)} + {eur(acc?.feeCents ?? 0)} Gebühr
				</p>
			</FormDialog>

			<FormDialog open={dialog === "reject"} onOpenChange={(o) => !o && setDialog(null)} title={`Vorschlag von ${p.author} ablehnen`} submit="Ablehnen" onSubmit={() => void reject()} busy={busy} error={err}>
				<Field label="Begründung (optional)" hint="Der Agent liest sie über cli/desk.py und lernt daraus.">
					{(id) => <Textarea id={id} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus />}
				</Field>
			</FormDialog>

			<FormDialog open={dialog === "fill"} onOpenChange={(o) => !o && setDialog(null)} title={`Ausführung in ${acc?.broker ?? "deinem Broker"} eintragen`} description="Werte aus der Abrechnung, in EUR." submit="Eintragen" onSubmit={() => void fill()} busy={busy} error={err}>
				<div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
					<Field label="Stück">{(id) => <Input id={id} inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} />}</Field>
					<Field label="Kurs (EUR)">{(id) => <Input id={id} inputMode="decimal" value={fillPrice} placeholder="z. B. 104,50" onChange={(e) => setFillPrice(e.target.value)} autoFocus />}</Field>
					<Field label="Gebühr (EUR)">{(id) => <Input id={id} inputMode="decimal" value={fillFee} onChange={(e) => setFillFee(e.target.value)} />}</Field>
				</div>
			</FormDialog>
		</article>
	);
}
