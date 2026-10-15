// Wegwerf-Arbeitsbereich mit Fake-Börse für Selbsttest, Tests und Playwright: deterministische Kurse, zwei eigene
// Depots (Trade Republic manuell, Papier), zwei Agenten mit Verlauf, offene Vorschläge, Journal, 90 Tagesstände.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dayKey, orderValueCents } from "@desk/shared";
import { cleanConfig, type Config } from "./config.ts";
import { openDatabase, type Database } from "./db.ts";
import { Desk } from "./desk.ts";
import { FakeMarket } from "./market.ts";

export interface Fixture {
	dir: string;
	cfg: Config;
	db: Database;
	desk: Desk;
	market: FakeMarket;
	cleanup(): void;
}

export const FIXTURE_CONFIG = {
	user: "Maurice",
	accounts: [
		{ id: "tr", name: "Trade Republic", kind: "manual", broker: "Trade Republic", feeEur: 1, startCashEur: 0 },
		{ id: "papier", name: "Mein Papierdepot", kind: "paper", feeEur: 1, startCashEur: 20000 },
	],
	agents: [{ name: "Atlas", startCashEur: 10000 }, { name: "Nova", startCashEur: 10000 }],
};

export async function makeFixture({ seed = true, now }: { seed?: boolean; now?: () => number } = {}): Promise<Fixture> {
	const dir = mkdtempSync(path.join(tmpdir(), "tradedesk-fx-"));
	const cfg = cleanConfig(FIXTURE_CONFIG, { home: dir, dbFile: path.join(dir, "desk.sqlite"), webDist: path.resolve(import.meta.dirname, "../../web/dist"), dev: false });
	const db = openDatabase(cfg.dbFile);
	const clock = now ?? Date.now;
	const market = new FakeMarket(clock);
	const desk = new Desk(cfg, db, market, clock);
	const fx: Fixture = {
		dir, cfg, db, desk, market,
		cleanup() {
			desk.stop();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
	if (seed) await seedFixture(fx);
	return fx;
}

async function seedFixture({ desk, db, cfg }: Fixture) {
	const day = 86_400_000;
	const t0 = desk.now();
	for (const s of ["SAP.DE", "ALV.DE", "AAPL", "MSFT", "NVDA", "EUNL.DE", "BTC-EUR"]) db.run("INSERT INTO watch (symbol, added_at, added_by) VALUES (?,?,?)", s, t0 - 90 * day, cfg.user);
	await desk.refresh(desk.trackedSymbols());
	const trade = (acc: string, symbol: string, side: "buy" | "sell", qty: number, price: number, daysAgo: number, currency = "EUR", fxRate = 1, source = "manual") =>
		db.run(
			"INSERT INTO trade (account_id, symbol, side, qty, price, currency, fx, value_cents, fee_cents, time, source, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,'')",
			acc, symbol, side, qty, price, currency, fxRate, orderValueCents(qty, price, fxRate), 100, t0 - daysAgo * day, source,
		);
	db.run("INSERT INTO cash_move (account_id, amount_cents, time, note) VALUES ('tr', 1500000, ?, 'Einzahlung')", t0 - 120 * day);
	trade("tr", "EUNL.DE", "buy", 25, 92.1, 110);
	trade("tr", "SAP.DE", "buy", 12, 176.4, 80);
	trade("tr", "AAPL", "buy", 6, 188.5, 60);
	trade("tr", "SAP.DE", "sell", 4, 205.0, 20);
	trade("tr", "EUNL.DE", "buy", 0.958773, 104.3, 5);
	trade("papier", "MSFT", "buy", 5, 395.0, 70, "USD", 0.93, "order");
	trade("papier", "ALV.DE", "buy", 8, 330.5, 40, "EUR", 1, "order");
	trade("agent-atlas", "NVDA", "buy", 20, 118.0, 50, "USD", 0.92, "proposal");
	trade("agent-atlas", "NVDA", "sell", 10, 140.0, 12, "USD", 0.92, "proposal");
	trade("agent-atlas", "SAP.DE", "buy", 10, 190.0, 30, "EUR", 1, "proposal");
	trade("agent-nova", "EUNL.DE", "buy", 60, 98.0, 75, "EUR", 1, "proposal");
	trade("agent-nova", "BTC-EUR", "buy", 0.05, 64000, 25, "EUR", 1, "proposal");
	trade("agent-nova", "BTC-EUR", "sell", 0.02, 59000, 8, "EUR", 1, "proposal");

	// Tagesstände: deterministischer Pfad, der beim heutigen Wert endet
	for (const a of cfg.accounts) {
		const s = desk.summary(a);
		let seed = [...a.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
		const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
		let eq = s.equityCents;
		for (let d = 1; d <= 90; d++) {
			eq = Math.round(eq / (1 + (rnd() - 0.47) * 0.018));
			db.run("INSERT OR REPLACE INTO snapshot (account_id, day, equity_cents, deposits_cents) VALUES (?,?,?,?)", a.id, dayKey(t0 - d * day), eq, s.depositsCents);
		}
	}

	const atlas = await desk.submit({ author: "Atlas", accountId: "agent-atlas", symbol: "MSFT", side: "buy", qty: 4, confidence: 0.72, thesis: "Cloud-Umsatz wächst zweistellig, Kurs nach Rücksetzer an der 50-Tage-Linie. Stop unter dem letzten Tief.", stopLoss: 395, takeProfit: 470 }, "cli");
	await desk.submit({ author: "Nova", accountId: "tr", symbol: "EUNL.DE", side: "buy", qty: 10, confidence: 0.8, thesis: "Monatliche Aufstockung des Weltportfolios; Cash-Quote liegt über dem Ziel von 10 %." }, "cli");
	await desk.submit({ author: "Atlas", accountId: "papier", symbol: "ALV.DE", side: "sell", qty: 2, orderType: "limit", limitPrice: 370, confidence: 0.6, thesis: "Teilgewinn am Widerstand 370 € mitnehmen." }, "cli");
	if (!atlas.ok) throw new Error(`Fixture: Vorschlag abgelehnt: ${atlas.check.violations.join(" ")}`);
	const old = await desk.submit({ author: "Nova", accountId: "agent-nova", symbol: "ALV.DE", side: "buy", qty: 5, confidence: 0.55, thesis: "Dividendenrendite über 5 %, defensiver Anker." }, "cli");
	desk.reject(old.proposal!.id, "Versicherer sind schon über Mein Papierdepot drin.");

	const j = (author: string, kind: string, symbol: string | null, text: string, daysAgo: number) => db.run("INSERT INTO journal (author, kind, symbol, text, time) VALUES (?,?,?,?,?)", author, kind, symbol, text, t0 - daysAgo * day);
	j("Atlas", "thesis", "NVDA", "Rechenzentrums-Nachfrage trägt; halbe Position nach +18 % realisiert, Rest läuft mit Stop am Einstand.", 12);
	j("Nova", "review", null, "Wochenrückblick: Krypto-Anteil auf 6 % reduziert, Ziel 5 %. Kein Handlungsbedarf beim ETF-Kern.", 3);
	j("Atlas", "note", "SAP.DE", "Quartalszahlen am Donnerstag – vorher keine neuen Käufe.", 1);
	db.run("INSERT INTO alert (symbol, op, price, created_at) VALUES ('NVDA','below',120,?)", t0 - 2 * day);
	db.run("DELETE FROM event");
	desk.event("start", "Desk", "Fixture geladen");
}
