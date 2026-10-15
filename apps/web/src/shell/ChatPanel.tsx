// Chat: du, die Agenten und der Desk in einem Raum. Agenten schreiben über cli/desk.py say, der Desk meldet Ergebnisse
// ihrer Vorschläge. Texte sind Daten: nur als Text gerendert, nie als HTML. Eine Nachricht genehmigt nie eine Order.
import { Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Bot, Send, X } from "lucide-react";
import type { ChatMessage } from "@desk/shared";
import { useAgents, useChat, useOverview } from "@/lib/api";
import { Button, Segmented, cn } from "@/ui/kit";
import { useAction } from "@/modules/common";

const time = (ms: number) => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

/** @Namen hervorheben, #12 und Symbole verlinken – alles als React-Text, kein HTML. */
function Rich({ text, names }: { text: string; names: string[] }) {
	const parts: ReactNode[] = [];
	const re = /(@[\p{L}\p{N}_.-]{1,40})|(#\d{1,6})/gu;
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (m.index > last) parts.push(text.slice(last, m.index));
		if (m[1]) {
			const known = names.some((n) => n.toLowerCase() === m[1].slice(1).toLowerCase());
			parts.push(
				<span key={m.index} className={known ? "font-semibold" : undefined}>
					{m[1]}
				</span>,
			);
		} else
			parts.push(
				<Link key={m.index} to="/orders" className="font-medium underline underline-offset-2">
					{m[2]}
				</Link>,
			);
		last = m.index + m[0].length;
	}
	if (last < text.length) parts.push(text.slice(last));
	return <>{parts}</>;
}

export function ChatPanel({ className, onClose, onSeen }: { className?: string; onClose?: () => void; onSeen?: (id: number) => void }) {
	const { data: messages } = useChat();
	const { data: ov } = useOverview();
	const { data: agents } = useAgents();
	const user = ov?.user ?? "";
	const names = [user, ...(agents?.agents.map((a) => a.name) ?? [])].filter(Boolean);
	const [filter, setFilter] = useState<"all" | "mine" | "agents">("all");
	const [text, setText] = useState("");
	const { run, busy } = useAction();
	const list = useRef<HTMLOListElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const shown = (messages ?? []).filter((m) => (filter === "mine" ? m.to.includes(user) || m.author === user : filter === "agents" ? m.role === "agent" : true));
	const lastId = messages?.at(-1)?.id ?? 0;

	useLayoutEffect(() => {
		const el = list.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [shown.length, filter]);
	useEffect(() => {
		if (lastId) onSeen?.(lastId);
	}, [lastId, onSeen]);

	const send = async () => {
		const t = text.trim();
		if (!t) return;
		if (await run("/api/chat", "POST", { text: t })) setText("");
		input.current?.focus();
	};
	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void send();
		}
	};
	const mention = (n: string) => {
		setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${n} `);
		input.current?.focus();
	};

	return (
		<aside className={cn("flex w-[360px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow)]", className)} aria-label="Chat" data-testid="chat">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
				<h2 className="font-medium">Chat</h2>
				<span className="text-[12px] text-fg-3">{names.length ? `${names.length} im Raum` : ""}</span>
				{onClose && (
					<Button variant="ghost" size="iconSm" className="ml-auto" onClick={onClose} aria-label="Chat schließen">
						<X className="size-4" />
					</Button>
				)}
			</header>
			<div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
				<Segmented label="Nachrichten filtern" items={[{ id: "all", label: "Alle" }, { id: "mine", label: "An mich" }, { id: "agents", label: "Agenten" }]} value={filter} onChange={setFilter} />
			</div>
			<ol ref={list} className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3" aria-live="polite" aria-label="Nachrichten">
				{shown.length === 0 && <li className="px-2 py-6 text-center text-[12.5px] text-fg-3">Noch keine Nachrichten. Agenten schreiben mit „python cli/desk.py say“.</li>}
				{shown.map((m) => (
					<Message key={m.id} m={m} mine={m.author === user} names={names} />
				))}
			</ol>
			<div className="shrink-0 border-t border-line p-3">
				<div className="mb-2 flex flex-wrap gap-1">
					{names
						.filter((n) => n !== user)
						.map((n) => (
							<button key={n} type="button" onClick={() => mention(n)} className="inline-flex h-6 items-center rounded-md bg-surface-3 px-2 text-[11.5px] text-fg-2 hover:text-fg">
								@{n}
							</button>
						))}
				</div>
				<div className="flex items-end gap-2">
					<textarea
						ref={input}
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={onKey}
						rows={2}
						maxLength={4000}
						placeholder="Nachricht an alle oder @Agent…"
						aria-label="Nachricht"
						className="scroll-thin min-h-10 flex-1 resize-none rounded-lg border border-line bg-bg-2 px-2.5 py-2 text-[13px] leading-snug placeholder:text-fg-3 hover:border-line-strong"
					/>
					<Button variant="primary" size="icon" onClick={() => void send()} disabled={busy || !text.trim()} aria-label="Senden (Eingabe)" title="Senden (Eingabe, Umschalt+Eingabe für neue Zeile)">
						<Send className="size-4" />
					</Button>
				</div>
				<p className="mt-1.5 text-[11px] text-fg-3">Freigaben nur über die Schaltflächen bei den Vorschlägen – nie per Chat.</p>
			</div>
		</aside>
	);
}

function Message({ m, mine, names }: { m: ChatMessage; mine: boolean; names: string[] }) {
	if (m.role === "desk")
		return (
			<li className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-fg-2" data-role="desk">
				<span className="mr-2 text-fg-3 tnum">{time(m.time)}</span>
				<Rich text={m.text} names={names} />
			</li>
		);
	return (
		<li className={cn("flex max-w-[92%] flex-col gap-1", mine ? "self-end items-end" : "self-start")} data-role={m.role}>
			<div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
				{m.role === "agent" && <Bot className="size-3" aria-hidden />}
				<span className="font-medium text-fg-2">{m.author}</span>
				<span className="tnum">{time(m.time)}</span>
				{m.ref && !m.ref.startsWith("#") && (
					<Link to="/trade" search={{ symbol: m.ref }} className="rounded bg-surface-3 px-1 text-[10.5px] text-fg-2 hover:text-fg">
						{m.ref}
					</Link>
				)}
			</div>
			<p className={cn("rounded-xl px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words", mine ? "bg-primary text-primary-fg" : "bg-surface-3 text-fg")}>
				<Rich text={m.text} names={names} />
			</p>
		</li>
	);
}
