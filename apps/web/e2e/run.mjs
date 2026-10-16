// Playwright headless gegen den Fixture-Server (Fake-Börse, Wegwerf-Daten, kein Netz):
// jedes Modul in Dark/Light und mehreren Breiten ohne seitliches Scrollen und ohne Konsolenfehler, Freigabe-Ablauf,
// Not-Aus, Fokusring neutral, Bestätigung startet auf „Abbrechen“. Dazu die Funde aus Qualitätsrunde q1
// (docs/quality/q1): Broker-Orders nie per Eingabetaste, Cockpit-Anordnung mit Chat, Fokus nach Dialogen, Chat als
// modaler Dialog, langsame und fehlerhafte Server-Antworten (per page.route), Wiederverbinden des Streams.
// Screenshots nach build/preview/.
// Nutzung: npm run build && npm run e2e
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const out = path.join(repo, "build", "preview");
mkdirSync(out, { recursive: true });
const PORT = 8000 + Math.floor(Math.random() * 900) + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const ROUTES = ["/", "/trade?symbol=NVDA", "/portfolio?account=tr", "/portfolio?account=ibkr", "/market?symbol=SAP.DE", "/orders", "/agents", "/risk"];
const WIDTHS = [390, 800, 1280, 1920];

function startServer() {
	return new Promise((resolve, reject) => {
		const p = spawn(process.execPath, [path.join(repo, "apps/server/src/index.ts"), "--fixture", "--port", String(PORT)], { cwd: repo, windowsHide: true });
		let log = "";
		const t = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 60_000);
		p.stdout.on("data", (d) => {
			log += d;
			if (log.includes("Tradedesk on")) {
				clearTimeout(t);
				resolve(p);
			}
		});
		p.stderr.on("data", (d) => (log += d));
		p.on("exit", (c) => reject(new Error(`server exited ${c}:\n${log}`)));
	});
}

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  – ${detail}`}`);
};

async function open(browser, { w = 1440, h = 900, theme = "dark", chat } = {}) {
	const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce", locale: "de-DE", timezoneId: "Europe/Berlin" });
	await ctx.addInitScript(
		([t, c]) => {
			try {
				localStorage.setItem("desk.theme", t);
				if (c !== null) localStorage.setItem("desk.chat", c ? "1" : "0");
			} catch {}
		},
		[theme, chat ?? null],
	);
	const pg = await ctx.newPage();
	pg.errors = [];
	pg.on("pageerror", (e) => pg.errors.push(e.message));
	pg.on("console", (m) => (m.type() === "error" || m.type() === "warning") && !/EventSource|net::ERR_ABORTED/.test(m.text()) && pg.errors.push(m.text()));
	return pg;
}

async function settle(pg) {
	await pg.waitForSelector("#main h1", { timeout: 20_000 });
	await pg.waitForFunction(() => !document.querySelector(".animate-pulse"), null, { timeout: 15_000 }).catch(() => undefined);
	await pg.evaluate(() => document.fonts.ready);
}

/** Wartet auf eine Bedingung im Browser; false statt Ausnahme, damit der Check die Meldung schreibt. */
const until = (pg, fn, arg, timeout = 8_000) =>
	pg
		.waitForFunction(fn, arg, { timeout })
		.then(() => true)
		.catch(() => false);
/** Änderung wie aus dem Browser (Origin wie die App) – zum Aufräumen nach einem Test. */
const owner = (p, method, body) => fetch(BASE + p, { method, headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const agentSays = (text) => fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: "Nova", text }) });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
/** Antwort verzögern (langsamer Server) – nur die Antwort, der Test selbst wartet auf Bedingungen. */
const slow = (pg, match, ms) => pg.route(match, async (route) => (await delay(ms), route.continue().catch(() => undefined)));
const rect = (loc) => loc.evaluate((e) => (({ top, bottom, left, right, height }) => ({ top, bottom, left, right, height }))(e.getBoundingClientRect()));

/** Layout des Cockpits und der Tabellen (D2, D3, D12): Rechner neben dem Chart, Beträge sichtbar, Zeilen gleich hoch. */
async function layoutChecks(browser) {
	for (const [w, h] of [
		[1280, 860],
		[1440, 900],
		[1600, 900],
	]) {
		for (const chat of [true, false]) {
			const pg = await open(browser, { w, h, chat });
			await pg.goto(`${BASE}/trade?symbol=SAP.DE`);
			await settle(pg);
			const chart = await rect(pg.locator('section[aria-label^="Chart"]'));
			const calc = await rect(pg.getByRole("region", { name: "Order-Rechner" }));
			const submit = await rect(pg.getByTestId("calc-submit"));
			check(`${w}px chat ${chat ? "open" : "closed"}: order calculator next to the chart, its button in the first screen`, calc.left >= chart.right - 1 && submit.bottom <= h && calc.top < chart.top + 40, JSON.stringify({ chart, calc, submit }));
			await pg.screenshot({ path: path.join(out, `cockpit-${w}-${chat ? "chat" : "nochat"}.png`) });
			const heights = await pg.getByTestId("scan-row").evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().height)))]);
			check(`${w}px chat ${chat ? "open" : "closed"}: scanner rows have one height (no wrapped prices)`, heights.length === 1, heights.join(","));
			await pg.context().close();
		}
	}
	// Beträge in Tabellen sichtbar, ohne seitlich zu scrollen (D3)
	for (const [w, chat] of [
		[390, false],
		[1280, true],
	]) {
		const pg = await open(browser, { w, h: w < 500 ? 844 : 860, chat });
		for (const [route, card, col] of [
			["/", "Depots", "Heute"],
			["/trade?symbol=SAP.DE", "Positionen", "G/V"],
			["/portfolio?account=tr", "Positionen", "G/V"],
			["/portfolio?account=tr", "Positionen", "Wert"],
		]) {
			await pg.goto(BASE + route);
			await settle(pg);
			const box = pg.getByRole("region", { name: card, exact: true }).first();
			const inside = await box.evaluate((el, name) => {
				const c = el.getBoundingClientRect();
				const th = [...el.querySelectorAll("th")].find((x) => x.textContent.trim().startsWith(name));
				if (!th) return { missing: true };
				const r = th.getBoundingClientRect();
				return { visible: r.width > 0 && getComputedStyle(th).display !== "none", inside: r.left >= c.left - 1 && r.right <= c.right + 1, r: [r.left, r.right], c: [c.left, c.right] };
			}, col);
			check(`${w}px ${route}: column ${col} visible inside the card`, inside.visible && inside.inside, JSON.stringify(inside));
		}
		await pg.context().close();
	}
	// Skelett mit langsamem Server: keine seitliche Verschiebung (D14)
	const pg = await open(browser, { w: 390, h: 844 });
	await slow(pg, (u) => u.pathname.startsWith("/api/") && u.pathname !== "/api/stream", 1_500);
	await pg.goto(`${BASE}/trade?symbol=NVDA`);
	await pg.waitForSelector(".animate-pulse", { timeout: 5_000 });
	const sw = await pg.evaluate(() => document.getElementById("main").scrollWidth - document.getElementById("main").clientWidth);
	check("390px: the Trading skeleton fits the width while loading", sw <= 0, `${sw}px`);
	const pend = await pg.getByTestId("pending-link").innerText();
	check("phone header shows a dash while the count is unknown, not 0", pend.includes("–") && !/\b0\b/.test(pend), pend);
	await pg.context().close();
}

/** Tastatur und Dialoge: Fokus zurück, Chat-Schublade modal, Sprunglink, Felder 13 px (D5, D6, D8, D23, D19). */
async function keyboardChecks(browser) {
	let pg = await open(browser);
	await pg.goto(`${BASE}/orders`);
	await settle(pg);
	await pg.keyboard.press("Tab");
	const skip = await pg.evaluate(() => document.activeElement?.textContent?.trim());
	await pg.keyboard.press("Enter");
	const onMain = await pg.evaluate(() => document.activeElement?.id);
	check("first Tab reaches the skip link, Enter jumps to the content", skip === "Zum Inhalt" && onMain === "main", `${skip} → ${onMain}`);
	const names = await pg.locator('[data-testid="proposal"]').evaluateAll((cards) =>
		cards.flatMap((c) => {
			const sym = c.getAttribute("aria-label").split(" von ")[0].split(" ").at(-1);
			return [...c.querySelectorAll("footer button")].map((b) => ({ sym, name: b.getAttribute("aria-label") ?? b.textContent.trim() }));
		}),
	);
	check("every proposal button names what it acts on", names.length > 0 && names.every((n) => n.name.includes(n.sym)), JSON.stringify(names.filter((n) => !n.name.includes(n.sym))));
	const approve = pg.getByRole("button", { name: /freigeben…$/ }).first();
	const label = await approve.getAttribute("aria-label");
	await approve.focus();
	await pg.keyboard.press("Enter");
	await pg.getByRole("dialog").waitFor();
	const font = await pg.getByRole("dialog").getByLabel("Stück").evaluate((e) => getComputedStyle(e).fontSize);
	check("inputs in dialogs use the 13 px UI font", font === "13px", font);
	const risk = await pg.getByRole("dialog").getByTestId("approve-facts").innerText();
	check("approve dialog lists type, price, estimate and stop", /Art/.test(risk) && /Kurs jetzt/.test(risk) && /Geschätzt/.test(risk), risk.replace(/\s+/g, " "));
	await pg.keyboard.press("Escape");
	await pg.getByRole("dialog").waitFor({ state: "detached" });
	// Radix gibt den Fokus nach dem Abbau im nächsten Takt zurück: darauf warten, nicht sofort lesen
	await until(pg, (l) => document.activeElement?.getAttribute("aria-label") === l, label, 3_000);
	const back = await pg.evaluate(() => document.activeElement?.getAttribute("aria-label"));
	check("focus returns to the opening button after a form dialog", back === label, `${back} vs ${label}`);
	await pg.goto(`${BASE}/risk`);
	await settle(pg);
	await pg.getByTestId("kill-toggle").focus();
	await pg.keyboard.press("Enter");
	await pg.getByTestId("confirm").waitFor();
	await pg.keyboard.press("Escape");
	await pg.getByTestId("confirm").waitFor({ state: "detached" });
	check("focus returns to the opening button after a confirmation", await until(pg, () => document.activeElement?.dataset.testid === "kill-toggle", null, 3_000));
	check("keyboard: no console errors or warnings", pg.errors.length === 0, pg.errors.slice(0, 3).join(" | "));
	// Übersicht: alles, was wartet, als Zeile – oder ein Link auf den Rest (D13); Handelszeiten und Not-Aus oben (D9)
	await pg.goto(`${BASE}/`);
	await settle(pg);
	const waitingStat = Number(await pg.getByTestId("stat-waiting").locator("div").nth(1).innerText());
	const rows = await pg.getByTestId("overview-waiting").getByTestId("proposal-row").count();
	const more = await pg.getByTestId("overview-more").count();
	check("overview lists every waiting decision or links to the rest", rows > 0 && (rows === waitingStat || more === 1), `${rows} rows, ${waitingStat} waiting, more ${more}`);
	check("overview shows sessions and the kill switch state", /Handel aktiv|Not-Aus an/.test(await pg.getByTestId("overview-session").innerText()) && (await pg.getByTestId("overview-session").getByTestId("session").count()) >= 2);
	// Benachrichtigungen verweigert: sichtbare Meldung statt nichts (F17)
	await pg.getByTestId("notify-toggle").click();
	check("blocked notifications say so", await until(pg, () => /Benachrichtigungen (sind im Browser blockiert|nicht erlaubt)/.test(document.body.innerText)));
	await pg.context().close();

	// Chat unter 1280 px: modaler Dialog (D6/F13); frischer Browser zählt den alten Verlauf nicht als ungelesen (F16)
	pg = await open(browser, { w: 1024, h: 800 });
	await pg.goto(`${BASE}/orders`);
	await settle(pg);
	await until(pg, () => document.querySelector('[data-testid="chat-toggle"]'));
	await delay(0);
	const fresh = await pg.getByTestId("chat-toggle").getAttribute("aria-label");
	check("fresh browser: old chat history is not counted as unread", fresh === "Chat (C)", fresh);
	await agentSays("Neue Nachricht für die Zählung");
	check("a new message counts as unread", await until(pg, () => /1 ungelesen/.test(document.querySelector('[data-testid="chat-toggle"]').getAttribute("aria-label"))));
	await pg.keyboard.press("c");
	const drawer = pg.getByRole("dialog", { name: "Chat" });
	await drawer.waitFor({ timeout: 5_000 });
	check("chat drawer takes the focus (message field), the hotkey is not typed into it", await pg.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Nachricht" && document.activeElement.value === ""));
	await drawer.getByRole("tab", { name: "Agenten" }).focus();
	await pg.keyboard.press("2");
	check("module hotkeys do nothing behind the open chat drawer", new URL(pg.url()).pathname === "/orders", pg.url());
	await pg.keyboard.press("Escape");
	await drawer.waitFor({ state: "detached", timeout: 5_000 });
	check("Escape closes the drawer and focus returns to the chat button", await until(pg, () => document.activeElement?.dataset.testid === "chat-toggle", null, 3_000));
	await pg.context().close();
}

/** Order-Rechner, Ticket, Schließen (F1, F3, F5, F10, D15, D17). */
async function orderChecks(browser) {
	let pg = await open(browser);
	// Kurs bewegt sich: der Einstieg einer Market-Order folgt, bis du ihn selbst änderst (F20)
	let bump = 0;
	await pg.route("**/api/cockpit", async (route) => {
		const r = await route.fetch();
		const j = await r.json();
		for (const row of j.scan) if (row.symbol === "SAP.DE" && row.price) row.price += bump;
		await route.fulfill({ response: r, json: j });
	});
	await pg.goto(`${BASE}/trade?symbol=SAP.DE`);
	await settle(pg);
	const entry = pg.getByTestId("order-calc").getByLabel("Einstieg (EUR)");
	const first = await entry.inputValue();
	bump = 1;
	// eine Änderung beim Server löst einen Tick aus, der das Cockpit neu lädt
	const lim = (await fetch(`${BASE}/api/risk`).then((r) => r.json())).accounts.find((a) => a.account.id === "papier").limits;
	await owner("/api/risk/papier", "PUT", { maxOpenProposals: lim.maxOpenProposals + 1 });
	await owner("/api/risk/papier", "PUT", { maxOpenProposals: lim.maxOpenProposals });
	const followed = await until(
		pg,
		(f) => {
			const label = [...document.querySelectorAll('[data-testid="order-calc"] label')].find((l) => l.textContent.startsWith("Einstieg"));
			const v = label && document.getElementById(label.htmlFor)?.value;
			return !!v && v !== f;
		},
		first,
		15_000,
	);
	check("market entry follows the live price until you edit it", followed && (await entry.inputValue()) !== first, `${first} → ${await entry.inputValue()}`);
	await pg.unroute("**/api/cockpit");
	// alle Werte warten im Cockpit, nicht nur der gewählte (D9)
	const others = await pg.getByTestId("cockpit-waiting").getByTestId("proposal-row").evaluateAll((rs) => rs.map((r) => r.textContent));
	check("cockpit lists waiting decisions for other symbols too", others.some((t) => !t.includes("SAP.DE")), others.join(" | "));
	await pg.keyboard.press("b");
	await pg.keyboard.type("10");
	await until(pg, () => /^10 Stk\./.test(document.querySelector('[data-testid="calc-risk"]')?.textContent ?? ""));
	const line = await pg.getByTestId("calc-risk").innerText();
	const value = (10 * Number((await entry.inputValue()).replace(/\./g, "").replace(",", "."))).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	check("calculator risk line is for the typed quantity", line.startsWith(`10 Stk. ≈ ${value}`) && /Verlust bis Stop [\d.,]+\s€ inkl\. Gebühren/.test(line), `${line} (want ${value})`);
	await until(pg, () => !document.querySelector('[data-testid="calc-submit"]').disabled);
	// langsamer Probelauf: Senden gesperrt, bis die Prüfung für genau diese Eingabe da ist
	let release;
	const gate = new Promise((r) => (release = r));
	await pg.route((u) => u.pathname === "/api/proposals" && u.search.includes("dryRun"), async (route) => {
		await gate;
		await route.continue().catch(() => undefined);
	});
	await pg.getByTestId("order-calc").getByLabel("Stück", { exact: true }).fill("3");
	await delay(400);
	const locked = await pg.getByTestId("calc-submit").isDisabled();
	release();
	await until(pg, () => !document.querySelector('[data-testid="calc-submit"]').disabled);
	await pg.getByTestId("calc-submit").click();
	const confirmText = await pg.getByTestId("confirm").innerText();
	check("stale dry run never enables submit; confirmation shows the estimate of the sent quantity", locked && /Kauf 3 SAP\.DE/.test(confirmText) && /603,75/.test(confirmText), `${locked} ${confirmText.replace(/\s+/g, " ")}`);
	await pg.keyboard.press("Escape");
	await pg.unroute((u) => u.pathname === "/api/proposals" && u.search.includes("dryRun"));
	// USD-Position in Euro, der Kurs in Dollar als zweite Zeile (D17)
	const usd = await pg.locator('[data-testid="position"][data-symbol="AAPL"] td').nth(3).innerText();
	check("USD position: Kurs (€) first, the dollar price below", /^[\d.,]+\s€\n[\d.,]+\s\$$/.test(usd.trim()), usd);
	// Schließen meldet, was passiert ist (F5): abgelehnt mit Grund
	await pg.route(
		(u) => u.pathname === "/api/proposals" && !u.search,
		(route) => (route.request().method() === "POST" ? route.fulfill({ json: { ok: true, proposal: { status: "rejected", reason: "Tagesverlust-Grenze erreicht" } } }) : route.continue()),
	);
	await pg.getByRole("button", { name: "ALV.DE schließen…" }).click();
	await pg.getByTestId("confirm").getByRole("button", { name: "Verkaufen" }).click();
	check("closing a position reports a rejection with its reason", await until(pg, () => document.body.innerText.includes("abgelehnt: Tagesverlust-Grenze erreicht")));
	check("no 'geschlossen' toast for a rejected close", !(await pg.getByText("ALV.DE geschlossen.").count()));
	await pg.unrouteAll({ behavior: "ignoreErrors" });
	await pg.context().close();

	// Wechsel des Werts mit langsamen Daten: nie die Kennzahlen des vorigen Werts (F2)
	pg = await open(browser);
	await pg.goto(`${BASE}/trade?symbol=SAP.DE`);
	await settle(pg);
	await slow(pg, (u) => /\/api\/market\/(analysis|chart)\/NVDA/.test(u.pathname), 2_000);
	await pg.locator('[data-testid="scan-row"][data-symbol="NVDA"]').click();
	await until(pg, () => document.querySelector("#main h1")?.textContent?.startsWith("NVDA"));
	const vwap = await pg.evaluate(() => [...document.querySelectorAll("#main dt")].find((d) => d.textContent === "VWAP")?.nextElementSibling?.textContent);
	const svg = await pg.evaluate(() => document.querySelector('#main svg[aria-label^="Kursverlauf"]')?.getAttribute("aria-label") ?? "");
	check("new symbol never shows the previous symbol's indicators or candles", vwap === "–" && !svg.includes("SAP"), `${vwap} / ${svg}`);
	await pg.context().close();

	// Ticket aus Depots: Depot der Seite, auch per Direktlink und nach dem Wechsel (F3)
	pg = await open(browser);
	await pg.goto(`${BASE}/portfolio?account=ibkr`);
	await settle(pg);
	const dry = pg.waitForRequest((r) => r.url().includes("dryRun") && r.postDataJSON()?.accountId === "ibkr", { timeout: 8_000 }).then(() => true, () => false);
	await pg.getByRole("button", { name: "Order…" }).click();
	const sel = await pg.getByTestId("ticket-account").inputValue();
	check("order ticket opened by deep link uses the page's account", sel === "ibkr" && (await dry), sel);
	await pg.keyboard.press("Escape");
	await pg.goto(`${BASE}/portfolio?account=papier`);
	await settle(pg);
	await pg.getByLabel("Depot wählen").selectOption("ibkr");
	await until(pg, () => document.querySelector("#main h1")?.textContent === "IBKR Papier");
	await pg.getByRole("button", { name: "Order…" }).click();
	check("order ticket follows an account switch on the page", (await pg.getByTestId("ticket-account").inputValue()) === "ibkr");
	// Eingabe im Broker-Ticket sendet nicht, sondern fragt nach (F4)
	const posts = [];
	pg.on("request", (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/proposals" && !r.url().includes("dryRun") && posts.push(r.url()));
	await until(pg, () => !document.querySelector('[role="dialog"] button[type="submit"]')?.disabled);
	await pg.getByRole("dialog").getByLabel("Stück").press("Enter");
	await pg.getByTestId("confirm").waitFor({ timeout: 5_000 });
	check("Enter in the broker order ticket opens the second confirmation, nothing sent", posts.length === 0 && (await pg.evaluate(() => document.activeElement?.textContent?.trim())) === "Abbrechen");
	await pg.keyboard.press("Escape");
	await pg.context().close();

	// USD-Wert ohne Position und ohne Vorschlag in USD: Wechselkurs aus dem Probelauf, der Rechner rechnet (F10)
	pg = await open(browser);
	await pg.route("**/api/cockpit", async (route) => {
		const r = await route.fetch();
		const j = await r.json();
		j.positions = j.positions.filter((p) => p.currency === "EUR");
		await route.fulfill({ response: r, json: j });
	});
	await pg.route(
		(u) => u.pathname === "/api/proposals" && !u.search.includes("dryRun"),
		async (route) => {
			if (route.request().method() !== "GET") return route.continue();
			const r = await route.fetch();
			await route.fulfill({ response: r, json: (await r.json()).filter((p) => p.currency === "EUR") });
		},
	);
	await pg.goto(`${BASE}/trade?symbol=AAPL`);
	await settle(pg);
	const sized = await until(pg, () => /^\d/.test(document.querySelector('[data-testid="order-calc"] input[placeholder]')?.placeholder ?? ""));
	const hint = await pg.locator('[data-testid="order-calc"]').innerText();
	check("calculator sizes a USD symbol nobody holds", sized && /Rechner: \d/.test(hint), hint.replace(/\s+/g, " ").slice(0, 300));
	await pg.context().close();
}

/** Daten und Stream: Fehler sichtbar, Wiederverbinden, Abrufe sparsam (F7, F8, F19, F21, F22). */
async function dataChecks(browser) {
	let pg = await open(browser);
	await pg.route("**/api/overview", (route) => route.fulfill({ status: 500, body: "" }));
	await pg.goto(`${BASE}/`);
	const shown = await until(pg, () => document.body.innerText.includes("Daten nicht verfügbar") && document.body.innerText.includes("Neu laden"), null, 15_000);
	const top = await pg.getByTestId("pending-link").innerText();
	check("overview with a failing server shows the error and Neu laden, not an endless skeleton", shown && !(await pg.locator(".animate-pulse").count()), String(shown));
	check("top bar shows a dash when the pending count is unknown", top.includes("–"), top);
	await pg.unroute("**/api/overview");
	await pg.getByRole("button", { name: "Neu laden" }).click();
	check("Neu laden recovers once the server answers", await until(pg, () => document.querySelector("#main h1")?.textContent?.startsWith("Hallo"), null, 10_000));
	await pg.route("**/api/cockpit", async (route) => {
		const r = await route.fetch();
		const j = await r.json();
		j.scan[0].price = "kaputt";
		await route.fulfill({ response: r, json: j });
	});
	await pg.goto(`${BASE}/trade`);
	check("schema mismatch shows the prepared message", await until(pg, () => document.body.innerText.includes("Server und App passen nicht zusammen"), null, 15_000));
	await pg.context().close();

	// Stream: HTTP-Fehler → Offline, danach von selbst wieder live; was in der Lücke kam, erscheint (F7)
	pg = await open(browser);
	await pg.route("**/api/stream", (route) => route.fulfill({ status: 503, body: "" }));
	await pg.goto(`${BASE}/agents`);
	await settle(pg);
	check("stream refused: status says offline", await until(pg, () => /Offline|Verbinde/.test(document.querySelector('[data-testid="live-status"]')?.textContent ?? "")));
	await agentSays("Nachricht während der Lücke");
	await pg.unroute("**/api/stream");
	check("stream comes back by itself after an HTTP error", await until(pg, () => /Kurse/.test(document.querySelector('[data-testid="live-status"]')?.textContent ?? ""), null, 20_000));
	check("message sent during the gap appears after reconnecting", await until(pg, () => document.querySelector('[data-testid="chat"]')?.innerText.includes("Nachricht während der Lücke"), null, 10_000));
	// Chat senden: ein POST, kein Neuladen aller Daten (F19). Der Kurstakt des Desks lädt regelmäßig neu – fällt ein
	// Tick in das Messfenster, wird neu gemessen (eigener Stream im Browser zählt die Ticks)
	await pg.evaluate(() => {
		window.__ticks = 0;
		new EventSource("/api/stream").addEventListener("tick", () => window.__ticks++);
	});
	let budget = null;
	for (let attempt = 0; attempt < 4 && budget === null; attempt++) {
		await delay(1_000);
		const gets = [];
		const onGet = (r) => r.method() === "GET" && new URL(r.url()).pathname.startsWith("/api/") && !r.url().includes("/api/stream") && gets.push(new URL(r.url()).pathname);
		const ticks = await pg.evaluate(() => window.__ticks);
		pg.on("request", onGet);
		const text = `ohne Neuladen ${attempt}`;
		await pg.getByTestId("chat").getByLabel("Nachricht", { exact: true }).fill(text);
		await pg.getByTestId("chat").getByLabel("Nachricht", { exact: true }).press("Enter");
		// in der Liste suchen: das Eingabefeld enthält den Text noch, bis das Senden fertig ist
		await pg.getByTestId("chat-list").getByText(text).waitFor({ timeout: 10_000 });
		await delay(1_500);
		pg.off("request", onGet);
		if ((await pg.evaluate(() => window.__ticks)) === ticks) budget = gets;
	}
	check("sending a chat message reloads nothing", budget !== null && budget.length === 0, budget === null ? "every window had a tick" : budget.join(", "));
	// Chat bleibt stehen, wenn du oben liest (F12)
	for (let i = 0; i < 25; i++) await agentSays(`Langer Verlauf ${i}: ${"Kurs, Volumen und VWAP im Blick. ".repeat(3)}`);
	await until(pg, () => document.querySelector('[data-testid="chat"]')?.innerText.includes("Langer Verlauf 24"));
	await pg.getByTestId("chat-list").evaluate((el) => {
		el.scrollTop = 0;
		el.dispatchEvent(new Event("scroll"));
	});
	await agentSays("Neu, während du oben liest");
	const jump = await until(pg, () => !!document.querySelector('[data-testid="chat-jump"]'));
	const stay = await pg.getByTestId("chat-list").evaluate((el) => el.scrollTop);
	check("chat keeps your reading position and offers a jump to new messages", jump && stay < 40, `${jump} ${stay}`);
	await pg.context().close();

	// IBKR fragt ohne Text: nichts zu bestätigen, nur stornieren (F21); unbekanntes Symbol in der Adresse (F22)
	pg = await open(browser);
	await pg.route((u) => u.pathname === "/api/proposals" && u.searchParams.has("limit"), async (route) => {
		const r = await route.fetch();
		const j = await r.json();
		const ib = j.find((p) => p.accountId === "ibkr") ?? j[0];
		Object.assign(ib, { status: "confirm", brokerMessage: null });
		await route.fulfill({ response: r, json: j });
	});
	await pg.goto(`${BASE}/orders`);
	await settle(pg);
	const q = pg.getByTestId("broker-question").first();
	await q.waitFor({ timeout: 8_000 });
	const qText = await q.innerText();
	const card = pg.locator('[data-testid="proposal"]', { has: q });
	check("broker question without text: no empty quotes, no confirm button", /Rückfrage ohne Text/.test(qText) && !qText.includes("„“") && (await card.getByRole("button", { name: /bestätigen…$/ }).count()) === 0, qText);
	await pg.goto(`${BASE}/trade?symbol=GIBTSNICHT`);
	await settle(pg);
	const fixed = await until(pg, () => new URL(location.href).searchParams.get("symbol") !== "GIBTSNICHT");
	check("unknown symbol in the address is replaced and explained", fixed && (await pg.getByText("„GIBTSNICHT“ steht nicht im Scanner").count()) === 1);
	await pg.context().close();
}

/** Eingaben: deutsche Zahlen, Risiko-Felder, Trade erfassen, Alarm mit Rückgängig, Suche (F6, F11, F18, F24, D20). */
async function inputChecks(browser) {
	const pg = await open(browser);
	const before = (await fetch(`${BASE}/api/risk`).then((r) => r.json())).accounts.find((a) => a.account.id === "papier").limits;
	await pg.goto(`${BASE}/risk`);
	await settle(pg);
	const card = pg.getByRole("region", { name: "Mein Papierdepot", exact: true });
	await card.getByLabel("Max. Orderwert (€)").fill("1.000");
	await card.getByLabel("Max. Orderwert (€)").press("Enter");
	let savedCents = null;
	for (let i = 0; i < 40 && savedCents !== 100000; i++) {
		await delay(200);
		savedCents = (await fetch(`${BASE}/api/risk`).then((r) => r.json())).accounts.find((a) => a.account.id === "papier").limits.maxOrderCents;
	}
	check("risk field reads 1.000 as one thousand euros", savedCents === 100000, `${savedCents} cents`);
	// langsames Neuladen nach dem ersten Feld überschreibt nicht, was du schon ins nächste tippst (F11)
	await slow(pg, "**/api/risk", 800);
	await card.getByLabel("Max. Orderwert (€)").fill(String(before.maxOrderCents / 100));
	await card.getByLabel("Max. Orderwert (€)").press("Tab");
	await pg.keyboard.type("33");
	await delay(1_800);
	const typed = await card.getByLabel("Max. Position (%)").inputValue();
	check("typing in the next risk field survives the refetch of the previous one", typed.endsWith("33"), typed);
	await card.getByLabel("Max. Position (%)").fill(String(before.maxPositionPct).replace(".", ","));
	await card.getByLabel("Max. Position (%)").press("Enter");
	await pg.unroute("**/api/risk");
	await until(pg, () => true);
	await owner("/api/risk/papier", "PUT", { maxOrderCents: before.maxOrderCents, maxPositionPct: before.maxPositionPct });
	// Trade erfassen ohne Datum: Meldung am Feld, nichts gesendet (F18)
	await pg.goto(`${BASE}/portfolio?account=tr`);
	await settle(pg);
	const sent = [];
	pg.on("request", (r) => r.method() === "POST" && r.url().includes("/trades") && sent.push(r.url()));
	await pg.getByRole("button", { name: "Trade erfassen…" }).click();
	const d = pg.getByRole("dialog");
	await d.getByRole("button", { name: "Erfassen" }).click();
	await d.getByText(/Symbol fehlt/).waitFor({ timeout: 5_000 });
	await pg.keyboard.press("Escape");
	await d.waitFor({ state: "detached" });
	await pg.getByRole("button", { name: "Trade erfassen…" }).click();
	check("dialog errors are gone when it opens again", (await d.getByText(/Symbol fehlt/).count()) === 0);
	await d.getByLabel("Symbol").fill("SAP.DE");
	await d.getByLabel("Stück", { exact: true }).fill("1");
	await d.getByLabel("Kurs je Stück (EUR)").fill("1.234,50");
	await d.getByLabel("Datum").fill("");
	await d.getByRole("button", { name: "Erfassen" }).click();
	check("trade without a date: message at the field, nothing sent", (await d.getByText("Datum fehlt.").count()) === 1 && sent.length === 0 && (await d.getByLabel("Datum").getAttribute("aria-invalid")) === "true");
	await pg.keyboard.press("Escape");
	// Alarm löschen mit Rückgängig (D20)
	await pg.goto(`${BASE}/market?symbol=NVDA`);
	await settle(pg);
	const del = pg.getByRole("button", { name: /^Alarm unter .* löschen$/ }).first();
	const delName = await del.getAttribute("aria-label");
	await del.click();
	const undo = pg.getByRole("button", { name: "Rückgängig" });
	await undo.waitFor({ timeout: 5_000 });
	await undo.click();
	check("deleted alarm comes back with Rückgängig", await until(pg, (n) => [...document.querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === n), delName, 8_000), delName);
	// Suche: Eingabe nimmt nie den Treffer einer alten Eingabe (F24)
	const adds = [];
	pg.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/market/watchlist") && adds.push(r.url()));
	await slow(pg, "**/api/market/search**", 1_000);
	const box = pg.getByLabel("Wertpapier suchen");
	await box.fill("Siemens");
	await box.press("Enter");
	await delay(1_500);
	check("search Enter before the hits arrive adds nothing", adds.length === 0, adds.join(","));
	await pg.unroute("**/api/market/search**");
	await pg.context().close();
}

const server = await startServer();
const browser = await chromium.launch({ headless: true });
try {
	/* Layout und Konsole: jedes Modul, beide Designs, vier Breiten */
	for (const theme of ["dark", "light"]) {
		for (const w of WIDTHS) {
			const pg = await open(browser, { w, h: w < 500 ? 844 : 900, theme });
			for (const r of ROUTES) {
				await pg.goto(BASE + r);
				await settle(pg);
				const sw = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
				check(`${theme} ${w}px ${r}: no horizontal page scroll`, sw <= 0, `${sw}px`);
				// keine Karte ragt aus dem Inhaltsbereich, keine zwei Karten überlappen sich
				const layout = await pg.evaluate(() => {
					const main = document.getElementById("main").getBoundingClientRect();
					const cards = [...document.querySelectorAll("#main section, #main article")].filter((e) => !e.parentElement.closest("#main section, #main article"));
					const rects = cards.map((e) => e.getBoundingClientRect());
					const outside = rects.filter((r) => r.right > main.right + 1 || r.left < main.left - 1).length;
					let overlap = 0;
					for (let i = 0; i < rects.length; i++)
						for (let j = i + 1; j < rects.length; j++) {
							const p = rects[i], q = rects[j];
							if (p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1) overlap++;
						}
					return { outside, overlap };
				});
				check(`${theme} ${w}px ${r}: cards inside the page and not overlapping`, layout.outside === 0 && layout.overlap === 0, JSON.stringify(layout));
				const small = await pg.evaluate(() => [...document.querySelectorAll("#main button, header button, header a")].filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 24).map((e) => e.textContent.trim() || e.getAttribute("aria-label")));
				check(`${theme} ${w}px ${r}: buttons at least 24 px high`, small.length === 0, small.slice(0, 4).join(", "));
				if (w !== 800) await pg.screenshot({ path: path.join(out, `${theme}-${w}-${r.slice(1).replace(/[?=&]+/g, "-") || "overview"}.png`) });
			}
			check(`${theme} ${w}px: no console errors or warnings`, pg.errors.length === 0, pg.errors.slice(0, 3).join(" | "));
			await pg.context().close();
		}
	}

	/* Freigabe: verkleinern, ausführen, Meldung nennt die freigegebene Menge */
	let pg = await open(browser);
	await pg.goto(`${BASE}/orders`);
	await settle(pg);
	const before = Number(await pg.getByTestId("pending-badge").innerText());
	const card = pg.locator('[data-testid="proposal"]', { hasText: "Kauf 4 MSFT" });
	await card.getByRole("button", { name: "Freigeben…" }).click();
	const dialog = pg.getByRole("dialog");
	await dialog.getByLabel("Stück").fill("5");
	await dialog.getByRole("button", { name: "Freigeben und ausführen" }).click();
	// Fehler am Feld: markiert, beschrieben und fokussiert (D22)
	await pg.waitForFunction(() => document.activeElement?.getAttribute("aria-invalid") === "true", null, { timeout: 5_000 }).catch(() => undefined);
	const invalid = await dialog.getByLabel("Stück").evaluate((el) => ({ invalid: el.getAttribute("aria-invalid"), note: document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? "", focused: document.activeElement === el }));
	check("approval refuses more than proposed, at the field", invalid.invalid === "true" && invalid.note.includes("mehr als vorgeschlagen") && invalid.focused, JSON.stringify(invalid));
	await dialog.getByLabel("Stück").fill("2");
	await dialog.getByRole("button", { name: "Freigeben und ausführen" }).click();
	await pg.getByText("Kauf 2 MSFT ausgeführt.").waitFor({ timeout: 10_000 });
	check("approved order executed with the narrowed quantity", true);
	await pg.waitForFunction((b) => Number(document.querySelector('[data-testid="pending-badge"]')?.textContent ?? 0) === b - 1, before, { timeout: 10_000 });
	check("pending badge counts down", true);

	/* Trade Republic: nach der Freigabe liegt die Order „beim Broker“, du trägst die Ausführung ein */
	const tr = pg.locator('[data-testid="proposal"]', { hasText: "für Trade Republic" });
	await tr.getByRole("button", { name: "Freigeben…" }).click();
	await pg.getByRole("dialog").getByRole("button", { name: "Freigeben", exact: true }).click();
	await tr.getByRole("button", { name: /^Ausführung von .* eintragen…$/ }).waitFor({ timeout: 10_000 });
	await tr.getByRole("button", { name: /^Ausführung von .* eintragen…$/ }).click();
	await pg.getByRole("dialog").getByLabel("Kurs (EUR)").fill("104,40");
	await pg.getByRole("dialog").getByRole("button", { name: "Eintragen" }).click();
	await pg.getByText("als ausgeführt eingetragen").waitFor({ timeout: 10_000 });
	check("broker order approved, then execution recorded", true);

	/* IBKR (Fake-Gateway, Papierkonto): Freigabe sendet an den Broker, Depot zeigt die Verbindung */
	await pg.goto(`${BASE}/orders`);
	await settle(pg);
	const ibCard = pg.locator('[data-testid="proposal"]', { hasText: "für IBKR Papier" });
	const approvals = [];
	const onReq = (r) => r.method() === "POST" && /\/approve$/.test(new URL(r.url()).pathname) && approvals.push(r.url());
	pg.on("request", onReq);
	await ibCard.getByRole("button", { name: "Freigeben…" }).click();
	// Owner-Entscheidung 2026-10-16: Eingabe im Freigabe-Dialog sendet nichts, sondern öffnet die zweite Bestätigung
	await pg.getByRole("dialog").getByLabel("Stück").press("Enter");
	const second = pg.getByTestId("confirm");
	await second.waitFor({ timeout: 5_000 });
	const secondText = await second.innerText();
	const onCancel = await pg.evaluate(() => document.activeElement?.textContent?.trim());
	check("broker approval: Enter opens a second confirmation that starts on Abbrechen", onCancel === "Abbrechen" && approvals.length === 0, `${onCancel} / ${approvals.length} requests`);
	check("broker confirmation names side, quantity, type, estimate and stop", /Kauf 2 SAP\.DE/.test(secondText) && /Market-Tagesorder/.test(secondText) && /geschätzt .*€/.test(secondText) && /Stop 195,00\s€/.test(secondText) && /Risiko bis Stop ≈ .*€/.test(secondText) && /Papierkonto/.test(secondText), secondText.replace(/\s+/g, " "));
	await pg.keyboard.press("Enter");
	await second.waitFor({ state: "detached", timeout: 5_000 });
	check("Enter on the second confirmation cancels and sends nothing", approvals.length === 0 && (await pg.getByRole("dialog").count()) === 1);
	await pg.getByRole("dialog").getByRole("button", { name: "An Interactive Brokers senden…" }).click();
	await second.getByRole("button", { name: "An Interactive Brokers senden", exact: true }).click();
	await pg.getByText("an Interactive Brokers gesendet", { exact: false }).first().waitFor({ timeout: 10_000 });
	check("approval sends the order to IBKR only after the second click", approvals.length === 1, `${approvals.length}`);
	pg.off("request", onReq);
	await pg.goto(`${BASE}/portfolio?account=ibkr`);
	await settle(pg);
	await pg.getByText("Interactive Brokers verbunden").waitFor({ timeout: 10_000 });
	check("broker account shows the gateway connection and paper badge", (await pg.getByText("Papierkonto", { exact: true }).count()) > 0);

	/* Cockpit: Rechner, Hotkey B, Kauf über den Rechner im Papierdepot */
	await pg.goto(`${BASE}/trade?symbol=SAP.DE`);
	await settle(pg);
	check("cockpit shows sessions and the scanner", (await pg.getByTestId("session").count()) >= 2 && (await pg.getByTestId("scan-row").count()) === 7);
	await pg.keyboard.press("b");
	check("hotkey B focuses the quantity", await pg.evaluate(() => document.activeElement?.getAttribute("inputmode") === "decimal"));
	await pg.keyboard.type("1");
	await pg.getByRole("button", { name: "Kaufen…" }).click();
	await pg.getByRole("dialog").getByRole("button", { name: "Kaufen", exact: true }).click();
	await pg.getByText("Kauf 1 SAP.DE ausgeführt.").waitFor({ timeout: 10_000 });
	check("buy from the calculator fills in the paper account", true);
	// Pfeiltasten folgen der sichtbaren Reihenfolge (D7/F9): Fokus in den Scanner, eine Zeile weiter
	const order = await pg.getByTestId("scan-row").evaluateAll((els) => els.map((e) => e.dataset.symbol));
	const at = order.indexOf("SAP.DE");
	await pg.locator('[data-testid="scan-row"][data-symbol="SAP.DE"]').focus();
	await pg.keyboard.press("ArrowDown");
	const want = order[Math.min(order.length - 1, at + 1)];
	await pg.waitForFunction((w) => new URL(location.href).searchParams.get("symbol") === w, want, { timeout: 5_000 }).catch(() => undefined);
	const got = await pg.evaluate(() => ({ symbol: new URL(location.href).searchParams.get("symbol"), focused: document.activeElement?.dataset?.symbol }));
	check("arrow down selects the next visible scanner row and keeps focus there", got.symbol === want && got.focused === want, `${JSON.stringify(got)} want ${want} of ${order.join(",")}`);

	/* Chat: senden, Nachricht eines Agenten mit HTML bleibt Text */
	await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: "Nova", text: '<img src=x onerror="window.__pwned=1"> @Maurice Gap bei NVDA' }) });
	const chat = pg.getByTestId("chat");
	await chat.getByText("Gap bei NVDA").waitFor({ timeout: 10_000 });
	check("agent message arrives live", true);
	check("chat renders HTML as text", (await chat.locator("img").count()) === 0 && !(await pg.evaluate(() => window.__pwned)));
	await chat.getByLabel("Nachricht", { exact: true }).fill("@Atlas bitte nur halbe Größe");
	await chat.getByLabel("Nachricht", { exact: true }).press("Enter");
	await chat.getByTestId("chat-list").getByText("bitte nur halbe Größe").waitFor({ timeout: 10_000 });
	check("you can write in the chat with Enter", true);
	check("approval and cockpit flows: no console errors or warnings", pg.errors.length === 0, pg.errors.slice(0, 3).join(" | "));
	await pg.context().close();
	await layoutChecks(browser);
	await keyboardChecks(browser);
	await orderChecks(browser);
	await dataChecks(browser);
	await inputChecks(browser);

	/* Not-Aus: Bestätigung startet auf Abbrechen, Banner erscheint, Fokusring neutral */
	pg = await open(browser);
	await pg.goto(`${BASE}/risk`);
	await settle(pg);
	await pg.getByTestId("kill-toggle").click();
	const focused = await pg.evaluate(() => document.activeElement?.textContent?.trim());
	check("destructive confirmation starts on Abbrechen", focused === "Abbrechen", focused);
	await pg.keyboard.press("Enter");
	check("Enter on the default does not switch it on", (await pg.getByTestId("kill-banner").count()) === 0);
	await pg.getByTestId("kill-toggle").click();
	await pg.getByRole("dialog").getByRole("button", { name: "Not-Aus einschalten" }).click();
	await pg.getByTestId("kill-banner").waitFor({ timeout: 10_000 });
	check("kill switch shows the banner", true);
	// frisch geladen, damit der Fokus wirklich von der Tastatur kommt (nach einem Mausklick gilt :focus-visible nicht)
	await pg.reload();
	await settle(pg);
	await pg.keyboard.press("Tab");
	const ring = await pg.evaluate(() => {
		const el = document.activeElement;
		const probe = document.createElement("div");
		probe.style.outline = "2px solid var(--focus-ring)";
		document.body.append(probe);
		const want = getComputedStyle(probe).outlineColor;
		probe.remove();
		const cs = getComputedStyle(el);
		return { el: el.tagName, style: cs.outlineStyle, got: cs.outlineColor, want };
	});
	check("keyboard focus ring uses the neutral token", ring.style === "solid" && ring.got === ring.want, JSON.stringify(ring));
	check("flows: no console errors or warnings", pg.errors.length === 0, pg.errors.slice(0, 3).join(" | "));
	await pg.context().close();
} catch (e) {
	check("e2e ran through", false, e.stack ?? String(e));
} finally {
	await browser.close();
	server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} ok – screenshots in build/preview`);
process.exit(failed ? 1 : 0);
