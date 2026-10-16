// Kalender der Tagesergebnisse (Auswertung): Monate als Wochenraster (Montag zuerst) und eine divergierende Skala mit
// neutraler Mitte – vier Stufen je Seite, genau 0 neutral, kein Wert („kein Tagesstand“) eigens. Rein und linear in
// der Zahl der Tage, Tage in Ortszeit als "YYYY-MM-DD" wie dayKey().

export const LEVELS = 4;

export interface HeatCell {
	day: string;
	value: number | null; // null: kein Wert an diesem Tag
	level: number; // −LEVELS … LEVELS, 0 = genau null oder kein Wert
}

export interface HeatMonth {
	key: string; // "YYYY-MM"
	year: number;
	month: number; // 1–12
	weeks: (HeatCell | null)[][]; // je Woche 7 Plätze Mo–So; null = Tag außerhalb des Monats oder Zeitraums
	sum: number; // Summe der Werte im Zeitraum
	days: number; // Tage mit Wert
}

const pad = (n: number) => String(n).padStart(2, "0");
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (day: string) => {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(y, m - 1, d, 12); // Mittag: Sommerzeit verschiebt nie den Tag
};

/**
 * Stufenbreite: das 90. Perzentil der Beträge (ohne Nullen), damit ein Ausreißertag nicht alle anderen blass macht;
 * bei weniger als 10 Tagen der größte Betrag. Darüber liegt Stufe 4.
 */
export function heatScale(values: number[]): { max: number; level: (v: number | null) => number } {
	const abs = values.filter((v) => v !== 0 && Number.isFinite(v)).map(Math.abs).sort((a, b) => a - b);
	const max = abs.length === 0 ? 0 : abs.length < 10 ? abs[abs.length - 1] : abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.9))];
	const level = (v: number | null) => {
		if (v === null || v === 0 || !Number.isFinite(v) || max === 0) return 0;
		return Math.sign(v) * Math.min(LEVELS, Math.max(1, Math.ceil((Math.abs(v) / max) * LEVELS)));
	};
	return { max, level };
}

/** Grenzen der Stufen für die Legende: Stufe k deckt (max·(k−1)/4, max·k/4], Stufe 4 alles darüber. */
export function levelBounds(max: number): number[] {
	return Array.from({ length: LEVELS }, (_, i) => (max * (i + 1)) / LEVELS);
}

/** Monate von from bis to (beide einschließlich) mit den Werten je Tag; Tage ohne Eintrag sind „kein Wert“. */
export function calendarMonths(values: Map<string, number | null>, from: string, to: string): HeatMonth[] {
	if (from > to) return [];
	const scale = heatScale([...values].filter(([d]) => d >= from && d <= to).map(([, v]) => v).filter((v): v is number => v !== null));
	const start = parse(from);
	const end = parse(to);
	const out: HeatMonth[] = [];
	for (let y = start.getFullYear(), m = start.getMonth(); y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth()); m === 11 ? (y++, (m = 0)) : m++) {
		const last = new Date(y, m + 1, 0).getDate();
		const lead = (new Date(y, m, 1, 12).getDay() + 6) % 7; // Montag = 0
		const slots: (HeatCell | null)[] = Array.from({ length: lead }, () => null);
		let sum = 0;
		let days = 0;
		for (let d = 1; d <= last; d++) {
			const day = key(new Date(y, m, d, 12));
			if (day < from || day > to) {
				slots.push(null);
				continue;
			}
			const v = values.get(day) ?? null;
			if (v !== null) {
				sum += v;
				days++;
			}
			slots.push({ day, value: v, level: scale.level(v) });
		}
		while (slots.length % 7) slots.push(null);
		const weeks: (HeatCell | null)[][] = [];
		for (let i = 0; i < slots.length; i += 7) weeks.push(slots.slice(i, i + 7));
		out.push({ key: `${y}-${pad(m + 1)}`, year: y, month: m + 1, weeks, sum, days });
	}
	return out;
}

/** Tag ± n Tage (Pfeiltasten im Kalender). */
export function addDays(day: string, n: number): string {
	const d = parse(day);
	d.setDate(d.getDate() + n);
	return key(d);
}
