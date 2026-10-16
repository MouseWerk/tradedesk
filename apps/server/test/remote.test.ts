// Zugriff vom Handy über Tailscale: nur Tailscale-Adressen, Host-Prüfung auch dort, und von einem anderen Gerät ohne
// PIN-Sitzung nichts – auch nicht lesen.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { cleanListen, isTailscaleV4 } from "../src/config.ts";
import { makeFixture, type Fixture } from "../src/fixture.ts";
import { deskHttp } from "./owner.ts";
import { SESSION_HEADER } from "../src/auth.ts";

const PC = "100.101.102.103"; // Beispieladressen im Tailscale-Bereich
const PHONE = "100.88.77.66";
let fx: Fixture;

beforeEach(async () => {
	fx = await makeFixture();
	fx.cfg.listen = [PC];
});
afterEach(() => fx.cleanup());

/** Anfrage wie vom Handy: Verbindung von seiner Tailscale-Adresse an die des PCs. */
const fromPhone = (p: string, init: RequestInit = {}) => {
	const base = `http://${PC}:${fx.cfg.port}`;
	return createApp(fx.desk).request(base + p, { ...init, headers: { Host: `${PC}:${fx.cfg.port}`, ...(init.headers as Record<string, string>) } }, { incoming: { socket: { remoteAddress: PHONE } } });
};

describe("listen", () => {
	it("accepts only Tailscale addresses", () => {
		expect(["100.64.0.1", PC, "100.127.255.255"].every(isTailscaleV4)).toBe(true);
		expect(["100.63.0.1", "100.128.0.1", "192.168.0.100", "0.0.0.0", "10.0.0.5", "100.300.1.1", "x"].some(isTailscaleV4)).toBe(false);
		expect(cleanListen([PC, "192.168.0.100", "0.0.0.0", "127.0.0.1", PC, 5])).toEqual([PC]);
		expect(cleanListen("100.64.0.1")).toEqual([]);
	});
});

describe("requests from another device", () => {
	it("get nothing without a session, not even read-only data", async () => {
		for (const p of ["/api/overview", "/api/proposals", "/api/chat", "/api/cockpit", "/api/ping"]) expect((await fromPhone(p)).status, p).toBe(401);
		expect((await fromPhone("/api/auth")).status).toBe(200); // der Anmeldebildschirm muss den Status kennen
	});

	it("work after logging in with the PIN", async () => {
		const origin = `http://${PC}:${fx.cfg.port}`;
		const login = await fromPhone("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ pin: "2468" }) });
		expect(login.status).toBe(200);
		const { token } = (await login.json()) as { token: string };
		expect((await fromPhone("/api/overview", { headers: { [SESSION_HEADER]: token } })).status).toBe(200);
		const kill = await fromPhone("/api/risk/kill", { method: "PUT", headers: { "Content-Type": "application/json", Origin: origin, [SESSION_HEADER]: token }, body: JSON.stringify({ on: true }) });
		expect(kill.status).toBe(200);
	});

	it("still refuse a Host that is not one of the desk's addresses", async () => {
		const r = await createApp(fx.desk).request(`http://evil.example/api/auth`, { headers: { Host: "evil.example" } }, { incoming: { socket: { remoteAddress: PHONE } } });
		expect(r.status).toBe(403);
		fx.cfg.listen = [];
		expect((await fromPhone("/api/auth")).status).toBe(403); // ohne listen ist die Tailscale-Adresse kein Host des Desks
	});

	it("leave local agents as they were: reading works without a session on this computer", async () => {
		const http = deskHttp(fx);
		expect((await http.get("/api/overview")).status).toBe(200);
	});
});
