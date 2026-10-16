// Agenten: Rendite im Vergleich zu dir, Bilanz je Agent (Trefferquote, Freigaben), Journal, Anbindung über die CLI.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Bot, NotebookPen, Terminal } from "lucide-react";
import type { CurvePoint } from "@desk/shared";
import { useAgents, useOverview } from "@/lib/api";
import { ago, dayLabel, eur, pct, tone } from "@/lib/format";
import { LineChart, Sparkline, type LineSeries } from "@/ui/charts";
import { Badge, Card, Empty, Select, Skeleton, cn } from "@/ui/kit";
import { Page, PageHead } from "../common";
import { LoadError } from "@/ui/boundary";

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];
const KIND = { note: "Notiz", thesis: "These", review: "Rückblick" } as const;

const ret = (p: CurvePoint) => (p.depositsCents > 0 ? ((p.equityCents - p.depositsCents) / p.depositsCents) * 100 : null);

export default function AgentsView() {
	const { data, error, refetch } = useAgents();
	const { data: ov, error: ovError, refetch: refetchOv } = useOverview();
	const [who, setWho] = useState("");
	if ((error && !data) || (ovError && !ov))
		return (
			<Page>
				<LoadError error={error ?? ovError} onRetry={() => void (refetch(), refetchOv())} />
			</Page>
		);
	if (!data || !ov)
		return (
			<Page>
				<Skeleton className="h-8 w-40" />
				<Skeleton className="h-[300px]" />
			</Page>
		);
	// Vergleich: Rendite je Tag – du (Summe deiner Depots) und jeder Agent. Farbe folgt der Person, nicht dem Rang.
	const you = ov.curve;
	const days = [...new Set([...you.map((p) => p.day), ...data.agents.flatMap((a) => a.curve.map((p) => p.day))])].sort().slice(-91);
	const at = (curve: CurvePoint[], day: string) => {
		const p = curve.find((x) => x.day === day);
		return p ? ret(p) : null;
	};
	const series: LineSeries[] = [
		{ id: "you", label: `${ov.user} (deine Depots)`, color: SERIES[0], values: days.map((d) => at(you, d)) },
		...data.agents.slice(0, 4).map((a, i) => ({ id: a.name, label: a.name, color: SERIES[i + 1], values: days.map((d) => at(a.curve, d)) })),
	];
	const journal = data.journal.filter((j) => !who || j.author === who);
	return (
		<Page>
			<PageHead title="Agenten" sub="Jeder Agent handelt ein eigenes Papierdepot und schlägt dir vor. Hier siehst du, wer gut entscheidet." />
			{data.agents.length === 0 ? (
				<Card>
					<Empty>Noch keine Agenten. In config.json unter „agents“ eintragen, z. B. [{"{"}"name": "Atlas", "startCashEur": 10000{"}"}], dann den Desk neu starten.</Empty>
				</Card>
			) : (
				<>
					<Card title="Rendite im Vergleich" aside="seit Start, in %">
						<LineChart label="Rendite in Prozent je Tag: du und die Agenten" xs={days} xLabel={dayLabel} series={series} format={(v) => pct(v, { digits: 1 })} baseline={0} height={260} />
						<ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px]" aria-label="Legende">
							{series.map((s) => {
								const last = [...s.values].reverse().find((v) => v !== null) ?? null;
								return (
									<li key={s.id} className="flex items-center gap-2">
										<span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} aria-hidden />
										<span className="text-fg-2">{s.label}</span>
										<span className="font-medium tnum">{pct(last)}</span>
									</li>
								);
							})}
						</ul>
					</Card>
					{/* auto-fit: wenige Agenten füllen die Reihe statt 40 % davon */}
					<div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
						{data.agents.map((a, i) => (
							<Card key={a.name} title={a.name} icon={<Bot className="size-4" />} aside={a.lastActive ? `aktiv ${ago(a.lastActive)}` : "noch nie aktiv"}>
								<div className="flex items-end gap-3">
									<div className="min-w-0">
										<div className="text-[22px] font-semibold tnum">
											<span className={tone(a.returnPct)}>{pct(a.returnPct)}</span>
										</div>
										<div className="text-[12px] text-fg-3 tnum">{eur(a.equityCents)} Depotwert</div>
									</div>
									<Sparkline values={a.curve.map((p) => p.equityCents)} color={i < 4 ? SERIES[i + 1] : "var(--fg-2)"} className="ml-auto h-10 w-32" />
								</div>
								<dl className="mt-4 grid grid-cols-3 gap-3 text-[12px]">
									<div>
										<dt className="text-fg-3">Trefferquote</dt>
										<dd className="font-medium tnum">{a.winRate === null ? "–" : pct(a.winRate, { signed: false, digits: 0 })}</dd>
										<dd className="text-fg-3 tnum">{a.closed} geschlossen</dd>
									</div>
									<div>
										<dt className="text-fg-3">Freigegeben</dt>
										<dd className="font-medium tnum">{a.approved}</dd>
										<dd className="text-fg-3 tnum">{a.rejected} abgelehnt</dd>
									</div>
									<div>
										<dt className="text-fg-3">Offen</dt>
										<dd className="font-medium tnum">{a.pending}</dd>
										<dd className="text-fg-3 tnum">{a.trades} Trades</dd>
									</div>
								</dl>
								<div className="mt-4 flex gap-3 text-[12.5px]">
									<Link to="/portfolio" search={{ account: a.accountId }} className="text-fg-2 underline-offset-2 hover:text-fg hover:underline">
										Depot ansehen
									</Link>
									{a.pending > 0 && (
										<Link to="/orders" className="text-fg-2 underline-offset-2 hover:text-fg hover:underline">
											{a.pending} offene Vorschläge
										</Link>
									)}
								</div>
							</Card>
						))}
					</div>
				</>
			)}
			<div className="grid grid-cols-[minmax(0,1fr)_420px] gap-4 @max-[1100px]:grid-cols-1">
				<Card title="Journal" icon={<NotebookPen className="size-4" />} pad={false} aside={
					<Select aria-label="Journal nach Autor filtern" value={who} onChange={(e) => setWho(e.target.value)} className="h-7 w-40 text-[12px]">
						<option value="">Alle</option>
						{data.agents.map((a) => (
							<option key={a.name} value={a.name}>
								{a.name}
							</option>
						))}
					</Select>
				}>
					{journal.length ? (
						<ol className="divide-y divide-line">
							{journal.map((j) => (
								<li key={j.id} className="px-4 py-3 text-[12.5px]">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium">{j.author}</span>
										<Badge>{KIND[j.kind]}</Badge>
										{j.symbol && (
											<Link to="/market" search={{ symbol: j.symbol }} className="text-fg-2 hover:underline">
												{j.symbol}
											</Link>
										)}
										<span className="ml-auto text-fg-3">{ago(j.time)}</span>
									</div>
									<p className="mt-1 leading-relaxed whitespace-pre-line text-fg-2">{j.text}</p>
								</li>
							))}
						</ol>
					) : (
						<Empty>Noch keine Einträge.</Empty>
					)}
				</Card>
				<Card title="Agenten anbinden" icon={<Terminal className="size-4" />}>
					<div className="flex flex-col gap-3 text-[12.5px] leading-relaxed text-fg-2">
						<p>Agenten sind Claude-Code-Sitzungen. Öffne Claude Code im Ordner des Tradedesk und starte je Agent:</p>
						<pre className={cn("scroll-thin overflow-x-auto rounded-lg bg-bg-2 p-3 font-mono text-[11.5px] text-fg")}>
							{`/desk-agent Atlas

# den ganzen Tag im Takt:
/loop 10m /desk-agent Atlas`}
						</pre>
						<p>Der Agent holt sich mit „desk.py brief“ alles Nötige, schreibt dir im Chat, schlägt mit Stop vor und wartet mit „desk.py wait“, bis du antwortest. Regeln: docs/AGENTS.md.</p>
						<p className="text-fg-3">Freigeben, bei IBKR bestätigen und stornieren kannst nur du hier im Browser.</p>
					</div>
				</Card>
			</div>
		</Page>
	);
}
