// Playwright headless gegen den Fixture-Server (Fake-Börse, Wegwerf-Daten, kein Netz):
// jedes Modul in Dark/Light und mehreren Breiten ohne seitliches Scrollen und ohne Konsolenfehler, Freigabe-Ablauf,
// Not-Aus, Fokusring neutral, Bestätigung startet auf „Abbrechen“. Screenshots nach build/preview/.
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

async function open(browser, { w = 1440, h = 900, theme = "dark" } = {}) {
	const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce", locale: "de-DE", timezoneId: "Europe/Berlin" });
	await ctx.addInitScript((t) => {
		try {
			localStorage.setItem("desk.theme", t);
		} catch {}
	}, theme);
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
				if (w === 1280 || w === 390) await pg.screenshot({ path: path.join(out, `${theme}-${w}-${r.split("?")[0].slice(1) || "overview"}.png`) });
			}
			check(`${theme} ${w}px: no console errors or warnings`, pg.errors.length === 0, pg.errors.slice(0, 3).join(" | "));
			await pg.context().close();
		}
	}

	/* Freigabe: verkleinern, ausführen, Meldung nennt die freigegebene Menge */
	const pg = await open(browser);
	await pg.goto(`${BASE}/orders`);
	await settle(pg);
	const before = Number(await pg.getByTestId("pending-badge").innerText());
	const card = pg.locator('[data-testid="proposal"]', { hasText: "Kauf 4 MSFT" });
	await card.getByRole("button", { name: "Freigeben…" }).click();
	const dialog = pg.getByRole("dialog");
	await dialog.getByLabel("Stück").fill("5");
	await dialog.getByRole("button", { name: "Freigeben und ausführen" }).click();
	check("approval refuses more than proposed", await dialog.getByRole("alert").innerText().then((t) => t.includes("mehr als vorgeschlagen")));
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
	await tr.getByRole("button", { name: "Ausführung eintragen…" }).waitFor({ timeout: 10_000 });
	await tr.getByRole("button", { name: "Ausführung eintragen…" }).click();
	await pg.getByRole("dialog").getByLabel("Kurs (EUR)").fill("104,40");
	await pg.getByRole("dialog").getByRole("button", { name: "Eintragen" }).click();
	await pg.getByText("als ausgeführt eingetragen").waitFor({ timeout: 10_000 });
	check("broker order approved, then execution recorded", true);

	/* IBKR (Fake-Gateway, Papierkonto): Freigabe sendet an den Broker, Depot zeigt die Verbindung */
	await pg.goto(`${BASE}/orders`);
	await settle(pg);
	const ibCard = pg.locator('[data-testid="proposal"]', { hasText: "für IBKR Papier" });
	await ibCard.getByRole("button", { name: "Freigeben…" }).click();
	await pg.getByRole("dialog").getByRole("button", { name: "An Interactive Brokers senden" }).click();
	await pg.getByText("an Interactive Brokers gesendet", { exact: false }).first().waitFor({ timeout: 10_000 });
	check("approval sends the order to IBKR", true);
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
	await pg.keyboard.press("ArrowDown");
	await pg.waitForFunction(() => !location.search.includes("SAP.DE"), null, { timeout: 5_000 });
	check("arrow keys move through the scanner", true);

	/* Chat: senden, Nachricht eines Agenten mit HTML bleibt Text */
	await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: "Nova", text: '<img src=x onerror="window.__pwned=1"> @Maurice Gap bei NVDA' }) });
	const chat = pg.getByTestId("chat");
	await chat.getByText("Gap bei NVDA").waitFor({ timeout: 10_000 });
	check("agent message arrives live", true);
	check("chat renders HTML as text", (await chat.locator("img").count()) === 0 && !(await pg.evaluate(() => window.__pwned)));
	await chat.getByLabel("Nachricht", { exact: true }).fill("@Atlas bitte nur halbe Größe");
	await chat.getByLabel("Nachricht", { exact: true }).press("Enter");
	await chat.getByText("bitte nur halbe Größe").waitFor({ timeout: 10_000 });
	check("you can write in the chat with Enter", true);

	/* Not-Aus: Bestätigung startet auf Abbrechen, Banner erscheint, Fokusring neutral */
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
