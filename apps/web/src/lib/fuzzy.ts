// Unscharfe Suche der Befehlspalette: jedes Wort der Eingabe muss im Namen oder in einem Stichwort vorkommen – ganz,
// als Wortanfang, irgendwo oder als Buchstabenfolge („nvd“ → NVDA, „pdep“ → Papierdepot). Umlaute und Groß-/Kleinschreibung
// zählen nicht („uber“ findet „Übersicht“). Bei Gleichstand bleibt die Reihenfolge der Einträge (Gruppen).

export function normalize(s: string): string {
	return s.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Punkte für ein Wort gegen einen Text; null, wenn es nicht vorkommt. */
export function wordScore(word: string, text: string): number | null {
	if (!word) return 0;
	if (text === word) return 100;
	if (text.startsWith(word)) return 80 + Math.min(10, (word.length / text.length) * 10);
	const at = text.indexOf(word);
	if (at > 0 && /[\s\-_./·(]/.test(text[at - 1])) return 60;
	if (at > 0) return 40;
	// Buchstabenfolge: jede Lücke kostet, ein Treffer am Wortanfang zählt mehr
	let score = 20;
	let pos = -1;
	for (const ch of word) {
		const next = text.indexOf(ch, pos + 1);
		if (next < 0) return null;
		if (next > pos + 1) score -= 1;
		pos = next;
	}
	return Math.max(1, score);
}

export interface Rankable {
	label: string;
	keywords?: string[];
}

/** Punkte eines Eintrags: Summe über die Wörter, jedes mit dem besten Text (Name zählt etwas mehr als Stichworte). */
export function entryScore(e: Rankable, query: string): number | null {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (!words.length) return 0;
	const label = normalize(e.label);
	const keys = (e.keywords ?? []).map(normalize);
	let total = 0;
	for (const w of words) {
		const own = wordScore(w, label);
		const best = Math.max(own === null ? -1 : own + 5, ...keys.map((k) => wordScore(w, k) ?? -1));
		if (best < 0) return null;
		total += best;
	}
	return total;
}

/** Treffer absteigend nach Punkten, bei Gleichstand in der gegebenen Reihenfolge; leere Eingabe: alles wie gegeben. */
export function rank<T extends Rankable>(entries: T[], query: string, limit = 50): T[] {
	if (!query.trim()) return entries.slice(0, limit);
	return entries
		.map((e, i) => ({ e, i, s: entryScore(e, query) }))
		.filter((x): x is { e: T; i: number; s: number } => x.s !== null)
		.sort((a, b) => b.s - a.s || a.i - b.i)
		.slice(0, limit)
		.map((x) => x.e);
}
