// Tradedesk – Server. Start: node apps/server/src/index.ts [--port 8095] [--home <datenordner>]   (Node >= 24 führt TypeScript direkt aus)
// Selbsttest: --selftest (eigene Fixture, kein Port, kein Netz). Fixture-Server für Playwright: --fixture (Test-PIN 2468).
// PIN vergessen: --reset-pin löscht PIN und Sitzungen; der nächste Start zeigt einen neuen Einrichtungscode.
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { Desk } from "./desk.ts";
import { OffMarket, YahooMarket } from "./market.ts";
import { createApp } from "./app.ts";
import { IbkrBroker } from "./broker.ts";
import { OwnerAuth } from "./auth.ts";

if (process.argv.includes("--selftest")) {
	const { selftest } = await import("./selftest.ts");
	process.exit(await selftest());
}

const base = loadConfig();
if (process.argv.includes("--reset-pin")) {
	const db = openDatabase(base.dbFile);
	new OwnerAuth(db, Date.now).reset();
	db.close();
	console.log(`PIN und Sitzungen gelöscht (${base.dbFile}). Beim nächsten Start zeigt der Desk hier einen neuen Einrichtungscode.`);
	process.exit(0);
}
let desk: Desk;
let cleanup = () => {};
if (process.argv.includes("--fixture")) {
	const { makeFixture, tradingDayClock } = await import("./fixture.ts");
	const fx = await makeFixture({ now: tradingDayClock() }); // Uhr an einem Handelstag: Papier-Orders werden ausgeführt
	fx.cfg.port = base.port;
	desk = fx.desk;
	cleanup = fx.cleanup;
} else {
	const brokers = new Map(Object.entries(base.brokers).map(([id, b]) => [id, new IbkrBroker({ gateway: b.gateway, account: b.account, conids: b.conids })] as const));
	desk = new Desk(base, openDatabase(base.dbFile), base.market === "off" ? new OffMarket() : new YahooMarket(), Date.now, brokers);
	cleanup = () => {
		desk.stop();
		desk.db.close();
	};
}
const cfg = desk.cfg;
await desk.tick().catch((e) => console.error("erster Kursabruf:", (e as Error).message));
desk.start();
const app = createApp(desk);
// zusätzlich auf Tailscale-Adressen (Handy) – erst wenn die PIN gesetzt ist, sonst wäre der Desk dort ohne Schutz;
// wird sie in dieser Sitzung festgelegt, gehen die Adressen sofort auf (kein zweiter Neustart)
const extra: ReturnType<typeof serve>[] = [];
const bindExtra = () => {
	if (extra.length || !desk.auth.pinSet) return;
	for (const addr of cfg.listen) {
		const s = serve({ fetch: app.fetch, port: cfg.port, hostname: addr }, () => console.log(`Tradedesk auch auf http://${addr}:${cfg.port} (nur deine Tailscale-Geräte, Anmeldung mit PIN)`));
		s.on("error", (e: NodeJS.ErrnoException) => console.error(`listen ${addr}: ${e.code === "EADDRNOTAVAIL" ? "Adresse gibt es auf diesem Computer nicht – läuft Tailscale?" : e.message}`));
		extra.push(s);
	}
};
if (cfg.listen.length) {
	bindExtra();
	if (!extra.length) {
		console.log(`listen: ${cfg.listen.join(", ")} erst nach dem Festlegen der PIN.`);
		desk.on("event", (e: { kind: string }) => e.kind === "auth.setup" && bindExtra());
	}
}
const server = serve({ fetch: app.fetch, port: cfg.port, hostname: "127.0.0.1" }, (info) => {
	const live = cfg.accounts.filter((a) => a.live);
	console.log(`Tradedesk on http://127.0.0.1:${info.port}  (${cfg.accounts.length} Depots, ${cfg.agents.length} Agenten, Markt ${desk.market.kind}, Daten ${cfg.home})`);
	// der Einrichtungscode erscheint nur hier, in deiner Konsole – nie in Datenbank, Logdatei, API oder Chat
	const code = desk.auth.startSetup();
	if (code) console.log(`PIN festlegen: Einrichtungscode ${code} – im Browser eingeben und eine PIN (4–12 Ziffern) wählen.`);
	if (desk.brokers.size) console.log(`Broker: ${[...desk.brokers.keys()].join(", ")} – Live-Handel ${cfg.liveTrading ? "AN" : "aus"}${live.length ? ` (echte Konten: ${live.map((a) => a.id).join(", ")})` : ""}`);
});
server.on("error", (e: NodeJS.ErrnoException) => {
	console.error(e.code === "EADDRINUSE" ? `Port ${cfg.port} ist belegt – läuft schon ein Tradedesk?` : e);
	process.exit(1);
});
const shutdown = () => {
	server.close();
	for (const s of extra) s.close();
	cleanup();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
