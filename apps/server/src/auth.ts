// Anmeldung des Besitzers (Entscheidung 2026-10-16): eine PIN, nur als langsamer Hash (scrypt mit Zufallssalz) in der
// Tabelle setting, und eine Sitzung als HttpOnly-Cookie (SameSite=Strict, 30 Tage). In der Datenbank steht nur der
// SHA-256 des Sitzungs-Tokens. Die erste PIN braucht einen Einrichtungscode, den der Server nur im Speicher hält und
// nur auf seiner eigenen Konsole ausgibt – ein Agent kann die PIN also nicht vor dir setzen.
// Vertrauensmodell: Agenten laufen als derselbe Benutzer. Die Anmeldung schützt vor einem Agenten, der (z. B. nach
// einer Prompt-Injection in News oder Chat) die API selbst aufruft – nicht vor einem Programm, das die Datenbank ändert.
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { Database } from "./db.ts";
import { de } from "./i18n/de.ts";

// Sitzung als Header, nicht als Cookie: Browser trennen Cookies nicht nach Port – ein Agent mit eigenem Server auf
// 127.0.0.1:<anderer Port> bekäme ein Cookie geschenkt, sobald du seinen Link öffnest (Review q1 M1). Das Token liegt
// im localStorage der Desk-Seite, und der gehört nur zu genau diesem Origin (inklusive Port).
export const SESSION_HEADER = "X-Desk-Session";
export const SESSION_MAX_AGE_SEC = 30 * 86_400;
const PIN = /^\d{4,12}$/;
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 };
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne 0/O und 1/I
const MAX_FAILS = 5; // danach Sperre: 60 s, dann jeweils doppelt so lang (höchstens eine Stunde)
const TOUCH_MS = 60_000; // last_used_at höchstens einmal je Minute schreiben

export class AuthError extends Error {
	readonly status: number;
	readonly retryAfterSec: number | null;
	constructor(message: string, status: number, retryAfterSec: number | null = null) {
		super(message);
		this.status = status;
		this.retryAfterSec = retryAfterSec;
	}
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Gleich lange Digests vergleichen, damit die Laufzeit nichts über die Eingabe verrät. */
function same(a: string, b: string): boolean {
	return timingSafeEqual(sha256(a), sha256(b));
}

function hashPin(pin: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(pin, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
	return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function checkPin(pin: string, stored: string): boolean {
	const [kind, n, r, p, salt, hash] = stored.split("$");
	if (kind !== "scrypt" || !salt || !hash) return false;
	const want = Buffer.from(hash, "base64");
	const got = scryptSync(pin, Buffer.from(salt, "base64"), want.length, { N: Number(n), r: Number(r), p: Number(p) });
	return got.length === want.length && timingSafeEqual(got, want);
}

export class OwnerAuth {
	private readonly db: Database;
	private readonly now: () => number;
	private setupCode: string | null = null; // nur im Speicher, nie in Datenbank, Log, API oder Chat
	private fails = 0;
	private lockouts = 0;
	private lockedUntil = 0;

	constructor(db: Database, now: () => number) {
		this.db = db;
		this.now = now;
	}

	get pinSet(): boolean {
		return !!this.db.get("SELECT 1 FROM setting WHERE key = 'owner_pin'");
	}

	/** Beim Start ohne PIN: neuer Einrichtungscode (8 Zeichen). Der Aufrufer gibt ihn nur auf der Konsole aus. */
	startSetup(): string | null {
		if (this.pinSet) {
			this.setupCode = null;
			return null;
		}
		this.setupCode = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
		return this.setupCode;
	}

	/** PIN direkt setzen – nur für Fixture und Tests (bekannte Test-PIN), nie über die API. */
	presetPin(pin: string) {
		if (!PIN.test(pin)) throw new AuthError(de.auth.pinFormat, 400);
		this.db.run("INSERT INTO setting (key, value) VALUES ('owner_pin', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", hashPin(pin));
		this.setupCode = null;
	}

	/** PIN und alle Sitzungen löschen (node apps/server/src/index.ts --reset-pin); der nächste Start zeigt einen neuen Code. */
	reset() {
		this.db.run("DELETE FROM setting WHERE key = 'owner_pin'");
		this.db.run("DELETE FROM owner_session");
	}

	private guard() {
		const wait = this.lockedUntil - this.now();
		if (wait > 0) throw new AuthError(de.auth.tooManyFails(Math.ceil(wait / 1000)), 429, Math.ceil(wait / 1000));
	}

	private failed(message: string, status: number): never {
		this.fails++;
		if (this.fails % MAX_FAILS === 0) {
			this.lockouts++;
			this.lockedUntil = this.now() + Math.min(3_600_000, 60_000 * 2 ** (this.lockouts - 1));
		}
		throw new AuthError(message, status);
	}

	private succeeded() {
		this.fails = 0;
		this.lockouts = 0;
		this.lockedUntil = 0;
	}

	/** Erste PIN mit dem Einrichtungscode setzen; gibt gleich eine Sitzung zurück. */
	setup(code: unknown, pin: unknown): string {
		this.guard();
		if (this.pinSet) throw new AuthError(de.auth.pinAlreadySet, 409);
		if (!this.setupCode) throw new AuthError(de.auth.noSetupCode, 409);
		const given = typeof code === "string" ? code.trim().toUpperCase() : "";
		if (!same(given, this.setupCode)) this.failed(de.auth.setupCodeWrong, 403);
		if (typeof pin !== "string" || !PIN.test(pin)) throw new AuthError(de.auth.pinFormat, 400);
		this.presetPin(pin);
		this.succeeded();
		return this.createSession();
	}

	login(pin: unknown): string {
		this.guard();
		const stored = this.db.get<{ value: string }>("SELECT value FROM setting WHERE key = 'owner_pin'")?.value;
		if (!stored) throw new AuthError(de.auth.noPinYet, 409);
		if (typeof pin !== "string" || !PIN.test(pin) || !checkPin(pin, stored)) this.failed(de.auth.pinWrong, 401);
		this.succeeded();
		return this.createSession();
	}

	private createSession(): string {
		const token = randomBytes(32).toString("base64url");
		const now = this.now();
		this.db.run("DELETE FROM owner_session WHERE expires_at <= ?", now);
		this.db.run("INSERT INTO owner_session (token_hash, created_at, last_used_at, expires_at) VALUES (?,?,?,?)", sha256(token).toString("hex"), now, now, now + SESSION_MAX_AGE_SEC * 1000);
		return token;
	}

	/** Gültige, nicht abgelaufene Sitzung? Merkt sich die letzte Nutzung. */
	verify(token: string | undefined): boolean {
		if (!token || token.length > 200) return false;
		const key = sha256(token).toString("hex");
		const row = this.db.get<{ last_used_at: number; expires_at: number }>("SELECT last_used_at, expires_at FROM owner_session WHERE token_hash = ?", key);
		const now = this.now();
		if (!row || row.expires_at <= now) return false;
		if (now - row.last_used_at > TOUCH_MS) this.db.run("UPDATE owner_session SET last_used_at = ? WHERE token_hash = ?", now, key);
		return true;
	}

	logout(token: string | undefined) {
		if (token) this.db.run("DELETE FROM owner_session WHERE token_hash = ?", sha256(token).toString("hex"));
	}
}
