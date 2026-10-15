// Zahlen und Daten auf Deutsch, an einer Stelle: Dezimalkomma, Tausenderpunkt, „€“ nachgestellt, Vorzeichen bei Änderungen.

const eurFmt = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const eurShort = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

export function eur(cents: number, { short = false } = {}): string {
	return (short ? eurShort : eurFmt).format(cents / 100);
}

/** +1.234,56 € / −12,00 € (echtes Minuszeichen) */
export function signedEur(cents: number): string {
	if (cents === 0) return eur(0);
	return `${cents > 0 ? "+" : "−"}${eur(Math.abs(cents))}`;
}

export function pct(v: number | null | undefined, { signed = true, digits = 1 } = {}): string {
	if (v === null || v === undefined || !Number.isFinite(v)) return "–";
	const s = Math.abs(v).toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
	if (!signed) return `${s} %`;
	return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${s} %`;
}

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", CHF: "CHF", JPY: "¥" };

/** Kurs in Wertpapierwährung, 2 bis 4 Nachkommastellen je nach Größe. */
export function price(v: number | null | undefined, currency = "EUR"): string {
	if (v === null || v === undefined) return "–";
	const digits = v >= 1000 ? 2 : v >= 1 ? 2 : 4;
	return `${v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${SYMBOLS[currency] ?? currency}`;
}

export function qty(v: number): string {
	return v.toLocaleString("de-DE", { maximumFractionDigits: 6 });
}

/** Stückzahl mit richtigem Plural: „1 Stück“ ist im Deutschen gleich, also nur die Zahl. */
export function shares(v: number): string {
	return `${qty(v)} Stk.`;
}

export function tone(v: number | null | undefined): string {
	if (!v) return "text-fg-2";
	return v > 0 ? "text-ok" : "text-err";
}

export function date(ms: number): string {
	return new Date(ms).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function dateTime(ms: number): string {
	return new Date(ms).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(day: string): string {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(y, m - 1, d).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function ago(ms: number | null, now = Date.now()): string {
	if (!ms) return "–";
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 45) return "gerade eben";
	const m = Math.round(s / 60);
	if (m < 60) return `vor ${m} Min.`;
	const h = Math.round(m / 60);
	if (h < 36) return `vor ${h} Std.`;
	const d = Math.round(h / 24);
	return d === 1 ? "vor 1 Tag" : `vor ${d} Tagen`;
}

/** Deutsche Eingabe „1.234,5“ oder „1234.5“ → Zahl, sonst NaN. */
export function parseDe(raw: string): number {
	const s = raw.trim().replace(/\s|€/g, "");
	if (!s) return Number.NaN;
	const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
	return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}
