// HTTP gegen die Fixture wie im Betrieb: Host und Origin des Desks, du mit Sitzungs-Cookie nach dem Anmelden mit der
// Test-PIN, Agenten ohne Cookie und ohne Origin.
import { createApp } from "../src/app.ts";
import { FIXTURE_PIN, type Fixture } from "../src/fixture.ts";

export function deskHttp(fx: Fixture) {
	const base = `http://127.0.0.1:${fx.cfg.port}`;
	let cookie = "";
	const request = (p: string, init: RequestInit = {}) => createApp(fx.desk).request(base + p, init);
	const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
	return {
		base,
		request,
		/** Anmelden mit der Test-PIN; danach schickt web() das Cookie mit. */
		async login(pin = FIXTURE_PIN) {
			const r = await request("/api/auth/login", json("POST", { pin }, { Origin: base }));
			if (r.status !== 200) throw new Error(`login ${r.status}: ${await r.text()}`);
			cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
			return r;
		},
		get cookie() {
			return cookie;
		},
		/** Du im Browser: Cookie und Origin des Desks. */
		web: (p: string, method = "POST", body: unknown = {}) => request(p, json(method, body, { Origin: base, Cookie: cookie })),
		/** Lesen im Browser (gleicher Origin: ohne Origin-Header, mit Cookie). */
		webGet: (p: string) => request(p, { headers: { Cookie: cookie } }),
		/** Ein Agent über cli/desk.py: kein Cookie, kein Origin. */
		cli: (p: string, body: unknown = {}, method = "POST") => request(p, json(method, body)),
		get: (p: string) => request(p),
	};
}
