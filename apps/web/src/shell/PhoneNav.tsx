// Telefon (unter 640 px): Leiste unten mit den fünf wichtigsten Modulen und „Mehr“ – 56 px hoch, Abstand zum
// Home-Balken (safe-area), Zustand nur über neutrale Tönung und Schriftgewicht. „Mehr“ öffnet ein Blatt von unten mit
// den übrigen Modulen und den Aktionen der Kopfzeile (Suche, Chat, Design, Benachrichtigungen, Abmelden).
import * as Dialog from "@radix-ui/react-dialog";
import { Link, useRouterState } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";
import { Bell, BellOff, Ellipsis, LogOut, MessageSquare, Moon, Search, Sun, X } from "lucide-react";
import { de } from "@/i18n/de";
import { MODULES, moduleForPath } from "@/modules/registry";
import { useOverview } from "@/lib/api";
import { quoteFeedNote } from "@/lib/format";
import { Button, cn } from "@/ui/kit";
import { restoreFocus, useOpener } from "@/ui/overlay";

export interface PhoneMenu {
	palette: () => void;
	chat: () => void;
	theme: () => void;
	logout: () => void;
	dark: boolean;
	notify?: { on: boolean; toggle: () => void };
	status: ReactNode;
}

export function PhoneNav({ menu }: { menu: PhoneMenu }) {
	const path = useRouterState({ select: (s) => s.location.pathname });
	const active = moduleForPath(path);
	const { data } = useOverview();
	const [more, setMore] = useState(false);
	const opener = useOpener(more);
	const pending = useRef<(() => void) | null>(null); // Aktion aus dem Blatt: erst schließen, Fokus zurück, dann ausführen
	const main = MODULES.filter((m) => m.phone);
	const rest = MODULES.filter((m) => !m.phone);
	const inRest = !!active && !active.phone;
	const item = "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[10.5px] leading-tight";
	const then = (run: () => void) => {
		pending.current = run;
		setMore(false);
	};
	return (
		<nav className="flex shrink-0 gap-1 px-[max(4px,env(safe-area-inset-left))] pt-1 pb-[max(4px,env(safe-area-inset-bottom))]" aria-label={de.shell.modules} data-testid="phone-nav">
			{main.map((m) => {
				const on = m.id === active?.id;
				return (
					<Link key={m.id} to={m.path} className={cn(item, "h-14 text-fg-2", on ? "bg-surface-3 font-semibold text-fg" : "active:bg-surface-2")} aria-current={on ? "page" : undefined} data-testid="phone-tab">
						<span className="relative">
							<m.icon className={cn("size-5", on ? "text-fg" : "text-fg-3")} strokeWidth={1.75} aria-hidden />
							{m.id === "orders" && !!data?.pending && (
								<span className="absolute -top-1.5 -right-2.5 grid h-4 min-w-4 place-items-center rounded-full bg-warn px-1 text-[10px] font-semibold text-primary-fg tnum" aria-hidden>
									{data.pending}
								</span>
							)}
						</span>
						<span className="max-w-full truncate">{m.title}</span>
						{m.id === "orders" && !!data?.pending && <span className="sr-only">{de.phone.waiting(data.pending)}</span>}
					</Link>
				);
			})}
			<Dialog.Root open={more} onOpenChange={setMore}>
				<Dialog.Trigger asChild>
					<button type="button" className={cn(item, "h-14 text-fg-2", inRest || more ? "bg-surface-3 font-semibold text-fg" : "active:bg-surface-2")} aria-current={inRest ? "page" : undefined} data-testid="phone-more">
						<Ellipsis className={cn("size-5", inRest ? "text-fg" : "text-fg-3")} strokeWidth={1.75} aria-hidden />
						<span>{inRest ? active!.title : de.phone.more}</span>
					</button>
				</Dialog.Trigger>
				<Dialog.Portal>
					<Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--overlay)]" />
					<Dialog.Content
						className="fixed inset-x-0 bottom-0 z-40 flex max-h-[85dvh] animate-enter flex-col rounded-t-2xl border-t border-line bg-surface pb-[max(8px,env(safe-area-inset-bottom))] shadow-2xl outline-none"
						aria-describedby={undefined}
						data-testid="phone-sheet"
						onCloseAutoFocus={(e) => {
							e.preventDefault();
							restoreFocus(opener.current);
							const run = pending.current;
							pending.current = null;
							run?.();
						}}
					>
						<div className="flex h-14 items-center px-4">
							<Dialog.Title className="text-[15px] font-semibold">{de.phone.more}</Dialog.Title>
							<Dialog.Close asChild>
								<Button variant="ghost" size="icon" className="ml-auto size-11" aria-label={de.common.close}>
									<X className="size-5" />
								</Button>
							</Dialog.Close>
						</div>
						<div className="scroll-thin flex flex-col gap-1 overflow-y-auto px-2 pb-2">
							{rest.map((m) => (
								<Link key={m.id} to={m.path} onClick={() => setMore(false)} className={cn("flex h-12 items-center gap-3 rounded-lg px-3 text-[14px]", m.id === active?.id ? "bg-surface-3 font-semibold" : "active:bg-surface-2")} aria-current={m.id === active?.id ? "page" : undefined}>
									<m.icon className="size-5 text-fg-3" strokeWidth={1.75} aria-hidden />
									{m.title}
								</Link>
							))}
							<div className="my-1 border-t border-line" />
							<SheetButton icon={<Search className="size-5" />} onClick={() => then(menu.palette)}>
								{de.shell.searchCommands}
							</SheetButton>
							<SheetButton icon={<MessageSquare className="size-5" />} onClick={() => then(menu.chat)}>
								{de.shell.chat}
							</SheetButton>
							<SheetButton icon={menu.dark ? <Sun className="size-5" /> : <Moon className="size-5" />} onClick={() => then(menu.theme)}>
								{menu.dark ? de.shell.lightTheme : de.shell.darkTheme}
							</SheetButton>
							{menu.notify && (
								<SheetButton icon={menu.notify.on ? <Bell className="size-5" /> : <BellOff className="size-5" />} onClick={() => then(menu.notify!.toggle)} pressed={menu.notify.on}>
									{menu.notify.on ? de.shell.notifyOff : de.shell.notifyOn}
								</SheetButton>
							)}
							<SheetButton icon={<LogOut className="size-5" />} onClick={() => then(menu.logout)}>
								{de.shell.logout}
							</SheetButton>
							<div className="mt-2 px-3 text-[12px] text-fg-3">{menu.status}</div>
							<p className="px-3 pt-1 text-[11.5px] leading-snug text-fg-3">{quoteFeedNote(data?.quoteFeed)}</p>
						</div>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>
		</nav>
	);
}

function SheetButton({ icon, children, onClick, pressed }: { icon: ReactNode; children: ReactNode; onClick: () => void; pressed?: boolean }) {
	return (
		<button type="button" onClick={onClick} aria-pressed={pressed} className="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-[14px] text-fg active:bg-surface-2">
			<span className="text-fg-3" aria-hidden>
				{icon}
			</span>
			{children}
		</button>
	);
}
