// API-Verträge: ein zod-Schema je Antwort, die Typen werden daraus abgeleitet (eine Quelle, kein Auseinanderlaufen).
// Geld in Cent (Basiswährung EUR) als ganze Zahl; Kurse in der Währung des Wertpapiers; Stückzahlen bis 6 Nachkommastellen.
import { z } from "zod";
import { decimals } from "./portfolio.ts";

/** Obergrenzen an der API-Grenze: was darüber liegt, ist ein Tippfehler oder ein Angriff, nie eine Order. */
export const MAX_QTY = 10_000_000;
export const MAX_PRICE = 10_000_000; // in Wertpapierwährung
export const MAX_EUR = 100_000_000; // Ein- und Auszahlungen, Gebühren, Grenzen
export const QtySchema = z.number().positive().max(MAX_QTY).refine((n) => decimals(n) <= 6, "höchstens 6 Nachkommastellen");
export const PriceSchema = z.number().positive().max(MAX_PRICE).refine((n) => decimals(n) <= 8, "höchstens 8 Nachkommastellen");

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
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

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
	accountId: z.string(),
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

export const RiskDataSchema = z.object({
	killSwitch: z.boolean(),
	minConfidence: z.number(),
	staleMovePct: z.number(),
	proposalTtlHours: z.number(),
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
});
export type ScanRow = z.infer<typeof ScanRowSchema>;

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
			stats: DayStatsSchema,
		}),
	),
	positions: z.array(CockpitPositionSchema),
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
