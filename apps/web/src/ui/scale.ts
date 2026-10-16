// Achsen der Charts: runde Teilstriche, und die Skala reicht bis zum nächsten Teilstrich über und unter den Daten –
// sonst lag das Tageshoch über dem obersten beschrifteten Wert.

function step(lo: number, hi: number, count: number): number {
	const raw = (hi - lo) / Math.max(1, count);
	const mag = 10 ** Math.floor(Math.log10(raw));
	return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
}

const clean = (v: number) => Number(v.toPrecision(12));

/** 4–5 runde Achsenwerte zwischen lo und hi (nur innerhalb). */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
	if (!(hi > lo)) return [lo];
	const s = step(lo, hi, count);
	const out: number[] = [];
	for (let v = Math.ceil(lo / s) * s; v <= hi + s * 1e-9; v += s) out.push(clean(v));
	return out;
}

/** Skala, die die Daten mit einem Teilstrich darüber und darunter einschließt; count je nach Höhe 3 bis 6. */
export function niceScale(lo: number, hi: number, count = 4): { lo: number; hi: number; ticks: number[] } {
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, ticks: [0, 1] };
	if (!(hi > lo)) {
		const pad = Math.abs(lo) * 0.01 || 1;
		return niceScale(lo - pad, hi + pad, count);
	}
	const s = step(lo, hi, count);
	const a = clean(Math.floor(lo / s + 1e-9) * s);
	const b = clean(Math.ceil(hi / s - 1e-9) * s);
	const ticks: number[] = [];
	for (let v = a; v <= b + s * 1e-9; v += s) ticks.push(clean(v));
	return { lo: a, hi: b, ticks };
}

/** Teilstriche nach Höhe: etwa alle 60–70 px einer, mindestens 3, höchstens 6. */
export const tickCount = (px: number) => Math.max(3, Math.min(6, Math.round(px / 65)));
