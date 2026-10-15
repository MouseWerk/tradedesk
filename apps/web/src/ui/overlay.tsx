// Dialoge und Meldungen: Bestätigen (startet auf „Abbrechen“), Formular-Dialog, Meldungen mit „Rückgängig“.
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, cn } from "./kit";

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
	const confirm = useCallback((a: Ask) => new Promise<boolean>((resolve) => ((resolver.current = resolve), setAsk(a))), []);
	const close = (v: boolean) => {
		resolver.current(v);
		setAsk(null);
	};
	return (
		<ConfirmCtx.Provider value={confirm}>
			{children}
			<Dialog.Root open={!!ask} onOpenChange={(o) => !o && close(false)}>
				<Dialog.Portal>
					<Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)]" />
					<Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-32px)] w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 animate-enter overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-2xl">
						<Dialog.Title className="text-[15px] font-semibold">{ask?.title}</Dialog.Title>
						<Dialog.Description asChild>
							<div className="mt-2 text-[13px] leading-relaxed text-fg-2">{ask?.body}</div>
						</Dialog.Description>
						<div className="mt-5 flex justify-end gap-2">
							{/* Abbrechen hat den Fokus: Eingabe führt nichts Folgenreiches aus */}
							<Button variant="ghost" onClick={() => close(false)} autoFocus>
								Abbrechen
							</Button>
							<Button variant={ask?.danger ? "danger" : "primary"} onClick={() => close(true)}>
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

export function FormDialog({ open, onOpenChange, title, description, children, onSubmit, submit, busy, error, wide }: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	title: string;
	description?: ReactNode;
	children: ReactNode;
	onSubmit: () => void;
	submit: string;
	busy?: boolean;
	error?: string | null;
	wide?: boolean;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)]" />
				<Dialog.Content
					className={cn("fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 animate-enter flex-col rounded-xl border border-line bg-surface shadow-2xl", wide ? "w-[640px]" : "w-[480px]")}
				>
					<form
						className="flex min-h-0 flex-col"
						onSubmit={(e) => {
							e.preventDefault();
							onSubmit();
						}}
					>
						<div className="flex items-start gap-3 px-5 pt-5">
							<div className="min-w-0">
								<Dialog.Title className="text-[15px] font-semibold">{title}</Dialog.Title>
								{description && <Dialog.Description className="mt-1 text-[12.5px] text-fg-3">{description}</Dialog.Description>}
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
						<div className="flex justify-end gap-2 border-t border-line px-5 py-3">
							<Dialog.Close asChild>
								<Button variant="ghost">Abbrechen</Button>
							</Dialog.Close>
							<Button type="submit" variant="primary" disabled={busy}>
								{submit}
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/* ------------------------------------------------------------ Meldungen */

interface Toast {
	id: number;
	text: string;
	tone: "info" | "error";
	action?: { label: string; run: () => void };
}

const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
	const [items, setItems] = useState<Toast[]>([]);
	const next = useRef(1);
	const push = useCallback((t: Omit<Toast, "id">) => {
		const id = next.current++;
		setItems((xs) => [...xs.slice(-3), { ...t, id }]);
	}, []);
	return (
		<ToastCtx.Provider value={push}>
			{children}
			<div className="pointer-events-none fixed right-3 bottom-3 z-[60] flex w-[min(380px,calc(100vw-24px))] flex-col gap-2" aria-live="polite">
				{items.map((t) => (
					<ToastItem key={t.id} toast={t} onDone={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} />
				))}
			</div>
		</ToastCtx.Provider>
	);
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
	useEffect(() => {
		const t = setTimeout(onDone, toast.action ? 8000 : 5000);
		return () => clearTimeout(t);
	}, [toast, onDone]);
	return (
		<div className={cn("pointer-events-auto flex animate-enter items-start gap-3 rounded-xl border border-line px-3.5 py-2.5 text-[12.5px] shadow-2xl", toast.tone === "error" ? "bg-surface text-err" : "bg-surface text-fg")} role={toast.tone === "error" ? "alert" : "status"}>
			<span className="min-w-0 flex-1 leading-relaxed break-words">{toast.text}</span>
			{toast.action && (
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						toast.action!.run();
						onDone();
					}}
				>
					{toast.action.label}
				</Button>
			)}
			<button type="button" className="-mr-1 rounded p-0.5 text-fg-3 hover:text-fg" onClick={onDone} aria-label="Meldung schließen">
				<X className="size-3.5" />
			</button>
		</div>
	);
}
