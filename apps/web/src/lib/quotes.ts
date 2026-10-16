// Herkunft und Alter eines Kurses als leiser Hinweis neben dem Preis: „Echtzeit“, „verzögert“ oder „vor 3 Min.“.
// Alt (Server: quoteStale) heißt gedimmt und „veraltet“ – nie ein farbiger Rahmen. Rein, damit es testbar bleibt.
import type { QuoteInfo } from "@desk/shared";
import { de } from "../i18n/de";
import { dateTime, hhmm } from "./format";

const SOURCE: Record<string, string> = { yahoo: "Yahoo Finance", ibkr: "Interactive Brokers", fake: de.quote.fixture };

/** Echtzeit nur, wenn die Quelle es sagt und der Kurs frisch ist – ein „Echtzeit“-Schlusskurs von gestern wäre irreführend. */
const LIVE_MAX_SEC = 300;

export function sourceName(source: string): string {
	return SOURCE[source] ?? (source ? source : de.quote.unknownSource);
}

/** Alter in Worten: „gerade eben“, „vor 3 Min.“, „vor 2 Std.“, „vor 3 Tagen“. */
export function quoteAge(sec: number): string {
	const s = Math.max(0, Math.round(sec));
	if (s < 60) return de.quote.justNow;
	const m = Math.round(s / 60);
	if (m < 60) return de.quote.minutesAgo(m);
	const h = Math.round(m / 60);
	if (h < 36) return de.quote.hoursAgo(h);
	const d = Math.round(h / 24);
	return de.quote.daysAgo(d);
}

export interface QuoteLabel {
	text: string; // kurz, neben dem Preis
	title: string; // Tooltip: Quelle, Kurszeit, Abruf, Verzögerung
	stale: boolean; // Preis dimmen
	live: boolean;
}

/** Hinweis zu einem Kurs; stale vom Server (Kurs während der Handelszeit zu alt oder Abruf fehlgeschlagen). */
export function quoteLabel(q: QuoteInfo | null | undefined, stale = false): QuoteLabel {
	if (!q) return { text: de.quote.none, title: de.quote.noneTitle, stale: true, live: false };
	const age = quoteAge(q.ageSec);
	const live = q.delayed === false && q.ageSec <= LIVE_MAX_SEC && !stale;
	const text = stale ? de.quote.stale(age) : live ? de.quote.live : q.delayed ? de.quote.delayed : age;
	const delay = q.delayed === true ? de.quote.delayedBySource : q.delayed === false ? de.quote.liveBySource : de.quote.delayUnknown;
	const parts = [
		de.quote.source(sourceName(q.source)),
		de.quote.time(q.marketTime ? dateTime(q.marketTime) : de.quote.unknown, age),
		delay,
		de.quote.fetched(hhmm(q.fetchedAt)),
		...(stale ? [de.quote.tooOld] : []),
	];
	return { text, title: parts.join(" · "), stale, live };
}
