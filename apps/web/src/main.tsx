import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRootRoute, createRoute, createRouter, lazyRouteComponent } from "@tanstack/react-router";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { queryClient } from "./lib/api";
import { Shell } from "./shell/Shell";
import { MODULES } from "./modules/registry";
import { ConfirmProvider, ToastProvider } from "./ui/overlay";
import { ModuleError } from "./ui/boundary";

// Design vor dem ersten Zeichnen setzen (kein Inline-Skript in index.html wegen der CSP)
try {
	if (localStorage.getItem("desk.theme") === "light") document.documentElement.classList.remove("dark");
} catch {
	// privater Modus
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const rootRoute = createRootRoute({ component: Shell });
const moduleRoutes = MODULES.map((m) =>
	createRoute({
		getParentRoute: () => rootRoute,
		path: m.path,
		component: lazyRouteComponent(m.load),
		validateSearch: (s: Record<string, unknown>) => ({ account: str(s.account), symbol: str(s.symbol) }),
	}),
);

export const router = createRouter({ routeTree: rootRoute.addChildren(moduleRoutes), defaultPreload: "intent", defaultErrorComponent: ModuleError });

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<ToastProvider>
				<ConfirmProvider>
					<RouterProvider router={router} />
				</ConfirmProvider>
			</ToastProvider>
		</QueryClientProvider>
	</StrictMode>,
);
