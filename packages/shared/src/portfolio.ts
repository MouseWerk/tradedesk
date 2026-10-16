// Reine Depotlogik für Server, Web und Tests: Positionen nach FIFO, Bewertung, Risikoprüfung, Kursbewegung.
// Geldbeträge in Cent (EUR), kaufmännisch gerundet an genau einer Stelle: cents().
import type { Check, ProposalStatus, RiskLimits, Side } from "./schema.ts";
import { sharedDe } from "./i18n/de.ts";

/**
 * EUR → Cent, kaufmännisch (halbe Cent vom Nullpunkt weg). Ein nicht endlicher oder nicht mehr exakt darstellbarer
 * Betrag ist ein Fehler, nie 0: sonst rutscht eine Order über 1e308 € als "0,00 €" durch jede Grenze.
 */
export function cents(eur: number): number {
	const abs = Math.abs(eur) * 100 * (1 + Number.EPSILON);
	if (!Number.isFinite(abs) || abs > Number.MAX_SAFE_INTEGER) throw new RangeError(sharedDe.money.notRepresentable(String(eur)));
	const sign = eur < 0 ? -1 : 1;
	return sign * Math.round(abs) || 0;
}

/** Wie cents(), aber null statt Fehler – für Prüfungen, die einen nicht darstellbaren Betrag als Verstoß melden. */
export function centsOrNull(eur: number): number | null {
	const abs = Math.abs(eur) * 100 * (1 + Number.EPSILON);
	return Number.isFinite(abs) && abs <= Number.MAX_SAFE_INTEGER ? cents(eur) : null;
}

export const QTY_DECIMALS = 6;

export function roundQty(q: number): number {
	return Math.round(q * 10 ** QTY_DECIMALS) / 10 ** QTY_DECIMALS;
}

export function decimals(n: number): number {
	const s = String(n);
	if (s.includes("e-")) {
		const [mantissa, exp] = s.split("e-");
		return Number(exp) + (mantissa.includes(".") ? mantissa.split(".")[1].length : 0);
	}
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
	oversold: Map<number, number>; // Verkauf → Stück über den Bestand zu seinem Zeitpunkt (sollte leer sein)
	openLots: Map<string, { tradeId: number; qty: number }[]>; // noch gehaltene Lose je Symbol, ältestes zuerst
	closed: ClosedLot[]; // geschlossene Teile von Losen in der Reihenfolge der Verkäufe (Auswertung)
}

/**
 * Ein geschlossener Trade: der Teil eines Kauf-Loses, den ein Verkauf nach FIFO geschlossen hat. Ein Verkauf über zwei
 * Lose ergibt zwei, ein Teilverkauf eines Loses einen (der Rest bleibt offen). Einstand und Erlös sind die Anteile, die
 * buildBook ohnehin rechnet – die Summe über die Teile eines Verkaufs ist genau sein realisiertes Ergebnis.
 */
export interface ClosedLot {
	buyId: number;
	sellId: number;
	symbol: string;
	qty: number;
	entryTime: number;
	exitTime: number;
	entryPrice: number; // EUR je Stück ohne Gebühr (gebuchter Kaufwert / Stück)
	exitPrice: number; // EUR je Stück ohne Gebühr (gebuchter Verkaufswert / Stück)
	costCents: number; // anteiliger Einstand inkl. anteiliger Kaufgebühr
	proceedsCents: number; // anteiliger Erlös nach anteiliger Verkaufsgebühr
	buyFeeCents: number;
	sellFeeCents: number;
	pnlCents: number; // proceedsCents − costCents
}

interface Lot {
	tradeId: number;
	qty: number;
	price: number;
	costCents: number;
	feeCents: number; // noch nicht zugeordneter Teil der Kaufgebühr (steckt in costCents)
	time: number;
}

/** Betrag in ganzen Cent nach Gewichten aufteilen; der letzte Teil bekommt den Rest, die Summe bleibt genau. */
function split(total: number, weights: number[], sum: number): number[] {
	let left = total;
	return weights.map((w, i) => {
		if (i === weights.length - 1) return left;
		const part = Math.round((total * w) / sum);
		left -= part;
		return part;
	});
}

/** Bestand nach FIFO (wie das deutsche Steuerrecht). Verkäufe über den Bestand hinaus zählen nur bis zum Bestand. */
export function buildBook(trades: TradeLike[]): Book {
	const lots = new Map<string, Lot[]>();
	const realizedBySell = new Map<number, number>();
	const oversold = new Map<number, number>();
	let realizedCents = 0;
	let feesCents = 0;
	let buysCents = 0;
	let sellsCents = 0;
	const closed: ClosedLot[] = [];
	const sorted = [...trades].sort((a, b) => a.time - b.time || a.id - b.id);
	for (const t of sorted) {
		feesCents += t.feeCents;
		const list = lots.get(t.symbol) ?? [];
		lots.set(t.symbol, list);
		if (t.side === "buy") {
			buysCents += t.valueCents + t.feeCents;
			// Preis je Stück in EUR aus dem gebuchten Wert: bei Trade Republic kauft man AAPL in EUR, notiert ist sie in USD
			list.push({ tradeId: t.id, qty: t.qty, price: t.valueCents / 100 / t.qty, costCents: t.valueCents + t.feeCents, feeCents: t.feeCents, time: t.time });
			continue;
		}
		sellsCents += t.valueCents - t.feeCents;
		let left = t.qty;
		let cost = 0;
		const parts: { lot: Lot; take: number; cost: number; fee: number }[] = [];
		while (left > 1e-9 && list.length) {
			const lot = list[0];
			const take = Math.min(lot.qty, left);
			const whole = take >= lot.qty - 1e-9;
			const part = whole ? lot.costCents : Math.round((lot.costCents * take) / lot.qty);
			const fee = whole ? lot.feeCents : Math.round((lot.feeCents * take) / lot.qty);
			parts.push({ lot, take, cost: part, fee });
			cost += part;
			lot.costCents -= part;
			lot.feeCents -= fee;
			lot.qty = roundQty(lot.qty - take);
			left = roundQty(left - take);
			if (lot.qty <= 1e-9) list.shift();
		}
		if (left > 1e-9) oversold.set(t.id, left);
		const soldQty = roundQty(t.qty - left);
		// Erlös nur für die tatsächlich gehaltenen Stück
		const proceeds = soldQty >= t.qty - 1e-9 ? t.valueCents - t.feeCents : Math.round(((t.valueCents - t.feeCents) * soldQty) / t.qty);
		const realized = proceeds - cost;
		realizedBySell.set(t.id, realized);
		realizedCents += realized;
		if (parts.length) {
			const sellFee = soldQty >= t.qty - 1e-9 ? t.feeCents : Math.round((t.feeCents * soldQty) / t.qty);
			const takes = parts.map((p) => p.take);
			const proceedsParts = split(proceeds, takes, soldQty);
			const feeParts = split(sellFee, takes, soldQty);
			parts.forEach((p, i) =>
				closed.push({
					buyId: p.lot.tradeId, sellId: t.id, symbol: t.symbol, qty: p.take, entryTime: p.lot.time, exitTime: t.time, entryPrice: p.lot.price, exitPrice: t.valueCents / 100 / t.qty,
					costCents: p.cost, proceedsCents: proceedsParts[i], buyFeeCents: p.fee, sellFeeCents: feeParts[i], pnlCents: proceedsParts[i] - p.cost,
				}),
			);
		}
	}
	const holdings = new Map<string, Holding>();
	const openLots = new Map<string, { tradeId: number; qty: number }[]>();
	for (const [symbol, list] of lots) {
		if (list.length) openLots.set(symbol, list.map((l) => ({ tradeId: l.tradeId, qty: l.qty })));
		const qty = roundQty(list.reduce((s, l) => s + l.qty, 0));
		if (qty <= 1e-9) continue;
		const costCents = list.reduce((s, l) => s + l.costCents, 0);
		const avgPrice = list.reduce((s, l) => s + l.qty * l.price, 0) / qty;
		holdings.set(symbol, { symbol, qty, costCents, avgPrice });
	}
	return { holdings, realizedBySell, realizedCents, feesCents, buysCents, sellsCents, oversold, openLots, closed };
}

/** Verkäufe, die zu ihrem Zeitpunkt mehr Stück verkaufen, als im Bestand waren (Trade-ID → Stück zu viel). Wie buildBook sortiert. */
export function oversold(trades: Pick<TradeLike, "id" | "symbol" | "side" | "qty" | "time">[]): Map<number, number> {
	const held = new Map<string, number>();
	const out = new Map<number, number>();
	for (const t of [...trades].sort((a, b) => a.time - b.time || a.id - b.id)) {
		const h = held.get(t.symbol) ?? 0;
		if (t.side === "buy") held.set(t.symbol, roundQty(h + t.qty));
		else {
			if (t.qty > h + 1e-9) out.set(t.id, roundQty(t.qty - h));
			held.set(t.symbol, Math.max(0, roundQty(h - t.qty)));
		}
	}
	return out;
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

/** Weiter vom Kurs darf ein Limit nicht liegen. */
export const MAX_LIMIT_MOVE_PCT = 50;

const eur = (c: number) => `${(c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Risikoprüfung vor jedem Vorschlag, jeder Freigabe und jeder Ausführung. Verstöße blockieren, Hinweise nicht. */
export function checkOrder(i: OrderCheckInput): Check {
	const violations: string[] = [];
	const warnings: string[] = [];
	if (i.killSwitch) violations.push(sharedDe.check.killSwitch);
	if (!(i.qty > 0) || !Number.isFinite(i.qty)) violations.push(sharedDe.check.qtyPositive);
	else if (decimals(i.qty) > QTY_DECIMALS) violations.push(sharedDe.check.qtyDecimals(QTY_DECIMALS));
	if (i.orderType === "limit" && !(i.limitPrice && i.limitPrice > 0)) violations.push(sharedDe.check.limitWithoutPrice);
	const bad = (v: number | null | undefined) => v !== null && v !== undefined && !(Number.isFinite(v) && v > 0);
	if (bad(i.stopLoss)) violations.push(sharedDe.check.stopInvalid);
	if (bad(i.takeProfit)) violations.push(sharedDe.check.targetInvalid);
	if (i.price === null || i.fx === null || bad(i.price) || bad(i.fx)) {
		violations.push(sharedDe.check.noQuote(i.symbol));
		return { ok: false, violations, warnings, estimateCents: 0, feeCents: i.feeCents, price: i.price };
	}
	const p = i.orderType === "limit" && i.limitPrice ? i.limitPrice : i.price;
	// ein nicht darstellbarer Orderwert (z. B. Limit 1e308) ist ein Verstoß, nie 0 €
	const estimate = Number.isFinite(i.qty) ? centsOrNull(i.qty * p * i.fx) : null;
	if (estimate === null) {
		violations.push(sharedDe.check.valueNotRepresentable);
		return { ok: false, violations, warnings, estimateCents: 0, feeCents: i.feeCents, price: i.price };
	}
	const estimateCents = estimate;
	if (estimateCents <= 0) violations.push(sharedDe.check.valueBelowCent);
	if (i.side === "sell") {
		if (i.heldQty + 1e-9 < i.qty) violations.push(sharedDe.check.noShortSelling(i.heldQty.toLocaleString("de-DE"), i.symbol));
		if (i.stopLoss || i.takeProfit) warnings.push(sharedDe.check.stopTargetIgnoredOnSell);
	} else {
		if (estimateCents + i.feeCents > i.cashCents) violations.push(sharedDe.check.notEnoughCash(eur(estimateCents + i.feeCents), eur(i.cashCents)));
		if (i.limits.maxPositionPct > 0 && i.equityCents > 0) {
			const after = ((i.positionValueCents + estimateCents) / i.equityCents) * 100;
			if (after > i.limits.maxPositionPct) violations.push(sharedDe.check.positionLimit(i.symbol, after.toFixed(1).replace(".", ","), String(i.limits.maxPositionPct).replace(".", ",")));
		}
		if (i.limits.dailyLossPct > 0 && i.dayLossPct !== null && i.dayLossPct >= i.limits.dailyLossPct)
			violations.push(sharedDe.check.dailyLoss(i.dayLossPct.toFixed(1).replace(".", ","), String(i.limits.dailyLossPct).replace(".", ",")));
		if (i.stopLoss && i.stopLoss >= p) violations.push(sharedDe.check.stopAboveEntry);
		else if (i.stopLoss) {
			// Risiko je Trade: Verlust bis zum Stop plus Kauf- und Verkaufsgebühr
			const risk = (centsOrNull(i.qty * (p - i.stopLoss) * i.fx) ?? Number.POSITIVE_INFINITY) + 2 * i.feeCents;
			const riskPct = i.equityCents > 0 ? (risk / i.equityCents) * 100 : 0;
			if (!Number.isFinite(risk)) violations.push(sharedDe.check.riskNotRepresentable);
			else if (i.limits.maxRiskPct > 0 && riskPct > i.limits.maxRiskPct)
				violations.push(sharedDe.check.riskLimit(eur(risk), riskPct.toFixed(2).replace(".", ","), String(i.limits.maxRiskPct).replace(".", ",")));
		} else if (i.byAgent && i.limits.requireStop) violations.push(sharedDe.check.agentNeedsStop);
		else warnings.push(sharedDe.check.noStop);
		if (i.takeProfit && i.takeProfit <= p) violations.push(sharedDe.check.targetBelowEntry);
	}
	if (i.limits.maxOrderCents > 0 && estimateCents > i.limits.maxOrderCents) violations.push(sharedDe.check.orderLimit(eur(estimateCents), eur(i.limits.maxOrderCents)));
	if (i.openByAuthor !== undefined && i.limits.maxOpenProposals > 0 && i.openByAuthor >= i.limits.maxOpenProposals)
		violations.push(sharedDe.check.openProposals(i.openByAuthor, i.limits.maxOpenProposals));
	// ein Limit weit weg vom Kurs ist fast immer ein Tippfehler – ab 50 % keine Order, ab 10 % ein Hinweis
	if (i.orderType === "limit" && i.limitPrice && movePct(i.price, i.limitPrice) > MAX_LIMIT_MOVE_PCT) violations.push(sharedDe.check.limitTooFar(MAX_LIMIT_MOVE_PCT));
	else if (i.orderType === "limit" && i.limitPrice && movePct(i.price, i.limitPrice) > 10) warnings.push(sharedDe.check.limitFar(10));
	if (estimateCents > 0 && i.feeCents / estimateCents > 0.02) warnings.push(sharedDe.check.feeHigh(((i.feeCents / estimateCents) * 100).toFixed(1).replace(".", ",")));
	return { ok: violations.length === 0, violations, warnings, estimateCents, feeCents: i.feeCents, price: i.price };
}

export const statusLabel: Record<ProposalStatus, string> = sharedDe.status;

export const sideLabel: Record<Side, string> = sharedDe.side;

export const ACTIVE_STATUSES: ProposalStatus[] = ["pending", "open", "placed", "sending", "confirm"];
