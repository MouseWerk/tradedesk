// Sicherung vor einer Migration (Q1 B24): auch was nur im WAL steht (noch kein Checkpoint), muss in der Sicherung sein.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, openDatabase, type Database } from "../src/db.ts";

describe("backup before a migration", () => {
	it("contains rows that are only in the WAL", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "tradedesk-db-"));
		const file = path.join(dir, "desk.sqlite");
		const open: { close(): void }[] = [];
		try {
			// eine Datenbank auf Stand 3, die zuletzt geschriebene Zeile liegt nur im WAL
			const old = new DatabaseSync(file);
			open.push(old);
			old.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
			for (const m of MIGRATIONS.slice(0, 3)) old.exec(m);
			old.exec("PRAGMA user_version = 3");
			old.exec("INSERT INTO setting (key, value) VALUES ('nur-im-wal', 'ja')");
			const db: Database = openDatabase(file); // migriert auf den neuesten Stand und sichert vorher
			open.push(db);
			const bak = new DatabaseSync(`${file}.v3.bak`, { readOnly: true });
			open.push(bak);
			expect(bak.prepare("SELECT value FROM setting WHERE key = 'nur-im-wal'").get()).toEqual({ value: "ja" });
			expect(bak.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
		} finally {
			for (const c of open.reverse()) c.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
