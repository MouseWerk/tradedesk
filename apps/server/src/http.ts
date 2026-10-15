// Der einzige HTTP-Client des Servers: Zeitlimit, User-Agent, Fehlertext an einer Stelle.
// Ein Test prüft, dass kein anderes Modul selbst fetch() aufruft.
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
