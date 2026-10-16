// Trading-Cockpit für den Tageshandel: Börsen-Sessions und Tagesergebnis oben, Scanner links, Intraday-Chart mit
// Indikatoren in der Mitte, Order-Rechner, Positionen, offene Vorschläge und News rechts, Tagesstatistik unten.
// Tasten: Pfeil hoch/runter wechselt den Wert, B/S öffnet den Rechner für Kauf/Verkauf.
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Side } from "@desk/shared";
import { useCockpit, useOverview, useProposals } from "@/lib/api";
import { Card, Empty, Skeleton } from "@/ui/kit";
import { Page, ProposalCard } from "../common";
import { DayTable, NewsCard, Positions, SessionBar } from "./parts";
import { Scanner } from "./Scanner";
import { IntradayChart } from "./IntradayChart";
import { OrderCalc } from "./OrderCalc";

export default function TradeView() {
	const { symbol: wanted } = useSearch({ strict: false }) as { symbol?: string };
	const navigate = useNavigate();
	const { data, isLoading } = useCockpit();
	const { data: ov } = useOverview();
	const { data: proposals } = useProposals();
	const [side, setSide] = useState<Side>("buy");
	const [focusCalc, setFocusCalc] = useState(0);
	const rows = data?.scan ?? [];
	const selected = rows.find((r) => r.symbol === wanted) ?? rows[0];
	const select = (s: string) => void navigate({ to: "/trade", search: { symbol: s }, replace: true });

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement;
			if (e.ctrlKey || e.metaKey || e.altKey || t.closest("input, textarea, select, [contenteditable=true]") || document.querySelector("[role=dialog]")) return;
			if ((e.key === "ArrowDown" || e.key === "ArrowUp") && rows.length && selected) {
				e.preventDefault();
				const i = rows.findIndex((r) => r.symbol === selected.symbol);
				select(rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].symbol);
			} else if (e.key === "b" || e.key === "s") {
				e.preventDefault();
				setSide(e.key === "b" ? "buy" : "sell");
				setFocusCalc((n) => n + 1);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	if (isLoading || !data || !ov)
		return (
			<Page>
				<Skeleton className="h-16" />
				<div className="grid grid-cols-[320px_minmax(0,1fr)_340px] gap-4">
					<Skeleton className="h-[520px]" />
					<Skeleton className="h-[520px]" />
					<Skeleton className="h-[520px]" />
				</div>
			</Page>
		);

	const active = (proposals ?? []).filter((p) => ["pending", "placed", "open", "sending", "confirm"].includes(p.status));
	const forSymbol = active.filter((p) => !selected || p.symbol === selected.symbol);
	return (
		<Page className="max-w-none">
			<SessionBar cockpit={data} />
			{rows.length === 0 ? (
				<Card>
					<Empty>Die Watchlist ist leer. Unter Markt Werte suchen und hinzufügen – dann erscheinen sie hier im Scanner.</Empty>
				</Card>
			) : (
				<div className="grid grid-cols-[300px_minmax(0,1fr)_340px] items-start gap-4 @max-[1400px]:grid-cols-[280px_minmax(0,1fr)] @max-[900px]:grid-cols-1">
					<Scanner rows={rows} selected={selected?.symbol} onSelect={select} />
					<div className="flex min-w-0 flex-col gap-4">
						{selected && <IntradayChart row={selected} cockpit={data} proposals={active} />}
						<Positions cockpit={data} onSelect={select} />
					</div>
					<div className="flex min-w-0 flex-col gap-4 @max-[1400px]:col-span-2 @max-[1400px]:grid @max-[1400px]:grid-cols-2 @max-[900px]:col-span-1 @max-[900px]:flex">
						{selected && <OrderCalc row={selected} cockpit={data} accounts={ov.accounts} side={side} onSide={setSide} focusSignal={focusCalc} />}
						<div className="flex min-w-0 flex-col gap-4">
							{forSymbol.length > 0 && (
								<section className="flex flex-col gap-3" aria-label="Offene Vorschläge zu diesem Wert">
									{forSymbol.slice(0, 3).map((p) => (
										<ProposalCard key={p.id} p={p} accounts={ov.accounts} user={ov.user} compact />
									))}
								</section>
							)}
							{selected && <NewsCard symbol={selected.symbol} />}
						</div>
					</div>
				</div>
			)}
			<DayTable cockpit={data} />
		</Page>
	);
}
