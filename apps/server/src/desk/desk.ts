// Der Desk: alle Module zusammen (core → book → risk → market → proposals → broker → manual → journal → analytics),
// dazu Cockpit und Takt (Kurse, Broker-Abruf, Limits, Abläufe, Hinweise, Tagesstand).
import type { Cockpit, CockpitPosition } from "@desk/shared";
import { cents, dayKey, orderValueCents, rMultiple } from "@desk/shared";
import { DeskAnalytics } from "./analytics.ts";
import { de } from "../i18n/de.ts";

const BROKER_KEEPALIVE_MS = 60_000; // IBKR empfiehlt etwa einmal je Minute /tickle, unabhängig vom Kurstakt

export class Desk extends DeskAnalytics {
	private timer: NodeJS.Timeout | null = null;
	private ticking: Promise<void> | null = null;
	private unfeed: (() => void) | null = null;

	cockpit(): Cockpit {
		const from = this.startOfDay();
		const positions: CockpitPosition[] = [];
		const days = this.cfg.accounts.map((a) => {
			const s = this.summary(a);
			const rows = this.tradeRows(a.id);
			let openRisk = this.reserved(a.id).riskCents;
			const boughtToday = new Set(rows.filter((t) => t.side === "buy" && t.time >= from).map((t) => t.symbol));
			for (const p of this.positions(a, s)) {
				const fx = this.priced(p.symbol)?.fx ?? null;
				// offene Position mit Stop: was bis zum Stop noch verloren gehen kann, plus die Verkaufsgebühr
				if (p.stopLoss && p.nativePrice !== null && fx !== null) openRisk += orderValueCents(p.qty, Math.max(0, p.nativePrice - p.stopLoss), fx) + a.feeCents;
				const avgNative = fx ? p.avgPrice / fx : null;
				positions.push({
					accountId: a.id, symbol: p.symbol, name: p.name, currency: p.currency, qty: p.qty, avgPrice: p.avgPrice, price: p.price, nativePrice: p.nativePrice,
					unrealizedCents: p.unrealizedCents, unrealizedPct: p.unrealizedPct, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
					r: avgNative !== null && p.nativePrice !== null ? rMultiple(avgNative, p.stopLoss, p.nativePrice) : null,
					openedToday: boughtToday.has(p.symbol),
				});
			}
			// Tagesverlust-Stopp in EUR auf den Stand von gestern, wie in der Risikoprüfung
			const prev = this.prevSnapshot(a.id);
			const pctLimit = this.limits(a.id).dailyLossPct;
			const limit = pctLimit > 0 && prev && prev.equity_cents > 0 ? cents((prev.equity_cents / 100) * (pctLimit / 100)) : null;
			const loss = Math.max(0, -(s.dayChangeCents ?? 0));
			return {
				accountId: a.id, name: a.name, owner: a.owner, kind: a.kind, equityCents: s.equityCents, cashCents: s.cashCents, dayChangeCents: s.dayChangeCents, dayLossPct: this.dayLossPct(a, s),
				openRiskCents: openRisk, dayLossLimitCents: limit, dayLossHeadroomCents: limit === null ? null : Math.max(0, limit - loss), stats: this.dayStatsOf(a.id),
			};
		});
		return {
			user: this.cfg.user,
			killSwitch: this.killSwitch,
			market: this.marketState,
			marketError: this.marketError,
			quotesAt: this.quotesAt,
			liveIntervalSec: this.cfg.liveIntervalSec,
			quoteFeed: this.feed.source,
			failedQuotes: [...this.quoteErrors.keys()].sort(),
			sessions: this.sessions(),
			scan: this.scan(),
			days,
			positions,
			agentBudget: this.agentBudget(),
		};
	}

	/** 15 Minuten vor Handelsschluss: einmal je Börse und Tag erinnern, welche heute eröffneten Positionen noch offen sind. */
	protected remindClose() {
		const now = this.now();
		for (const s of this.sessions()) {
			if (s.state !== "open" || !s.regEnd || s.regEnd - now > 15 * 60_000) continue;
			const key = `eod:${s.exchange}:${dayKey(now)}`;
			if (this.db.get("SELECT 1 FROM setting WHERE key = ?", key)) continue;
			this.db.run("INSERT INTO setting (key, value) VALUES (?, '1')", key);
			const open = this.cockpit().positions.filter((p) => p.openedToday && this.instrument(p.symbol)?.exchange === s.exchange);
			if (open.length)
				this.event("close", "Desk", de.desk.closeReminder(s.exchange, open.map((p) => `${p.symbol} (${this.account(p.accountId).name})`).join(", ")), { ref: null });
		}
	}

	/** Kurse holen, Limits ausführen, Abläufe, Alarme, Stop-/Ziel-Hinweise, Tagesstand. */
	tick(): Promise<void> {
		if (this.ticking) return this.ticking;
		this.ticking = (async () => {
			try {
				const tracked = this.trackedSymbols();
				this.feed.subscribe(tracked); // eine Push-Quelle liefert diese Symbole auch zwischen den Takten
				// Fehler von Symbolen, die niemand mehr verfolgt, nicht ewig melden (Wechselkurse bleiben, die hängen an Beständen)
				for (const s of this.quoteErrors.keys()) if (!s.endsWith("=X") && !tracked.includes(s)) this.quoteErrors.delete(s);
				await this.refresh(tracked);
				await this.refreshDaily(this.scanSymbols().filter((s) => !this.dailyStat(s)).slice(0, 3)).catch(() => undefined);
				for (const id of this.brokers.keys()) await this.pollBroker(id).catch((e) => console.error(`broker ${id}:`, (e as Error).message));
				this.db.tx(() => {
					this.fillLimits();
					this.expire();
					this.checkAlerts();
					this.checkStops();
					this.remindClose();
					this.snapshot();
				});
				this.ticks++;
				this.emit("tick", { at: this.now() });
			} finally {
				this.ticking = null;
			}
		})();
		return this.ticking;
	}

	/** Takt: schnell, solange ein Browser zusieht (liveIntervalSec), sonst ruhig; bei Störung der Börse dreifach langsamer. */
	start() {
		this.stop();
		this.unfeed = this.feed.onQuotes((quotes) => this.storePushed(quotes));
		let last = 0;
		let lastKeepAlive = this.now();
		this.timer = setInterval(() => {
			// Broker-Sitzungen eigenständig wach halten – auch bei Kurstakt 3600 s oder gestörter Börse
			if (this.brokers.size && this.now() - lastKeepAlive >= BROKER_KEEPALIVE_MS) {
				lastKeepAlive = this.now();
				for (const [id, b] of this.brokers) void b.keepAlive().catch((e) => console.error(`broker ${id} keepAlive:`, (e as Error).message));
			}
			const every = (this.viewers > 0 ? this.cfg.liveIntervalSec : this.cfg.quoteIntervalSec) * 1000 * (this.marketState === "error" ? 3 : 1);
			if (this.now() - last < every) return;
			last = this.now();
			void this.tick().catch((e) => console.error("tick:", e));
		}, 1000);
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.unfeed?.();
		this.unfeed = null;
	}
}
