// Bausteine im shadcn-Stil (Tokens aus styles.css). Gewinn/Verlust nie nur über Farbe: immer mit Vorzeichen.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { cva, type VariantProps } from "class-variance-authority";
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

const badge = cva("inline-flex items-center gap-1.5 whitespace-nowrap font-medium leading-none", {
	variants: {
		variant: {
			outline: "border border-line text-fg-2",
			soft: "bg-surface-3 text-fg-2",
			ok: "bg-ok/12 text-ok",
			warn: "bg-warn/14 text-warn",
			err: "bg-err/12 text-err",
		},
		size: { sm: "h-5 px-1.5 text-[11px] rounded-[5px]", md: "h-6 px-2 text-xs rounded-md" },
	},
	defaultVariants: { variant: "soft", size: "sm" },
});

export function Badge({ className, variant, size, ...p }: ComponentProps<"span"> & VariantProps<typeof badge>) {
	return <span className={cn(badge({ variant, size }), className)} {...p} />;
}

const button = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-50", {
	variants: {
		variant: {
			primary: "bg-primary text-primary-fg hover:opacity-90",
			outline: "border border-line bg-surface text-fg hover:bg-surface-2",
			ghost: "text-fg-2 hover:bg-surface-3 hover:text-fg",
			// eigene Fläche statt --err: im dunklen Design ist --err für Text aufgehellt, weiße Schrift darauf war 2,7:1
			danger: "bg-danger text-danger-fg hover:opacity-90",
		},
		size: { sm: "h-7 px-2.5 text-xs rounded-md", md: "h-8 px-3 text-[13px] rounded-lg", icon: "size-8 rounded-lg", iconSm: "size-7 rounded-md" },
	},
	defaultVariants: { variant: "outline", size: "md" },
});

export function Button({ className, variant, size, type = "button", ...p }: ComponentProps<"button"> & VariantProps<typeof button>) {
	return <button type={type} className={cn(button({ variant, size }), className)} {...p} />;
}

export function Card({ title, icon, aside, children, className, pad = true, label }: { title?: ReactNode; icon?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; pad?: boolean; label?: string }) {
	return (
		<section className={cn("min-w-0 rounded-xl border border-line bg-surface shadow-[var(--shadow)]", className)} aria-label={label ?? (typeof title === "string" ? title : undefined)}>
			{title && (
				<header className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-2">
					{icon && <span className="text-fg-3">{icon}</span>}
					<h2 className="font-medium">{title}</h2>
					<div className="ml-auto flex min-w-0 items-center gap-2 text-[12px] text-fg-3">{aside}</div>
				</header>
			)}
			<div className={cn(pad && "p-4")}>{children}</div>
		</section>
	);
}

export function Segmented<T extends string>({ items, value, onChange, className, label }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; className?: string; label: string }) {
	return (
		<div className={cn("scroll-thin flex h-8 max-w-full items-center overflow-x-auto rounded-lg border border-line bg-bg-2 p-0.5", className)} role="tablist" aria-label={label}>
			{items.map((it) => (
				<button
					key={it.id}
					type="button"
					role="tab"
					aria-selected={it.id === value}
					onClick={() => onChange(it.id)}
					className={cn("h-full shrink-0 rounded-md px-3 text-[12px] whitespace-nowrap", it.id === value ? "bg-surface font-medium text-fg shadow-[var(--shadow)]" : "text-fg-2 hover:text-fg")}
				>
					{it.label}
				</button>
			))}
		</div>
	);
}

export function Empty({ children, className, style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
	return (
		<div className={cn("px-4 py-6 text-center text-[12.5px] text-fg-3", className)} style={style}>
			{children}
		</div>
	);
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
	return <div className={cn("animate-pulse rounded-md bg-surface-3", className)} style={style} aria-hidden />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
	return <kbd className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line px-1 font-mono text-[10px] text-fg-3", className)}>{children}</kbd>;
}

/** Kennzahl: Wert groß, Beschriftung klein, optional Änderung darunter. */
export function Stat({ label, value, sub, className, testId }: { label: string; value: ReactNode; sub?: ReactNode; className?: string; testId?: string }) {
	return (
		<div className={cn("min-w-0 rounded-xl border border-line bg-surface px-4 py-3 shadow-[var(--shadow)]", className)} data-testid={testId}>
			<div className="truncate text-[12px] text-fg-3" title={label}>{label}</div>
			{/* Beträge nie abschneiden: in schmalen Ansichten kleiner statt mit Auslassungspunkten */}
			<div className="mt-1 text-[22px] leading-tight font-semibold whitespace-nowrap tnum @max-[700px]:text-[16px]">{value}</div>
			{sub && <div className="mt-1 text-[12px] leading-snug tnum">{sub}</div>}
		</div>
	);
}

const input = "h-8 w-full min-w-0 rounded-lg border border-line bg-bg-2 px-2.5 text-[13px] placeholder:text-fg-3 hover:border-line-strong";

export function Input({ className, ...p }: ComponentProps<"input">) {
	return <input className={cn(input, className)} {...p} />;
}

export function Select({ className, ...p }: ComponentProps<"select">) {
	return <select className={cn(input, "pr-7", className)} {...p} />;
}

export function Textarea({ className, ...p }: ComponentProps<"textarea">) {
	return <textarea className={cn(input, "h-auto min-h-24 py-2 leading-relaxed", className)} {...p} />;
}

export interface FieldAria {
	"aria-invalid"?: true;
	"aria-describedby"?: string;
}

/**
 * Beschriftetes Feld; das Kind bekommt ID und aria-Attribute über die Render-Funktion. Ein Fehler steht am Feld,
 * das Feld ist aria-invalid und nennt den Text als Beschreibung (der Dialog fokussiert das erste ungültige Feld).
 */
export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string, aria: FieldAria) => ReactNode; className?: string }) {
	const id = useId();
	const note = `${id}-note`;
	const aria: FieldAria = { ...(error ? { "aria-invalid": true as const } : {}), ...(error || hint ? { "aria-describedby": note } : {}) };
	return (
		<div className={cn("flex min-w-0 flex-col gap-1", className)}>
			<label htmlFor={id} className="text-[12px] font-medium text-fg-2">
				{label}
			</label>
			{children(id, aria)}
			{error ? (
				<p id={note} className="text-[11.5px] text-err">
					{error}
				</p>
			) : hint ? (
				<p id={note} className="text-[11.5px] text-fg-3">
					{hint}
				</p>
			) : null}
		</div>
	);
}

/**
 * Spalten, die in schmalen Tabellen zuerst weichen (Breite der Tabelle, nicht des Fensters): Beträge wie Wert, G/V
 * und Heute bleiben immer sichtbar, Nebenspalten (Einstand, Anteil, Gebühr, Quelle) gehen vorher.
 */
export const hideBelow = {
	sm: "@max-[560px]/table:hidden",
	md: "@max-[720px]/table:hidden",
	lg: "@max-[900px]/table:hidden",
	xl: "@max-[1040px]/table:hidden",
} as const;

/**
 * Tabelle mit horizontalem Scroll im eigenen Kasten – die Seite selbst scrollt nie seitlich. Die erste Spalte bleibt
 * beim Scrollen stehen, ein Verlauf am rechten Rand zeigt, dass es weitergeht.
 */
export function Table({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
	const box = useRef<HTMLDivElement>(null);
	const [more, setMore] = useState(false);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const update = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		if (el.firstElementChild) ro.observe(el.firstElementChild);
		el.addEventListener("scroll", update, { passive: true });
		return () => {
			ro.disconnect();
			el.removeEventListener("scroll", update);
		};
	}, []);
	return (
		// relative: sonst hängt sich ein sr-only-Kopf (position: absolute) an die Seite und erzeugt seitliches Scrollen
		<div className={cn("@container/table relative", more && "table-fade", className)} data-more={more || undefined}>
			<div ref={box} className="scroll-thin overflow-x-auto">
				<table className="[&_tbody_tr:last-child>td]:border-b-0 table-sticky w-full border-collapse text-[12.5px]" aria-label={label}>
					{children}
				</table>
			</div>
		</div>
	);
}

// in schmalen Tabellen (Telefon) weniger Innenabstand, damit die Betragsspalten Platz haben
const narrow = "@max-[560px]/table:px-2 @max-[560px]/table:first:pl-3 @max-[560px]/table:last:pr-3";
export const th = `h-9 border-b border-line px-3 text-left text-[11.5px] font-medium whitespace-nowrap text-fg-3 first:pl-4 last:pr-4 ${narrow}`;
export const td = `h-10 border-b border-line px-3 whitespace-nowrap first:pl-4 last:pr-4 ${narrow}`;
