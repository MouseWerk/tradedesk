// Modul-Registry: Navigation, Hotkeys und Routen entstehen hieraus.
import type { LucideIcon } from "lucide-react";
import { Bot, CandlestickChart, LayoutDashboard, ListChecks, ShieldAlert, Wallet } from "lucide-react";
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
	{ id: "portfolio", title: "Depots", icon: Wallet, hotkey: "2", path: "/portfolio", load: () => import("./portfolio/PortfolioView") },
	{ id: "market", title: "Markt", icon: CandlestickChart, hotkey: "3", path: "/market", load: () => import("./market/MarketView") },
	{ id: "orders", title: "Orders", icon: ListChecks, hotkey: "4", path: "/orders", load: () => import("./orders/OrdersView") },
	{ id: "agents", title: "Agenten", icon: Bot, hotkey: "5", path: "/agents", load: () => import("./agents/AgentsView") },
	{ id: "risk", title: "Risiko", icon: ShieldAlert, hotkey: "6", path: "/risk", load: () => import("./risk/RiskView") },
];

export function moduleForPath(pathname: string): WebModule | undefined {
	return MODULES.find((m) => (m.path === "/" ? pathname === "/" : pathname === m.path || pathname.startsWith(m.path + "/")));
}
