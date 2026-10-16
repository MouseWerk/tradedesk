// Zeitbudgets ohne Flattern: gemessen wird das Minimum mehrerer Läufe, und das Budget wächst um den Faktor, um den ein
// fester Vergleichslauf gerade langsamer ist als auf einem ruhigen Rechner (ausgelastete Maschine, langsamer CI-Runner).
// Strenger als das Budget wird es nie.

/** Vergleichslauf auf einem ruhigen Rechner (Minimum aus fünf), in ms */
const REFERENCE_MS = 10;

function reference(): number {
	const a: number[] = [];
	for (let i = 0; i < 50_000; i++) a.push((i * 7919) % 100_003);
	a.sort((x, y) => x - y);
	const seen = new Map<number, number>();
	for (const v of a) seen.set(v, (seen.get(v) ?? 0) + 1);
	return seen.size;
}

/** Kürzeste Dauer aus `runs` Läufen, in ms. */
export async function best(runs: number, fn: () => unknown): Promise<number> {
	let min = Number.POSITIVE_INFINITY;
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		await fn();
		min = Math.min(min, performance.now() - t);
	}
	return min;
}

/** Wie viel langsamer die Maschine gerade ist (mindestens 1). Direkt vor und nach der Messung aufrufen, das Größere zählt. */
export async function slowdown(): Promise<number> {
	return Math.max(1, (await best(5, reference)) / REFERENCE_MS);
}

/** Prüft gemessene Dauern gegen ihre Budgets, skaliert mit der Auslastung; die Zahlen stehen in der Ausgabe. */
export function withinBudget(label: string, factor: number, measured: Record<string, [ms: number, budget: number]>): string[] {
	console.log(`budget ${label} (Faktor ${factor.toFixed(2)}): ${Object.entries(measured).map(([k, [ms, b]]) => `${k} ${ms.toFixed(1)}/${(b * factor).toFixed(0)} ms`).join(", ")}`);
	return Object.entries(measured).filter(([, [ms, b]]) => ms >= b * factor).map(([k, [ms, b]]) => `${k}: ${ms.toFixed(1)} ms >= ${(b * factor).toFixed(0)} ms`);
}
