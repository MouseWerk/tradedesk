// API-Verträge: ein zod-Schema je Antwort, die Typen werden daraus abgeleitet (eine Quelle, kein Auseinanderlaufen).
// Geld in Cent (Basiswährung EUR) als ganze Zahl; Kurse in der Währung des Wertpapiers; Stückzahlen bis 6 Nachkommastellen.
import { z } from "zod";
import { decimals } from "./portfolio.ts";
import { sharedDe } from "./i18n/de.ts";

/** Obergrenzen an der API-Grenze: was darüber liegt, ist ein Tippfehler oder ein Angriff, nie eine Order. */
export const MAX_QTY = 10_000_000;
export const MAX_PRICE = 10_000_000; // in Wertpapierwährung
export const MAX_EUR = 100_000_000; // Ein- und Auszahlungen, Gebühren, Grenzen
export const QtySchema = z.number().positive().max(MAX_QTY).refine((n) => decimals(n) <= 6, sharedDe.schema.maxDecimals(6));
export const PriceSchema = z.number().positive().max(MAX_PRICE).refine((n) => decimals(n) <= 8, sharedDe.schema.maxDecimals(8));

export const SideSchema = z.enum(["buy", "sell"]);
export type Side = z.infer<typeof SideSchema>;

export const AccountKindSchema = z.enum(["paper", "manual", "broker"]); // broker: Orders gehen über die API des Brokers (IBKR)
export type AccountKind = z.infer<typeof AccountKindSchema>;

export const ProposalStatusSchema = z.enum([
	"pending", // wartet auf deine Freigabe
	"open", // freigegeben, Limit noch nicht erreicht (nur Papierdepot)
	"placed", // freigegeben: manuelles Depot – du führst sie aus; Broker-Depot – beim Broker in Arbeit
	"sending", // wird gerade an den Broker gesendet
	"confirm", // der Broker fragt nach (z. B. Preisabweichung) – du bestätigst oder stornierst
	"filled",
	"rejected",
	"stale", // Kurs hat sich seit dem Vorschlag zu stark bewegt – nichts ausgeführt
	"expired",
	"cancelled",
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const AccountSchema = z.object({
	id: z.string(),
	name: z.string(),
	kind: AccountKindSchema,
	owner: z.string(), // "user" oder der Name eines Agenten
	broker: z.string(), // z. B. "Trade Republic"; Papierdepot: "Papier"
	feeCents: z.number().int(),
	startCashCents: z.number().int(),
	live: z.boolean(), // echtes Geld über eine Broker-API
});
export type Account = z.infer<typeof AccountSchema>;

export const AccountSummarySchema = AccountSchema.extend({
	cashCents: z.number().int(),
	marketValueCents: z.number().int(),
	equityCents: z.number().int(),
	costCents: z.number().int(), // Einstand der offenen Positionen
	unrealizedCents: z.number().int(),
	realizedCents: z.number().int(),
	feesCents: z.number().int(),
	dayChangeCents: z.number().int().nullable(), // null: noch kein Stand von gestern
	depositsCents: z.number().int(), // Startguthaben + Ein-/Auszahlungen
	returnPct: z.number().nullable(),
	positions: z.number().int(),
	missingQuotes: z.array(z.string()),
	oversoldTrades: z.array(z.number().int()), // Verkäufe, die zu ihrem Zeitpunkt mehr verkauften als da war (alte Daten, Broker-Import)
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

/**
 * Herkunft und Alter eines Kurses, damit die Oberfläche verzögert und Echtzeit unterscheiden kann. source: "yahoo",
 * "ibkr", "fake" (Fixture) oder "" (vor dem ersten Abruf mit dieser Version gespeichert). ageSec: Sekunden seit der
 * Kurszeit der Quelle (marketTime), ohne sie seit dem Abruf. delayed: laut Quelle verzögert; null = unbekannt (Yahoo
 * sagt es nicht – dort zeigt das Alter, wie alt der Kurs ist).
 */
export const QuoteInfoSchema = z.object({
	source: z.string(),
	fetchedAt: z.number(),
	marketTime: z.number().nullable(),
	ageSec: z.number().int(),
	delayed: z.boolean().nullable(),
	bid: z.number().nullable(),
	ask: z.number().nullable(),
});
export type QuoteInfo = z.infer<typeof QuoteInfoSchema>;

/** Kursquelle des Desks (config.json "quotes"; "fake" in der Fixture, "off" ohne Marktdaten). */
export const QuoteFeedSchema = z.enum(["yahoo", "ibkr", "fake", "off"]);

export const PositionSchema = z.object({
	symbol: z.string(),
	name: z.string(),
	currency: z.string(),
	qty: z.number(),
	avgPrice: z.number(), // Einstand je Stück in EUR (ohne Gebühr)
	costCents: z.number().int(),
	price: z.number().nullable(), // aktueller Kurs je Stück in EUR
	nativePrice: z.number().nullable(), // aktueller Kurs in Wertpapierwährung
	valueCents: z.number().int(),
	unrealizedCents: z.number().int(),
	unrealizedPct: z.number().nullable(),
	dayChangePct: z.number().nullable(),
	weightPct: z.number(),
	quoteTime: z.number().nullable(),
	stopLoss: z.number().nullable(), // aus dem letzten ausgeführten Vorschlag – nur Hinweis, keine automatische Order
	takeProfit: z.number().nullable(),
	quote: QuoteInfoSchema.nullable(), // null ohne Kurs
});
export type Position = z.infer<typeof PositionSchema>;

export const TradeSchema = z.object({
	id: z.number().int(),
	accountId: z.string(),
	symbol: z.string(),
	side: SideSchema,
	qty: z.number(),
	price: z.number(),
	currency: z.string(),
	fx: z.number(), // 1 Einheit Wertpapierwährung in EUR
	valueCents: z.number().int(),
	feeCents: z.number().int(),
	time: z.number(),
	source: z.enum(["manual", "proposal", "import", "order"]),
	proposalId: z.number().int().nullable(),
	note: z.string(),
	realizedCents: z.number().int().nullable(), // nur Verkäufe
});
export type Trade = z.infer<typeof TradeSchema>;

export const CashMoveSchema = z.object({ id: z.number().int(), accountId: z.string(), amountCents: z.number().int(), time: z.number(), note: z.string() });
export type CashMove = z.infer<typeof CashMoveSchema>;

export const CurvePointSchema = z.object({ day: z.string(), equityCents: z.number().int(), depositsCents: z.number().int() });
export type CurvePoint = z.infer<typeof CurvePointSchema>;

export const RiskLimitsSchema = z.object({
	accountId: z.string(),
	maxOrderCents: z.number().int().min(0).max(MAX_EUR * 100), // 0 = keine Grenze
	maxPositionPct: z.number().min(0).max(100), // Anteil am Depotwert nach der Order; 0 = keine Grenze
	dailyLossPct: z.number().min(0).max(100), // ab diesem Tagesverlust keine Käufe mehr; 0 = keine Grenze
	maxOpenProposals: z.number().int().min(0), // je Autor; 0 = keine Grenze
	maxRiskPct: z.number().min(0).max(100), // Verlust bis zum Stop je Trade in % des Depots; 0 = keine Grenze
	requireStop: z.boolean(), // Käufe von Agenten nur mit Stop-Loss
});
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

export const AccountDetailSchema = z.object({
	account: AccountSummarySchema,
	positions: z.array(PositionSchema),
	trades: z.array(TradeSchema),
	cashMoves: z.array(CashMoveSchema),
	curve: z.array(CurvePointSchema),
	risk: RiskLimitsSchema,
});
export type AccountDetail = z.infer<typeof AccountDetailSchema>;

export const EventSchema = z.object({ id: z.number().int(), time: z.number(), kind: z.string(), actor: z.string(), text: z.string() });
export type DeskEvent = z.infer<typeof EventSchema>;

/** Anlageklasse aus dem Instrumenttyp (Yahoo): EQUITY → equity, ETF → etf, CRYPTOCURRENCY → crypto, Cash, sonst other. */
export const AssetClassSchema = z.enum(["equity", "etf", "crypto", "cash", "other"]);
export type AssetClass = z.infer<typeof AssetClassSchema>;

/**
 * Aufteilung deiner Depots (owner "user") zum aktuellen Wert wie in den Depots (ohne Kurs: Einstand). pct bezieht sich
 * immer auf totalCents (Depotwert inkl. Cash) – bySymbol summiert sich darum mit dem Cash auf 100 %; null bei totalCents ≤ 0.
 */
export const AllocationSchema = z.object({
	totalCents: z.number().int(),
	byClass: z.array(z.object({ assetClass: AssetClassSchema, valueCents: z.number().int(), pct: z.number().nullable() })), // alle Klassen in fester Reihenfolge, auch 0
	bySymbol: z.array(z.object({ symbol: z.string(), name: z.string(), assetClass: AssetClassSchema, valueCents: z.number().int(), pct: z.number().nullable() })), // nach Wert absteigend
});
export type Allocation = z.infer<typeof AllocationSchema>;

export const EquityRangeSchema = z.enum(["1W", "1M", "3M", "YTD", "1Y", "all"]);
export type EquityRange = z.infer<typeof EquityRangeSchema>;

/**
 * Veränderung deiner Depots seit dem Tagesstand am Beginn des Zeitraums (letzter Stand am oder vor dem Starttag; YTD:
 * am oder vor dem 31.12. des Vorjahrs; all: der erste Stand) bis heute (Live-Wert). changeCents: Differenz des
 * Depotwerts; resultCents: dieselbe ohne Ein- und Auszahlungen dazwischen. Prozent auf den Depotwert am Beginn. Alles
 * null, wenn es keinen Stand so weit zurück gibt (oder der Depotwert damals ≤ 0 war: nur die Prozente).
 */
export const EquityChangeSchema = z.object({
	range: EquityRangeSchema,
	fromDay: z.string().nullable(),
	changeCents: z.number().int().nullable(),
	changePct: z.number().nullable(),
	resultCents: z.number().int().nullable(),
	resultPct: z.number().nullable(),
});
export type EquityChange = z.infer<typeof EquityChangeSchema>;

export const OverviewSchema = z.object({
	user: z.string(),
	baseCurrency: z.string(),
	killSwitch: z.boolean(),
	market: z.enum(["live", "off", "error"]),
	marketError: z.string().nullable(),
	quotesAt: z.number().nullable(),
	accounts: z.array(AccountSummarySchema),
	curve: z.array(CurvePointSchema), // Summe deiner Depots
	pending: z.number().int(),
	events: z.array(EventSchema),
	failedQuotes: z.array(z.string()), // Symbole, deren letzter Kursabruf fehlschlug, während andere ankamen
	quoteFeed: QuoteFeedSchema,
	allocation: AllocationSchema, // deine Depots nach Symbol und Anlageklasse
	changes: z.array(EquityChangeSchema), // 1W, 1M, 3M, YTD, 1Y, all – immer alle sechs
});
export type Overview = z.infer<typeof OverviewSchema>;

export const AlertSchema = z.object({ id: z.number().int(), symbol: z.string(), op: z.enum(["above", "below"]), price: z.number(), createdAt: z.number(), triggeredAt: z.number().nullable() });
export type Alert = z.infer<typeof AlertSchema>;

export const WatchItemSchema = z.object({
	symbol: z.string(),
	name: z.string(),
	currency: z.string(),
	exchange: z.string(),
	price: z.number().nullable(),
	prevClose: z.number().nullable(),
	changePct: z.number().nullable(),
	marketTime: z.number().nullable(),
	held: z.boolean(),
	watched: z.boolean(), // false: nur im Bestand, nicht auf der Watchlist
	alerts: z.array(AlertSchema),
	quote: QuoteInfoSchema.nullable(),
});
export type WatchItem = z.infer<typeof WatchItemSchema>;

export const SearchHitSchema = z.object({ symbol: z.string(), name: z.string(), exchange: z.string(), type: z.string() });
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const CandleSchema = z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() });
export type Candle = z.infer<typeof CandleSchema>;

export const ChartRangeSchema = z.enum(["1d", "5d", "1mo", "3mo", "6mo", "1y", "5y"]); // 1d: 1-Minuten-Kerzen, 5d: 5 Minuten
export type ChartRange = z.infer<typeof ChartRangeSchema>;

export const ChartSchema = z.object({ symbol: z.string(), name: z.string(), currency: z.string(), range: ChartRangeSchema, prevClose: z.number().nullable(), candles: z.array(CandleSchema) });
export type Chart = z.infer<typeof ChartSchema>;

export const OrderTypeSchema = z.enum(["market", "limit"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const ProposalSchema = z.object({
	id: z.number().int(),
	accountId: z.string(),
	author: z.string(),
	symbol: z.string(),
	name: z.string(),
	currency: z.string(),
	side: SideSchema,
	qty: z.number(),
	orderType: OrderTypeSchema,
	limitPrice: z.number().nullable(),
	stopLoss: z.number().nullable(),
	takeProfit: z.number().nullable(),
	confidence: z.number(),
	thesis: z.string(),
	status: ProposalStatusSchema,
	reason: z.string(), // Ablehnung, Ablauf, Kursbewegung
	quotePrice: z.number(), // Kurs beim Vorschlag
	price: z.number().nullable(), // aktueller Kurs
	estimateCents: z.number().int(), // geschätzter Orderwert in EUR (ohne Gebühr)
	warnings: z.array(z.string()),
	createdAt: z.number(),
	decidedAt: z.number().nullable(),
	decidedBy: z.string().nullable(),
	approvedQty: z.number().nullable(),
	expiresAt: z.number(),
	fillPrice: z.number().nullable(),
	brokerOrderId: z.string().nullable(),
	brokerMessage: z.string().nullable(), // Rückfrage des Brokers im Originaltext
	filledQty: z.number().nullable(), // beim Broker schon ausgeführte Stück (Teilausführung: weniger als approvedQty)
	riskCents: z.number().int().nullable(), // Verlust bis zum Stop inkl. Kauf- und Verkaufsgebühr; null ohne Stop
	riskPct: z.number().nullable(), // riskCents in % des Depotwerts
	targetR: z.number().nullable(), // Kursziel als Vielfaches des Risikos (R); null ohne Stop oder Ziel
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** Eingabe eines Vorschlags (Agent über cli/desk.py oder deine Order im Papierdepot). */
export const ProposalInputSchema = z.object({
	author: z.string().trim().min(1).max(40),
	accountId: z.string().trim().min(1).max(40),
	symbol: z.string().trim().min(1).max(24),
	side: SideSchema,
	qty: QtySchema,
	orderType: OrderTypeSchema.default("market"),
	limitPrice: PriceSchema.nullish(),
	stopLoss: PriceSchema.nullish(),
	takeProfit: PriceSchema.nullish(),
	confidence: z.number().min(0).max(1),
	thesis: z.string().trim().min(1).max(2000),
});
export type ProposalInput = z.infer<typeof ProposalInputSchema>;

export const CheckSchema = z.object({
	ok: z.boolean(),
	violations: z.array(z.string()), // blockieren
	warnings: z.array(z.string()), // nur Hinweis
	estimateCents: z.number().int(),
	feeCents: z.number().int(),
	price: z.number().nullable(),
});
export type Check = z.infer<typeof CheckSchema>;

export const JournalEntrySchema = z.object({
	id: z.number().int(),
	author: z.string(),
	kind: z.enum(["note", "thesis", "review"]),
	symbol: z.string().nullable(),
	text: z.string(),
	time: z.number(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export const AgentSummarySchema = z.object({
	name: z.string(),
	accountId: z.string().nullable(), // null: ohne eigenes Papierdepot (config "agentDepots": false)
	equityCents: z.number().int(),
	returnPct: z.number().nullable(),
	curve: z.array(CurvePointSchema),
	trades: z.number().int(),
	closed: z.number().int(), // Verkäufe mit Ergebnis
	winRate: z.number().nullable(),
	pending: z.number().int(),
	approved: z.number().int(),
	rejected: z.number().int(),
	lastActive: z.number().nullable(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentsDataSchema = z.object({
	agents: z.array(AgentSummarySchema),
	you: z.array(z.object({ accountId: z.string(), name: z.string(), returnPct: z.number().nullable(), curve: z.array(CurvePointSchema) })),
	journal: z.array(JournalEntrySchema),
});
export type AgentsData = z.infer<typeof AgentsDataSchema>;

/**
 * Agenten-Budget für echtes Geld (config "agentBudgetEur"): so viel dürfen Käufe aus Agenten-Vorschlägen in deinen
 * Depots mit echtem Geld (manuell, IBKR live) zusammen binden – Einstand gehaltener Käufe plus wartende und
 * freigegebene, noch nicht ausgeführte Käufe, je mit Gebühr.
 */
export const AgentBudgetSchema = z.object({
	budgetCents: z.number().int(),
	usedCents: z.number().int(),
	freeCents: z.number().int(), // mindestens 0; 0 auch, wenn ein offener Kauf ohne Kurs nicht bewertbar ist
	unpriced: z.boolean(),
	accounts: z.array(z.string()), // Depots, für die das Budget gilt
});
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

export const RiskDataSchema = z.object({
	killSwitch: z.boolean(),
	minConfidence: z.number(),
	staleMovePct: z.number(),
	proposalTtlHours: z.number(),
	agentBudget: AgentBudgetSchema.nullable(), // null: kein Budget in config.json
	accounts: z.array(z.object({ account: AccountSchema, limits: RiskLimitsSchema, dayLossPct: z.number().nullable() })),
});
export type RiskData = z.infer<typeof RiskDataSchema>;

export const ImportResultSchema = z.object({ imported: z.number().int(), skipped: z.number().int(), errors: z.array(z.string()) });
export type ImportResult = z.infer<typeof ImportResultSchema>;

/* ------------------------------------------------------------------ Daytrading */

export const SessionStateSchema = z.enum(["pre", "open", "post", "closed"]);

export const SessionInfoSchema = z.object({
	exchange: z.string(),
	timezone: z.string(),
	state: SessionStateSchema,
	preStart: z.number().nullable(),
	regStart: z.number().nullable(),
	regEnd: z.number().nullable(),
	postEnd: z.number().nullable(),
	symbols: z.number().int(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const ScanRowSchema = z.object({
	symbol: z.string(),
	name: z.string(),
	currency: z.string(),
	exchange: z.string(),
	state: SessionStateSchema,
	price: z.number().nullable(),
	changePct: z.number().nullable(),
	gapPct: z.number().nullable(), // Eröffnung gegen Vortagesschluss
	dayOpen: z.number().nullable(),
	dayHigh: z.number().nullable(),
	dayLow: z.number().nullable(),
	rangePos: z.number().nullable(), // 0 = Tagestief, 1 = Tageshoch
	volume: z.number().nullable(),
	relVolume: z.number().nullable(), // Volumen heute / Schnitt 20 Tage
	atrPct: z.number().nullable(), // ATR 14 Tage in % des Kurses
	marketTime: z.number().nullable(),
	held: z.boolean(),
	alerts: z.number().int(),
	quoteStale: z.boolean(), // Kurs während der Handelszeit älter als maxQuoteAgeSec oder letzter Abruf fehlgeschlagen
	quote: QuoteInfoSchema.nullable(),
});
export type ScanRow = z.infer<typeof ScanRowSchema>;

/** Größte Bewegungen im Universum (GET /api/market/movers) */
export const MoversSchema = z.object({ at: z.number().nullable(), count: z.number().int(), rows: z.array(ScanRowSchema) });
export type Movers = z.infer<typeof MoversSchema>;

export const AnalysisSchema = z.object({
	symbol: z.string(),
	name: z.string(),
	currency: z.string(),
	state: SessionStateSchema,
	price: z.number().nullable(),
	prevClose: z.number().nullable(),
	dayOpen: z.number().nullable(),
	dayHigh: z.number().nullable(),
	dayLow: z.number().nullable(),
	gapPct: z.number().nullable(),
	changePct: z.number().nullable(),
	ema9: z.number().nullable(), // auf 1-Minuten-Kerzen
	ema21: z.number().nullable(),
	vwap: z.number().nullable(),
	rsi14: z.number().nullable(),
	atr14: z.number().nullable(), // Tageskerzen
	relVolume: z.number().nullable(),
	candles: z.number().int(),
	asOf: z.number().nullable(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const NewsItemSchema = z.object({ title: z.string(), publisher: z.string(), time: z.number(), link: z.string() });
export type NewsItem = z.infer<typeof NewsItemSchema>;

export const DayStatsSchema = z.object({
	trades: z.number().int(),
	closed: z.number().int(),
	wins: z.number().int(),
	losses: z.number().int(),
	realizedCents: z.number().int(),
	winRate: z.number().nullable(),
	avgWinCents: z.number().int().nullable(),
	avgLossCents: z.number().int().nullable(),
	profitFactor: z.number().nullable(),
	largestLossCents: z.number().int().nullable(),
	feesCents: z.number().int(),
});

export const CockpitPositionSchema = z.object({
	accountId: z.string(),
	symbol: z.string(),
	name: z.string(),
	currency: z.string(),
	qty: z.number(),
	avgPrice: z.number(), // EUR
	price: z.number().nullable(), // EUR
	nativePrice: z.number().nullable(),
	unrealizedCents: z.number().int(),
	unrealizedPct: z.number().nullable(),
	stopLoss: z.number().nullable(), // Wertpapierwährung
	takeProfit: z.number().nullable(),
	r: z.number().nullable(),
	openedToday: z.boolean(),
});
export type CockpitPosition = z.infer<typeof CockpitPositionSchema>;

export const CockpitSchema = z.object({
	user: z.string(),
	killSwitch: z.boolean(),
	market: z.enum(["live", "off", "error"]),
	marketError: z.string().nullable(),
	quotesAt: z.number().nullable(),
	liveIntervalSec: z.number(),
	quoteFeed: QuoteFeedSchema,
	failedQuotes: z.array(z.string()),
	sessions: z.array(SessionInfoSchema),
	scan: z.array(ScanRowSchema),
	days: z.array(
		z.object({
			accountId: z.string(),
			name: z.string(),
			owner: z.string(),
			kind: AccountKindSchema,
			equityCents: z.number().int(),
			cashCents: z.number().int(),
			dayChangeCents: z.number().int().nullable(),
			dayLossPct: z.number().nullable(),
			openRiskCents: z.number().int(), // Risiko bis zum Stop: offene Positionen mit Stop (ab Kurs, mit Verkaufsgebühr) und freigegebene offene Käufe
			dayLossLimitCents: z.number().int().nullable(), // Tagesverlust-Stopp in EUR (Grenze × Stand von gestern); null ohne Grenze oder Stand
			dayLossHeadroomCents: z.number().int().nullable(), // Verlust, der heute noch bleibt, bis der Stopp greift (mindestens 0)
			stats: DayStatsSchema,
		}),
	),
	positions: z.array(CockpitPositionSchema),
	agentBudget: AgentBudgetSchema.nullable(),
});
export type Cockpit = z.infer<typeof CockpitSchema>;

/* ------------------------------------------------------------------ Chat */

export const ChatMessageSchema = z.object({
	id: z.number().int(),
	time: z.number(),
	author: z.string(),
	role: z.enum(["user", "agent", "desk"]),
	text: z.string(),
	to: z.array(z.string()), // erwähnte Namen (@Atlas); leer = an alle
	ref: z.string().nullable(), // z. B. "#12" für Vorschlag 12 oder ein Symbol
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/* ------------------------------------------------------------------ Broker */

export const BrokerStatusSchema = z.object({
	accountId: z.string(),
	adapter: z.string(),
	connected: z.boolean(), // Gateway erreichbar
	authenticated: z.boolean(), // du bist im Gateway angemeldet
	brokerAccount: z.string().nullable(),
	paper: z.boolean().nullable(),
	live: z.boolean(),
	liveTrading: z.boolean(), // Hauptschalter in config.json
	message: z.string(),
	checkedAt: z.number().nullable(),
	loginUrl: z.string().nullable(),
});
export type BrokerStatus = z.infer<typeof BrokerStatusSchema>;

export const ReconcileRowSchema = z.object({
	symbol: z.string().nullable(), // null: Kontrakt ohne Zuordnung zu einem Symbol
	conid: z.number().nullable(),
	description: z.string(),
	brokerQty: z.number(),
	deskQty: z.number(),
	avgCost: z.number().nullable(),
	currency: z.string(),
});
export const ReconcileSchema = z.object({
	status: BrokerStatusSchema,
	rows: z.array(ReconcileRowSchema),
	brokerCashCents: z.number().int().nullable(), // Cash beim Broker in EUR (Basiswährung)
	deskCashCents: z.number().int(),
	differences: z.number().int(),
	cashNote: z.string().nullable(), // warum das Cash nicht verglichen wird (z. B. Basiswährung nicht EUR)
});
export type Reconcile = z.infer<typeof ReconcileSchema>;

/* ------------------------------------------------------------------ Auswertung */

/**
 * Ein geschlossener Trade (GET /api/analytics): der Teil eines Kauf-Loses, den ein Verkauf nach FIFO geschlossen hat
 * (buildBook). Einstieg = Zeit und Kurs des Loses, Ausstieg = der Verkauf. Ein Verkauf über zwei Lose ergibt zwei
 * geschlossene Trades, ein Teilverkauf einen über die verkaufte Stückzahl (der Rest des Loses bleibt offen). Einstand
 * und Erlös sind anteilig inkl. Gebühren; die Summe über die Teile eines Verkaufs ist genau sein realisiertes Ergebnis.
 */
export const ClosedTradeSchema = z.object({
	accountId: z.string(),
	symbol: z.string(),
	name: z.string(),
	author: z.string(), // wer den Einstieg entschieden hat: Autor des Vorschlags hinter dem Kauf, sonst der Besitzer des Depots
	buyTradeId: z.number().int(),
	sellTradeId: z.number().int(),
	proposalId: z.number().int().nullable(), // Vorschlag hinter dem Kauf
	qty: z.number(),
	entryTime: z.number(),
	exitTime: z.number(),
	entryPrice: z.number(), // EUR je Stück ohne Gebühr
	exitPrice: z.number(), // EUR je Stück ohne Gebühr
	costCents: z.number().int(), // Einstand inkl. anteiliger Kaufgebühr
	proceedsCents: z.number().int(), // Erlös nach anteiliger Verkaufsgebühr
	feesCents: z.number().int(), // anteilige Kauf- und Verkaufsgebühr
	pnlCents: z.number().int(), // proceedsCents − costCents
	holdMs: z.number(),
	stopLoss: z.number().nullable(), // Stop des Vorschlags (Wertpapierwährung)
	riskCents: z.number().int().nullable(), // Verlust bis zum Stop inkl. beider anteiligen Gebühren; null ohne Stop
	r: z.number().nullable(), // pnlCents / riskCents; null ohne Stop, mit Stop über dem Einstieg oder Kauf in anderer Währung als der Stop
});
export type ClosedTrade = z.infer<typeof ClosedTradeSchema>;

/** Kennzahlen über geschlossene Trades. Gewinn: pnlCents > 0, Verlust: < 0 (genau 0 zählt zu keinem). */
export const TradeStatsSchema = z.object({
	trades: z.number().int(),
	wins: z.number().int(),
	losses: z.number().int(),
	winRate: z.number().nullable(), // wins / trades in %
	pnlCents: z.number().int(),
	grossProfitCents: z.number().int(), // Summe der Gewinne
	grossLossCents: z.number().int(), // Summe der Verluste (≤ 0)
	profitFactor: z.number().nullable(), // Gewinne / |Verluste|; null ohne Verlust
	expectancyCents: z.number().int().nullable(), // Ergebnis je Trade
	expectancyR: z.number().nullable(), // mittleres R der Trades mit R
	rTrades: z.number().int(), // Trades mit bekanntem R
	avgWinCents: z.number().int().nullable(),
	avgLossCents: z.number().int().nullable(), // negativ
	largestWinCents: z.number().int().nullable(),
	largestLossCents: z.number().int().nullable(),
	avgHoldMs: z.number().nullable(),
	feesCents: z.number().int(),
});
export type TradeStats = z.infer<typeof TradeStatsSchema>;

/**
 * Kurve mit Drawdown. Ergebnis = Equity − Einzahlungen (Ein- und Auszahlungen sind kein Gewinn oder Verlust). Spitze =
 * höchstes Ergebnis seit Beginn des Zeitraums; Drawdown = Ergebnis − Spitze (≤ 0), in % von (Einzahlungen des Tages +
 * Spitze), also dem Depotwert, den du zur Spitze mit den heutigen Einzahlungen hättest.
 */
export const AnalyticsPointSchema = CurvePointSchema.extend({
	resultCents: z.number().int(),
	peakCents: z.number().int(),
	drawdownCents: z.number().int(),
	drawdownPct: z.number().nullable(),
});
export type AnalyticsPoint = z.infer<typeof AnalyticsPointSchema>;

export const MaxDrawdownSchema = z.object({
	cents: z.number().int(), // tiefster Drawdown (≤ 0)
	pct: z.number().nullable(), // dessen Prozent
	peakDay: z.string(),
	troughDay: z.string(),
	recoveryDay: z.string().nullable(), // erster Tag danach mit Ergebnis ≥ Spitze; null: noch nicht erholt
});

/**
 * Ergebnis je Ortstag (Kalender). realizedCents: Verkäufe des Tages. resultCents: Änderung des Ergebnisses seit dem
 * vorigen Tagesstand (sinceDay; Lücken ohne Stand gehören zum nächsten Tag mit Stand), unrealizedChangeCents = resultCents
 * minus realisiert im selben Fenster. Tage ohne Tagesstand, aber mit Verkäufen: nur realizedCents, der Rest null.
 */
export const DayResultSchema = z.object({
	day: z.string(),
	realizedCents: z.number().int(),
	trades: z.number().int(), // geschlossene Trades an diesem Tag
	resultCents: z.number().int().nullable(),
	unrealizedChangeCents: z.number().int().nullable(),
	sinceDay: z.string().nullable(),
});
export type DayResult = z.infer<typeof DayResultSchema>;

/** R-Verteilung: from < r ≤ to; from null = ohne Untergrenze, to null = ohne Obergrenze. */
export const RBucketSchema = z.object({ from: z.number().nullable(), to: z.number().nullable(), trades: z.number().int(), pnlCents: z.number().int() });

export const AnalyticsSchema = z.object({
	scope: z.string(), // "mine" (deine Depots), "all" oder eine Depot-ID
	accountIds: z.array(z.string()),
	from: z.string().nullable(), // YYYY-MM-DD, null: ab Beginn
	to: z.string(),
	timezone: z.string(), // Ortszeit für Tage, Wochentage und Stunden (Europe/Berlin)
	curve: z.array(AnalyticsPointSchema),
	maxDrawdown: MaxDrawdownSchema.nullable(),
	days: z.array(DayResultSchema),
	trades: z.array(ClosedTradeSchema), // Ausstieg im Zeitraum, neueste zuerst, höchstens 1000
	tradesTotal: z.number().int(),
	stats: TradeStatsSchema,
	rBuckets: z.array(RBucketSchema),
	byWeekday: z.array(TradeStatsSchema.extend({ weekday: z.number().int() })), // 1 = Montag … 7 = Sonntag, nach Einstieg; immer alle 7
	byHour: z.array(TradeStatsSchema.extend({ hour: z.number().int() })), // Stunde des Einstiegs 0–23; immer alle 24
	byAuthor: z.array(TradeStatsSchema.extend({ author: z.string() })), // du und jeder Agent (auch ohne Trades), dann weitere
	bySymbol: z.array(TradeStatsSchema.extend({ symbol: z.string(), name: z.string() })), // nach Ergebnis absteigend
});
export type Analytics = z.infer<typeof AnalyticsSchema>;
