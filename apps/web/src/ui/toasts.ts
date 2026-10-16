// Meldungsliste ohne React: welche Meldung beim Platzmangel weicht. Eine Meldung mit „Rückgängig“ verdrängt keine
// spätere Info (AICodeGuidelines quality/perfection-pass.md, Logic) – es weicht zuerst die älteste ohne Aktion.

export interface Toast {
	id: number;
	text: string;
	tone: "info" | "error";
	action?: { label: string; run: () => void };
}

export const MAX_TOASTS = 4;

export function pushToast(xs: Toast[], t: Toast, max = MAX_TOASTS): Toast[] {
	const next = [...xs, t];
	while (next.length > max) {
		// nie die neue Meldung selbst, nie eine mit Aktion; gibt es keine andere, bleiben ausnahmsweise mehr stehen
		const i = next.findIndex((x, k) => k < next.length - 1 && !x.action);
		if (i < 0) break;
		next.splice(i, 1);
	}
	return next;
}
