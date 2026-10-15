// Reine Depotlogik für Server, Web und Tests: Positionen nach FIFO, Bewertung, Risikoprüfung, Kursbewegung.
// Geldbeträge in Cent (EUR), kaufmännisch gerundet an genau einer Stelle: cents().
import type { Check, ProposalStatus, RiskLimits, Side } from "./schema.ts";

/** EUR → Cent, kaufmännisch (halbe Cent vom Nullpunkt weg). */
export function cents(eur: number): number {
	if (!Number.isFinite(eur)) return 0;
	const sign = eur < 0 ? -1 : 1;
	return sign * Math.round(Math.abs(eur) * 100 * (1 + Number.EPSILON)) || 0;
}

export const QTY_DECIMALS = 6;

export function roundQty(q: number): number {
	return Math.round(q * 10 ** QTY_DECIMALS) / 10 ** QTY_DECIMALS;
}

export function decimals(n: number): number {
	const s = String(n);
	if (s.includes("e-")) return Number(s.split("e-")[1]);
	return s.includes(".") ? s.split(".")[1].length : 0;
}

/** Ortsdatum "YYYY-MM-DD" (Tagesstände, Tagesverlust). */
export function dayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Orderwert in Cent: Stück × Kurs × Wechselkurs. */
export function orderValueCents(qty: number, price: number, fx: number): number {
	return cents(qty * price * fx);
}

export interface TradeLike {
	id: number;
	symbol: string;
	side: Side;
	qty: number;
	price: number;
	valueCents: number;
	feeCents: number;
	time: number;
}

export interface Holding {
	symbol: string;
	qty: number;
	costCents: number; // Einstand inkl. anteiliger Kaufgebühr
	avgPrice: number; // Einstand je Stück in EUR, ohne Gebühr
}

export interface Book {
	holdings: Map<string, Holding>;
	realizedBySell: Map<number, number>; // Trade-ID → realisiertes Ergebnis in Cent
	realizedCents: number;
	feesCents: number;
	buysCents: number; // Summe Kaufwert + Gebühr
	sellsCents: number; // Summe Verkaufswert − Gebühr
}

interface Lot {
	qty: number;
	price: number;
	costCents: number;
}

/** Bestand nach FIFO (wie das deutsche Steuerrecht). Verkäufe über den Bestand hinaus zählen nur bis zum Bestand. */
export function buildBook(trades: TradeLike[]): Book {
	const lots = new Map<string, Lot[]>();
	const realizedBySell = new Map<number, number>();
	let realizedCents = 0;
	let feesCents = 0;
	let buysCents = 0;
	let sellsCents = 0;
	const sorted = [...trades].sort((a, b) => a.time - b.time || a.id - b.id);
	for (const t of sorted) {
		feesCents += t.feeCents;
		const list = lots.get(t.symbol) ?? [];
		lots.set(t.symbol, list);
		if (t.side === "buy") {
			buysCents += t.valueCents + t.feeCents;
			// Preis je Stück in EUR aus dem gebuchten Wert: bei Trade Republic kauft man AAPL in EUR, notiert ist sie in USD
			list.push({ qty: t.qty, price: t.valueCents / 100 / t.qty, costCents: t.valueCents + t.feeCents });
			continue;
		}
		sellsCents += t.valueCents - t.feeCents;
		let left = t.qty;
		let cost = 0;
		while (left > 1e-9 && list.length) {
			const lot = list[0];
			const take = Math.min(lot.qty, left);
			const part = take >= lot.qty - 1e-9 ? lot.costCents : Math.round((lot.costCents * take) / lot.qty);
			cost += part;
			lot.costCents -= part;
			lot.qty = roundQty(lot.qty - take);
			left = roundQty(left - take);
			if (lot.qty <= 1e-9) list.shift();
		}
		const soldQty = roundQty(t.qty - left);
		// Erlös nur für die tatsächlich gehaltenen Stück
		const proceeds = soldQty >= t.qty - 1e-9 ? t.valueCents - t.feeCents : Math.round(((t.valueCents - t.feeCents) * soldQty) / t.qty);
		const realized = proceeds - cost;
		realizedBySell.set(t.id, realized);
		realizedCents += realized;
	}
	const holdings = new Map<string, Holding>();
	for (const [symbol, list] of lots) {
		const qty = roundQty(list.reduce((s, l) => s + l.qty, 0));
		if (qty <= 1e-9) continue;
		const costCents = list.reduce((s, l) => s + l.costCents, 0);
		const avgPrice = list.reduce((s, l) => s + l.qty * l.price, 0) / qty;
		holdings.set(symbol, { symbol, qty, costCents, avgPrice });
	}
	return { holdings, realizedBySell, realizedCents, feesCents, buysCents, sellsCents };
}

export interface Valued {
	marketValueCents: number;
	costCents: number;
	unrealizedCents: number;
	missing: string[];
	values: Map<string, number>;
}

/** Bewertung zu aktuellen Kursen; ohne Kurs zählt der Einstand (und das Symbol steht in missing). */
export function valueHoldings(holdings: Map<string, Holding>, quote: (symbol: string) => { price: number; fx: number } | null): Valued {
	let marketValueCents = 0;
	let costCents = 0;
	let unrealizedCents = 0;
	const missing: string[] = [];
	const values = new Map<string, number>();
	for (const h of holdings.values()) {
		const q = quote(h.symbol);
		costCents += h.costCents;
		if (!q) {
			missing.push(h.symbol);
			marketValueCents += h.costCents;
			values.set(h.symbol, h.costCents);
			continue;
		}
		const v = orderValueCents(h.qty, q.price, q.fx);
		marketValueCents += v;
		unrealizedCents += v - h.costCents;
		values.set(h.symbol, v);
	}
	return { marketValueCents, costCents, unrealizedCents, missing, values };
}

export function returnPct(equityCents: number, depositsCents: number): number | null {
	return depositsCents > 0 ? ((equityCents - depositsCents) / depositsCents) * 100 : null;
}

/** Bewegung in Prozent zwischen zwei Kursen (Betrag). */
export function movePct(from: number, to: number): number {
	return from > 0 ? (Math.abs(to - from) / from) * 100 : 0;
}

export interface OrderCheckInput {
	side: Side;
	qty: number;
	orderType: "market" | "limit";
	limitPrice?: number | null;
	stopLoss?: number | null;
	takeProfit?: number | null;
	symbol: string;
	price: number | null; // aktueller Kurs in Wertpapierwährung
	fx: number | null; // Wertpapierwährung → EUR
	cashCents: number;
	equityCents: number;
	feeCents: number;
	heldQty: number;
	positionValueCents: number;
	limits: RiskLimits;
	killSwitch: boolean;
	dayLossPct: number | null; // heutiger Verlust in Prozent (positiv = Verlust)
	openByAuthor?: number; // nur für neue Vorschläge
	byAgent?: boolean; // Stop-Pflicht gilt für Agenten
}

const eur = (c: number) => `${(c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Risikoprüfung vor jedem Vorschlag, jeder Freigabe und jeder Ausführung. Verstöße blockieren, Hinweise nicht. */
export function checkOrder(i: OrderCheckInput): Check {
	const violations: string[] = [];
	const warnings: string[] = [];
	if (i.killSwitch) violations.push("Not-Aus ist aktiv – keine Orders, bis du ihn ausschaltest.");
	if (!(i.qty > 0) || !Number.isFinite(i.qty)) violations.push("Stückzahl muss größer als 0 sein.");
	else if (decimals(i.qty) > QTY_DECIMALS) violations.push(`Stückzahl mit höchstens ${QTY_DECIMALS} Nachkommastellen.`);
	if (i.orderType === "limit" && !(i.limitPrice && i.limitPrice > 0)) violations.push("Limit-Order ohne Limitkurs.");
	if (i.price === null || i.fx === null) {
		violations.push(`Kein aktueller Kurs für ${i.symbol} – ohne Kurs keine Order.`);
		return { ok: false, violations, warnings, estimateCents: 0, feeCents: i.feeCents, price: i.price };
	}
	const p = i.orderType === "limit" && i.limitPrice ? i.limitPrice : i.price;
	const estimateCents = orderValueCents(i.qty, p, i.fx);
	if (i.side === "sell") {
		if (i.heldQty + 1e-9 < i.qty) violations.push(`Im Depot sind nur ${i.heldQty.toLocaleString("de-DE")} Stück ${i.symbol} – Leerverkäufe gibt es hier nicht.`);
		if (i.stopLoss || i.takeProfit) warnings.push("Stop-Loss und Kursziel gelten nur für Käufe und werden ignoriert.");
	} else {
		if (estimateCents + i.feeCents > i.cashCents) violations.push(`Nicht genug Cash: benötigt ${eur(estimateCents + i.feeCents)}, verfügbar ${eur(i.cashCents)}.`);
		if (i.limits.maxPositionPct > 0 && i.equityCents > 0) {
			const after = ((i.positionValueCents + estimateCents) / i.equityCents) * 100;
			if (after > i.limits.maxPositionPct) violations.push(`${i.symbol} hätte danach ${after.toFixed(1).replace(".", ",")} % des Depots – Grenze ${String(i.limits.maxPositionPct).replace(".", ",")} %.`);
		}
		if (i.limits.dailyLossPct > 0 && i.dayLossPct !== null && i.dayLossPct >= i.limits.dailyLossPct)
			violations.push(`Tagesverlust ${i.dayLossPct.toFixed(1).replace(".", ",")} % erreicht die Grenze von ${String(i.limits.dailyLossPct).replace(".", ",")} % – heute keine Käufe mehr.`);
		if (i.stopLoss && i.stopLoss >= p) violations.push("Stop-Loss muss unter dem Kaufkurs liegen.");
		else if (i.stopLoss) {
			// Risiko je Trade: Verlust bis zum Stop plus Kauf- und Verkaufsgebühr
			const risk = orderValueCents(i.qty, p - i.stopLoss, i.fx) + 2 * i.feeCents;
			const riskPct = i.equityCents > 0 ? (risk / i.equityCents) * 100 : 0;
			if (i.limits.maxRiskPct > 0 && riskPct > i.limits.maxRiskPct)
				violations.push(`Risiko bis zum Stop ${eur(risk)} = ${riskPct.toFixed(2).replace(".", ",")} % des Depots – Grenze ${String(i.limits.maxRiskPct).replace(".", ",")} % je Trade.`);
		} else if (i.byAgent && i.limits.requireStop) violations.push("Käufe von Agenten brauchen einen Stop-Loss.");
		else warnings.push("Ohne Stop-Loss ist das Risiko dieser Order nicht begrenzt.");
		if (i.takeProfit && i.takeProfit <= p) violations.push("Kursziel muss über dem Kaufkurs liegen.");
	}
	if (i.limits.maxOrderCents > 0 && estimateCents > i.limits.maxOrderCents) violations.push(`Orderwert ${eur(estimateCents)} liegt über der Grenze von ${eur(i.limits.maxOrderCents)}.`);
	if (i.openByAuthor !== undefined && i.limits.maxOpenProposals > 0 && i.openByAuthor >= i.limits.maxOpenProposals)
		violations.push(`Schon ${i.openByAuthor} offene Vorschläge – Grenze ${i.limits.maxOpenProposals}. Erst entscheiden lassen.`);
	if (i.orderType === "limit" && i.limitPrice && movePct(i.price, i.limitPrice) > 10) warnings.push("Limit liegt mehr als 10 % vom aktuellen Kurs entfernt.");
	if (estimateCents > 0 && i.feeCents / estimateCents > 0.02) warnings.push(`Gebühr ist ${((i.feeCents / estimateCents) * 100).toFixed(1).replace(".", ",")} % des Orderwerts.`);
	return { ok: violations.length === 0, violations, warnings, estimateCents, feeCents: i.feeCents, price: i.price };
}

export const statusLabel: Record<ProposalStatus, string> = {
	pending: "wartet auf dich",
	open: "Limit offen",
	placed: "beim Broker ausführen",
	filled: "ausgeführt",
	rejected: "abgelehnt",
	stale: "Kurs bewegt",
	expired: "abgelaufen",
	cancelled: "storniert",
};

export const sideLabel: Record<Side, string> = { buy: "Kauf", sell: "Verkauf" };

export const ACTIVE_STATUSES: ProposalStatus[] = ["pending", "open", "placed"];
