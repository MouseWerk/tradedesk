// Journal, Agenten-Vergleich und Chat.
import type { AgentsData, ChatMessage, JournalEntry } from "@desk/shared";
import { DeskError, type Origin } from "./core.ts";
import { DeskManual } from "./manual.ts";
import { de } from "../i18n/de.ts";

export abstract class DeskJournal extends DeskManual {
	journal(opts: { author?: string; symbol?: string; limit?: number } = {}): JournalEntry[] {
		const where: string[] = [];
		const params: unknown[] = [];
		if (opts.author) {
			where.push("lower(author) = lower(?)");
			params.push(opts.author);
		}
		if (opts.symbol) {
			where.push("symbol = ?");
			params.push(opts.symbol.toUpperCase());
		}
		return this.db.all<JournalEntry>(`SELECT id, author, kind, symbol, text, time FROM journal ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY time DESC, id DESC LIMIT ?`, ...params, opts.limit ?? 100);
	}

	addJournal(body: Record<string, unknown>, origin: Origin): JournalEntry {
		const author = origin === "web" ? this.cfg.user : this.agentName(typeof body.author === "string" ? body.author : "");
		if (!author) throw new DeskError(de.core.unknownAgent(String(body.author ?? "")), 403);
		const kind = body.kind === "thesis" || body.kind === "review" ? body.kind : "note";
		const text = typeof body.text === "string" ? body.text.trim() : "";
		if (!text || text.length > 4000) throw new DeskError(de.journal.textInvalid);
		const symbol = body.symbol ? this.normalizeSymbol(body.symbol) : null;
		const time = this.now();
		const { lastId } = this.db.run("INSERT INTO journal (author, kind, symbol, text, time) VALUES (?,?,?,?,?)", author, kind, symbol, text, time);
		this.emit("event", { id: 0, time, kind: "journal", actor: author, text: text.slice(0, 120) });
		return { id: lastId, author, kind, symbol, text, time };
	}

	agentsData(): AgentsData {
		const agents = this.cfg.agents.map((name) => {
			const count = (status: string) => this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM proposal WHERE author = ? AND ${status} AND ${this.knownAccounts()}`, name)!.n;
			const last = this.db.get<{ t: number | null }>("SELECT MAX(t) AS t FROM (SELECT MAX(created_at) AS t FROM proposal WHERE author = ? UNION ALL SELECT MAX(time) FROM journal WHERE author = ?)", name, name);
			const a = this.cfg.accounts.find((x) => x.owner === name);
			const decisions = { pending: count("status = 'pending'"), approved: count("status IN ('open','placed','filled')"), rejected: count("status IN ('rejected','stale')"), lastActive: last?.t ?? null };
			// ohne eigenes Depot: nur die Vorschläge zählen (ausgeführt sind sie in deinen Depots)
			if (!a) return { name, accountId: null, equityCents: 0, returnPct: null, curve: [], trades: count("status = 'filled'"), closed: 0, winRate: null, ...decisions };
			const s = this.summary(a);
			const book = this.book(a.id);
			const closed = [...book.realizedBySell.values()];
			return {
				name,
				accountId: a.id,
				equityCents: s.equityCents,
				returnPct: s.returnPct,
				curve: this.curve(a, s),
				trades: this.tradeRows(a.id).length,
				closed: closed.length,
				winRate: closed.length ? (closed.filter((x) => x > 0).length / closed.length) * 100 : null,
				...decisions,
			};
		});
		const you = this.cfg.accounts.filter((a) => a.owner === "user").map((a) => {
			const s = this.summary(a);
			return { accountId: a.id, name: a.name, returnPct: s.returnPct, curve: this.curve(a, s) };
		});
		return { agents, you, journal: this.journal({ limit: 80 }) };
	}

	/**
	 * Chat: ohne since die neuesten limit Nachrichten (Verlauf im Browser); mit since die nächsten limit nach since in
	 * Reihenfolge – wer liest, blättert so weiter, bis weniger als limit kommen, und verliert in einem Schwall nichts.
	 */
	chat(opts: { since?: number; limit?: number } = {}): ChatMessage[] {
		type Row = { id: number; time: number; author: string; role: ChatMessage["role"]; text: string; recipients: string; ref: string | null };
		const limit = opts.limit ?? 200;
		const rows = opts.since === undefined ? this.db.all<Row>("SELECT * FROM chat ORDER BY id DESC LIMIT ?", limit).reverse() : this.db.all<Row>("SELECT * FROM chat WHERE id > ? ORDER BY id ASC LIMIT ?", opts.since, limit);
		return rows.map((r) => ({ id: r.id, time: r.time, author: r.author, role: r.role, text: r.text, to: JSON.parse(r.recipients) as string[], ref: r.ref }));
	}

	/** Nachricht von dir (Browser) oder einem Agenten (CLI). Erwähnungen @Name nur für bekannte Namen. Der Chat genehmigt nie eine Order. */
	say(body: Record<string, unknown>, origin: Origin): ChatMessage {
		const author = origin === "web" ? this.cfg.user : this.agentName(typeof body.author === "string" ? body.author : "");
		if (!author) throw new DeskError(de.core.unknownAgent(String(body.author ?? "")), 403);
		const text = typeof body.text === "string" ? body.text.trim() : "";
		if (!text) throw new DeskError(de.journal.emptyMessage);
		if (text.length > 4000) throw new DeskError(de.journal.messageTooLong);
		const names = [this.cfg.user, ...this.cfg.agents];
		const canon = (n: string) => names.find((x) => x.toLowerCase() === n.toLowerCase()) ?? null;
		const to = new Set<string>();
		for (const m of text.matchAll(/@([\p{L}\p{N}_.-]{1,40})/gu)) {
			const n = canon(m[1]);
			if (n) to.add(n);
		}
		if (Array.isArray(body.to)) for (const n of body.to) if (typeof n === "string" && canon(n)) to.add(canon(n)!);
		to.delete(author);
		const rawRef = typeof body.ref === "string" ? body.ref.trim().toUpperCase() : "";
		const ref = /^(#\d{1,6}|[A-Z0-9.=^-]{1,24})$/.test(rawRef) ? rawRef : null;
		return this.postChat({ author, role: origin === "web" ? "user" : "agent", text, to: [...to], ref });
	}
}
