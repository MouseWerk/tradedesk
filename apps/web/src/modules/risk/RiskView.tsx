// Risiko: Not-Aus und Grenzen je Depot. Änderungen gelten sofort (beim Verlassen des Feldes), mit Rückgängig.
import { useEffect, useRef, useState } from "react";
import { OctagonX, ShieldCheck } from "lucide-react";
import type { RiskLimits } from "@desk/shared";
import { useRisk } from "@/lib/api";
import { inputNumber, numberError, parseDe, pct } from "@/lib/format";
import { Badge, Button, Card, Field, Input, Skeleton, cn } from "@/ui/kit";
import { LoadError } from "@/ui/boundary";
import { Page, PageHead, useAction, useKillSwitch } from "../common";

export default function RiskView() {
	const { data, error, refetch } = useRisk();
	const kill = useKillSwitch();
	if (error && !data)
		return (
			<Page>
				<LoadError error={error} onRetry={() => void refetch()} />
			</Page>
		);
	if (!data)
		return (
			<Page>
				<Skeleton className="h-8 w-40" />
				<Skeleton className="h-40" />
			</Page>
		);
	const toggleKill = () => kill.toggle(data.killSwitch);
	return (
		<Page>
			<PageHead title="Risiko" sub="Jede Order, jeder Vorschlag und jede Freigabe läuft durch diese Prüfung – auch deine eigenen." />
			<Card pad={false}>
				<div className={cn("flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4", data.killSwitch && "bg-err/8")}>
					{data.killSwitch ? <OctagonX className="size-6 text-err" aria-hidden /> : <ShieldCheck className="size-6 text-ok" aria-hidden />}
					<div className="min-w-0 flex-1">
						<h2 className="text-[15px] font-semibold">{data.killSwitch ? "Not-Aus ist an" : "Handel aktiv"}</h2>
						<p className="text-[12.5px] text-fg-3">{data.killSwitch ? "Nichts wird freigegeben oder ausgeführt, bis du ihn ausschaltest." : "Ein Klick stoppt alle Freigaben und Ausführungen sofort."}</p>
					</div>
					<Button variant={data.killSwitch ? "outline" : "danger"} onClick={() => void toggleKill()} disabled={kill.busy} data-testid="kill-toggle">
						{data.killSwitch ? "Not-Aus ausschalten" : "Not-Aus…"}
					</Button>
				</div>
				<dl className="grid grid-cols-3 gap-4 border-t border-line px-4 py-3 text-[12.5px] @max-[700px]:grid-cols-1">
					<div>
						<dt className="text-fg-3">Mindest-Zuversicht für Agenten</dt>
						<dd className="font-medium tnum">{Math.round(data.minConfidence * 100)} %</dd>
					</div>
					<div>
						<dt className="text-fg-3">Kursbewegung bis zur Freigabe höchstens</dt>
						<dd className="font-medium tnum">{pct(data.staleMovePct, { signed: false })}</dd>
					</div>
					<div>
						<dt className="text-fg-3">Vorschläge verfallen nach</dt>
						<dd className="font-medium tnum">{data.proposalTtlHours} Std.</dd>
					</div>
				</dl>
				<p className="border-t border-line px-4 py-2 text-[11.5px] text-fg-3">Diese drei Werte stehen in config.json (minConfidence, staleMovePct, proposalTtlHours).</p>
			</Card>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-4">
				{data.accounts.map((a) => (
					<Limits key={a.account.id} name={a.account.name} owner={a.account.owner} limits={a.limits} dayLossPct={a.dayLossPct} />
				))}
			</div>
		</Page>
	);
}

const FIELDS: { key: keyof Omit<RiskLimits, "accountId" | "requireStop">; label: string; hint: string; unit: string; toUi: (v: number) => string; fromUi: (v: number) => number }[] = [
	{ key: "maxOrderCents", label: "Max. Orderwert", hint: "je Order, 0 = keine Grenze", unit: "€", toUi: (v) => inputNumber(v / 100, v % 100 ? 2 : 0), fromUi: (v) => Math.round(v * 100) },
	{ key: "maxPositionPct", label: "Max. Position", hint: "Anteil am Depot nach dem Kauf", unit: "%", toUi: (v) => String(v).replace(".", ","), fromUi: (v) => v },
	{ key: "maxRiskPct", label: "Risiko je Trade", hint: "Verlust bis zum Stop, 0 = keine Grenze", unit: "%", toUi: (v) => String(v).replace(".", ","), fromUi: (v) => v },
	{ key: "dailyLossPct", label: "Tagesverlust-Stopp", hint: "danach keine Käufe, 0 = keine Grenze", unit: "%", toUi: (v) => String(v).replace(".", ","), fromUi: (v) => v },
	{ key: "maxOpenProposals", label: "Offene Vorschläge", hint: "je Agent, 0 = keine Grenze", unit: "", toUi: (v) => String(v), fromUi: (v) => Math.round(v) },
];

function Limits({ name, owner, limits, dayLossPct }: { name: string; owner: string; limits: RiskLimits; dayLossPct: number | null }) {
	const { run } = useAction();
	const [vals, setVals] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.key, f.toUi(limits[f.key])])) as Record<string, string>);
	const [errs, setErrs] = useState<Record<string, string | null>>({});
	// Neu vom Server nur die Felder, deren Wert sich dort geändert hat und die du gerade nicht bearbeitest – sonst
	// überschrieb das Neuladen nach dem einen Feld, was du schon ins nächste getippt hattest
	const editing = useRef<string | null>(null);
	const lastServer = useRef(limits);
	useEffect(() => {
		const prev = lastServer.current;
		lastServer.current = limits;
		setVals((v) => {
			const next = { ...v };
			for (const f of FIELDS) if (limits[f.key] !== prev[f.key] && editing.current !== f.key) next[f.key] = f.toUi(limits[f.key]);
			return next;
		});
	}, [limits]);
	const commit = async (f: (typeof FIELDS)[number]) => {
		const v = parseDe(vals[f.key]);
		if (!(v >= 0) || (f.unit === "%" && v > 100)) return setErrs({ ...errs, [f.key]: numberError(vals[f.key]) ?? (f.unit === "%" ? "0 bis 100" : "0 oder mehr") });
		setErrs({ ...errs, [f.key]: null });
		// gleiche Schreibweise wie vom Server (z. B. „5000“ → „5.000“)
		setVals((x) => ({ ...x, [f.key]: f.toUi(f.fromUi(v)) }));
		const next = f.fromUi(v);
		if (next === limits[f.key]) return;
		const prev = limits[f.key];
		await run(`/api/risk/${limits.accountId}`, "PUT", { [f.key]: next }, `${f.label} für ${name} geändert.`, { label: "Rückgängig", run: () => void run(`/api/risk/${limits.accountId}`, "PUT", { [f.key]: prev }, "Zurückgesetzt.") });
	};
	return (
		<Card title={name} aside={owner === "user" ? <Badge>dein Depot</Badge> : <Badge>Agent {owner}</Badge>}>
			<div className="grid grid-cols-2 gap-3 @max-[480px]:grid-cols-1">
				{FIELDS.map((f) => (
					<Field key={f.key} label={`${f.label}${f.unit ? ` (${f.unit})` : ""}`} hint={f.hint} error={errs[f.key]}>
						{(id, a) => (
							<Input
								id={id}
								{...a}
								inputMode="decimal"
								value={vals[f.key]}
								onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
								onFocus={() => (editing.current = f.key)}
								onBlur={() => {
									editing.current = null;
									void commit(f);
								}}
								onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
							/>
						)}
					</Field>
				))}
			</div>
			<label className="mt-3 flex items-center gap-2 text-[12.5px]">
				<input
					type="checkbox"
					className="size-4 accent-[var(--fg)]"
					checked={limits.requireStop}
					onChange={(e) => void run(`/api/risk/${limits.accountId}`, "PUT", { requireStop: e.target.checked }, e.target.checked ? `Stop-Pflicht für Agenten in ${name} an.` : `Stop-Pflicht für Agenten in ${name} aus.`)}
				/>
				Agenten müssen beim Kauf einen Stop-Loss setzen
			</label>
			<p className="mt-2 text-[12px] text-fg-3 tnum">Heute: {dayLossPct === null ? "noch kein Vortag" : dayLossPct > 0 ? `${pct(dayLossPct, { signed: false })} Verlust` : "kein Verlust"}</p>
		</Card>
	);
}
