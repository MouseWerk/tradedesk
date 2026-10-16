// Modul-Registry: Navigation, Hotkeys, Befehlspalette, Leiste am Telefon und Routen entstehen hieraus.
// Hotkeys in der Reihenfolge der Navigation; die Auswertung steht hinter den Depots, aus denen sie rechnet.
import type { LucideIcon } from "lucide-react";
import { Activity, Bot, CandlestickChart, ChartColumn, LayoutDashboard, ListChecks, ShieldAlert, Wallet } from "lucide-react";
import type { ComponentType } from "react";

export interface WebModule {
	id: string;
	title: string;
	icon: LucideIcon;
	hotkey: string;
	path: string;
	phone?: boolean; // in der unteren Leiste am Telefon (höchstens fünf, der Rest unter „Mehr“)
	keywords?: string[]; // weitere Suchwörter für die Befehlspalette
	load: () => Promise<{ default: ComponentType }>;
}

export const MODULES: WebModule[] = [
	{ id: "overview", title: "Übersicht", icon: LayoutDashboard, hotkey: "1", path: "/", phone: true, keywords: ["Start", "Vermögen"], load: () => import("./overview/OverviewView") },
	{ id: "trade", title: "Trading", icon: Activity, hotkey: "2", path: "/trade", phone: true, keywords: ["Cockpit", "Scanner", "Chart"], load: () => import("./trade/TradeView") },
	{ id: "orders", title: "Orders", icon: ListChecks, hotkey: "3", path: "/orders", phone: true, keywords: ["Vorschläge", "Freigabe"], load: () => import("./orders/OrdersView") },
	{ id: "portfolio", title: "Depots", icon: Wallet, hotkey: "4", path: "/portfolio", phone: true, keywords: ["Positionen", "Konto"], load: () => import("./portfolio/PortfolioView") },
	{ id: "analytics", title: "Auswertung", icon: ChartColumn, hotkey: "5", path: "/analytics", keywords: ["Statistik", "Trefferquote", "Drawdown", "Journal"], load: () => import("./analytics/AnalyticsView") },
	{ id: "market", title: "Markt", icon: CandlestickChart, hotkey: "6", path: "/market", phone: true, keywords: ["Watchlist", "Alarme", "Suche"], load: () => import("./market/MarketView") },
	{ id: "agents", title: "Agenten", icon: Bot, hotkey: "7", path: "/agents", keywords: ["Journal", "Vergleich"], load: () => import("./agents/AgentsView") },
	{ id: "risk", title: "Risiko", icon: ShieldAlert, hotkey: "8", path: "/risk", keywords: ["Grenzen", "Not-Aus", "Limits"], load: () => import("./risk/RiskView") },
];

export function moduleForPath(pathname: string): WebModule | undefined {
	return MODULES.find((m) => (m.path === "/" ? pathname === "/" : pathname === m.path || pathname.startsWith(m.path + "/")));
}
