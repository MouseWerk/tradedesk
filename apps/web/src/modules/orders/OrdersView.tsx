// Orders: was auf dich wartet (Vorschläge, Broker-Orders, offene Limits) und der Verlauf aller Entscheidungen.
import { useState } from "react";
import { ShoppingCart } from "lucide-react";
import { useOverview, useProposals } from "@/lib/api";
import { Button, Card, Empty, Segmented, Select, Skeleton } from "@/ui/kit";
import { LoadError } from "@/ui/boundary";
import { Page, PageHead, ProposalCard, isActive } from "../common";
import { OrderTicket } from "./OrderTicket";

type Tab = "open" | "history";

export default function OrdersView() {
	const { data: ov, error: ovError, refetch: refetchOv } = useOverview();
	const { data, error, refetch } = useProposals();
	const [tab, setTab] = useState<Tab>("open");
	const [author, setAuthor] = useState("");
	const [ticket, setTicket] = useState(false);
	const all = data ?? [];
	const active = all.filter(isActive);
	const list = (tab === "open" ? active : all.filter((p) => !isActive(p))).filter((p) => !author || p.author === author);
	const authors = [...new Set(all.map((p) => p.author))].sort();
	const pending = active.filter((p) => p.status === "pending").length;
	return (
		<Page>
			<PageHead
				title="Orders"
				sub="Agenten schlagen vor, du entscheidest. Für Trade Republic führst du freigegebene Orders selbst in der App aus."
				aside={
					<Button variant="primary" onClick={() => setTicket(true)} disabled={!ov}>
						<ShoppingCart className="size-4" aria-hidden />
						Neue Order…
					</Button>
				}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<Segmented label="Ansicht" items={[{ id: "open", label: `Offen (${data ? active.length : "–"})` }, { id: "history", label: "Verlauf" }]} value={tab} onChange={setTab} />
				<Select aria-label="Nach Autor filtern" value={author} onChange={(e) => setAuthor(e.target.value)} className="w-44">
					<option value="">Alle Autoren</option>
					{authors.map((a) => (
						<option key={a} value={a}>
							{a}
						</option>
					))}
				</Select>
				{tab === "open" && pending > 0 && <span className="text-[12.5px] text-fg-3">{pending === 1 ? "1 Vorschlag wartet auf deine Entscheidung" : `${pending} Vorschläge warten auf deine Entscheidung`}</span>}
			</div>
			{(error && !data) || (ovError && !ov) ? (
				<LoadError error={error ?? ovError} onRetry={() => void (refetch(), refetchOv())} />
			) : !data || !ov ? (
				<div className="grid grid-cols-2 gap-4 @max-[1000px]:grid-cols-1 @min-[1800px]:grid-cols-3">
					<Skeleton className="h-56" />
					<Skeleton className="h-56" />
				</div>
			) : list.length ? (
				<div className="grid grid-cols-2 gap-4 @max-[1000px]:grid-cols-1 @min-[1800px]:grid-cols-3">
					{list.map((p) => (
						<ProposalCard key={p.id} p={p} accounts={ov.accounts} user={ov.user} />
					))}
				</div>
			) : (
				<Card>
					<Empty>{tab === "open" ? "Nichts offen. Agenten schlagen mit „python cli/desk.py propose“ vor." : "Noch keine Entscheidungen."}</Empty>
				</Card>
			)}
			{ov && <OrderTicket open={ticket} onOpenChange={setTicket} accounts={ov.accounts} />}
		</Page>
	);
}
