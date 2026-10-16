// Reine Depotlogik für Server, Web und Tests: Positionen nach FIFO, Bewertung, Risikoprüfung, Kursbewegung.
// Geldbeträge in Cent (EUR), kaufmännisch gerundet an genau einer Stelle: cents().
import type { Check, ProposalStatus, RiskLimits, Side } from "./schema.ts";

/**
 * EUR → Cent, kaufmännisch (halbe Cent vom Nullpunkt weg). Ein nicht endlicher oder nicht mehr exakt darstellbarer
 * Betrag ist ein Fehler, nie 0: sonst rutscht eine Order über 1e308 € als "0,00 €" durch jede Grenze.
 */
export function cents(eur: number): number {
	const abs = Math.abs(eur) * 100 * (1 + Number.EPSILON);
	if (!Number.isFinite(abs) || abs > Number.MAX_SAFE_INTEGER) throw new RangeError(`Betrag ${eur} € ist nicht darstellbar.`);
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
}

interface Lot {
	tradeId: number;
	qty: number;
	price: number;
	costCents: number;
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
	const sorted = [...trades].sort((a, b) => a.time - b.time || a.id - b.id);
	for (const t of sorted) {
		feesCents += t.feeCents;
		const list = lots.get(t.symbol) ?? [];
		lots.set(t.symbol, list);
		if (t.side === "buy") {
			buysCents += t.valueCents + t.feeCents;
			// Preis je Stück in EUR aus dem gebuchten Wert: bei Trade Republic kauft man AAPL in EUR, notiert ist sie in USD
			list.push({ tradeId: t.id, qty: t.qty, price: t.valueCents / 100 / t.qty, costCents: t.valueCents + t.feeCents });
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
		if (left > 1e-9) oversold.set(t.id, left);
		const soldQty = roundQty(t.qty - left);
		// Erlös nur für die tatsächlich gehaltenen Stück
		const proceeds = soldQty >= t.qty - 1e-9 ? t.valueCents - t.feeCents : Math.round(((t.valueCents - t.feeCents) * soldQty) / t.qty);
		const realized = proceeds - cost;
		realizedBySell.set(t.id, realized);
		realizedCents += realized;
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
	return { holdings, realizedBySell, realizedCents, feesCents, buysCents, sellsCents, oversold, openLots };
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
	if (i.killSwitch) violations.push("Not-Aus ist aktiv – keine Orders, bis du ihn ausschaltest.");
	if (!(i.qty > 0) || !Number.isFinite(i.qty)) violations.push("Stückzahl muss größer als 0 sein.");
	else if (decimals(i.qty) > QTY_DECIMALS) violations.push(`Stückzahl mit höchstens ${QTY_DECIMALS} Nachkommastellen.`);
	if (i.orderType === "limit" && !(i.limitPrice && i.limitPrice > 0)) violations.push("Limit-Order ohne Limitkurs.");
	const bad = (v: number | null | undefined) => v !== null && v !== undefined && !(Number.isFinite(v) && v > 0);
	if (bad(i.stopLoss)) violations.push("Stop-Loss ist keine gültige Zahl.");
	if (bad(i.takeProfit)) violations.push("Kursziel ist keine gültige Zahl.");
	if (i.price === null || i.fx === null || bad(i.price) || bad(i.fx)) {
		violations.push(`Kein aktueller Kurs für ${i.symbol} – ohne Kurs keine Order.`);
		return { ok: false, violations, warnings, estimateCents: 0, feeCents: i.feeCents, price: i.price };
	}
	const p = i.orderType === "limit" && i.limitPrice ? i.limitPrice : i.price;
	// ein nicht darstellbarer Orderwert (z. B. Limit 1e308) ist ein Verstoß, nie 0 €
	const estimate = Number.isFinite(i.qty) ? centsOrNull(i.qty * p * i.fx) : null;
	if (estimate === null) {
		violations.push("Orderwert ist nicht darstellbar – Stückzahl und Kurs prüfen.");
		return { ok: false, violations, warnings, estimateCents: 0, feeCents: i.feeCents, price: i.price };
	}
	const estimateCents = estimate;
	if (estimateCents <= 0) violations.push("Orderwert unter einem Cent – keine Order.");
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
			const risk = (centsOrNull(i.qty * (p - i.stopLoss) * i.fx) ?? Number.POSITIVE_INFINITY) + 2 * i.feeCents;
			const riskPct = i.equityCents > 0 ? (risk / i.equityCents) * 100 : 0;
			if (!Number.isFinite(risk)) violations.push("Risiko bis zum Stop ist nicht darstellbar.");
			else if (i.limits.maxRiskPct > 0 && riskPct > i.limits.maxRiskPct)
				violations.push(`Risiko bis zum Stop ${eur(risk)} = ${riskPct.toFixed(2).replace(".", ",")} % des Depots – Grenze ${String(i.limits.maxRiskPct).replace(".", ",")} % je Trade.`);
		} else if (i.byAgent && i.limits.requireStop) violations.push("Käufe von Agenten brauchen einen Stop-Loss.");
		else warnings.push("Ohne Stop-Loss ist das Risiko dieser Order nicht begrenzt.");
		if (i.takeProfit && i.takeProfit <= p) violations.push("Kursziel muss über dem Kaufkurs liegen.");
	}
	if (i.limits.maxOrderCents > 0 && estimateCents > i.limits.maxOrderCents) violations.push(`Orderwert ${eur(estimateCents)} liegt über der Grenze von ${eur(i.limits.maxOrderCents)}.`);
	if (i.openByAuthor !== undefined && i.limits.maxOpenProposals > 0 && i.openByAuthor >= i.limits.maxOpenProposals)
		violations.push(`Schon ${i.openByAuthor} offene Vorschläge – Grenze ${i.limits.maxOpenProposals}. Erst entscheiden lassen.`);
	// ein Limit weit weg vom Kurs ist fast immer ein Tippfehler – ab 50 % keine Order, ab 10 % ein Hinweis
	if (i.orderType === "limit" && i.limitPrice && movePct(i.price, i.limitPrice) > MAX_LIMIT_MOVE_PCT) violations.push(`Limit liegt mehr als ${MAX_LIMIT_MOVE_PCT} % vom aktuellen Kurs entfernt – Tippfehler?`);
	else if (i.orderType === "limit" && i.limitPrice && movePct(i.price, i.limitPrice) > 10) warnings.push("Limit liegt mehr als 10 % vom aktuellen Kurs entfernt.");
	if (estimateCents > 0 && i.feeCents / estimateCents > 0.02) warnings.push(`Gebühr ist ${((i.feeCents / estimateCents) * 100).toFixed(1).replace(".", ",")} % des Orderwerts.`);
	return { ok: violations.length === 0, violations, warnings, estimateCents, feeCents: i.feeCents, price: i.price };
}

export const statusLabel: Record<ProposalStatus, string> = {
	pending: "wartet auf dich",
	open: "Limit offen",
	placed: "beim Broker",
	sending: "wird gesendet",
	confirm: "Broker fragt nach",
	filled: "ausgeführt",
	rejected: "abgelehnt",
	stale: "Kurs bewegt",
	expired: "abgelaufen",
	cancelled: "storniert",
};

export const sideLabel: Record<Side, string> = { buy: "Kauf", sell: "Verkauf" };

export const ACTIVE_STATUSES: ProposalStatus[] = ["pending", "open", "placed", "sending", "confirm"];
