// Orders im Browser: Probelauf der Risikoprüfung (an die Eingaben gebunden), Text der Ergebnis-Meldung je Status,
// Wechselkurs und Risiko bis zum Stop aus Daten, die die API schon liefert.
import { useEffect, useState } from "react";
import type { Check, Cockpit, Proposal, ProposalStatus } from "@desk/shared";
import { riskToStopCents, statusLabel } from "@desk/shared";

export interface OrderBody {
	accountId: string;
	symbol: string;
	side: "buy" | "sell";
	qty: number;
	orderType: "market" | "limit";
	limitPrice?: number;
	stopLoss?: number;
	takeProfit?: number;
}

/**
 * Probelauf beim Server (dieselbe Prüfung wie beim Absenden). Das Ergebnis gehört zu genau den Eingaben, für die es
 * kam: ändern sie sich, ist es nicht mehr „aktuell“ (pending), bis die neue Antwort da ist. So kann ein alter
 * Probelauf weder den Knopf freigeben noch den Betrag in der Bestätigung liefern.
 */
export function useDryRun(body: OrderBody | null, delay = 250): { check: Check | null; pending: boolean; failed: string | null } {
	const key = body ? JSON.stringify(body) : null;
	const [res, setRes] = useState<{ key: string; check: Check | null; failed: string | null } | null>(null);
	useEffect(() => {
		if (!key) return;
		const ctl = new AbortController();
		const t = setTimeout(() => {
			fetch("/api/proposals?dryRun=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: ctl.signal })
				.then(async (r) => {
					const j = (await r.json().catch(() => ({}))) as { check?: Check; msg?: string };
					setRes({ key, check: j.check ?? null, failed: j.check ? null : (j.msg ?? `Prüfung nicht möglich (${r.status}).`) });
				})
				.catch((e: Error) => e.name !== "AbortError" && setRes({ key, check: null, failed: "Prüfung nicht möglich – Desk nicht erreichbar." }));
		}, delay);
		return () => {
			clearTimeout(t);
			ctl.abort();
		};
	}, [key, delay]);
	const current = res && key && res.key === key ? res : null;
	return { check: current?.check ?? null, pending: !!key && !current, failed: current?.failed ?? null };
}

/** Meldung nach dem Absenden einer eigenen Order – nach dem, was wirklich passiert ist, nicht pauschal „ausgeführt“. */
export function orderResultText(r: { status: ProposalStatus; reason: string }, o: { label: string; broker?: string; kind: "paper" | "broker" | "manual"; filled?: string }): string {
	switch (r.status) {
		case "filled":
			return o.filled ?? `${o.label} ausgeführt.`;
		case "rejected":
			return `${o.label} abgelehnt: ${r.reason || "Risikoprüfung"}`;
		case "confirm":
			return `${o.label}: ${o.broker ?? "Der Broker"} fragt nach – unter Orders bestätigen oder stornieren.`;
		case "placed":
		case "sending":
			return o.kind === "manual" ? `${o.label} freigegeben – jetzt in ${o.broker ?? "deinem Broker"} ausführen und eintragen.` : `${o.label} an ${o.broker ?? "den Broker"} gesendet, Ausführung folgt.`;
		case "open":
			return `${o.label}: Limit angelegt.`;
		case "stale":
			return `${o.label} nicht ausgeführt: ${r.reason || "Kurs hat sich zu stark bewegt."}`;
		default:
			return `${o.label}: ${statusLabel[r.status]}${r.reason ? ` – ${r.reason}` : ""}.`;
	}
}

/**
 * Wechselkurs (EUR je Einheit der Wertpapierwährung) aus Daten, die die API schon liefert: eine Position in derselben
 * Währung (Kurs in EUR / Kurs in Originalwährung, egal welches Depot) oder ein Vorschlag (Schätzwert / Menge × Kurs).
 */
export function fxFromData(currency: string, cockpit?: Pick<Cockpit, "positions"> | null, proposals?: Proposal[] | null): number | null {
	if (currency === "EUR") return 1;
	const pos = cockpit?.positions.find((p) => p.currency === currency && p.price && p.nativePrice);
	if (pos) return pos.price! / pos.nativePrice!;
	const prop = proposals?.find((p) => p.currency === currency && p.estimateCents > 0 && unitPrice(p) > 0);
	if (prop) return prop.estimateCents / 100 / ((prop.approvedQty ?? prop.qty) * unitPrice(prop));
	return null;
}

/** Wechselkurs aus einem Probelauf: der Server rechnet den Schätzwert mit seinem Kurs um. */
export function fxFromCheck(check: Check | null, qty: number, unit: number): number | null {
	return check && check.estimateCents > 0 && qty > 0 && unit > 0 ? check.estimateCents / 100 / (qty * unit) : null;
}

/**
 * Warum der Rechner keine Stückzahl liefert – der Hinweis nennt den echten Grund statt immer „Stop unter Einstieg
 * setzen“ (auch ohne Wechselkurs oder bei zu kleinem Budget kam der).
 */
export function sizingReason(i: { fx: number | null; currency: string; entry: number; stop: number; budgetCents: number; feeCents: number; cashCents: number }): string {
	if (!(i.entry > 0)) return "Einstieg eintragen.";
	if (!(i.stop > 0) || i.stop >= i.entry) return "Stop unter dem Einstieg setzen.";
	if (!i.fx) return `Kein Wechselkurs ${i.currency}/EUR – Stück selbst eintragen.`;
	if (!(i.budgetCents > 2 * i.feeCents)) return "Risiko-Budget deckt nicht einmal die Gebühren.";
	if (i.cashCents <= i.feeCents) return "Kein Cash im Depot.";
	return "Budget reicht nicht für 1 Stück – Stop näher setzen oder Budget erhöhen.";
}

const unitPrice = (p: Proposal) => p.limitPrice ?? p.price ?? p.quotePrice;

/**
 * Risiko einer Kauf-Freigabe bis zum Stop wie in der Risikoprüfung (checkOrder): Verlust bis Stop plus Kauf- und
 * Verkaufsgebühr, dazu Anteil am Depot und das Ziel in R. Der Wechselkurs kommt aus dem Schätzwert des Vorschlags.
 */
export function proposalRisk(p: Proposal, qty: number, feeCents: number, equityCents: number | undefined): { riskCents: number; pctOfAccount: number | null; targetR: number | null } | null {
	const unit = unitPrice(p);
	const q0 = p.approvedQty ?? p.qty;
	if (p.side !== "buy" || !p.stopLoss || !(unit > p.stopLoss) || !(q0 > 0) || !(qty > 0) || !(p.estimateCents > 0)) return null;
	const fx = p.estimateCents / 100 / (q0 * unit);
	const riskCents = riskToStopCents(qty, unit, p.stopLoss, fx)! + 2 * feeCents;
	return { riskCents, pctOfAccount: equityCents ? (riskCents / equityCents) * 100 : null, targetR: p.takeProfit && p.takeProfit > unit ? (p.takeProfit - unit) / (unit - p.stopLoss) : null };
}
