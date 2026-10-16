// Der einzige HTTP-Client des Servers: Zeitlimit, User-Agent, Fehlertext an einer Stelle.
// Ein Test prüft, dass kein anderes Modul selbst fetch() aufruft.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

export class HttpError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export async function httpJson<T>(url: string, { timeoutMs = 8_000 }: { timeoutMs?: number } = {}): Promise<T> {
	let r: Response;
	try {
		r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (tradedesk)", Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
	} catch (e) {
		const name = (e as Error).name;
		throw new HttpError(name === "TimeoutError" ? `keine Antwort nach ${timeoutMs / 1000} s` : `nicht erreichbar (${(e as Error).message})`, 0);
	}
	if (!r.ok) throw new HttpError(`HTTP ${r.status}`, r.status);
	return (await r.json()) as T;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * JSON an ein lokales Gateway (IBKR Client Portal Gateway auf https://localhost:5000). Dessen Zertifikat ist
 * selbstsigniert; die Prüfung entfällt deshalb – aber ausschließlich für localhost, nie für einen fremden Host.
 */
export async function localJson<T>(method: "GET" | "POST" | "DELETE", url: string, body?: unknown, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<T> {
	const u = new URL(url);
	if (!LOCAL_HOSTS.has(u.hostname)) throw new HttpError(`nur lokale Gateways erlaubt, nicht ${u.hostname}`, 0);
	const request = u.protocol === "https:" ? httpsRequest : httpRequest;
	const data = body === undefined ? undefined : JSON.stringify(body);
	return new Promise<T>((resolve, reject) => {
		const req = request(
			u,
			{
				method,
				rejectUnauthorized: false,
				timeout: timeoutMs,
				headers: { "User-Agent": "tradedesk", Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
			},
			(res: IncomingMessage) => {
				let raw = "";
				res.setEncoding("utf8");
				res.on("data", (c: string) => (raw += c));
				res.on("end", () => {
					const status = res.statusCode ?? 0;
					let parsed: unknown = null;
					try {
						parsed = raw ? JSON.parse(raw) : null;
					} catch {
						// kein JSON (z. B. Login-Seite des Gateways)
					}
					if (status < 200 || status >= 300) {
						const msg = (parsed as { error?: string; message?: string } | null)?.error ?? (parsed as { message?: string } | null)?.message ?? raw.slice(0, 200);
						return reject(new HttpError(`HTTP ${status}${msg ? `: ${msg}` : ""}`, status));
					}
					resolve(parsed as T);
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error(`keine Antwort nach ${timeoutMs / 1000} s`)));
		req.on("error", (e: Error) => reject(new HttpError(`nicht erreichbar (${e.message})`, 0)));
		if (data) req.write(data);
		req.end();
	});
}
