// Modul-Registry: Navigation, Hotkeys, Befehlspalette, Leiste am Telefon und Routen entstehen hieraus.
// Hotkeys in der Reihenfolge der Navigation; die Auswertung steht hinter den Depots, aus denen sie rechnet.
import type { LucideIcon } from "lucide-react";
import { Activity, Bot, CandlestickChart, ChartColumn, LayoutDashboard, ListChecks, ShieldAlert, Wallet } from "lucide-react";
import type { ComponentType } from "react";
import { de } from "@/i18n/de";

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
	{ id: "overview", title: de.nav.overview, icon: LayoutDashboard, hotkey: "1", path: "/", phone: true, keywords: de.nav.keywords.overview, load: () => import("./overview/OverviewView") },
	{ id: "trade", title: de.nav.trade, icon: Activity, hotkey: "2", path: "/trade", phone: true, keywords: de.nav.keywords.trade, load: () => import("./trade/TradeView") },
	{ id: "orders", title: de.nav.orders, icon: ListChecks, hotkey: "3", path: "/orders", phone: true, keywords: de.nav.keywords.orders, load: () => import("./orders/OrdersView") },
	{ id: "portfolio", title: de.nav.portfolio, icon: Wallet, hotkey: "4", path: "/portfolio", phone: true, keywords: de.nav.keywords.portfolio, load: () => import("./portfolio/PortfolioView") },
	{ id: "analytics", title: de.nav.analytics, icon: ChartColumn, hotkey: "5", path: "/analytics", keywords: de.nav.keywords.analytics, load: () => import("./analytics/AnalyticsView") },
	{ id: "market", title: de.nav.market, icon: CandlestickChart, hotkey: "6", path: "/market", phone: true, keywords: de.nav.keywords.market, load: () => import("./market/MarketView") },
	{ id: "agents", title: de.nav.agents, icon: Bot, hotkey: "7", path: "/agents", keywords: de.nav.keywords.agents, load: () => import("./agents/AgentsView") },
	{ id: "risk", title: de.nav.risk, icon: ShieldAlert, hotkey: "8", path: "/risk", keywords: de.nav.keywords.risk, load: () => import("./risk/RiskView") },
];

export function moduleForPath(pathname: string): WebModule | undefined {
	return MODULES.find((m) => (m.path === "/" ? pathname === "/" : pathname === m.path || pathname.startsWith(m.path + "/")));
}
