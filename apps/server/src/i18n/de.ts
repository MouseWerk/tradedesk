// Texte des Servers: was der Desk dir und den Agenten sagt – API-Fehler, Verlauf und Chat, Broker, Kurse und die
// Konsole beim Start. Begriffe nach docs/GLOSSARY.md. Werte kommen fertig formatiert (num(), Datum, Betrag); Zahlen
// nur, wo die Mehrzahl daran hängt.
const plural = (n: number, one: string, other: string) => (n === 1 ? one : other);
const count = (n: number) => n.toLocaleString("de-DE");

export const de = {
	/* app.ts: HTTP-Schicht der API */
	api: {
		forbiddenHost: "Unbekannte Adresse – der Desk antwortet nur unter seiner eigenen Adresse und seinem Port.",
		tooLarge: "Anfrage zu groß.",
		forbidden: "Nicht erlaubt – Änderungen nur als JSON und nur von der Seite des Desks.",
		notLoggedIn: "Nicht angemeldet – mit deiner PIN anmelden.",
		notLoggedInBrowser: "Nicht angemeldet – im Browser mit deiner PIN anmelden.",
		serverError: (msg: string) => `Serverfehler: ${msg}`,
		ownerOnly: "Nur im Browser mit deiner Anmeldung – das entscheidet der Mensch, nicht ein Agent.",
		invalidJson: "Ungültiges JSON.",
		jsonObject: "JSON-Objekt erwartet.",
		loginBrowserOnly: "Anmelden nur im Browser.",
		pinSetUp: "PIN eingerichtet",
		invalidId: "Ungültige ID.",
		chartRange: "range: 1d, 1mo, 3mo, 6mo, 1y oder 5y",
		noQuote: (symbol: string) => `Kein Kurs für ${symbol}.`,
		killOnOff: "on: true oder false",
		notFound: "Nicht gefunden.",
		webNotBuilt: "Web-App nicht gebaut: npm run build",
	},

	/* http.ts: Abrufe bei Yahoo und beim lokalen Gateway */
	http: {
		status: (status: number) => `HTTP ${status}`,
		noAnswer: (sec: string) => `keine Antwort nach ${sec} s`,
		unreachable: (msg: string) => `nicht erreichbar (${msg})`,
		localOnly: (host: string) => `nur lokale Gateways erlaubt, nicht ${host}`,
	},

	/* auth.ts: PIN und Einrichtungscode */
	auth: {
		pinFormat: "PIN: 4 bis 12 Ziffern.",
		tooManyFails: (sec: number) => `Zu viele Fehlversuche – in ${count(sec)} s erneut versuchen.`,
		pinAlreadySet: "Die PIN ist schon gesetzt – mit der PIN anmelden.",
		noSetupCode: "Kein Einrichtungscode aktiv – den Desk neu starten, der Code steht dann in seiner Konsole.",
		setupCodeWrong: "Einrichtungscode stimmt nicht – er steht in der Konsole, in der der Desk läuft.",
		noPinYet: "Noch keine PIN gesetzt – zuerst mit dem Einrichtungscode aus der Konsole einrichten.",
		pinWrong: "PIN falsch.",
	},

	/* config.ts: Standardwerte und Warnungen beim Lesen von config.json */
	config: {
		defaultUser: "Ich",
		paperBroker: "Papier",
		manualBroker: "Broker",
		paperDepot: "Papierdepot",
		agentDepot: (name: string) => `Papierdepot ${name}`,
		listenIgnored: (addr: string) => `listen: ${addr} ignoriert – nur Tailscale-Adressen (100.64.0.0/10) sind erlaubt.`,
	},

	/* db.ts */
	db: {
		newerVersion: (file: string, version: number, known: number) => `Datenbank ${file} stammt aus einer neueren Version (${version} > ${known}) – bitte die neuere Version starten.`,
	},

	/* index.ts: Konsole beim Start, nur für dich */
	startup: {
		pinReset: (file: string) => `PIN und Sitzungen gelöscht (${file}). Beim nächsten Start zeigt der Desk hier einen neuen Einrichtungscode.`,
		ibkrQuotesWithoutDepot: "quotes „ibkr“ braucht ein IBKR-Depot (kind „broker“) – Kurse weiter von Yahoo.",
		firstQuotes: "erster Kursabruf:",
		alsoOn: (url: string) => `Tradedesk auch auf ${url} (nur deine Tailscale-Geräte, Anmeldung mit PIN)`,
		listenFailed: (addr: string, msg: string) => `listen ${addr}: ${msg}`,
		addrNotAvailable: "Adresse gibt es auf diesem Computer nicht – läuft Tailscale?",
		listenAfterPin: (addrs: string) => `listen: ${addrs} erst nach dem Festlegen der PIN.`,
		running: (url: string, depots: number, agents: number, market: string, quotes: string, home: string) =>
			`Tradedesk läuft auf ${url}  (${plural(depots, "1 Depot", `${count(depots)} Depots`)}, ${plural(agents, "1 Agent", `${count(agents)} Agenten`)}, Markt ${market}, Kurse ${quotes}, Daten ${home})`,
		setupCode: (code: string) => `PIN festlegen: Einrichtungscode ${code} – im Browser eingeben und eine PIN (4–12 Ziffern) wählen.`,
		brokers: (ids: string, liveTrading: boolean, liveDepots: string) => `Broker: ${ids} – Live-Handel ${liveTrading ? "AN" : "aus"}${liveDepots ? ` (Depots mit echtem Geld: ${liveDepots})` : ""}`,
		portInUse: (port: number) => `Port ${port} ist belegt – läuft schon ein Tradedesk?`,
	},

	/* broker.ts: IBKR-Gateway und Fake-Broker */
	broker: {
		notLoggedIn: "Im Gateway nicht angemeldet.",
		notLoggedInShort: "nicht angemeldet",
		emptyAnswer: "leere Antwort des Brokers",
		unknownAnswer: (raw: string) => `unbekannte Antwort: ${raw}`,
		accountNotTradable: (account: string, found: string) => `Konto ${account} ist in dieser Sitzung nicht handelbar (gefunden: ${found || "keins"}).`,
		gateway: (msg: string) => `Gateway: ${msg}`,
		sessionNotReady: "IBKR-Sitzung nicht bereit.",
		conidFromConfig: (symbol: string) => `${symbol} (conid aus config.json)`,
		noCryptoFx: (symbol: string) => `${symbol}: Krypto und Devisen handelt der Desk nicht über IBKR.`,
		exchangeUnmapped: (symbol: string, suffix: string) => `${symbol}: Börse „.${suffix}“ ist nicht zugeordnet – conid in config.json unter „conids“ eintragen.`,
		noContract: (symbol: string) => `${symbol}: kein passender Kontrakt bei IBKR gefunden.`,
		manyContracts: (symbol: string, list: string) => `${symbol}: mehrere Kontrakte (${list}) – eindeutige conid in config.json unter „conids“ eintragen.`,
		unknownReply: "unbekannte Rückfrage",
		fakeContract: (symbol: string) => `${symbol} (Fake)`,
	},

	/* feed.ts */
	feed: {
		ibkrQuotes: (msg: string) => `IBKR-Kurse: ${msg}`,
	},

	/* market.ts: Yahoo, Markt aus und Fake-Börse */
	market: {
		invalidSymbol: (symbol: string) => `ungültiges Symbol ${symbol}`,
		noQuotes: (symbol: string) => `keine Kurse für ${symbol}`,
		off: (symbol: string) => `Marktdaten sind ausgeschaltet („market“: „off“) – kein Chart für ${symbol}`,
		fakeUnknown: (symbol: string) => `unbekannt: ${symbol}`,
		fakeUnreachable: "Fake-Börse: nicht erreichbar",
		unreachable: "nicht erreichbar",
		fakeNoQuotes: "Fake-Börse: keine Kurse",
		fakeNewsPublisher: "Fake-Nachrichten",
		fakeNewsEarnings: (name: string) => `${name}: Quartalszahlen über den Erwartungen`,
		fakeNewsAnalyst: (name: string) => `Analyst hebt Kursziel für ${name} an`,
	},

	/* desk/core.ts und was mehrere Module des Desks gleich sagen */
	core: {
		qty: "Stückzahl",
		price: "Kurs",
		qtyInvalid: (what: string) => `${what}: größer als 0, höchstens 10 Mio. und höchstens 6 Nachkommastellen.`,
		priceInvalid: (what: string) => `${what}: größer als 0, höchstens 10 Mio. und höchstens 8 Nachkommastellen.`,
		feeInvalid: (max: string) => `Gebühr in EUR zwischen 0 und ${max}, höchstens 2 Nachkommastellen.`,
		unknownDepot: (id: string) => `Unbekanntes Depot ${id}.`,
		unknownAgent: (name: string) => `Unbekannter Agent „${name}“ – in config.json unter „agents“ eintragen.`,
		fewerShares: (qty: string, symbol: string) => `Im Depot sind weniger als ${qty} Stück ${symbol}.`,
		fewerSharesAt: (date: string, qty: string, symbol: string) => `Am ${date} waren weniger als ${qty} Stück ${symbol} im Depot – Zeitpunkt prüfen.`,
	},

	/* desk/book.ts */
	book: {
		tradeTime: "Zeitpunkt: ab 1990 und nicht in der Zukunft.",
	},

	/* desk/risk.ts */
	risk: {
		invalidLimit: (field: string, msg: string) => `Ungültige Grenze: ${field} – ${msg}`,
		limitsChanged: (depot: string) => `Grenzen für ${depot} geändert`,
		killOn: "Not-Aus eingeschaltet – keine Freigaben und keine Ausführungen",
		killOff: "Not-Aus ausgeschaltet",
	},

	/* desk/market.ts: Kurse, Watchlist, Suche, Charts, Alarme, News */
	quotes: {
		noNewQuote: (symbols: string, more: number) => `Kein neuer Kurs für ${symbols}${more > 0 ? ` und ${count(more)} weitere` : ""}`,
		age: (minutes: number) => `${count(minutes)} min`,
		stale: (symbol: string, age: string, maxSec: number) => `Kein aktueller Kurs für ${symbol} – der letzte ist ${age} alt (Grenze ${count(maxSec)} s während der Handelszeit).`,
		staleFx: (currency: string, age: string | null) => `Kein aktueller Wechselkurs ${currency}/EUR${age ? ` – der letzte ist ${age} alt` : ""}.`,
		invalidSymbol: "Ungültiges Symbol – Yahoo-Schreibweise, z. B. SAP.DE, AAPL, EUNL.DE oder BTC-EUR.",
		symbolNotFound: (symbol: string) => `Kein Kurs für ${symbol} gefunden – Symbol prüfen (Yahoo-Schreibweise, z. B. SAP.DE).`,
		watchAdded: (symbol: string) => `${symbol} auf die Watchlist`,
		watchRemoved: (symbol: string) => `${symbol} von der Watchlist`,
		searchFailed: (msg: string) => `Suche nicht möglich: ${msg}`,
		chartFailed: (symbol: string, msg: string) => `Chart für ${symbol} nicht verfügbar: ${msg}`,
		newsFailed: (symbol: string, msg: string) => `News für ${symbol} nicht verfügbar: ${msg}`,
		alertOp: "Alarm: über oder unter?",
		alertPrice: "Alarm: Kurs",
		alertAdded: (symbol: string, above: boolean, price: string) => `Alarm ${symbol} ${above ? "über" : "unter"} ${price}`,
		alertHit: (symbol: string, above: boolean, price: string, now: string) => `Alarm ${symbol} ${above ? "über" : "unter"} ${price} – jetzt ${now}`,
	},

	/* desk/proposals.ts: Vorschläge, Freigabe, Storno, Ausführung, Abläufe, Stop und Ziel */
	proposals: {
		unknown: (id: number) => `Unbekannter Vorschlag ${id}.`,
		overBudget: (cost: string, free: string, budget: string) => `Über dem Agenten-Budget: der Kauf bindet ${cost}, frei sind noch ${free} von ${budget} (echtes Geld, alle Agenten zusammen).`,
		budgetUnpriced: "Ein offener Agenten-Kauf hat keinen Kurs oder Wechselkurs – das Agenten-Budget ist gerade nicht prüfbar.",
		unpriced: (n: number, ids: string) => `${plural(n, "Freigegebene Order", "Freigegebene Orders")} ${ids} ohne Kurs oder Wechselkurs – das gebundene Cash ist nicht prüfbar.`,
		reservedCash: (eur: string) => `Freigegebene, noch offene Orders binden ${eur} – im verfügbaren Cash schon abgezogen.`,
		reservedSell: (qty: string, symbol: string) => `${qty} Stück ${symbol} sind schon in offenen Verkaufsorders gebunden.`,
		unknownField: (field: string, allowed: string) => `Ungültiger Vorschlag: unbekanntes Feld „${field}“ – erlaubt: ${allowed}.`,
		invalid: (field: string, msg: string) => `Ungültiger Vorschlag: ${field} – ${msg}`,
		ownThesis: "Eigene Order",
		notAllowed: (author: string, depot: string) => `${author} darf nicht für ${depot} vorschlagen – nur fürs eigene Papierdepot oder deine Depots.`,
		noBroker: (depot: string) => `${depot}: keine Verbindung zum Broker eingerichtet.`,
		manualDepot: (depot: string) => `${depot} führst du beim Broker aus – dort ausgeführte Trades mit „Trade erfassen…“ eintragen.`,
		notWatched: (symbol: string) => `${symbol} steht nicht auf der Watchlist und nicht im Depot.`,
		lowConfidence: (pct: number, min: number) => `Zuversicht ${pct} % liegt unter dem Mindestwert von ${min} %.`,
		marketWithLimit: "Market-Order mit Limitkurs – orderType „limit“ verwenden oder den Limitkurs weglassen.",
		waitingBuys: (n: number) =>
			`${plural(n, "Zusammen mit einem wartenden Kaufvorschlag reicht das Cash nicht für beide", `Zusammen mit ${count(n)} wartenden Kaufvorschlägen reicht das Cash nicht für alle`)} – bei der Freigabe wird neu geprüft.`,
		blocked: (order: string, why: string) => `Vorschlag ${order} nicht angelegt: ${why}`,
		proposed: (author: string, order: string, depot: string, id: number) => `${author} schlägt vor: ${order} (${depot}) #${id}`,
		autoTraded: (author: string, order: string, depot: string, id: number) => `${author} handelt automatisch: ${order} (${depot}) #${id}`,
		autoBy: "Automatik (Papier)",
		moved: (pct: string, from: string, to: string, currency: string) => `Kurs hat sich um ${pct} bewegt (${from} → ${to} ${currency}) – nichts ausgeführt. Agent soll neu vorschlagen.`,
		movedAtOpen: (pct: string, from: string, to: string, currency: string) => `Kurs hat sich bis zur Eröffnung um ${pct} bewegt (${from} → ${to} ${currency}) – nichts ausgeführt.`,
		riskBeforeSend: (violations: string) => `Risikoprüfung vor dem Senden: ${violations}`,
		decided: "Dieser Vorschlag wurde schon entschieden.",
		liveOff: (broker: string) => `Live-Handel ist aus – in config.json „liveTrading“: true setzen, um echte Orders an ${broker} zu senden.`,
		manualApproved: (order: string, broker: string) => `${order} freigegeben – jetzt in ${broker} ausführen und die Ausführung eintragen.`,
		limitOpen: (order: string, limit: string, currency: string) => `${order} freigegeben – Limit ${limit} ${currency} offen.`,
		waitsForOpen: "wartet auf den Handelsbeginn",
		approvedWaits: (order: string) => `${order} freigegeben – wartet auf den Handelsbeginn.`,
		filled: (order: string, price: string, currency: string, depot: string) => `${order} zu ${price} ${currency} ausgeführt (${depot})`,
		tooMany: (max: string) => `Freigeben darfst du höchstens ${max} Stück – mehr als vorgeschlagen geht nicht.`,
		staleWaits: (stale: string) => `${stale} Nichts ausgeführt, der Vorschlag wartet weiter.`,
		rejectedByYou: "von dir abgelehnt",
		rejected: (order: string, author: string, why: string) => `${order} von ${author} abgelehnt${why ? `: ${why}` : ""}`,
		cancelFailed: (broker: string, msg: string) => `Storno bei ${broker} fehlgeschlagen: ${msg}`,
		cancelRequested: "Storno beim Broker angefragt",
		cancelSent: (order: string, broker: string) => `${order}: Storno an ${broker} gesendet`,
		cancelledByYou: "von dir storniert",
		notCancellable: "Nur offene Limits, Broker-Rückfragen und noch nicht eingetragene Broker-Orders lassen sich stornieren.",
		cancelled: (order: string) => `${order} storniert`,
		fillOnlyPlaced: "Nur freigegebene Broker-Orders lassen sich als ausgeführt eintragen.",
		fillAutomatic: (broker: string) => `Ausführungen von ${broker} kommen automatisch über die API.`,
		fillQtyRange: (max: string) => `Stück zwischen 0 und ${max}.`,
		fillPrice: "Ausführungskurs in EUR",
		alreadyFilled: "Schon eingetragen.",
		filledAt: (order: string, price: string, broker: string) => `${order} zu ${price} € in ${broker} ausgeführt`,
		limitReached: "Limit erreicht",
		marketOpen: "Börse offen",
		riskAfter: (what: string, violations: string) => `${what}, aber Risikoprüfung: ${violations}`,
		notFilledRisk: (order: string, what: string, violation: string) => `${order}: ${what}, nicht ausgeführt – ${violation}`,
		noteLimit: "Limit",
		noteOpening: "Eröffnung",
		filledOpen: (order: string, price: string, currency: string, how: string, depot: string) => `${order} zu ${price} ${currency} ausgeführt (${how}, ${depot})`,
		viaLimit: (limit: string) => `Limit ${limit}`,
		atOpening: "zur Eröffnung",
		replyExpired: "Rückfrage des Brokers nicht innerhalb von 15 Minuten bestätigt – nichts gesendet.",
		replyExpiredEvent: (order: string) => `${order}: Rückfrage des Brokers abgelaufen – nichts gesendet.`,
		notDecidedInTime: "nicht rechtzeitig entschieden",
		notFilled: "nicht ausgeführt",
		expired: (order: string, author: string) => `${order} von ${author} abgelaufen`,
		stopHit: (symbol: string, stop: string, depot: string) => `${symbol} hat den Stop-Loss ${stop} erreicht (${depot}) – Verkauf prüfen.`,
		targetHit: (symbol: string, target: string, depot: string) => `${symbol} hat das Kursziel ${target} erreicht (${depot}).`,
	},

	/* desk/broker.ts: senden, Rückfrage, Abruf, Abgleich */
	brokerFlow: {
		noBroker: (depot: string) => `${depot}: keine Broker-Verbindung eingerichtet.`,
		notChecked: "Noch nicht geprüft.",
		noBrokerStatus: "Keine Broker-Verbindung eingerichtet.",
		paperSession: "das Gateway ist mit einem Papierkonto angemeldet, das Depot ist aber für echtes Geld eingetragen",
		sent: (order: string, broker: string, orderId: string, live: boolean) => `${order} an ${broker} gesendet (Order ${orderId}, ${live ? "echtes Geld" : "Papierkonto"})`,
		asks: (order: string, broker: string, question: string) => `${order}: ${broker} fragt nach – „${question}“ – bitte unter Orders bestätigen oder stornieren.`,
		unknownResult: (broker: string, msg: string) => `Keine sichere Antwort von ${broker} (${msg}) – Ergebnis unbekannt. Der Desk sucht die Order über ihre ID und sendet nicht erneut.`,
		rejectedBy: (order: string, broker: string, msg: string) => `${order}: ${broker} hat abgelehnt – ${msg}`,
		noReply: "Hier gibt es keine offene Rückfrage des Brokers.",
		killActive: "Not-Aus ist aktiv – keine Orders, bis du ihn ausschaltest.",
		liveOff: "Live-Handel ist aus – in config.json „liveTrading“: true setzen.",
		staleWaits: (stale: string) => `${stale} Nichts gesendet, die Rückfrage wartet weiter.`,
		loginFirst: (broker: string, msg: string) => `${broker}: ${msg} – erst im Gateway anmelden, dann bestätigen.`,
		alreadyConfirmed: "Schon bestätigt.",
		found: (order: string, broker: string, orderId: string) => `${order}: bei ${broker} gefunden (Order ${orderId}).`,
		interruptedReason: (broker: string) => `Senden an ${broker} unterbrochen – Order dort nicht gefunden. Bei ${broker} prüfen; der Desk sendet nicht erneut.`,
		interrupted: (order: string, broker: string) => `${order}: Senden an ${broker} unterbrochen – bitte dort prüfen.`,
		partial: (qty: string, want: string) => `teilweise ausgeführt: ${qty} von ${want} Stück`,
		partialRest: (partial: string, rest: string) => `${partial}, Rest ${rest}`,
		lateFill: (order: string, before: string, broker: string, qty: string) => `${order}: nach „${before}“ doch bei ${broker} ausgeführt (${qty} Stück) – Bestand prüfen.`,
		filled: (order: string, broker: string, price: string | null) => `${order} bei ${broker} ausgeführt${price ? ` zu ${price}` : ""}`,
		cancelledAt: (broker: string) => `bei ${broker} storniert`,
		rejectedAt: (broker: string) => `von ${broker} abgelehnt`,
		unlisted: (broker: string) => `bei ${broker} nicht mehr gelistet – dort prüfen`,
		inactiveMessage: (broker: string) => `${broker} meldet „Inactive“ – die Order arbeitet nicht, kann aber wieder aktiv werden (z. B. außerhalb der Handelszeit). Bei ${broker} prüfen.`,
		inactive: (order: string, broker: string) => `${order}: ${broker} meldet „Inactive“ – bitte dort prüfen.`,
		mismatch: (broker: string, execId: string, id: number, got: string, want: string) =>
			`${broker}: Ausführung ${execId} trägt die Order-ID von #${id}, aber einen anderen Kontrakt (${got} statt ${want}) – nicht diesem Vorschlag zugeordnet.`,
		unmapped: (broker: string, conid: string) => `${broker}: Ausführung für Kontrakt ${conid} ohne Symbol – in config.json unter „conids“ zuordnen, dann „Mit ${broker} abgleichen“.`,
		waits: (broker: string, qty: string, symbol: string, what: string) => `${broker}: Ausführung ${qty} ${symbol} wartet auf ${what} – wird gebucht, sobald er da ist.`,
		waitsFx: (currency: string) => `den Wechselkurs ${currency}/EUR`,
		waitsCurrency: "Kursdaten (Währung)",
		notBrokerDepot: (depot: string) => `${depot} ist kein Broker-Depot.`,
		cashNote: (broker: string, currency: string | null) => `Cash bei ${broker} in ${currency ?? "unbekannter Basiswährung"} – der Desk gleicht nur EUR ab.`,
		notLoggedIn: (broker: string) => `${broker}: nicht angemeldet – erst im Gateway anmelden.`,
		reconcileNote: (broker: string) => `Abgleich ${broker}`,
		reconciled: (depot: string, broker: string, n: number, skipped: string) =>
			`${depot} mit ${broker} abgeglichen (${plural(n, "1 Unterschied", `${count(n)} Unterschiede`)} übernommen)${skipped ? ` – ohne Kurs oder Wechselkurs nicht übernommen: ${skipped}` : ""}`,
	},

	/* desk/manual.ts: Trades von Hand, Cash, CSV-Import */
	manual: {
		notManual: (depot: string) => `${depot} ist kein manuelles Depot – dort gibt es Orders statt erfasster Trades.`,
		sideMissing: "Kauf oder Verkauf?",
		laterSellUncovered: "Dieser Trade lässt einen späteren Verkauf ungedeckt.",
		recorded: (side: string, qty: string, symbol: string, price: string, depot: string) => `${side} ${qty} ${symbol} zu ${price} € erfasst (${depot})`,
		buyHasSells: "Spätere Verkäufe hängen an diesem Kauf – zuerst den Verkauf löschen.",
		restoreUncovered: (date: string) => `Der Verkauf vom ${date} wäre nicht mehr gedeckt – nicht wiederhergestellt.`,
		nothingToRestore: "Nichts zum Wiederherstellen.",
		onlyOwnTrades: "Nur selbst erfasste oder importierte Trades lassen sich löschen.",
		tradeDeleted: (id: number, depot: string, restored: boolean) => `Trade ${id} in ${depot} ${restored ? "wiederhergestellt" : "gelöscht"}`,
		amountInvalid: "Betrag in EUR mit höchstens 2 Nachkommastellen (bis 100 Mio.), positiv für Einzahlung, negativ für Auszahlung.",
		overdraw: "Auszahlung größer als das Cash im Depot.",
		cashMoved: (deposit: boolean, eur: string, depot: string) => `${deposit ? "Einzahlung" : "Auszahlung"} ${eur} € (${depot})`,
		csvUncovered: (line: number, qty: string, symbol: string, date: string) => `Zeile ${line}: Verkauf ${qty} ${symbol} am ${date} – zu dem Zeitpunkt nicht genug Stück im Depot.`,
		emptyFile: "Leere Datei.",
		fileTooLarge: "Datei zu groß (höchstens 2 MB).",
		inFuture: "liegt in der Zukunft",
		before1990: "liegt vor 1990",
		badDate: (line: number, why: string) => `Zeile ${line}: Datum ${why}.`,
		imported: (n: number, depot: string, skipped: number) => `${plural(n, "1 Trade", `${count(n)} Trades`)} in ${depot} importiert${skipped ? `, ${count(skipped)} schon vorhanden` : ""}`,
	},

	/* desk/journal.ts: Journal und Chat */
	journal: {
		textInvalid: "Text fehlt oder ist länger als 4000 Zeichen.",
		emptyMessage: "Leere Nachricht.",
		messageTooLong: "Nachricht länger als 4000 Zeichen.",
	},

	/* desk/analytics.ts */
	analytics: {
		badDate: (what: string) => `${what}: Datum als JJJJ-MM-TT, z. B. 2026-10-01.`,
		fromAfterTo: "from liegt nach to.",
	},

	/* desk/desk.ts: Takt */
	desk: {
		closeReminder: (exchange: string, positions: string) => `${exchange} schließt in 15 Minuten – heute eröffnet und noch offen: ${positions}.`,
	},
};
