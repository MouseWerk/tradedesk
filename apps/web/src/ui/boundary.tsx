// Fehlergrenzen: ein kaputtes Modul (oder eine unpassende API-Antwort) zeigt „Daten nicht verfügbar“, die App bleibt stehen.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "./kit";

function Fallback({ title, error, onRetry, compact }: { title: string; error: unknown; onRetry: () => void; compact?: boolean }) {
	return (
		<div className={compact ? "p-4" : "grid h-full min-h-60 place-items-center px-6"} role="alert">
			<div className="max-w-lg text-center">
				<TriangleAlert className="mx-auto size-5 text-warn" aria-hidden />
				<h2 className="mt-2 text-[15px] font-semibold">{title}</h2>
				<p className="mt-1 text-[12.5px] break-words text-fg-3">{error instanceof Error ? error.message : String(error)}</p>
				<Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
					<RotateCcw className="size-3.5" />
					Neu laden
				</Button>
			</div>
		</div>
	);
}

/** Für Routen (TanStack Router defaultErrorComponent): Modul fällt aus, Rahmen und Chat bleiben. */
export function ModuleError({ error, reset }: ErrorComponentProps) {
	const router = useRouter();
	const qc = useQueryClient();
	return (
		<Fallback
			title="Daten nicht verfügbar"
			error={error}
			onRetry={() => {
				void qc.invalidateQueries();
				reset();
				void router.invalidate();
			}}
		/>
	);
}

/** Für feste Teile des Rahmens (Seitenleiste, Chat). */
export class Boundary extends Component<{ name: string; children: ReactNode; compact?: boolean }, { error: unknown }> {
	state = { error: null as unknown };
	static getDerivedStateFromError(error: unknown) {
		return { error };
	}
	componentDidCatch(error: unknown, info: ErrorInfo) {
		console.warn(`desk: ${this.props.name} ausgefallen`, error, info.componentStack);
	}
	render() {
		if (this.state.error) return <Fallback compact={this.props.compact} title={`${this.props.name}: Daten nicht verfügbar`} error={this.state.error} onRetry={() => this.setState({ error: null })} />;
		return this.props.children;
	}
}
