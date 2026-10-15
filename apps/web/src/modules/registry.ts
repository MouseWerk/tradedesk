// Modul-Registry: Navigation, Hotkeys und Routen entstehen hieraus.
import type { LucideIcon } from "lucide-react";
import { Activity, Bot, CandlestickChart, LayoutDashboard, ListChecks, ShieldAlert, Wallet } from "lucide-react";
import type { ComponentType } from "react";

export interface WebModule {
	id: string;
	title: string;
	icon: LucideIcon;
	hotkey: string;
	path: string;
	load: () => Promise<{ default: ComponentType }>;
}

export const MODULES: WebModule[] = [
	{ id: "overview", title: "Übersicht", icon: LayoutDashboard, hotkey: "1", path: "/", load: () => import("./overview/OverviewView") },
	{ id: "trade", title: "Trading", icon: Activity, hotkey: "2", path: "/trade", load: () => import("./trade/TradeView") },
	{ id: "orders", title: "Orders", icon: ListChecks, hotkey: "3", path: "/orders", load: () => import("./orders/OrdersView") },
	{ id: "portfolio", title: "Depots", icon: Wallet, hotkey: "4", path: "/portfolio", load: () => import("./portfolio/PortfolioView") },
	{ id: "market", title: "Markt", icon: CandlestickChart, hotkey: "5", path: "/market", load: () => import("./market/MarketView") },
	{ id: "agents", title: "Agenten", icon: Bot, hotkey: "6", path: "/agents", load: () => import("./agents/AgentsView") },
	{ id: "risk", title: "Risiko", icon: ShieldAlert, hotkey: "7", path: "/risk", load: () => import("./risk/RiskView") },
];

export function moduleForPath(pathname: string): WebModule | undefined {
	return MODULES.find((m) => (m.path === "/" ? pathname === "/" : pathname === m.path || pathname.startsWith(m.path + "/")));
}
