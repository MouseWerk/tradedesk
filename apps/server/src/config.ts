// Konfiguration: ~/.tradedesk/config.json (überschreibbar mit TRADEDESK_HOME oder --home). Depots, Agenten und
// Grenzwerte stehen dort, Trades und Kurse in der Datenbank daneben – nie im Repo.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Account } from "@desk/shared";
import { de } from "./i18n/de.ts";
import { DEFAULT_UNIVERSE } from "./universe.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
	home: string;
	user: string; // du – der Einzige, der freigibt
	port: number;
	baseCurrency: "EUR";
	market: "yahoo" | "off";
	quotes: "yahoo" | "ibkr"; // Kursquelle: Yahoo (Standard) oder IBKR-Momentaufnahmen über das Gateway, Yahoo als Rückfall
	accounts: Account[]; // deine Depots + je Agent ein Papierdepot
	agents: string[];
	minConfidence: number; // darunter wird ein Agenten-Vorschlag gar nicht erst angelegt
	staleMovePct: number; // so weit darf sich der Kurs zwischen Vorschlag und Freigabe bewegen
	proposalTtlHours: number;
	quoteIntervalSec: number;
	liveIntervalSec: number; // solange ein Browser offen ist
	maxQuoteAgeSec: number; // während der Handelszeit entscheidet kein älterer Kurs (Vorschlag, Freigabe, Bestätigung, Limit)
	universe: string[]; // Scanner-Universum neben der Watchlist ("universe" in config.json, sonst src/universe.ts)
	universeIntervalSec: number; // so oft wird das Universum abgefragt – langsam, sonst sperrt Yahoo
	autoPaper: boolean; // Agenten handeln ihr eigenes Papierdepot ohne Freigabe (nur Papier, nie echtes Geld)
	agentBudgetCents: number | null; // "agentBudgetEur": so viel dürfen Agenten-Käufe mit echtem Geld zusammen binden; null: ohne Grenze
	liveTrading: boolean; // Hauptschalter: Orders mit echtem Geld nur, wenn true (IBKR-Papierkonten gehen immer)
	listen: string[]; // zusätzliche Adressen neben 127.0.0.1 – nur Tailscale (100.64.0.0/10), z. B. fürs Handy
	brokers: Record<string, BrokerConfig>; // je Broker-Depot (kind "broker")
	dbFile: string;
	webDist: string;
	dev: boolean;
}

export interface BrokerConfig {
	adapter: "ibkr";
	account: string; // IBKR-Kontonummer, z. B. DU1234567 (Papier) oder U1234567 (echt)
	gateway: string; // Client Portal Gateway, nur localhost
	conids: Record<string, number>; // feste Zuordnung Symbol → IBKR-Kontrakt
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IB_ACCOUNT = /^[A-Z]{1,3}\d{4,10}$/;
const LOCAL_GATEWAY = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

export function homeDir(env = process.env, argv: string[] = []): string {
	const i = argv.indexOf("--home");
	if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
	return env.TRADEDESK_HOME ? path.resolve(env.TRADEDESK_HOME) : path.join(homedir(), ".tradedesk");
}

export function agentAccountId(name: string): string {
	return `agent-${name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "x"}`;
}

const eurToCents = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : d);
const clampNum = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Aus der Datei, was gültig ist; fehlerhafte Einträge fallen weg, statt den Start zu verhindern. */
export function cleanConfig(raw: Record<string, unknown>, base: Pick<Config, "home" | "dbFile" | "webDist" | "dev">, env = process.env): Config {
	const user = typeof raw.user === "string" && NAME.test(raw.user) ? raw.user : (env.USERNAME ?? env.USER ?? de.config.defaultUser);
	const accounts: Account[] = [];
	const brokers: Record<string, BrokerConfig> = {};
	for (const r of Array.isArray(raw.accounts) ? (raw.accounts as Record<string, unknown>[]) : []) {
		if (!r || typeof r.id !== "string" || !ID.test(r.id) || r.id.startsWith("agent-") || accounts.some((a) => a.id === r.id)) continue;
		const kind = r.kind === "manual" ? "manual" : r.kind === "broker" ? "broker" : "paper";
		let live = false;
		if (kind === "broker") {
			// nur IBKR, nur mit gültiger Kontonummer und lokalem Gateway – sonst fällt das Depot weg
			const account = typeof r.ibAccount === "string" ? r.ibAccount.trim().toUpperCase() : "";
			const gateway = typeof r.gateway === "string" && r.gateway.trim() ? r.gateway.trim() : "https://localhost:5000";
			if (r.adapter !== undefined && r.adapter !== "ibkr") continue;
			if (!IB_ACCOUNT.test(account) || !LOCAL_GATEWAY.test(gateway)) continue;
			const conids: Record<string, number> = {};
			if (r.conids && typeof r.conids === "object")
				for (const [sym, id] of Object.entries(r.conids as Record<string, unknown>)) if (/^[A-Z0-9.=^-]{1,24}$/.test(sym) && Number.isInteger(id) && (id as number) > 0) conids[sym] = id as number;
			brokers[r.id] = { adapter: "ibkr", account, gateway, conids };
			live = !account.startsWith("D"); // IBKR-Papierkonten beginnen mit D (DU…, DF…)
		}
		accounts.push({
			id: r.id,
			name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : r.id,
			kind,
			owner: "user",
			broker: typeof r.broker === "string" && r.broker.trim() ? r.broker.trim().slice(0, 40) : kind === "paper" ? de.config.paperBroker : kind === "broker" ? "Interactive Brokers" : de.config.manualBroker,
			feeCents: eurToCents(r.feeEur, 100),
			startCashCents: eurToCents(r.startCashEur, kind === "paper" ? 1_000_000 : 0),
			live,
		});
	}
	if (!accounts.length) accounts.push({ id: "papier", name: de.config.paperDepot, kind: "paper", owner: "user", broker: de.config.paperBroker, feeCents: 100, startCashCents: 1_000_000, live: false });
	const agents: string[] = [];
	for (const r of Array.isArray(raw.agents) ? (raw.agents as unknown[]) : []) {
		const a = (typeof r === "string" ? { name: r } : r) as Record<string, unknown>;
		const name = typeof a?.name === "string" ? a.name.trim() : "";
		if (!NAME.test(name) || name.toLowerCase() === user.toLowerCase() || agents.some((x) => x.toLowerCase() === name.toLowerCase())) continue;
		agents.push(name);
		accounts.push({ id: agentAccountId(name), name: de.config.agentDepot(name), kind: "paper", owner: name, broker: de.config.paperBroker, feeCents: eurToCents(a.feeEur, 100), startCashCents: eurToCents(a.startCashEur, 1_000_000), live: false });
	}
	return {
		...base,
		user,
		port: Math.trunc(clampNum(raw.port, 8095, 1024, 65535)),
		baseCurrency: "EUR",
		market: raw.market === "off" ? "off" : "yahoo",
		quotes: raw.quotes === "ibkr" ? "ibkr" : "yahoo",
		accounts,
		agents,
		minConfidence: clampNum(raw.minConfidence, 0.5, 0, 1),
		staleMovePct: clampNum(raw.staleMovePct, 2, 0.1, 50),
		proposalTtlHours: clampNum(raw.proposalTtlHours, 24, 1, 24 * 14),
		quoteIntervalSec: Math.trunc(clampNum(raw.quoteIntervalSec, 60, 15, 3600)),
		liveIntervalSec: Math.trunc(clampNum(raw.liveIntervalSec, 15, 5, 300)),
		maxQuoteAgeSec: Math.trunc(clampNum(raw.maxQuoteAgeSec, 120, 30, 3600)),
		universe: Array.isArray(raw.universe) ? [...new Set(raw.universe.filter((s): s is string => typeof s === "string" && /^[A-Za-z0-9.=^-]{1,24}$/.test(s.trim())).map((s) => s.trim().toUpperCase()))].slice(0, 500) : [...DEFAULT_UNIVERSE],
		universeIntervalSec: Math.trunc(clampNum(raw.universeIntervalSec, 300, 120, 3600)),
		autoPaper: raw.autoPaper === true,
		agentBudgetCents: typeof raw.agentBudgetEur === "number" && Number.isFinite(raw.agentBudgetEur) && raw.agentBudgetEur > 0 ? Math.round(Math.min(raw.agentBudgetEur, 10_000_000) * 100) : null,
		liveTrading: raw.liveTrading === true,
		listen: cleanListen(raw.listen),
		brokers,
	};
}

/** Nur Tailscale-Adressen (100.64.0.0/10, im Tailnet verschlüsselt und nur für deine Geräte) – nie WLAN, nie 0.0.0.0. */
export function isTailscaleV4(addr: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
	if (!m || m.slice(1).some((x) => Number(x) > 255)) return false;
	return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

export function cleanListen(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const a of raw) {
		if (typeof a !== "string") continue;
		const addr = a.trim();
		if (addr === "127.0.0.1" || addr === "localhost") continue; // gilt immer
		if (!isTailscaleV4(addr)) {
			console.warn(de.config.listenIgnored(addr));
			continue;
		}
		if (!out.includes(addr)) out.push(addr);
	}
	return out;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env = process.env): Config {
	const arg = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
	const home = homeDir(env, argv);
	const file = arg("config") ? path.resolve(arg("config")!) : path.join(home, "config.json");
	let raw: Record<string, unknown> = {};
	try {
		const j = JSON.parse(readFileSync(file, "utf8"));
		if (j && typeof j === "object") raw = j;
	} catch {
		// fehlt oder halb geschrieben: Standard mit einem Papierdepot, die Oberfläche erklärt die Einrichtung
	}
	const cfg = cleanConfig(raw, { home, dbFile: env.TRADEDESK_DB ?? path.join(home, "desk.sqlite"), webDist: path.resolve(HERE, "../../web/dist"), dev: argv.includes("--dev") }, env);
	const port = arg("port") ?? env.TRADEDESK_PORT;
	if (port && Number.isInteger(Number(port))) cfg.port = Number(port);
	return cfg;
}
