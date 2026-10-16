// Auswertung (Seite „Auswertung“): Kurve mit Drawdown, Ergebnis je Tag, geschlossene Trades mit R, Kennzahlen und
// Gruppen. Rein und linear in der Zahl der Trades und Tage – der Server reicht Buch, Vorschläge und Tagesstände herein.
// Tage, Wochentage und Stunden in Ortszeit wie dayKey() (der Desk läuft in Europe/Berlin).
import type { AnalyticsPoint, ClosedTrade, CurvePoint, DayResult, TradeStats } from "./schema.ts";
import { cents, dayKey, type ClosedLot } from "./portfolio.ts";

/** Grenzen der R-Verteilung: (−∞, −2], (−2, −1], (−1, 0], (0, 1], (1, 2], (2, 3], (3, ∞). */
export const R_EDGES = [-2, -1, 0, 1, 2, 3];

/** Was der Server je Trade dazugibt: Kauf und Verkauf aus dem Buch, Vorschlag und Währung des Instruments. */
export interface LotContext {
	accountId: string;
	name: string;
	author: string;
	proposalId: number | null;
	stopLoss: number | null; // Stop des Vorschlags in Wertpapierwährung
	buyPrice: number; // gebuchter Kurs des Kaufs in seiner Währung
	buyCurrency: string;
	buyFx: number;
	stopCurrency: string; // Währung des Instruments (darin steht der Stop)
}

/**
 * Geschlossener Trade mit R. Risiko = Verlust bis zum Stop über die Stückzahl des Teils, zum Wechselkurs des Kaufs,
 * plus beide anteiligen Gebühren (wie die Risikoprüfung). Ohne Stop, mit Stop über dem Einstieg oder bei einem Kauf in
 * einer anderen Währung als der Stop (Trade Republic bucht US-Werte in EUR) ist R unbekannt.
 */
export function closedTrade(l: ClosedLot, c: LotContext): ClosedTrade {
	const stop = c.stopLoss;
	const riskCents = stop !== null && c.buyPrice > stop && c.buyCurrency === c.stopCurrency ? cents(l.qty * (c.buyPrice - stop) * c.buyFx) + l.buyFeeCents + l.sellFeeCents : null;
	return {
		accountId: c.accountId, symbol: l.symbol, name: c.name, author: c.author, buyTradeId: l.buyId, sellTradeId: l.sellId, proposalId: c.proposalId, qty: l.qty,
		entryTime: l.entryTime, exitTime: l.exitTime, entryPrice: l.entryPrice, exitPrice: l.exitPrice, costCents: l.costCents, proceedsCents: l.proceedsCents,
		feesCents: l.buyFeeCents + l.sellFeeCents, pnlCents: l.pnlCents, holdMs: l.exitTime - l.entryTime, stopLoss: stop, riskCents, r: riskCents && riskCents > 0 ? l.pnlCents / riskCents : null,
	};
}

/** Kennzahlen über geschlossene Trades (siehe TradeStatsSchema). */
export function tradeStats(trades: ClosedTrade[]): TradeStats {
	let wins = 0;
	let losses = 0;
	let profit = 0;
	let loss = 0;
	let rSum = 0;
	let rTrades = 0;
	let hold = 0;
	let fees = 0;
	let largestWin: number | null = null;
	let largestLoss: number | null = null;
	for (const t of trades) {
		if (t.pnlCents > 0) {
			wins++;
			profit += t.pnlCents;
			if (largestWin === null || t.pnlCents > largestWin) largestWin = t.pnlCents;
		} else if (t.pnlCents < 0) {
			losses++;
			loss += t.pnlCents;
			if (largestLoss === null || t.pnlCents < largestLoss) largestLoss = t.pnlCents;
		}
		if (t.r !== null) {
			rSum += t.r;
			rTrades++;
		}
		hold += t.holdMs;
		fees += t.feesCents;
	}
	const n = trades.length;
	const pnl = profit + loss;
	return {
		trades: n,
		wins,
		losses,
		winRate: n ? (wins / n) * 100 : null,
		pnlCents: pnl,
		grossProfitCents: profit,
		grossLossCents: loss,
		profitFactor: loss < 0 ? profit / -loss : null,
		expectancyCents: n ? cents(pnl / n / 100) : null,
		expectancyR: rTrades ? rSum / rTrades : null,
		rTrades,
		avgWinCents: wins ? cents(profit / wins / 100) : null,
		avgLossCents: losses ? cents(loss / losses / 100) : null,
		largestWinCents: largestWin,
		largestLossCents: largestLoss,
		avgHoldMs: n ? hold / n : null,
		feesCents: fees,
	};
}

/** R-Verteilung nach R_EDGES; Trades ohne R zählen nicht. */
export function rBuckets(trades: ClosedTrade[]): { from: number | null; to: number | null; trades: number; pnlCents: number }[] {
	const out = [null, ...R_EDGES].map((from, i) => ({ from, to: i < R_EDGES.length ? R_EDGES[i] : null, trades: 0, pnlCents: 0 }));
	for (const t of trades) {
		if (t.r === null) continue;
		let i = R_EDGES.findIndex((e) => t.r! <= e);
		if (i < 0) i = R_EDGES.length;
		out[i].trades++;
		out[i].pnlCents += t.pnlCents;
	}
	return out;
}

/**
 * Tagesstände mehrerer Depots zu einer Kurve: je Tag die Summe des jeweils letzten Stands jedes Depots (ein Depot ohne
 * Stand an dem Tag zählt mit seinem vorigen). Linear über alle Punkte; jede Eingabekurve nach Tag sortiert.
 */
export function combineCurves(curves: CurvePoint[][]): CurvePoint[] {
	if (curves.length === 1) return curves[0];
	const days = [...new Set(curves.flatMap((c) => c.map((p) => p.day)))].sort();
	const at = curves.map(() => -1);
	return days.map((day) => {
		let equityCents = 0;
		let depositsCents = 0;
		curves.forEach((c, k) => {
			while (at[k] + 1 < c.length && c[at[k] + 1].day <= day) at[k]++;
			if (at[k] >= 0) {
				equityCents += c[at[k]].equityCents;
				depositsCents += c[at[k]].depositsCents;
			}
		});
		return { day, equityCents, depositsCents };
	});
}

/** Kurve im Zeitraum mit Ergebnis, Spitze und Drawdown (siehe AnalyticsPointSchema) und dem tiefsten Drawdown. */
export function drawdowns(curve: CurvePoint[]): { points: AnalyticsPoint[]; max: { cents: number; pct: number | null; peakDay: string; troughDay: string; recoveryDay: string | null } | null } {
	let peak = Number.NEGATIVE_INFINITY;
	let peakDay = "";
	let max: { cents: number; pct: number | null; peakDay: string; troughDay: string; recoveryDay: string | null } | null = null;
	let maxPeak = 0;
	const points = curve.map((p) => {
		const result = p.equityCents - p.depositsCents;
		if (result >= peak) {
			peak = result;
			peakDay = p.day;
		}
		const dd = result - peak;
		const base = p.depositsCents + peak;
		const point = { ...p, resultCents: result, peakCents: peak, drawdownCents: dd, drawdownPct: base > 0 ? (dd / base) * 100 : null };
		if (max && max.recoveryDay === null && result >= maxPeak) max.recoveryDay = p.day;
		if (dd < 0 && (!max || dd < max.cents)) {
			max = { cents: dd, pct: point.drawdownPct, peakDay, troughDay: p.day, recoveryDay: null };
			maxPeak = peak;
		}
		return point;
	});
	return { points, max };
}

/**
 * Ergebnis je Tag (siehe DayResultSchema). curve: alle Tagesstände (auch vor from, für das erste Fenster), nach Tag
 * sortiert; realized: geschlossene Trades nach Ausstiegstag. Ausgabe nur für Tage im Zeitraum, aufsteigend.
 */
export function dayResults(curve: CurvePoint[], trades: ClosedTrade[], from: string | null, to: string): DayResult[] {
	const realized = new Map<string, { cents: number; trades: number }>();
	for (const t of trades) {
		const d = dayKey(t.exitTime);
		const r = realized.get(d) ?? { cents: 0, trades: 0 };
		r.cents += t.pnlCents;
		r.trades++;
		realized.set(d, r);
	}
	const inRange = (d: string) => (from === null || d >= from) && d <= to;
	const realizedDays = [...realized.keys()].sort();
	const out: DayResult[] = [];
	const covered = new Set<string>();
	let k = 0; // Zeiger in realizedDays: alles bis zum vorigen Stand ist verbraucht
	curve.forEach((p, i) => {
		const prev = i > 0 ? curve[i - 1] : null;
		let windowCents = 0;
		while (k < realizedDays.length && realizedDays[k] <= p.day) {
			if (prev && realizedDays[k] > prev.day) windowCents += realized.get(realizedDays[k])!.cents;
			k++;
		}
		if (!inRange(p.day)) return;
		covered.add(p.day);
		const own = realized.get(p.day);
		const result = prev ? p.equityCents - p.depositsCents - (prev.equityCents - prev.depositsCents) : null;
		out.push({ day: p.day, realizedCents: own?.cents ?? 0, trades: own?.trades ?? 0, resultCents: result, unrealizedChangeCents: result === null ? null : result - windowCents, sinceDay: prev?.day ?? null });
	});
	for (const d of realizedDays)
		if (inRange(d) && !covered.has(d)) out.push({ day: d, realizedCents: realized.get(d)!.cents, trades: realized.get(d)!.trades, resultCents: null, unrealizedChangeCents: null, sinceDay: null });
	return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** ISO-Wochentag in Ortszeit: 1 = Montag … 7 = Sonntag. */
export function isoWeekday(ms: number): number {
	return ((new Date(ms).getDay() + 6) % 7) + 1;
}

/** Gruppen nach einem Schlüssel; keys gibt Reihenfolge und Gruppen vor, die auch ohne Trades erscheinen. */
export function groupStats<K>(trades: ClosedTrade[], keyOf: (t: ClosedTrade) => K, keys: K[] = []): Map<K, TradeStats> {
	const groups = new Map<K, ClosedTrade[]>(keys.map((k) => [k, []]));
	for (const t of trades) {
		const k = keyOf(t);
		const g = groups.get(k);
		if (g) g.push(t);
		else groups.set(k, [t]);
	}
	return new Map([...groups].map(([k, g]) => [k, tradeStats(g)]));
}
