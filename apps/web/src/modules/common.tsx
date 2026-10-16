// Gemeinsames der Module: Seitenrahmen, Aktionen mit Meldung, Vorschlagskarte und -zeile mit Freigabe-Dialogen.
// Orders an ein Broker-Depot (IBKR) gehen nie per Eingabetaste raus: Der Dialog öffnet eine zweite Bestätigung, die
// auf „Abbrechen“ startet (Owner-Entscheidung 2026-10-16). Papierdepots behalten den einen Dialog.
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Bot, Check, Clock, OctagonX, TriangleAlert, User, X } from "lucide-react";
import type { AccountSummary, Proposal, ProposalStatus } from "@desk/shared";
import { movePct, sideLabel, statusLabel } from "@desk/shared";
import { live, refreshable, send } from "@/lib/api";
import { ago, dateTime, eur, inputNumber, num, numberError, parseDe, pct, price, qty as fmtQty } from "@/lib/format";
import { orderResultText, proposalRisk } from "@/lib/orders";
import { Badge, Button, Field, Input, Textarea, cn } from "@/ui/kit";
import { FormDialog, useConfirm, useFormErrors, useToast } from "@/ui/overlay";

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

/**
 * Änderung senden, Ergebnis als Meldung. Gibt null bei Fehler zurück (Meldung ist dann schon da).
 * Neu laden: Jede Änderung meldet der Server über den Live-Stream (Tick), der lädt die angezeigten Daten neu. Nur wenn
 * der Stream steht oder kein Tick kommt, lädt die Aktion selbst neu – vorher lud jede Aktion alles doppelt.
 */
export function useAction() {
	const qc = useQueryClient();
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const reload = () => void qc.invalidateQueries({ predicate: refreshable }, { cancelRefetch: false });
	const run = async <T,>(url: string, method: "POST" | "PUT" | "DELETE", body: unknown, ok?: string | ((r: T) => string | null), undo?: { label: string; run: () => void }, opts: { refresh?: boolean } = {}): Promise<T | null> => {
		setBusy(true);
		const t0 = Date.now();
		try {
			const r = await send<T>(url, method, body);
			const text = typeof ok === "function" ? ok(r) : ok;
			if (text) toast({ text, tone: "info", action: undo });
			if (opts.refresh !== false) {
				if (live.state !== "live") reload();
				else setTimeout(() => live.signalAt < t0 && reload(), 1200);
			}
			return r;
		} catch (e) {
			toast({ text: (e as Error).message, tone: "error" });
			// der Stand hat sich vielleicht geändert (schon entschieden, Not-Aus): neu laden, damit du ihn siehst
			reload();
			return null;
		} finally {
			setBusy(false);
		}
	};
	return { run, busy };
}

const STATUS_VARIANT: Record<ProposalStatus, "warn" | "ok" | "err" | "soft"> = {
	pending: "warn",
	open: "soft",
	placed: "warn",
	sending: "soft",
	confirm: "warn",
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

export const ACTIVE = ["pending", "placed", "open", "sending", "confirm"] as const;
export const isActive = (p: Proposal) => (ACTIVE as readonly string[]).includes(p.status);
/** Was deine Entscheidung braucht: freigeben, beim Broker bestätigen oder eine Ausführung eintragen. */
export const needsYou = (p: Proposal, accounts: AccountSummary[]) => p.status === "pending" || p.status === "confirm" || (p.status === "placed" && accounts.find((a) => a.id === p.accountId)?.kind === "manual");

const orderKind = (p: Proposal) => (p.orderType === "limit" ? `Limit ${price(p.limitPrice, p.currency)}` : "Market");

/** Freigeben, ablehnen, eintragen, bestätigen, stornieren – für Karte und Zeile dieselbe Logik und dieselben Dialoge. */
function useProposalActions(p: Proposal, accounts: AccountSummary[]) {
	const acc = accounts.find((a) => a.id === p.accountId);
	const { run, busy } = useAction();
	const confirm = useConfirm();
	const [dialog, setDialog] = useState<"approve" | "reject" | "fill" | null>(null);
	const [qtyText, setQtyText] = useState(inputNumber(p.qty, p.qty % 1 ? 6 : 0));
	const [reason, setReason] = useState("");
	const [fillPrice, setFillPrice] = useState("");
	const [fillFee, setFillFee] = useState(acc ? inputNumber(acc.feeCents / 100) : "1,00");
	const errs = useFormErrors(dialog !== null);
	const manual = acc?.kind === "manual";
	const broker = acc?.kind === "broker";
	const liveMoney = !!acc?.live;
	const qtyNum = parseDe(qtyText);
	const shownQty = p.approvedQty ?? p.qty;
	const label = `${sideLabel[p.side]} ${fmtQty(shownQty)} ${p.symbol}`;
	const estimate = (q: number) => (q > 0 ? Math.round((p.estimateCents * q) / shownQty) : p.estimateCents);
	const risk = (q: number) => proposalRisk(p, q, acc?.feeCents ?? 0, acc?.equityCents);
	const kind = (acc?.kind ?? "paper") as "paper" | "broker" | "manual";

	const approve = async () => {
		if (!(qtyNum > 0) || qtyNum > p.qty) return errs.fail("qty", numberError(qtyText) ?? `Zwischen 0 und ${fmtQty(p.qty)} Stück – mehr als vorgeschlagen geht nicht.`);
		const doneLabel = `${sideLabel[p.side]} ${fmtQty(qtyNum)} ${p.symbol}`;
		if (broker) {
			const r = risk(qtyNum);
			const ok = await confirm({
				title: `${doneLabel} an ${acc?.broker} senden?`,
				body: (
					<span className="flex flex-col gap-1.5 tnum" data-testid="broker-confirm">
						<span>
							{doneLabel} · {p.orderType === "limit" ? `Limit ${price(p.limitPrice, p.currency)}` : "Market"}-Tagesorder in „{acc?.name}“
						</span>
						<span>
							geschätzt {eur(estimate(qtyNum))} + {eur(acc?.feeCents ?? 0)} Gebühr
						</span>
						{p.side === "buy" && (
							<span>
								{p.stopLoss ? `Stop ${price(p.stopLoss, p.currency)}` : "ohne Stop"}
								{r ? ` · Risiko bis Stop ≈ ${eur(r.riskCents)} inkl. Gebühren${r.pctOfAccount !== null ? ` (${pct(r.pctOfAccount, { signed: false, digits: 2 })} des Depots)` : ""}` : ""}
							</span>
						)}
						{liveMoney ? <span className="font-medium text-err">Echtes Geld: Die Order geht sofort an die Börse.</span> : <span className="text-fg-3">Papierkonto bei {acc?.broker}.</span>}
					</span>
				),
				confirm: liveMoney ? "Mit echtem Geld senden" : `An ${acc?.broker} senden`,
				danger: liveMoney,
			});
			if (!ok) return;
		}
		const r = await run<{ proposal: Proposal }>(`/api/proposals/${p.id}/approve`, "POST", qtyNum === p.qty ? {} : { qty: qtyNum }, (res) =>
			orderResultText(res.proposal, { label: `${sideLabel[p.side]} ${fmtQty(res.proposal.approvedQty ?? p.qty)} ${p.symbol}`, broker: acc?.broker, kind }),
		);
		if (r) setDialog(null);
	};
	const reject = async () => {
		if (await run(`/api/proposals/${p.id}/reject`, "POST", { reason }, `${label} abgelehnt.`)) setDialog(null);
	};
	const fill = async () => {
		const pr = parseDe(fillPrice);
		const fee = parseDe(fillFee || "0");
		if (!(qtyNum > 0)) return errs.fail("fillQty", numberError(qtyText) ?? "Stückzahl größer als 0 eintragen.");
		if (!(pr > 0)) return errs.fail("fillPrice", numberError(fillPrice) ?? "Ausführungskurs in EUR eintragen, wie in der Abrechnung.");
		if (fillFee && !(fee >= 0)) return errs.fail("fillFee", numberError(fillFee) ?? "Gebühr 0 oder mehr.");
		if (await run(`/api/proposals/${p.id}/fill`, "POST", { qty: qtyNum, price: pr, feeEur: Number.isFinite(fee) ? fee : undefined }, `${label} als ausgeführt eingetragen.`)) setDialog(null);
	};
	const cancel = async () => {
		const ok = await confirm({
			title: `${label} stornieren?`,
			body:
				broker && (p.status === "placed" || p.status === "confirm")
					? `Der Desk schickt die Stornierung an ${acc?.broker}. Ist die Order dort schon ausgeführt, bleibt sie ausgeführt.`
					: manual
						? `Nur im Desk. Hast du die Order schon in ${acc?.broker} aufgegeben, storniere sie dort selbst.`
						: "Das offene Limit wird gelöscht, es wird nichts ausgeführt.",
			confirm: "Stornieren",
			danger: true,
		});
		if (ok) await run(`/api/proposals/${p.id}/cancel`, "POST", {}, broker && p.status === "placed" ? `${label}: Storno an ${acc?.broker} gesendet.` : `${label} storniert.`);
	};
	const confirmBroker = async () => {
		const ok = await confirm({
			title: `${label} bei ${acc?.broker} bestätigen?`,
			body: (
				<span className="flex flex-col gap-2">
					<span>{acc?.broker} fragt:</span>
					<span className="font-medium text-fg">„{p.brokerMessage}“</span>
					{liveMoney && <span className="font-medium text-err">Echtes Geld: Die Order geht danach an die Börse.</span>}
				</span>
			),
			confirm: "Bestätigen und senden",
			danger: liveMoney,
		});
		if (ok) await run(`/api/proposals/${p.id}/confirm`, "POST", {}, `${label} an ${acc?.broker} gesendet.`);
	};
	const open = (d: "approve" | "reject" | "fill") => {
		setQtyText(inputNumber(shownQty, shownQty % 1 ? 6 : 0));
		setDialog(d);
	};
	const question = p.brokerMessage?.trim() ?? "";
	const r = risk(qtyNum);

	const dialogs = (
		<>
			<FormDialog
				open={dialog === "approve"}
				onOpenChange={(o) => !o && setDialog(null)}
				title={`${sideLabel[p.side]} ${p.symbol} freigeben`}
				description={
					manual
						? `Der Desk führt nichts aus: Danach gibst du die Order selbst in ${acc?.broker} auf.`
						: broker
							? `Geht als ${p.orderType === "limit" ? "Limit" : "Market"}-Tagesorder an ${acc?.broker}${liveMoney ? " – echtes Geld" : " (Papierkonto)"}. Vor dem Senden fragt der Desk noch einmal nach.`
							: `Wird sofort in „${acc?.name ?? "Papierdepot"}“ ausgeführt${p.orderType === "limit" ? ", sobald das Limit erreicht ist" : " zum aktuellen Kurs"}.`
				}
				submit={manual ? "Freigeben" : broker ? `An ${acc?.broker} senden…` : p.orderType === "limit" ? "Limit freigeben" : "Freigeben und ausführen"}
				submitVariant={liveMoney ? "danger" : "primary"}
				onSubmit={() => void approve()}
				busy={busy}
				error={errs.general}
			>
				<Field label="Stück" hint={`Höchstens ${fmtQty(p.qty)} – du kannst nur verkleinern.`} error={errs.at("qty")}>
					{(id, a) => <Input id={id} {...a} inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} autoFocus />}
				</Field>
				<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px] tnum" data-testid="approve-facts">
					<dt className="text-fg-3">Art</dt>
					<dd>{orderKind(p)}</dd>
					<dt className="text-fg-3">Kurs jetzt</dt>
					<dd>{price(p.price, p.currency)}</dd>
					<dt className="text-fg-3">Geschätzt</dt>
					<dd>
						{eur(estimate(qtyNum))} + {eur(acc?.feeCents ?? 0)} Gebühr
					</dd>
					{p.side === "buy" && (
						<>
							<dt className="text-fg-3">Stop / Ziel</dt>
							<dd>{p.stopLoss || p.takeProfit ? `${price(p.stopLoss, p.currency)} / ${price(p.takeProfit, p.currency)}` : "kein Stop – Risiko nicht begrenzt"}</dd>
						</>
					)}
					{r && (
						<>
							<dt className="text-fg-3">Risiko bis Stop</dt>
							<dd data-testid="approve-risk">
								≈ {eur(r.riskCents)} inkl. Gebühren{r.pctOfAccount !== null ? ` · ${pct(r.pctOfAccount, { signed: false, digits: 2 })} des Depots` : ""}
								{r.targetR !== null ? ` · Ziel ${num(r.targetR, 1)} R` : ""}
							</dd>
						</>
					)}
				</dl>
				{p.warnings.length > 0 && <Warnings items={p.warnings} />}
				{p.thesis && p.author !== "" && (
					<div className="flex flex-col gap-1">
						<span className="text-[12px] font-medium text-fg-2">These von {p.author}</span>
						<p className="scroll-thin max-h-32 overflow-y-auto rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-line text-fg-2">{p.thesis}</p>
					</div>
				)}
			</FormDialog>

			<FormDialog open={dialog === "reject"} onOpenChange={(o) => !o && setDialog(null)} title={`Vorschlag von ${p.author} ablehnen`} description={label} submit="Ablehnen" onSubmit={() => void reject()} busy={busy} error={errs.general}>
				<Field label="Begründung (optional)" hint="Der Agent liest sie über cli/desk.py und lernt daraus.">
					{(id, a) => <Textarea id={id} {...a} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus />}
				</Field>
			</FormDialog>

			<FormDialog open={dialog === "fill"} onOpenChange={(o) => !o && setDialog(null)} title={`Ausführung in ${acc?.broker ?? "deinem Broker"} eintragen`} description={`${label} – Werte aus der Abrechnung, in EUR.`} submit="Eintragen" onSubmit={() => void fill()} busy={busy} error={errs.general}>
				<div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
					<Field label="Stück" error={errs.at("fillQty")}>
						{(id, a) => <Input id={id} {...a} inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} />}
					</Field>
					<Field label="Kurs (EUR)" error={errs.at("fillPrice")}>
						{(id, a) => <Input id={id} {...a} inputMode="decimal" value={fillPrice} placeholder="z. B. 104,50" onChange={(e) => setFillPrice(e.target.value)} autoFocus />}
					</Field>
					<Field label="Gebühr (EUR)" error={errs.at("fillFee")}>
						{(id, a) => <Input id={id} {...a} inputMode="decimal" value={fillFee} onChange={(e) => setFillFee(e.target.value)} />}
					</Field>
				</div>
			</FormDialog>
		</>
	);
	return { acc, busy, label, manual, broker, liveMoney, question, open, cancel, confirmBroker, dialogs };
}

function Warnings({ items }: { items: string[] }) {
	return (
		<ul className="flex flex-col gap-1 rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn">
			{items.map((w) => (
				<li key={w} className="flex gap-2">
					<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
					{w}
				</li>
			))}
		</ul>
	);
}

/** Knöpfe zu einem Vorschlag; die Namen sagen, worauf sie wirken („Kauf 2 SAP.DE freigeben…“). */
function Actions({ p, a, size }: { p: Proposal; a: ReturnType<typeof useProposalActions>; size?: "sm" }) {
	return (
		<>
			{p.status === "pending" && (
				<>
					<Button size={size} variant="primary" onClick={() => a.open("approve")} disabled={a.busy} aria-label={`${a.label} freigeben…`}>
						<Check className="size-3.5" aria-hidden />
						Freigeben…
					</Button>
					<Button size={size} onClick={() => a.open("reject")} disabled={a.busy} aria-label={`${a.label} ablehnen…`}>
						Ablehnen…
					</Button>
				</>
			)}
			{p.status === "placed" && a.manual && (
				<Button size={size} variant="primary" onClick={() => a.open("fill")} disabled={a.busy} aria-label={`Ausführung von ${a.label} eintragen…`}>
					Ausführung eintragen…
				</Button>
			)}
			{p.status === "confirm" && a.question && (
				<Button size={size} variant={a.liveMoney ? "danger" : "primary"} onClick={() => void a.confirmBroker()} disabled={a.busy} aria-label={`${a.label} bei ${a.acc?.broker ?? "Broker"} bestätigen…`}>
					Bei {a.acc?.broker ?? "Broker"} bestätigen…
				</Button>
			)}
			{(p.status === "placed" || p.status === "open" || p.status === "confirm") && (
				<Button size={size} variant="ghost" onClick={() => void a.cancel()} disabled={a.busy} aria-label={`${a.label} stornieren…`}>
					Stornieren…
				</Button>
			)}
		</>
	);
}

export function ProposalCard({ p, accounts, user }: { p: Proposal; accounts: AccountSummary[]; user: string }) {
	const a = useProposalActions(p, accounts);
	const { acc, label, broker } = a;
	const moved = p.price !== null ? movePct(p.quotePrice, p.price) : 0;
	const isAgent = p.author !== user;

	return (
		<article className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--shadow)]" aria-label={`${label} von ${p.author}`} data-testid="proposal" data-id={p.id}>
			<header className="flex flex-wrap items-center gap-2">
				<span className="flex min-w-0 items-center gap-1.5 text-fg-2">
					{isAgent ? <Bot className="size-3.5 shrink-0 text-fg-3" aria-hidden /> : <User className="size-3.5 shrink-0 text-fg-3" aria-hidden />}
					<span className="font-medium text-fg">{p.author}</span>
					<span className="truncate text-fg-3">für {acc?.name ?? p.accountId}</span>
				</span>
				<span className="ml-auto flex items-center gap-2">
					<StatusBadge status={p.status} />
					<span className="text-[11.5px] text-fg-3" title={dateTime(p.createdAt)}>
						{ago(p.createdAt)}
					</span>
				</span>
			</header>
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<span className="text-[15px] font-semibold">{label}</span>
				<span className="min-w-0 truncate text-fg-3" title={p.name}>
					{p.name}
				</span>
				<span className="ml-auto tnum text-fg-2">≈ {eur(p.estimateCents)}</span>
			</div>
			<dl className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-x-4 gap-y-2 text-[12px]">
				<div>
					<dt className="text-fg-3">Art</dt>
					<dd className="tnum">{orderKind(p)}</dd>
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
						<dd className="tnum">{price(p.fillPrice, a.manual ? "EUR" : p.currency)}</dd>
					</div>
				)}
			</dl>
			{p.thesis && <p className="text-[12.5px] leading-relaxed whitespace-pre-line text-fg-2">{p.thesis}</p>}
			{p.warnings.length > 0 && p.status === "pending" && <Warnings items={p.warnings} />}
			{p.reason && p.status !== "pending" && <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-fg-2">{p.reason}</p>}
			{p.status === "placed" && !broker && (
				<p className="flex gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-fg-2">
					<OctagonX className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-hidden />
					Öffne {acc?.broker ?? "deinen Broker"}, führe „{label}“ dort aus und trage danach Kurs und Gebühr aus der Abrechnung ein.
				</p>
			)}
			{p.status === "placed" && broker && (
				<p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-fg-2">
					Bei {acc?.broker} in Arbeit{p.brokerOrderId ? ` (Order ${p.brokerOrderId})` : ""}. Die Ausführung kommt automatisch.
				</p>
			)}
			{p.status === "confirm" && (
				<div className="flex flex-col gap-1 rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-fg" data-testid="broker-question">
					<span className="font-medium text-warn">{acc?.broker} fragt nach:</span>
					{a.question ? <span className="break-words">„{a.question}“</span> : <span>Rückfrage ohne Text – bitte im Gateway von {acc?.broker ?? "deinem Broker"} prüfen. Bestätigen geht hier nicht, nur stornieren.</span>}
				</div>
			)}
			{isActive(p) && p.status !== "sending" && (
				<footer className="flex flex-wrap gap-2">
					<Actions p={p} a={a} />
					<span className="ml-auto self-center text-[11.5px] text-fg-3">gilt bis {dateTime(p.expiresAt)}</span>
				</footer>
			)}
			{a.dialogs}
		</article>
	);
}

/** Kompakte Zeile für Listen (Übersicht, Cockpit): was es ist, von wem, wie viel – und dieselben Knöpfe wie die Karte. */
export function ProposalRow({ p, accounts }: { p: Proposal; accounts: AccountSummary[] }) {
	const a = useProposalActions(p, accounts);
	return (
		// schmal (Spalte im Cockpit, Übersicht): Knöpfe unter dem Text, breit daneben
		<li className="@container/row px-4 py-2.5" data-testid="proposal-row" data-id={p.id}>
			<div className="flex flex-col gap-2 @min-[480px]/row:flex-row @min-[480px]/row:items-center">
				<span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
					<span className="flex min-w-0 items-center gap-2">
						<Link to="/trade" search={{ symbol: p.symbol }} className="truncate font-medium hover:underline">
							{a.label}
						</Link>
						{p.status !== "pending" && <StatusBadge status={p.status} />}
						<span className="ml-auto shrink-0 text-[12px] whitespace-nowrap text-fg-2 tnum">≈ {eur(p.estimateCents)}</span>
					</span>
					<span className="truncate text-[11.5px] text-fg-3" title={`${p.author} für ${a.acc?.name ?? p.accountId}`}>
						{p.author} für {a.acc?.name ?? p.accountId}
					</span>
				</span>
				<span className="flex shrink-0 flex-wrap gap-1.5">
					<Actions p={p} a={a} size="sm" />
				</span>
			</div>
			{a.dialogs}
		</li>
	);
}
