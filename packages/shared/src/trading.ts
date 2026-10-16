// Daytrading-Logik, rein und getestet: Indikatoren (EMA, VWAP, RSI, ATR), Session einer Börse, Tagesstatistik,
// Positionsgröße aus Risiko und Stop. Server, Web und Agenten (über /api) rechnen alle hiermit.
import { MAX_QTY, type Candle } from "./schema.ts";
import { cents } from "./portfolio.ts";

/** Exponentieller gleitender Durchschnitt; null, bis n Werte da sind (Start mit dem einfachen Mittel). */
export function ema(values: number[], n: number): (number | null)[] {
	const out: (number | null)[] = [];
	const k = 2 / (n + 1);
	let prev: number | null = null;
	let sum = 0;
	values.forEach((v, i) => {
		if (i < n - 1) {
			sum += v;
			out.push(null);
			return;
		}
		if (prev === null) {
			prev = (sum + v) / n;
		} else prev = v * k + prev * (1 - k);
		out.push(prev);
	});
	return out;
}

/** VWAP je Handelstag (Neustart bei jedem neuen Ortsdatum der Kerze). Ohne Volumen: null. */
export function vwap(candles: Candle[], dayOf: (t: number) => string): (number | null)[] {
	let day = "";
	let pv = 0;
	let vol = 0;
	return candles.map((c) => {
		const d = dayOf(c.t);
		if (d !== day) {
			day = d;
			pv = 0;
			vol = 0;
		}
		pv += ((c.h + c.l + c.c) / 3) * c.v;
		vol += c.v;
		return vol > 0 ? pv / vol : null;
	});
}

/** RSI nach Wilder; null, bis n Änderungen da sind. */
export function rsi(values: number[], n = 14): (number | null)[] {
	const out: (number | null)[] = [null];
	let gain = 0;
	let loss = 0;
	for (let i = 1; i < values.length; i++) {
		const d = values[i] - values[i - 1];
		const g = Math.max(0, d);
		const l = Math.max(0, -d);
		if (i <= n) {
			gain += g / n;
			loss += l / n;
			out.push(i === n ? (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)) : null);
		} else {
			gain = (gain * (n - 1) + g) / n;
			loss = (loss * (n - 1) + l) / n;
			out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
		}
	}
	return values.length ? out : [];
}

/** Average True Range nach Wilder; null, bis n Kerzen da sind. */
export function atr(candles: Candle[], n = 14): (number | null)[] {
	const out: (number | null)[] = [];
	let prev: number | null = null;
	let sum = 0;
	candles.forEach((c, i) => {
		const tr = i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c));
		if (i < n - 1) {
			sum += tr;
			out.push(null);
		} else if (prev === null) {
			prev = (sum + tr) / n;
			out.push(prev);
		} else {
			prev = (prev * (n - 1) + tr) / n;
			out.push(prev);
		}
	});
	return out;
}

export const last = <T>(xs: (T | null)[]): T | null => {
	for (let i = xs.length - 1; i >= 0; i--) if (xs[i] !== null) return xs[i];
	return null;
};

/* ------------------------------------------------------------------ Session */

export type SessionState = "pre" | "open" | "post" | "closed";

export interface SessionTimes {
	preStart: number | null;
	regStart: number;
	regEnd: number;
	postEnd: number | null;
}

/** Zustand einer Börse aus den Handelszeiten des letzten bekannten Handelstags. */
export function sessionState(s: SessionTimes | null, now: number): SessionState {
	if (!s) return "closed";
	if (now >= s.regStart && now < s.regEnd) return "open";
	if (s.preStart !== null && now >= s.preStart && now < s.regStart) return "pre";
	if (s.postEnd !== null && now >= s.regEnd && now < s.postEnd) return "post";
	return "closed";
}

/* ------------------------------------------------------------------ Tagesstatistik */

export interface DayStats {
	trades: number; // alle Ausführungen heute
	closed: number; // Verkäufe heute mit Ergebnis
	wins: number;
	losses: number;
	realizedCents: number;
	winRate: number | null;
	avgWinCents: number | null;
	avgLossCents: number | null; // negativ
	profitFactor: number | null; // Summe Gewinne / Summe Verluste
	largestLossCents: number | null;
	feesCents: number;
}

/** Aus den Trades eines Tages und den realisierten Ergebnissen der Verkäufe (FIFO aus buildBook). */
export function dayStats(trades: { id: number; side: "buy" | "sell"; time: number; feeCents: number }[], realizedBySell: Map<number, number>, from: number, to = Number.MAX_SAFE_INTEGER): DayStats {
	const today = trades.filter((t) => t.time >= from && t.time < to);
	const results = today.filter((t) => t.side === "sell" && realizedBySell.has(t.id)).map((t) => realizedBySell.get(t.id)!);
	const wins = results.filter((r) => r > 0);
	const losses = results.filter((r) => r < 0);
	const sumWin = wins.reduce((s, r) => s + r, 0);
	const sumLoss = losses.reduce((s, r) => s + r, 0);
	return {
		trades: today.length,
		closed: results.length,
		wins: wins.length,
		losses: losses.length,
		realizedCents: results.reduce((s, r) => s + r, 0),
		winRate: results.length ? (wins.length / results.length) * 100 : null,
		avgWinCents: wins.length ? Math.round(sumWin / wins.length) : null,
		avgLossCents: losses.length ? Math.round(sumLoss / losses.length) : null,
		profitFactor: sumLoss < 0 ? sumWin / -sumLoss : null,
		largestLossCents: losses.length ? Math.min(...losses) : null,
		feesCents: today.reduce((s, t) => s + t.feeCents, 0),
	};
}

/* ------------------------------------------------------------------ Positionsgröße */

export interface Sizing {
	qty: number; // ganze Stück (bei Krypto: 6 Nachkommastellen)
	riskCents: number; // Verlust bis zum Stop inkl. Gebühren für Kauf und Verkauf
	valueCents: number;
	perShareRisk: number; // in Wertpapierwährung
	limitedBy: "risk" | "cash" | "value"; // was die Stückzahl begrenzt hat
}

/**
 * Stückzahl so, dass der Verlust bis zum Stop (plus beide Gebühren) das Risiko-Budget nicht übersteigt,
 * gedeckelt durch das Cash. Long only: Stop muss unter dem Einstieg liegen.
 */
export function positionSize(i: { budgetCents: number; entry: number; stop: number; fx: number; feeCents: number; cashCents: number; fractional?: boolean; maxValueCents?: number }): Sizing | null {
	const perShareRisk = i.entry - i.stop;
	if (!(perShareRisk > 0) || !(i.entry > 0) || !(i.fx > 0) || !(i.budgetCents > 2 * i.feeCents)) return null;
	const step = i.fractional ? 1e6 : 1;
	const byRisk = (i.budgetCents - 2 * i.feeCents) / 100 / (perShareRisk * i.fx);
	const byCash = Math.max(0, i.cashCents - i.feeCents) / 100 / (i.entry * i.fx);
	// Grenzen aus der Risikoprüfung (Orderwert, Positionsgröße) gleich mit einrechnen
	const byValue = i.maxValueCents !== undefined && i.maxValueCents > 0 ? i.maxValueCents / 100 / (i.entry * i.fx) : Number.POSITIVE_INFINITY;
	const best = Math.min(byRisk, byCash, byValue);
	const qty = Math.floor(best * step) / step;
	if (!(qty > 0) || qty > MAX_QTY || !Number.isFinite(qty * i.entry * i.fx * 100)) return null;
	const limitedBy = best === byRisk ? "risk" : best === byCash ? "cash" : "value";
	return { qty, riskCents: cents(qty * perShareRisk * i.fx) + 2 * i.feeCents, valueCents: cents(qty * i.entry * i.fx), perShareRisk, limitedBy };
}

/** Risiko einer Kauforder bis zum Stop in Cent (ohne Gebühren); null ohne Stop. */
export function riskToStopCents(qty: number, entry: number, stop: number | null | undefined, fx: number): number | null {
	return stop && stop < entry ? cents(qty * (entry - stop) * fx) : null;
}

/** Gewinn/Verlust in R (Vielfache des anfänglichen Risikos). */
export function rMultiple(entry: number, stop: number | null, price: number): number | null {
	return stop && entry > stop ? (price - entry) / (entry - stop) : null;
}
