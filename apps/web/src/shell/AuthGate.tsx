// Anmeldung vor dem Desk: beim ersten Start PIN festlegen (mit dem Einrichtungscode aus dem Serverfenster), danach
// mit der PIN anmelden. Die Sitzung (Token im localStorage, kein Cookie) hält dich 30 Tage angemeldet; läuft die Sitzung ab, kommt dieser Bildschirm wieder.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { AUTH_EVENT, getAuth, send, setSessionToken } from "@/lib/api";
import { Button, Field, Input } from "@/ui/kit";
import { de } from "@/i18n/de";

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
	if (isLoading) return <Screen><p className="text-[13px] text-fg-3">{de.auth.connecting}</p></Screen>;
	if (error || !data)
		return (
			<Screen>
				<p className="text-[13px] text-fg-2" role="alert">
					{de.api.unreachable}
				</p>
				<Button className="mt-4" onClick={() => void refetch()}>
					{de.auth.retry}
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
						<div className="font-semibold">{de.shell.product}</div>
						<div className="text-[12px] text-fg-3">{de.auth.tagline}</div>
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
			const r = await send<{ token?: string }>(url, "POST", body);
			setSessionToken(r.token ?? null);
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
					if (!PIN.test(pin)) return setErr(de.auth.pinLength);
					void go("/api/auth/login", { pin }).then(() => setPin(""));
				}}
			>
				<h1 className="text-[15px] font-semibold">{de.auth.login}</h1>
				<Field label={de.auth.pin} error={err} hint={" "}>
					{(id) => <Input id={id} ref={ref} type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} maxLength={12} aria-invalid={!!err} />}
				</Field>
				<Button type="submit" variant="primary" disabled={busy}>
					{de.auth.login}
				</Button>
				<p className="text-[11.5px] text-fg-3">{de.auth.forgot}</p>
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
					if (!code.trim()) return setErr(de.auth.codeMissing);
					if (!PIN.test(pin)) return setErr(de.auth.pinLength);
					if (pin !== again) return setErr(de.auth.pinMismatch);
					void go("/api/auth/setup", { code: code.trim(), pin });
				}}
			>
				<h1 className="text-[15px] font-semibold">{de.auth.setup}</h1>
				<p className="text-[12.5px] leading-relaxed text-fg-2">
					{de.auth.setupIntro}
				</p>
				<Field label={de.auth.code}>{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus spellCheck={false} />}</Field>
				<Field label={de.auth.newPin}>{(id) => <Input id={id} type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} maxLength={12} />}</Field>
				<Field label={de.auth.repeatPin} error={err} hint={" "}>
					{(id) => <Input id={id} type="password" inputMode="numeric" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ""))} maxLength={12} aria-invalid={!!err} />}
				</Field>
				<Button type="submit" variant="primary" disabled={busy}>
					{de.auth.setup}
				</Button>
			</form>
		</Screen>
	);
}
