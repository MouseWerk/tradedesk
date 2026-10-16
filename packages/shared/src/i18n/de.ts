// Texte der gemeinsamen Logik, die Server und Web-App zeigen: Risikoprüfung, Status- und Seitennamen, CSV-Import,
// Prüfmeldungen der Schemas. Deutsch mit „du“ (AICodeGuidelines design/writing.md, Begriffe in docs/GLOSSARY.md).
// Texte mit Werten sind kleine Funktionen; Zahlen und Beträge kommen schon formatiert herein.

const plural = (n: number, one: string, other: string) => (n === 1 ? one : other);

export const sharedDe = {
	/** Name eines Vorschlags-Status (ProposalStatus) */
	status: {
		pending: "wartet auf dich",
		open: "Limit offen",
		placed: "beim Broker",
		sending: "wird gesendet",
		confirm: "Broker fragt nach",
		filled: "ausgeführt",
		rejected: "abgelehnt",
		stale: "Kurs bewegt",
		expired: "abgelaufen",
		cancelled: "storniert",
	},
	/** Kauf oder Verkauf (Side) */
	side: { buy: "Kauf", sell: "Verkauf" },
	money: {
		notRepresentable: (eur: string) => `Betrag ${eur} € ist nicht darstellbar.`,
	},
	/** Risikoprüfung (checkOrder): Verstöße blockieren, Hinweise nicht */
	check: {
		killSwitch: "Not-Aus ist aktiv – keine Orders, bis du ihn ausschaltest.",
		qtyPositive: "Stückzahl muss größer als 0 sein.",
		qtyDecimals: (max: number) => `Stückzahl mit höchstens ${max} Nachkommastellen.`,
		limitWithoutPrice: "Limit-Order ohne Limitkurs.",
		stopInvalid: "Stop-Loss ist keine gültige Zahl.",
		targetInvalid: "Kursziel ist keine gültige Zahl.",
		noQuote: (symbol: string) => `Kein aktueller Kurs für ${symbol} – ohne Kurs keine Order.`,
		valueNotRepresentable: "Orderwert ist nicht darstellbar – Stückzahl und Kurs prüfen.",
		valueBelowCent: "Orderwert unter einem Cent – keine Order.",
		noShortSelling: (held: string, symbol: string) => `Im Depot sind nur ${held} Stück ${symbol} – Leerverkäufe gibt es hier nicht.`,
		stopTargetIgnoredOnSell: "Stop-Loss und Kursziel gelten nur für Käufe und werden ignoriert.",
		notEnoughCash: (needed: string, available: string) => `Nicht genug Cash: benötigt ${needed}, verfügbar ${available}.`,
		positionLimit: (symbol: string, after: string, limit: string) => `${symbol} hätte danach ${after} % des Depots – Grenze ${limit} %.`,
		dailyLoss: (loss: string, limit: string) => `Tagesverlust ${loss} % erreicht die Grenze von ${limit} % – heute keine Käufe mehr.`,
		stopAboveEntry: "Stop-Loss muss unter dem Kaufkurs liegen.",
		riskNotRepresentable: "Risiko bis Stop ist nicht darstellbar.",
		riskLimit: (risk: string, pct: string, limit: string) => `Risiko bis Stop ${risk} = ${pct} % des Depots – Grenze ${limit} % je Trade.`,
		agentNeedsStop: "Käufe von Agenten brauchen einen Stop-Loss.",
		noStop: "Ohne Stop-Loss ist das Risiko dieser Order nicht begrenzt.",
		targetBelowEntry: "Kursziel muss über dem Kaufkurs liegen.",
		orderLimit: (value: string, limit: string) => `Orderwert ${value} liegt über der Grenze von ${limit}.`,
		openProposals: (n: number, limit: number) => `Schon ${plural(n, "1 offener Vorschlag", `${n} offene Vorschläge`)} – Grenze ${limit}. Erst entscheiden lassen.`,
		limitTooFar: (pct: number) => `Limit liegt mehr als ${pct} % vom aktuellen Kurs entfernt – Tippfehler?`,
		limitFar: (pct: number) => `Limit liegt mehr als ${pct} % vom aktuellen Kurs entfernt.`,
		feeHigh: (pct: string) => `Gebühr ist ${pct} % des Orderwerts.`,
	},
	/** Prüfmeldungen der zod-Schemas */
	schema: {
		maxDecimals: (n: number) => `höchstens ${n} Nachkommastellen`,
	},
	/** CSV-Import (parseTradesCsv) */
	csv: {
		empty: "Datei ist leer.",
		missingColumns: (n: number, columns: string) => `Kopfzeile ohne ${plural(n, "Spalte", "Spalten")} ${columns} – erwartet z. B. „datum;symbol;seite;stueck;kurs;gebuehr;waehrung“.`,
		invalid: (line: number, fields: string) => `Zeile ${line}: ${fields} ungültig.`,
		noFx: (line: number, currency: string) => `Zeile ${line}: ${currency} ohne Wechselkurs – Spalte fx (EUR je ${currency} am Handelstag) oder betrag_eur angeben.`,
		/** Namen der Felder in „Zeile 3: Datum, Kurs ungültig.“ */
		field: {
			date: "Datum",
			symbol: "Symbol",
			side: "Seite (kauf/verkauf)",
			qty: "Stück",
			price: "Kurs",
			fee: "Gebühr",
			currency: "Währung",
			fx: "Wechselkurs",
		},
	},
};
