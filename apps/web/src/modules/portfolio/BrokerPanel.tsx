// Broker-Depot (IBKR): Verbindung, Papier oder echtes Geld, Hauptschalter, Abgleich von Bestand und Cash.
// Anmelden machst du im Gateway selbst – der Desk sieht nie Zugangsdaten.
import { useState } from "react";
import { ExternalLink, Link2, Link2Off, RefreshCw } from "lucide-react";
import type { AccountSummary, Reconcile } from "@desk/shared";
import { ReconcileSchema } from "@desk/shared";
import { getChecked, useBrokers } from "@/lib/api";
import { ago, eur, num, qty } from "@/lib/format";
import { Badge, Button, Card, Table, cn, td, th } from "@/ui/kit";
import { FormDialog, useToast } from "@/ui/overlay";
import { useAction } from "../common";
import { de } from "@/i18n/de";

/** Die Zeile aus config.json, wörtlich (kein Text, sondern Einstellung) */
const LIVE_SETTING = '"liveTrading": true';

export function BrokerPanel({ account }: { account: AccountSummary }) {
	const { data } = useBrokers();
	const s = data?.find((b) => b.accountId === account.id);
	const [preview, setPreview] = useState<Reconcile | null>(null);
	const [loading, setLoading] = useState(false);
	const { run, busy } = useAction();
	const toast = useToast();
	const load = async () => {
		setLoading(true);
		try {
			setPreview(await getChecked(`/api/accounts/${encodeURIComponent(account.id)}/reconcile`, ReconcileSchema));
		} catch (e) {
			toast({ text: (e as Error).message, tone: "error" });
		} finally {
			setLoading(false);
		}
	};
	const apply = async () => {
		const r = await run<Reconcile>(`/api/accounts/${encodeURIComponent(account.id)}/reconcile`, "POST", {}, de.brokerPanel.applied);
		if (r) setPreview(null);
	};
	if (!s) return null;
	const ok = s.authenticated && !!s.brokerAccount;
	return (
		<Card pad={false} label={de.brokerPanel.label(account.broker)}>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
				{ok ? <Link2 className="size-5 text-ok" aria-hidden /> : <Link2Off className="size-5 text-warn" aria-hidden />}
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{ok ? de.brokerPanel.connected(account.broker) : de.brokerPanel.notConnected(account.broker)}</span>
						{s.brokerAccount && <Badge>{s.brokerAccount}</Badge>}
						{account.live ? <Badge variant="err">{de.brokerPanel.liveMoney}</Badge> : <Badge>{de.common.paperAccount}</Badge>}
						{account.live && <Badge variant={s.liveTrading ? "warn" : "soft"}>{s.liveTrading ? de.brokerPanel.liveTradingOn : de.brokerPanel.liveTradingOff}</Badge>}
					</div>
					<p className="text-[12px] text-fg-3">
						{ok ? de.brokerPanel.checked(ago(s.checkedAt)) : s.message || de.brokerPanel.notChecked}
						{account.live && !s.liveTrading && de.brokerPanel.liveLocked(LIVE_SETTING)}
					</p>
				</div>
				{!ok && s.loginUrl && (
					<a href={s.loginUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-surface-2">
						{de.brokerPanel.gatewayLogin}
						<ExternalLink className="size-3.5" aria-hidden />
					</a>
				)}
				<Button onClick={() => void load()} disabled={loading || !ok}>
					<RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
					{de.brokerPanel.reconcile(account.broker)}
				</Button>
			</div>
			<FormDialog
				open={!!preview}
				onOpenChange={(o) => !o && setPreview(null)}
				title={de.brokerPanel.dialogTitle(account.broker)}
				description={de.brokerPanel.dialogDescription}
				submit={preview?.differences ? de.brokerPanel.applyDifferences(preview.differences) : de.brokerPanel.nothingToDo}
				onSubmit={() => (preview?.differences ? void apply() : setPreview(null))}
				busy={busy}
				wide
			>
				{preview && (
					<>
						<Table label={de.brokerPanel.tableLabel}>
							<thead>
								<tr>
									<th className={th}>{de.portfolio.positions.value}</th>
									<th className={cn(th, "text-right")}>{de.brokerPanel.colBroker}</th>
									<th className={cn(th, "text-right")}>{de.brokerPanel.colDesk}</th>
									<th className={cn(th, "text-right")}>{de.brokerPanel.colCost}</th>
								</tr>
							</thead>
							<tbody>
								{preview.rows.map((r) => {
									const diff = Math.abs(r.brokerQty - r.deskQty) > 1e-9;
									return (
										<tr key={`${r.conid}-${r.symbol}`} className={diff ? "font-medium" : "text-fg-2"}>
											<td className={td}>
												{r.symbol ?? <span className="text-warn">{de.brokerPanel.unmatched}</span>} <span className="text-[11.5px] text-fg-3">{r.description}{r.conid ? de.brokerPanel.conid(String(r.conid)) : ""}</span>
											</td>
											<td className={cn(td, "text-right tnum")}>{qty(r.brokerQty)}</td>
											<td className={cn(td, "text-right tnum")}>{qty(r.deskQty)}</td>
											<td className={cn(td, "text-right tnum")}>{r.avgCost ? `${num(r.avgCost)} ${r.currency}` : "–"}</td>
										</tr>
									);
								})}
							</tbody>
						</Table>
						<p className="text-[12.5px] tnum">
							{de.brokerPanel.cash(preview.brokerCashCents === null ? "–" : eur(preview.brokerCashCents), eur(preview.deskCashCents))}
						</p>
						{preview.rows.some((r) => !r.symbol) && <p className="text-[12px] text-warn">{de.brokerPanel.unmatchedHint}</p>}
					</>
				)}
			</FormDialog>
		</Card>
	);
}
