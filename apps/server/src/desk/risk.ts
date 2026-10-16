// Risiko: Grenzen je Depot, Tagesverlust, Not-Aus.
import type { Account, RiskData, RiskLimits } from "@desk/shared";
import { RiskLimitsSchema } from "@desk/shared";
import { DEFAULT_LIMITS, DeskError } from "./core.ts";
import { DeskBook } from "./book.ts";

export abstract class DeskRisk extends DeskBook {
	dayLossPct(a: Account, s = this.summary(a)): number | null {
		const prev = this.prevSnapshot(a.id);
		if (!prev || prev.equity_cents <= 0 || s.dayChangeCents === null) return null;
		return Math.max(0, (-s.dayChangeCents / prev.equity_cents) * 100);
	}

	limits(accountId: string): RiskLimits {
		const r = this.db.get<{ max_order_cents: number; max_position_pct: number; daily_loss_pct: number; max_open_proposals: number; max_risk_pct: number; require_stop: number }>("SELECT * FROM risk WHERE account_id = ?", accountId);
		return r
			? { accountId, maxOrderCents: r.max_order_cents, maxPositionPct: r.max_position_pct, dailyLossPct: r.daily_loss_pct, maxOpenProposals: r.max_open_proposals, maxRiskPct: r.max_risk_pct, requireStop: !!r.require_stop }
			: { accountId, ...DEFAULT_LIMITS };
	}

	risk(): RiskData {
		return {
			killSwitch: this.killSwitch,
			minConfidence: this.cfg.minConfidence,
			staleMovePct: this.cfg.staleMovePct,
			proposalTtlHours: this.cfg.proposalTtlHours,
			accounts: this.cfg.accounts.map((a) => ({ account: a, limits: this.limits(a.id), dayLossPct: this.dayLossPct(a) })),
		};
	}

	setLimits(accountId: string, body: unknown): RiskData {
		const a = this.account(accountId);
		const parsed = RiskLimitsSchema.safeParse({ ...this.limits(a.id), ...(body && typeof body === "object" ? body : {}), accountId: a.id });
		if (!parsed.success) throw new DeskError(`Ungültige Grenze: ${parsed.error.issues[0].path.join(".")} – ${parsed.error.issues[0].message}`);
		const l = parsed.data;
		this.db.run(
			"UPDATE risk SET max_order_cents = ?, max_position_pct = ?, daily_loss_pct = ?, max_open_proposals = ?, max_risk_pct = ?, require_stop = ? WHERE account_id = ?",
			l.maxOrderCents, l.maxPositionPct, l.dailyLossPct, l.maxOpenProposals, l.maxRiskPct, l.requireStop, a.id,
		);
		this.event("risk.limits", this.cfg.user, `Grenzen für ${a.name} geändert`);
		return this.risk();
	}

	setKill(on: boolean): RiskData {
		this.db.run("INSERT INTO setting (key, value) VALUES ('kill_switch', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", on ? "1" : "0");
		this.event("risk.kill", this.cfg.user, on ? "Not-Aus eingeschaltet – keine Freigaben und keine Ausführungen" : "Not-Aus ausgeschaltet");
		this.emit("tick", { at: this.now() });
		return this.risk();
	}
}
