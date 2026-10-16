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
		const r = await run<Reconcile>(`/api/accounts/${encodeURIComponent(account.id)}/reconcile`, "POST", {}, "Abgleich übernommen.");
		if (r) setPreview(null);
	};
	if (!s) return null;
	const ok = s.authenticated && !!s.brokerAccount;
	return (
		<Card pad={false} label={`Verbindung zu ${account.broker}`}>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
				{ok ? <Link2 className="size-5 text-ok" aria-hidden /> : <Link2Off className="size-5 text-warn" aria-hidden />}
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{ok ? `${account.broker} verbunden` : `${account.broker} nicht verbunden`}</span>
						{s.brokerAccount && <Badge>{s.brokerAccount}</Badge>}
						{account.live ? <Badge variant="err">Echtes Geld</Badge> : <Badge>Papierkonto</Badge>}
						{account.live && <Badge variant={s.liveTrading ? "warn" : "soft"}>Live-Handel {s.liveTrading ? "an" : "aus"}</Badge>}
					</div>
					<p className="text-[12px] text-fg-3">
						{ok ? `Geprüft ${ago(s.checkedAt)}.` : s.message || "Noch nicht geprüft."}
						{account.live && !s.liveTrading && " Echte Orders sind gesperrt, bis in config.json \"liveTrading\": true steht."}
					</p>
				</div>
				{!ok && s.loginUrl && (
					<a href={s.loginUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-surface-2">
						Im Gateway anmelden
						<ExternalLink className="size-3.5" aria-hidden />
					</a>
				)}
				<Button onClick={() => void load()} disabled={loading || !ok}>
					<RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
					Mit {account.broker} abgleichen…
				</Button>
			</div>
			<FormDialog
				open={!!preview}
				onOpenChange={(o) => !o && setPreview(null)}
				title={`Abgleich mit ${account.broker}`}
				description="Was beim Broker liegt, gegen das Buch des Desks. Übernehmen bucht die Unterschiede als Abgleich (Bestand zum Einstand des Brokers, Cash als Ausgleich)."
				submit={preview?.differences ? `${preview.differences} Unterschiede übernehmen` : "Nichts zu tun"}
				onSubmit={() => (preview?.differences ? void apply() : setPreview(null))}
				busy={busy}
				wide
			>
				{preview && (
					<>
						<Table label="Bestand beim Broker und im Desk">
							<thead>
								<tr>
									<th className={th}>Wert</th>
									<th className={cn(th, "text-right")}>Broker</th>
									<th className={cn(th, "text-right")}>Desk</th>
									<th className={cn(th, "text-right")}>Einstand</th>
								</tr>
							</thead>
							<tbody>
								{preview.rows.map((r) => {
									const diff = Math.abs(r.brokerQty - r.deskQty) > 1e-9;
									return (
										<tr key={`${r.conid}-${r.symbol}`} className={diff ? "font-medium" : "text-fg-2"}>
											<td className={td}>
												{r.symbol ?? <span className="text-warn">ohne Zuordnung</span>} <span className="text-[11.5px] text-fg-3">{r.description}{r.conid ? ` · conid ${r.conid}` : ""}</span>
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
							Cash beim Broker {preview.brokerCashCents === null ? "–" : eur(preview.brokerCashCents)} · im Desk {eur(preview.deskCashCents)}
						</p>
						{preview.rows.some((r) => !r.symbol) && <p className="text-[12px] text-warn">Werte ohne Zuordnung bleiben außen vor: in config.json unter „conids“ Symbol und conid eintragen, Desk neu starten.</p>}
					</>
				)}
			</FormDialog>
		</Card>
	);
}
