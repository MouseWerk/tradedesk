// Dialoge und Meldungen: Bestätigen (startet auf „Abbrechen“), Formular-Dialog, Meldungen mit „Rückgängig“.
// Nach dem Schließen geht der Fokus zurück auf den Knopf, der den Dialog geöffnet hat (design/principles.md).
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, cn } from "./kit";
import { pushToast, type Toast } from "./toasts";

/* ------------------------------------------------------------ Fokus zurückgeben */

/**
 * Fokus auf den Auslöser zurück. Ohne Dialog.Trigger fokussiert Radix nichts Sinnvolles (der Fokus landete auf body);
 * ist der Auslöser weg oder gesperrt (Vorschlag schon entschieden), geht er an den Inhaltsbereich statt ins Leere.
 */
export function restoreFocus(el: Element | null) {
	const ok = el instanceof HTMLElement && el.isConnected && !(el as HTMLButtonElement).disabled && el !== document.body;
	(ok ? el : document.getElementById("main"))?.focus({ preventScroll: true });
}

/** Merkt sich beim Öffnen das fokussierte Element – noch im Rendern, bevor autoFocus im Dialog den Fokus nimmt. */
export function useOpener(open: boolean) {
	const opener = useRef<Element | null>(null);
	const was = useRef(false);
	if (open && !was.current) opener.current = document.activeElement;
	was.current = open;
	return opener;
}

/** Am Telefon: Knöpfe im Dialog 44 px hoch und je halbe Breite – mit dem Daumen erreichbar. */
const THUMB = "max-sm:h-11 max-sm:flex-1";

/* ------------------------------------------------------------ Bestätigen */

interface Ask {
	title: string;
	body?: ReactNode;
	confirm?: string;
	danger?: boolean;
}

const ConfirmCtx = createContext<(a: Ask) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
	const [ask, setAsk] = useState<Ask | null>(null);
	const resolver = useRef<(v: boolean) => void>(() => undefined);
	const opener = useRef<Element | null>(null);
	const confirm = useCallback(
		(a: Ask) =>
			new Promise<boolean>((resolve) => {
				opener.current = document.activeElement;
				resolver.current = resolve;
				setAsk(a);
			}),
		[],
	);
	const close = (v: boolean) => {
		resolver.current(v);
		setAsk(null);
	};
	return (
		<ConfirmCtx.Provider value={confirm}>
			{children}
			<Dialog.Root open={!!ask} onOpenChange={(o) => !o && close(false)}>
				<Dialog.Portal>
					<Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[3px]" />
					<Dialog.Content
						className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-32px)] w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 animate-enter overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-2xl"
						data-testid="confirm"
						onCloseAutoFocus={(e) => {
							e.preventDefault();
							restoreFocus(opener.current);
						}}
					>
						<Dialog.Title className="text-[15px] font-semibold">{ask?.title}</Dialog.Title>
						<Dialog.Description asChild>
							<div className="mt-2 text-[13px] leading-relaxed text-fg-2">{ask?.body}</div>
						</Dialog.Description>
						<div className="mt-5 flex flex-wrap justify-end gap-2">
							{/* Abbrechen hat den Fokus: Eingabe führt nichts Folgenreiches aus */}
							<Button variant="ghost" onClick={() => close(false)} autoFocus className={THUMB}>
								Abbrechen
							</Button>
							<Button variant={ask?.danger ? "danger" : "primary"} onClick={() => close(true)} className={THUMB}>
								{ask?.confirm ?? "Ausführen"}
							</Button>
						</div>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>
		</ConfirmCtx.Provider>
	);
}

/* ------------------------------------------------------------ Formular-Dialog */

export function FormDialog({ open, onOpenChange, title, description, children, onSubmit, submit, submitVariant = "primary", busy, error, wide }: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	title: string;
	description?: ReactNode;
	children: ReactNode;
	onSubmit: () => void;
	submit: string;
	/** danger: der Klick bewegt echtes Geld */
	submitVariant?: "primary" | "danger";
	busy?: boolean;
	error?: string | null;
	wide?: boolean;
}) {
	const opener = useOpener(open);
	const content = useRef<HTMLDivElement>(null);
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)]" />
				<Dialog.Content
					ref={content}
					className={cn("fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 animate-enter flex-col rounded-xl border border-line bg-surface shadow-2xl", wide ? "w-[640px]" : "w-[480px]")}
					onCloseAutoFocus={(e) => {
						e.preventDefault();
						restoreFocus(opener.current);
					}}
				>
					<form
						className="flex min-h-0 flex-col"
						noValidate
						onSubmit={(e) => {
							e.preventDefault();
							onSubmit();
							// Fehler am Feld: Fokus auf das erste markierte Feld, damit du direkt korrigieren kannst
							requestAnimationFrame(() => content.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
						}}
					>
						<div className="flex items-start gap-3 px-5 pt-5">
							<div className="min-w-0">
								<Dialog.Title className="text-[15px] font-semibold">{title}</Dialog.Title>
								{description ? <Dialog.Description className="mt-1 text-[12.5px] text-fg-3">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
							</div>
							<Dialog.Close asChild>
								<Button variant="ghost" size="iconSm" className="-mt-1 ml-auto" aria-label="Schließen">
									<X className="size-4" />
								</Button>
							</Dialog.Close>
						</div>
						<div className="scroll-thin flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4">{children}</div>
						{error && (
							<p className="mx-5 mb-1 rounded-lg bg-err/10 px-3 py-2 text-[12.5px] text-err" role="alert">
								{error}
							</p>
						)}
						<div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
							<Dialog.Close asChild>
								<Button variant="ghost" className={THUMB}>
									Abbrechen
								</Button>
							</Dialog.Close>
							<Button type="submit" variant={submitVariant} disabled={busy} className={THUMB}>
								{submit}
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/**
 * Fehler eines Formular-Dialogs: am Feld (Schlüssel) oder allgemein (null). Beim Öffnen leer, damit eine alte Meldung
 * nicht beim nächsten Öffnen wieder dasteht.
 */
export function useFormErrors(open: boolean) {
	const [err, setErr] = useState<{ field: string | null; text: string } | null>(null);
	useEffect(() => {
		if (open) setErr(null);
	}, [open]);
	return {
		/** gibt undefined zurück, damit „return fail(…)“ in einer Prüfung passt */
		fail: (field: string | null, text: string): undefined => void setErr({ field, text }),
		clear: () => setErr(null),
		at: (key: string) => (err?.field === key ? err.text : null),
		general: err && err.field === null ? err.text : null,
	};
}

/* ------------------------------------------------------------ Meldungen */

const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
	const [items, setItems] = useState<Toast[]>([]);
	const next = useRef(1);
	const push = useCallback((t: Omit<Toast, "id">) => {
		const id = next.current++;
		setItems((xs) => pushToast(xs, { ...t, id }));
	}, []);
	const done = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
	return (
		<ToastCtx.Provider value={push}>
			{children}
			<div className="pointer-events-none fixed right-3 bottom-3 z-[60] flex max-sm:bottom-[calc(76px+env(safe-area-inset-bottom))] w-[min(380px,calc(100vw-24px))] flex-col gap-2" aria-live="polite">
				{items.map((t) => (
					<ToastItem key={t.id} toast={t} onDone={done} />
				))}
			</div>
		</ToastCtx.Provider>
	);
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: (id: number) => void }) {
	// eigene Uhr je Meldung: eine neue Meldung startet die Zeit der anderen nicht neu
	useEffect(() => {
		const t = setTimeout(() => onDone(toast.id), toast.action ? 8000 : 5000);
		return () => clearTimeout(t);
	}, [toast.id, toast.action, onDone]);
	return (
		<div className={cn("pointer-events-auto flex animate-enter items-start gap-3 rounded-xl border border-line px-3.5 py-2.5 text-[12.5px] shadow-2xl", toast.tone === "error" ? "bg-surface text-err" : "bg-surface text-fg")} role={toast.tone === "error" ? "alert" : "status"}>
			<span className="min-w-0 flex-1 leading-relaxed break-words">{toast.text}</span>
			{toast.action && (
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						toast.action!.run();
						onDone(toast.id);
					}}
				>
					{toast.action.label}
				</Button>
			)}
			<button type="button" className="-mr-1 rounded p-0.5 text-fg-3 hover:text-fg" onClick={() => onDone(toast.id)} aria-label="Meldung schließen">
				<X className="size-3.5" />
			</button>
		</div>
	);
}
