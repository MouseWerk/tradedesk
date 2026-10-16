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
import { IbkrQuoteFeed, MarketFeed, type QuoteFeed } from "./feed.ts";
import { OwnerAuth } from "./auth.ts";
import { de } from "./i18n/de.ts";

if (process.argv.includes("--selftest")) {
	const { selftest } = await import("./selftest.ts");
	process.exit(await selftest());
}

const base = loadConfig();
if (process.argv.includes("--reset-pin")) {
	const db = openDatabase(base.dbFile);
	new OwnerAuth(db, Date.now).reset();
	db.close();
	console.log(de.startup.pinReset(base.dbFile));
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
	const market = base.market === "off" ? new OffMarket() : new YahooMarket();
	// Kursquelle: Yahoo; mit "quotes": "ibkr" Momentaufnahmen über das Gateway des ersten IBKR-Depots, Yahoo als Rückfall
	let feed: QuoteFeed = new MarketFeed(market);
	const ib = Object.entries(base.brokers)[0];
	if (base.quotes === "ibkr" && base.market !== "off") {
		if (ib) feed = new IbkrQuoteFeed({ gateway: ib[1].gateway, broker: brokers.get(ib[0])!, fallback: feed });
		else console.warn(de.startup.ibkrQuotesWithoutDepot);
	}
	desk = new Desk(base, openDatabase(base.dbFile), market, Date.now, brokers, feed);
	cleanup = () => {
		desk.stop();
		desk.db.close();
	};
}
const cfg = desk.cfg;
await desk.tick().catch((e) => console.error(de.startup.firstQuotes, (e as Error).message));
desk.start();
const app = createApp(desk);
// zusätzlich auf Tailscale-Adressen (Handy) – erst wenn die PIN gesetzt ist, sonst wäre der Desk dort ohne Schutz;
// wird sie in dieser Sitzung festgelegt, gehen die Adressen sofort auf (kein zweiter Neustart)
const extra: ReturnType<typeof serve>[] = [];
const bindExtra = () => {
	if (extra.length || !desk.auth.pinSet) return;
	for (const addr of cfg.listen) {
		const s = serve({ fetch: app.fetch, port: cfg.port, hostname: addr }, () => console.log(de.startup.alsoOn(`http://${addr}:${cfg.port}`)));
		s.on("error", (e: NodeJS.ErrnoException) => console.error(de.startup.listenFailed(addr, e.code === "EADDRNOTAVAIL" ? de.startup.addrNotAvailable : e.message)));
		extra.push(s);
	}
};
if (cfg.listen.length) {
	bindExtra();
	if (!extra.length) {
		console.log(de.startup.listenAfterPin(cfg.listen.join(", ")));
		desk.on("event", (e: { kind: string }) => e.kind === "auth.setup" && bindExtra());
	}
}
const server = serve({ fetch: app.fetch, port: cfg.port, hostname: "127.0.0.1" }, (info) => {
	const live = cfg.accounts.filter((a) => a.live);
	console.log(de.startup.running(`http://127.0.0.1:${info.port}`, cfg.accounts.length, cfg.agents.length, desk.market.kind, desk.feed.source, cfg.home));
	// der Einrichtungscode erscheint nur hier, in deiner Konsole – nie in Datenbank, Logdatei, API oder Chat
	const code = desk.auth.startSetup();
	if (code) console.log(de.startup.setupCode(code));
	if (desk.brokers.size) console.log(de.startup.brokers([...desk.brokers.keys()].join(", "), cfg.liveTrading, live.map((a) => a.id).join(", ")));
});
server.on("error", (e: NodeJS.ErrnoException) => {
	console.error(e.code === "EADDRINUSE" ? de.startup.portInUse(cfg.port) : e);
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
