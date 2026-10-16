// Herkunft und Alter eines Kurses als leiser Hinweis neben dem Preis: „Echtzeit“, „verzögert“ oder „vor 3 Min.“.
// Alt (Server: quoteStale) heißt gedimmt und „veraltet“ – nie ein farbiger Rahmen. Rein, damit es testbar bleibt.
import type { QuoteInfo } from "@desk/shared";
import { dateTime, hhmm } from "./format";

const SOURCE: Record<string, string> = { yahoo: "Yahoo Finance", ibkr: "Interactive Brokers", fake: "Testbörse (Fixture)" };

/** Echtzeit nur, wenn die Quelle es sagt und der Kurs frisch ist – ein „Echtzeit“-Schlusskurs von gestern wäre irreführend. */
const LIVE_MAX_SEC = 300;

export function sourceName(source: string): string {
	return SOURCE[source] ?? (source ? source : "unbekannte Quelle");
}

/** Alter in Worten: „gerade eben“, „vor 3 Min.“, „vor 2 Std.“, „vor 3 Tagen“. */
export function quoteAge(sec: number): string {
	const s = Math.max(0, Math.round(sec));
	if (s < 60) return "gerade eben";
	const m = Math.round(s / 60);
	if (m < 60) return `vor ${m} Min.`;
	const h = Math.round(m / 60);
	if (h < 36) return `vor ${h} Std.`;
	const d = Math.round(h / 24);
	return d === 1 ? "vor 1 Tag" : `vor ${d} Tagen`;
}

export interface QuoteLabel {
	text: string; // kurz, neben dem Preis
	title: string; // Tooltip: Quelle, Kurszeit, Abruf, Verzögerung
	stale: boolean; // Preis dimmen
	live: boolean;
}

/** Hinweis zu einem Kurs; stale vom Server (Kurs während der Handelszeit zu alt oder Abruf fehlgeschlagen). */
export function quoteLabel(q: QuoteInfo | null | undefined, stale = false): QuoteLabel {
	if (!q) return { text: "kein Kurs", title: "Noch kein Kurs abgerufen.", stale: true, live: false };
	const age = quoteAge(q.ageSec);
	const live = q.delayed === false && q.ageSec <= LIVE_MAX_SEC && !stale;
	const text = stale ? `veraltet · ${age}` : live ? "Echtzeit" : q.delayed ? "verzögert" : age;
	const delay = q.delayed === true ? "laut Quelle verzögert" : q.delayed === false ? "laut Quelle in Echtzeit" : "Verzögerung unbekannt – das Alter zeigt, wie alt der Kurs ist";
	const parts = [
		`Quelle: ${sourceName(q.source)}`,
		`Kurszeit ${q.marketTime ? dateTime(q.marketTime) : "unbekannt"} (${age})`,
		delay,
		`abgerufen ${hhmm(q.fetchedAt)}`,
		...(stale ? ["Kurs zu alt für eine Entscheidung oder letzter Abruf fehlgeschlagen"] : []),
	];
	return { text, title: parts.join(" · "), stale, live };
}
