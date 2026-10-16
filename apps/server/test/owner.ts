// HTTP gegen die Fixture wie im Betrieb: Host und Origin des Desks, du mit dem Sitzungs-Header nach dem Anmelden mit
// der Test-PIN, Agenten ohne Sitzung und ohne Origin.
import { createApp } from "../src/app.ts";
import { FIXTURE_PIN, type Fixture } from "../src/fixture.ts";
import { SESSION_HEADER } from "../src/auth.ts";

export function deskHttp(fx: Fixture) {
	const base = `http://127.0.0.1:${fx.cfg.port}`;
	let token = "";
	const request = (p: string, init: RequestInit = {}) => createApp(fx.desk).request(base + p, init);
	const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
	return {
		base,
		request,
		/** Anmelden mit der Test-PIN; danach schickt web() den Sitzungs-Header mit. */
		async login(pin = FIXTURE_PIN) {
			const r = await request("/api/auth/login", json("POST", { pin }, { Origin: base }));
			if (r.status !== 200) throw new Error(`login ${r.status}: ${await r.text()}`);
			token = ((await r.clone().json()) as { token: string }).token;
			return r;
		},
		get token() {
			return token;
		},
		/** Der Sitzungs-Header, wie ihn die Desk-Seite schickt. */
		get session(): Record<string, string> {
			return { [SESSION_HEADER]: token };
		},
		/** Du im Browser: Sitzung und Origin des Desks. */
		web: (p: string, method = "POST", body: unknown = {}) => request(p, json(method, body, { Origin: base, [SESSION_HEADER]: token })),
		/** Lesen im Browser (gleicher Origin: ohne Origin-Header, mit Sitzung). */
		webGet: (p: string) => request(p, { headers: { [SESSION_HEADER]: token } }),
		/** Ein Agent über cli/desk.py: keine Sitzung, kein Origin. */
		cli: (p: string, body: unknown = {}, method = "POST") => request(p, json(method, body)),
		get: (p: string) => request(p),
	};
}
