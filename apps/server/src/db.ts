// SQLite über das eingebaute node:sqlite. Migrationen nummeriert und nur additiv (PRAGMA user_version);
// eine veröffentlichte Migration wird nie geändert, die nächste bekommt die nächste Nummer.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS: string[] = [
	/* 1 */ `
	CREATE TABLE trade (
		id INTEGER PRIMARY KEY,
		account_id TEXT NOT NULL,
		symbol TEXT NOT NULL,
		side TEXT NOT NULL CHECK (side IN ('buy','sell')),
		qty REAL NOT NULL CHECK (qty > 0),
		price REAL NOT NULL,
		currency TEXT NOT NULL,
		fx REAL NOT NULL,
		value_cents INTEGER NOT NULL,
		fee_cents INTEGER NOT NULL DEFAULT 0,
		time INTEGER NOT NULL,
		source TEXT NOT NULL,
		proposal_id INTEGER,
		note TEXT NOT NULL DEFAULT '',
		import_key TEXT,
		deleted_at INTEGER
	);
	CREATE INDEX trade_account ON trade (account_id, time);
	CREATE UNIQUE INDEX trade_import ON trade (account_id, import_key) WHERE import_key IS NOT NULL;
	CREATE TABLE cash_move (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, time INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
	CREATE TABLE instrument (symbol TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, exchange TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '');
	CREATE TABLE quote (symbol TEXT PRIMARY KEY, price REAL NOT NULL, prev_close REAL, market_time INTEGER, fetched_at INTEGER NOT NULL);
	CREATE TABLE watch (symbol TEXT PRIMARY KEY, added_at INTEGER NOT NULL, added_by TEXT NOT NULL);
	CREATE TABLE alert (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, op TEXT NOT NULL CHECK (op IN ('above','below')), price REAL NOT NULL, created_at INTEGER NOT NULL, triggered_at INTEGER);
	CREATE TABLE proposal (
		id INTEGER PRIMARY KEY,
		account_id TEXT NOT NULL,
		author TEXT NOT NULL,
		symbol TEXT NOT NULL,
		side TEXT NOT NULL,
		qty REAL NOT NULL,
		order_type TEXT NOT NULL,
		limit_price REAL,
		stop_loss REAL,
		take_profit REAL,
		confidence REAL NOT NULL,
		thesis TEXT NOT NULL,
		status TEXT NOT NULL,
		reason TEXT NOT NULL DEFAULT '',
		quote_price REAL NOT NULL,
		warnings TEXT NOT NULL DEFAULT '[]',
		created_at INTEGER NOT NULL,
		decided_at INTEGER,
		decided_by TEXT,
		approved_qty REAL,
		expires_at INTEGER NOT NULL,
		fill_price REAL,
		stop_hit_at INTEGER,
		target_hit_at INTEGER,
		raw TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX proposal_status ON proposal (status, created_at);
	CREATE TABLE journal (id INTEGER PRIMARY KEY, author TEXT NOT NULL, kind TEXT NOT NULL, symbol TEXT, text TEXT NOT NULL, time INTEGER NOT NULL);
	CREATE TABLE risk (account_id TEXT PRIMARY KEY, max_order_cents INTEGER NOT NULL, max_position_pct REAL NOT NULL, daily_loss_pct REAL NOT NULL, max_open_proposals INTEGER NOT NULL);
	CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE snapshot (account_id TEXT NOT NULL, day TEXT NOT NULL, equity_cents INTEGER NOT NULL, deposits_cents INTEGER NOT NULL, PRIMARY KEY (account_id, day));
	CREATE TABLE event (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL);
	`,
];

function param(v: unknown): SQLInputValue {
	if (v === undefined || v === null) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "number" || typeof v === "string" || typeof v === "bigint" || v instanceof Uint8Array) return v;
	return JSON.stringify(v);
}

export interface Database {
	raw: DatabaseSync;
	run(sql: string, ...p: unknown[]): { changes: number; lastId: number };
	get<T>(sql: string, ...p: unknown[]): T | undefined;
	all<T>(sql: string, ...p: unknown[]): T[];
	/** Synchrone Transaktion – Node ist einthreadig, alles darin läuft am Stück. */
	tx<T>(fn: () => T): T;
	close(): void;
}

export function openDatabase(file: string): Database {
	if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
	const existed = file !== ":memory:" && existsSync(file);
	const raw = new DatabaseSync(file);
	raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;");
	const cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
	const prep = (sql: string) => {
		let st = cache.get(sql);
		if (!st) {
			st = raw.prepare(sql);
			if (cache.size > 300) cache.clear();
			cache.set(sql, st);
		}
		return st;
	};
	let depth = 0;
	const tx = <T>(fn: () => T): T => {
		if (depth > 0) return fn();
		raw.exec("BEGIN IMMEDIATE");
		depth++;
		try {
			const out = fn();
			raw.exec("COMMIT");
			return out;
		} catch (e) {
			raw.exec("ROLLBACK");
			throw e;
		} finally {
			depth--;
		}
	};
	const version = Number((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
	if (version > MIGRATIONS.length) throw new Error(`Datenbank ${file} stammt aus einer neueren Version (${version} > ${MIGRATIONS.length}) – bitte die neuere Version starten.`);
	if (version < MIGRATIONS.length && existed && version > 0) copyFileSync(file, `${file}.v${version}.bak`); // Sicherung vor jeder Migration
	for (let v = version; v < MIGRATIONS.length; v++) {
		tx(() => {
			raw.exec(MIGRATIONS[v]);
			raw.exec(`PRAGMA user_version = ${v + 1}`);
		});
	}
	return {
		raw,
		run: (sql, ...p) => {
			const r = prep(sql).run(...p.map(param));
			return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
		},
		get: <T>(sql: string, ...p: unknown[]) => prep(sql).get(...p.map(param)) as T | undefined,
		all: <T>(sql: string, ...p: unknown[]) => prep(sql).all(...p.map(param)) as T[],
		tx,
		close: () => raw.close(),
	};
}
