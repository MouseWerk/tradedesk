// Anmeldung vor dem Desk: beim ersten Start PIN festlegen (mit dem Einrichtungscode aus dem Serverfenster), danach
// mit der PIN anmelden. Das Cookie hält dich 30 Tage angemeldet; läuft die Sitzung ab, kommt dieser Bildschirm wieder.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { AUTH_EVENT, getAuth, send } from "@/lib/api";
import { Button, Field, Input } from "@/ui/kit";

const PIN = /^\d{4,12}$/;

export function AuthGate({ children }: { children: ReactNode }) {
	const qc = useQueryClient();
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["auth"], queryFn: getAuth, staleTime: Number.POSITIVE_INFINITY, retry: 1 });
	// eine Anfrage meldet „nicht angemeldet“ (Sitzung abgelaufen, abgemeldet): Status neu holen, Daten verwerfen
	useEffect(() => {
		const on = () => void refetch();
		window.addEventListener(AUTH_EVENT, on);
		return () => window.removeEventListener(AUTH_EVENT, on);
	}, [refetch]);
	if (isLoading) return <Screen><p className="text-[13px] text-fg-3">Verbinde mit dem Desk…</p></Screen>;
	if (error || !data)
		return (
			<Screen>
				<p className="text-[13px] text-fg-2" role="alert">
					Desk nicht erreichbar – läuft der Server noch?
				</p>
				<Button className="mt-4" onClick={() => void refetch()}>
					Erneut versuchen
				</Button>
			</Screen>
		);
	if (data.authenticated) return <>{children}</>;
	const done = () => {
		qc.clear(); // nichts aus einer früheren Sitzung anzeigen
		void refetch();
	};
	return data.pinSet ? <Login onDone={done} /> : <Setup onDone={done} />;
}

function Screen({ children }: { children: ReactNode }) {
	return (
		<main className="grid min-h-screen place-items-center bg-bg px-4 text-fg">
			<div className="w-full max-w-[380px] rounded-xl border border-line bg-surface p-6 shadow-[var(--shadow)]">
				<div className="mb-5 flex items-center gap-2.5">
					<span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-fg" aria-hidden>
						<KeyRound className="size-4" />
					</span>
					<div className="leading-tight">
						<div className="font-semibold">Tradedesk</div>
						<div className="text-[12px] text-fg-3">Freigaben nur mit deiner PIN</div>
					</div>
				</div>
				{children}
			</div>
		</main>
	);
}

function useSubmit(onDone: () => void) {
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const go = async (url: string, body: unknown) => {
		setBusy(true);
		setErr(null);
		try {
			await send(url, "POST", body);
			onDone();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return { err, setErr, busy, go };
}

function Login({ onDone }: { onDone: () => void }) {
	const [pin, setPin] = useState("");
	const { err, setErr, busy, go } = useSubmit(onDone);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => ref.current?.focus(), [err]);
	return (
		<Screen>
			<form
				className="flex flex-col gap-4"
				onSubmit={(e) => {
					e.preventDefault();
					if (!PIN.test(pin)) return setErr("Die PIN hat 4 bis 12 Ziffern.");
					void go("/api/auth/login", { pin }).then(() => setPin(""));
				}}
			>
				<h1 className="text-[15px] font-semibold">Anmelden</h1>
				<Field label="PIN" error={err}>
					{(id) => <Input id={id} ref={ref} type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} maxLength={12} aria-invalid={!!err} />}
				</Field>
				<Button type="submit" variant="primary" disabled={busy}>
					Anmelden
				</Button>
				<p className="text-[11.5px] text-fg-3">PIN vergessen? Desk mit „--reset-pin“ starten und neu festlegen.</p>
			</form>
		</Screen>
	);
}

function Setup({ onDone }: { onDone: () => void }) {
	const [code, setCode] = useState("");
	const [pin, setPin] = useState("");
	const [again, setAgain] = useState("");
	const { err, setErr, busy, go } = useSubmit(onDone);
	return (
		<Screen>
			<form
				className="flex flex-col gap-4"
				onSubmit={(e) => {
					e.preventDefault();
					if (!code.trim()) return setErr("Einrichtungscode aus dem Serverfenster eintragen.");
					if (!PIN.test(pin)) return setErr("Die PIN hat 4 bis 12 Ziffern.");
					if (pin !== again) return setErr("Die beiden PINs sind verschieden.");
					void go("/api/auth/setup", { code: code.trim(), pin });
				}}
			>
				<h1 className="text-[15px] font-semibold">PIN festlegen</h1>
				<p className="text-[12.5px] leading-relaxed text-fg-2">
					Mit der PIN gibst du Orders frei. Den Einrichtungscode zeigt nur das Fenster, in dem der Desk läuft (Zeile „PIN festlegen: Einrichtungscode“) – so kann kein Agent die PIN vor dir setzen.
				</p>
				<Field label="Einrichtungscode">{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus spellCheck={false} />}</Field>
				<Field label="Neue PIN (4–12 Ziffern)">{(id) => <Input id={id} type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} maxLength={12} />}</Field>
				<Field label="PIN wiederholen" error={err}>
					{(id) => <Input id={id} type="password" inputMode="numeric" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ""))} maxLength={12} aria-invalid={!!err} />}
				</Field>
				<Button type="submit" variant="primary" disabled={busy}>
					PIN festlegen
				</Button>
			</form>
		</Screen>
	);
}
