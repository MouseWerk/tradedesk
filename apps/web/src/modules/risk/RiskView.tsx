// Risiko: Not-Aus und Grenzen je Depot. Änderungen gelten sofort (beim Verlassen des Feldes), mit Rückgängig.
import { useEffect, useState } from "react";
import { OctagonX, ShieldCheck } from "lucide-react";
import type { RiskLimits } from "@desk/shared";
import { useRisk } from "@/lib/api";
import { parseDe, pct } from "@/lib/format";
import { Badge, Button, Card, Field, Input, Skeleton, cn } from "@/ui/kit";
import { useConfirm } from "@/ui/overlay";
import { Page, PageHead, useAction } from "../common";

export default function RiskView() {
	const { data } = useRisk();
	const { run, busy } = useAction();
	const confirm = useConfirm();
	if (!data)
		return (
			<Page>
				<Skeleton className="h-8 w-40" />
				<Skeleton className="h-40" />
			</Page>
		);
	const toggleKill = async () => {
		const on = !data.killSwitch;
		if (on && !(await confirm({ title: "Not-Aus einschalten?", body: "Keine Freigaben und keine Ausführungen mehr, offene Limits ruhen. Vorschläge kommen weiter an.", confirm: "Not-Aus einschalten", danger: true }))) return;
		await run("/api/risk/kill", "PUT", { on }, on ? "Not-Aus ist an." : "Not-Aus ist aus.");
	};
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
					<Button variant={data.killSwitch ? "outline" : "danger"} onClick={() => void toggleKill()} disabled={busy} data-testid="kill-toggle">
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

const FIELDS: { key: keyof Omit<RiskLimits, "accountId">; label: string; hint: string; unit: string; toUi: (v: number) => string; fromUi: (v: number) => number }[] = [
	{ key: "maxOrderCents", label: "Max. Orderwert", hint: "je Order, 0 = keine Grenze", unit: "€", toUi: (v) => String(v / 100).replace(".", ","), fromUi: (v) => Math.round(v * 100) },
	{ key: "maxPositionPct", label: "Max. Position", hint: "Anteil nach dem Kauf", unit: "%", toUi: (v) => String(v).replace(".", ","), fromUi: (v) => v },
	{ key: "dailyLossPct", label: "Tagesverlust-Stopp", hint: "danach keine Käufe", unit: "%", toUi: (v) => String(v).replace(".", ","), fromUi: (v) => v },
	{ key: "maxOpenProposals", label: "Offene Vorschläge", hint: "je Agent, 0 = keine Grenze", unit: "", toUi: (v) => String(v), fromUi: (v) => Math.round(v) },
];

function Limits({ name, owner, limits, dayLossPct }: { name: string; owner: string; limits: RiskLimits; dayLossPct: number | null }) {
	const { run } = useAction();
	const [vals, setVals] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.key, f.toUi(limits[f.key])])) as Record<string, string>);
	const [errs, setErrs] = useState<Record<string, string | null>>({});
	useEffect(() => setVals(Object.fromEntries(FIELDS.map((f) => [f.key, f.toUi(limits[f.key])]))), [limits]);
	const commit = async (f: (typeof FIELDS)[number]) => {
		const v = parseDe(vals[f.key]);
		if (!(v >= 0) || (f.unit === "%" && v > 100)) return setErrs({ ...errs, [f.key]: f.unit === "%" ? "0 bis 100" : "0 oder mehr" });
		setErrs({ ...errs, [f.key]: null });
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
						{(id) => (
							<Input
								id={id}
								inputMode="decimal"
								value={vals[f.key]}
								onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
								onBlur={() => void commit(f)}
								onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
							/>
						)}
					</Field>
				))}
			</div>
			<p className="mt-3 text-[12px] text-fg-3 tnum">Heute: {dayLossPct === null ? "noch kein Vortag" : dayLossPct > 0 ? `${pct(dayLossPct, { signed: false })} Verlust` : "kein Verlust"}</p>
		</Card>
	);
}
