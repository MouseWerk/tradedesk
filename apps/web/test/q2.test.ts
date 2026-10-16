// Reine Logik der Runde q2: Kalender der Tagesergebnisse (Monate, Stufen), Rangfolge der Befehlspalette,
// Hinweis zu Herkunft und Alter eines Kurses, Haltedauer.
import { describe, expect, it } from "vitest";
import type { QuoteInfo } from "@desk/shared";
import { addDays, calendarMonths, heatScale, levelBounds } from "../src/lib/heatmap.ts";
import { entryScore, normalize, rank, wordScore } from "../src/lib/fuzzy.ts";
import { quoteAge, quoteLabel } from "../src/lib/quotes.ts";
import { duration } from "../src/lib/format.ts";

describe("heatScale", () => {
	it("keeps 0 neutral and gives every other value at least level 1, with the sign", () => {
		const s = heatScale([100, -50, 25, 0]);
		expect(s.max).toBe(100);
		expect(s.level(0)).toBe(0);
		expect(s.level(null)).toBe(0);
		expect(s.level(1)).toBe(1);
		expect(s.level(100)).toBe(4);
		expect(s.level(-50)).toBe(-2);
		expect(s.level(-51)).toBe(-3);
		expect(s.level(-1000)).toBe(-4);
	});

	it("uses the 90th percentile from 10 days on, so one outlier does not wash out the rest", () => {
		const vals = [...Array.from({ length: 19 }, (_, i) => (i + 1) * 10), 10_000];
		const s = heatScale(vals);
		expect(s.max).toBe(190);
		expect(s.level(10_000)).toBe(4);
		expect(s.level(95)).toBe(2);
	});

	it("handles no values and only zeros", () => {
		expect(heatScale([]).level(5)).toBe(0);
		expect(heatScale([0, 0]).max).toBe(0);
	});

	it("names the level bounds for the legend", () => {
		expect(levelBounds(400)).toEqual([100, 200, 300, 400]);
	});
});

describe("calendarMonths", () => {
	it("lays out months Monday first, marks days outside the range and days without a value", () => {
		// Oktober 2026 beginnt an einem Donnerstag
		const months = calendarMonths(new Map([["2026-10-02", 500], ["2026-10-05", -200], ["2026-10-06", 0]]), "2026-10-02", "2026-10-07");
		expect(months).toHaveLength(1);
		const [oct] = months;
		expect(oct.key).toBe("2026-10");
		expect(oct.weeks[0].slice(0, 4)).toEqual([null, null, null, null]); // Mo–Do: vor dem Monat bzw. vor from
		expect(oct.weeks[0][4]).toEqual({ day: "2026-10-02", value: 500, level: 4 });
		expect(oct.weeks[0][5]).toEqual({ day: "2026-10-03", value: null, level: 0 });
		expect(oct.weeks[1][0]).toEqual({ day: "2026-10-05", value: -200, level: -2 });
		expect(oct.weeks[1][1]).toEqual({ day: "2026-10-06", value: 0, level: 0 });
		expect(oct.weeks[1][3]).toBeNull(); // 08.10. liegt nach to
		expect(oct.weeks.every((w) => w.length === 7)).toBe(true);
		expect(oct.sum).toBe(300);
		expect(oct.days).toBe(3);
	});

	it("spans a year boundary and DST without losing or doubling a day", () => {
		const months = calendarMonths(new Map(), "2026-10-20", "2027-01-05");
		expect(months.map((m) => m.key)).toEqual(["2026-10", "2026-11", "2026-12", "2027-01"]);
		const days = months.flatMap((m) => m.weeks.flat().filter((c) => c !== null).map((c) => c!.day));
		expect(days[0]).toBe("2026-10-20");
		expect(days.at(-1)).toBe("2027-01-05");
		expect(new Set(days).size).toBe(days.length);
		expect(days).toContain("2026-10-25"); // Ende der Sommerzeit
		expect(days).toHaveLength(78);
	});

	it("is empty for an inverted range and scales only inside the range", () => {
		expect(calendarMonths(new Map(), "2026-10-07", "2026-10-01")).toEqual([]);
		const [m] = calendarMonths(new Map([["2026-09-30", 1_000_000], ["2026-10-01", 100]]), "2026-10-01", "2026-10-01");
		expect(m.weeks.flat().find((c) => c?.day === "2026-10-01")?.level).toBe(4);
	});

	it("adds days across month ends and DST", () => {
		expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
		expect(addDays("2026-10-25", -7)).toBe("2026-10-18");
		expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
	});

	it("stays fast for three years of days", () => {
		const values = new Map<string, number>();
		let d = "2024-01-01";
		for (let i = 0; i < 1100; i++, d = addDays(d, 1)) values.set(d, ((i * 7919) % 2001) - 1000);
		const t0 = performance.now();
		const months = calendarMonths(values, "2024-01-01", d);
		const ms = performance.now() - t0;
		console.log(`calendarMonths: 1100 days in ${ms.toFixed(1)} ms`);
		expect(months.length).toBeGreaterThanOrEqual(36);
		expect(ms).toBeLessThan(150);
	});
});

describe("palette ranking", () => {
	it("normalizes umlauts and case", () => {
		expect(normalize("Übersicht")).toBe("ubersicht");
		expect(normalize("Straße")).toBe("strasse");
	});

	it("scores exact over prefix over word start over substring over subsequence", () => {
		const exact = wordScore("sap", "sap")!;
		const prefix = wordScore("sap", "sap.de")!;
		const wordStart = wordScore("sap", "aktie sap")!;
		const inside = wordScore("ap", "sap")!;
		const subseq = wordScore("nvd", "nvidia")!;
		expect(exact).toBeGreaterThan(prefix);
		expect(prefix).toBeGreaterThan(wordStart);
		expect(wordStart).toBeGreaterThan(inside);
		expect(inside).toBeGreaterThan(subseq);
		expect(subseq).toBeGreaterThan(0);
		expect(wordScore("xyz", "nvidia")).toBeNull();
	});

	it("needs every word somewhere and lets keywords match", () => {
		expect(entryScore({ label: "Not-Aus…", keywords: ["stopp", "kill"] }, "kill")).not.toBeNull();
		expect(entryScore({ label: "Mein Papierdepot", keywords: ["Depot"] }, "papier depot")).not.toBeNull();
		expect(entryScore({ label: "Mein Papierdepot" }, "papier ibkr")).toBeNull();
	});

	it("ranks the best match first and keeps the given order on ties", () => {
		const items = [
			{ id: "m-market", label: "Markt" },
			{ id: "s-msft", label: "MSFT", keywords: ["Microsoft Corporation"] },
			{ id: "s-sap", label: "SAP.DE", keywords: ["SAP SE"] },
			{ id: "a-papier", label: "Mein Papierdepot" },
			{ id: "m-overview", label: "Übersicht" },
		];
		expect(rank(items, "sap")[0].id).toBe("s-sap");
		expect(rank(items, "uber")[0].id).toBe("m-overview");
		expect(rank(items, "mi")[0].id).toBe("s-msft"); // Wortanfang im Stichwort „Microsoft“ vor „Mein“-Buchstabenfolge
		expect(rank(items, "pap").map((x) => x.id)).toEqual(["a-papier"]);
		expect(rank(items, "").map((x) => x.id)).toEqual(items.map((x) => x.id));
		// Präfix: je mehr vom Namen getippt ist, desto weiter oben
		expect(rank(items, "m").map((x) => x.id).slice(0, 3)).toEqual(["s-msft", "m-market", "a-papier"]);
		const tie = [{ id: "a", label: "Depot A" }, { id: "b", label: "Depot B" }];
		expect(rank(tie, "depot").map((x) => x.id)).toEqual(["a", "b"]);
		expect(rank([...tie].reverse(), "depot").map((x) => x.id)).toEqual(["b", "a"]);
	});
});

describe("quote label", () => {
	const q = (p: Partial<QuoteInfo>): QuoteInfo => ({ source: "yahoo", fetchedAt: Date.now(), marketTime: Date.now() - 180_000, ageSec: 180, delayed: null, bid: null, ask: null, ...p });

	it("says Echtzeit only for a fresh quote the source calls real-time", () => {
		expect(quoteLabel(q({ source: "ibkr", delayed: false, ageSec: 20 })).text).toBe("Echtzeit");
		expect(quoteLabel(q({ source: "ibkr", delayed: false, ageSec: 20 })).live).toBe(true);
		expect(quoteLabel(q({ source: "ibkr", delayed: false, ageSec: 7200 })).text).toBe("vor 2 Std.");
	});

	it("says verzögert when the source says so, otherwise the age", () => {
		expect(quoteLabel(q({ delayed: true, ageSec: 900 })).text).toBe("verzögert");
		expect(quoteLabel(q({ ageSec: 180 })).text).toBe("vor 3 Min.");
		expect(quoteLabel(q({ ageSec: 30 })).text).toBe("gerade eben");
	});

	it("marks stale quotes and explains source and delay in the tooltip", () => {
		const l = quoteLabel(q({ ageSec: 1500 }), true);
		expect(l).toMatchObject({ text: "veraltet · vor 25 Min.", stale: true, live: false });
		expect(l.title).toMatch(/Quelle: Yahoo Finance/);
		expect(l.title).toMatch(/Verzögerung unbekannt/);
		expect(quoteLabel(q({ source: "ibkr", delayed: true })).title).toMatch(/Interactive Brokers.*laut Quelle verzögert/);
		expect(quoteLabel(null)).toMatchObject({ text: "kein Kurs", stale: true });
	});

	it("words ages like the rest of the desk", () => {
		expect(quoteAge(59)).toBe("gerade eben");
		expect(quoteAge(61)).toBe("vor 1 Min.");
		expect(quoteAge(36 * 3600)).toBe("vor 2 Tagen");
		expect(quoteAge(30 * 3600)).toBe("vor 30 Std.");
	});
});

describe("duration", () => {
	it("words holding times", () => {
		expect(duration(30_000)).toBe("unter 1 Min.");
		expect(duration(600_000)).toBe("10 Min.");
		expect(duration(3.25 * 3_600_000)).toBe("3,3 Std.");
		expect(duration(30 * 3_600_000)).toBe("30 Std.");
		expect(duration(23 * 86_400_000)).toBe("23 Tage");
		expect(duration(null)).toBe("–");
	});
});
