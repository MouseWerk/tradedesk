// Zahlen und Daten auf Deutsch, an einer Stelle: Dezimalkomma, Tausenderpunkt, „€“ nachgestellt, Vorzeichen bei Änderungen.

const eurFmt = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const eurShort = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** Ein Minuszeichen überall: Intl liefert den Bindestrich (U+002D), die App zeigt das echte Minus (U+2212). */
const minus = (s: string) => s.replace(/^-/, "−").replace(/(\s)-/, "$1−");

export function eur(cents: number, { short = false } = {}): string {
	return minus((short ? eurShort : eurFmt).format(cents / 100));
}

/** +1.234,56 € / −12,00 € (echtes Minuszeichen) */
export function signedEur(cents: number): string {
	if (cents === 0) return eur(0);
	return `${cents > 0 ? "+" : "−"}${eur(Math.abs(cents))}`;
}

/** +1.235 € / −12 € ohne Cent (Achsen, Monatssummen, Legenden) */
export function signedEurShort(cents: number): string {
	const r = Math.round(cents / 100) * 100;
	if (r === 0) return eur(0, { short: true });
	return `${r > 0 ? "+" : "−"}${eur(Math.abs(r), { short: true })}`;
}

export function pct(v: number | null | undefined, { signed = true, digits = 1 } = {}): string {
	if (v === null || v === undefined || !Number.isFinite(v)) return "–";
	const s = Math.abs(v).toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
	if (!signed) return `${s} %`;
	return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${s} %`;
}

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", CHF: "CHF", JPY: "¥" };

/** Kurs in Wertpapierwährung, 2 bis 4 Nachkommastellen je nach Größe; geschütztes Leerzeichen wie bei eur() (bricht nie um). */
export function price(v: number | null | undefined, currency = "EUR"): string {
	if (v === null || v === undefined) return "–";
	return `${num(v, priceDigits(v))} ${SYMBOLS[currency] ?? currency}`;
}

/** Nachkommastellen für Kurse: 2 ab 1, darunter 4 (Pennystocks, manche Kryptowerte). */
export function priceDigits(v: number): number {
	return Math.abs(v) >= 1 ? 2 : 4;
}

/** Zahl für ein Eingabefeld: deutsch mit Tausenderpunkt, wird von parseDe wieder genauso gelesen. */
export function inputNumber(v: number | null | undefined, digits = 2): string {
	if (v === null || v === undefined || !Number.isFinite(v)) return "";
	return minus(v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
}

export function currencySymbol(currency: string): string {
	return SYMBOLS[currency] ?? currency;
}

export function qty(v: number): string {
	return minus(v.toLocaleString("de-DE", { maximumFractionDigits: 6 }));
}

/** Für Tabellen: höchstens 4 Nachkommastellen (Bruchstücke aus Sparplänen), die genaue Zahl gehört in den Tooltip. */
export function qtyShort(v: number): string {
	return minus(v.toLocaleString("de-DE", { maximumFractionDigits: 4 }));
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

/**
 * Deutsche Eingabe → Zahl, sonst NaN. Komma ist das Dezimalzeichen, der Punkt trennt Tausender: „1.000“ = 1000,
 * „1.234,56“ = 1234,56. Ein einzelner Punkt ohne Dreiergruppe gilt als Dezimalpunkt („1234.5“, „104.50“, „0.001“).
 * Englische Schreibweise mit beidem („1,234.5“) ist mehrdeutig und wird abgelehnt (siehe numberError).
 */
export function parseDe(raw: string): number {
	let s = raw.trim().replace(/[\s\u00a0\u202f\u20ac$\u00a3%]/g, "");
	let sign = 1;
	if (/^[-−]/.test(s)) {
		sign = -1;
		s = s.slice(1);
	} else if (s.startsWith("+")) s = s.slice(1);
	if (!s) return Number.NaN;
	let normalized: string | null = null;
	if (s.includes(",")) {
		// deutsch: Tausenderpunkte nur in Dreiergruppen vor dem einen Komma
		if (/^(\d{1,3}(\.\d{3})+|\d*),\d*$/.test(s) && /\d/.test(s)) normalized = s.replace(/\./g, "").replace(",", ".");
	} else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) normalized = s.replace(/\./g, "");
	else if (/^\d*\.?\d+$|^\d+\.$/.test(s)) normalized = s;
	if (normalized === null || normalized === "." || normalized === "") return Number.NaN;
	const v = Number(normalized.endsWith(".") ? normalized.slice(0, -1) : normalized);
	return Number.isFinite(v) ? sign * v : Number.NaN;
}

/** Warum eine Eingabe keine Zahl ist – für die Fehlermeldung am Feld; null, wenn sie lesbar oder leer ist. */
export function numberError(raw: string): string | null {
	if (!raw.trim() || Number.isFinite(parseDe(raw))) return null;
	return /\d,\d{3}\./.test(raw) || /\d\.\d+,\d+\./.test(raw) ? "Bitte deutsches Format: 1.234,50" : "Keine Zahl – z. B. 1.234,50";
}

/** Große Zahlen kurz: 950, 12.400, 1,2 Mio., 3,4 Mrd. */
export function compact(v: number | null | undefined): string {
	if (v === null || v === undefined) return "–";
	if (Math.abs(v) >= 1e9) return minus(`${(v / 1e9).toLocaleString("de-DE", { maximumFractionDigits: 1 })} Mrd.`);
	if (Math.abs(v) >= 1e6) return minus(`${(v / 1e6).toLocaleString("de-DE", { maximumFractionDigits: 1 })} Mio.`);
	return minus(Math.round(v).toLocaleString("de-DE"));
}

export function hhmm(ms: number | null | undefined): string {
	return ms ? new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "–";
}

export function num(v: number | null | undefined, digits = 2): string {
	return v === null || v === undefined || !Number.isFinite(v) ? "–" : minus(v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
}

/** Dauer kurz (Haltedauer): „unter 1 Min.“, „45 Min.“, „3,2 Std.“, „1 Tag“, „12 Tage“. */
export function duration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
	const min = ms / 60_000;
	if (min < 1) return "unter 1 Min.";
	if (min < 60) return `${Math.round(min)} Min.`;
	const h = min / 60;
	if (h < 48) return `${h.toLocaleString("de-DE", { maximumFractionDigits: h < 10 ? 1 : 0 })} Std.`;
	const d = Math.round(h / 24);
	return d === 1 ? "1 Tag" : `${d} Tage`;
}

/** Hinweis unter der Navigation: woher die Kurse kommen (config.json "quotes"). */
export function quoteFeedNote(feed: string | undefined): string {
	if (feed === "ibkr") return "Keine Anlageberatung. Kurse von Interactive Brokers, sonst Yahoo Finance.";
	if (feed === "off") return "Keine Anlageberatung. Kurse sind ausgeschaltet.";
	if (feed === "fake") return "Keine Anlageberatung. Testkurse aus der Fixture.";
	return "Keine Anlageberatung. Kurse von Yahoo Finance, oft verzögert.";
}
