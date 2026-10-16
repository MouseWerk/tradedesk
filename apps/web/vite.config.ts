import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Dev: Vite auf 5175, API vom Server (npm run dev, 8096). Build: dist/, ausgeliefert vom Server.
const api = process.env.DESK_API ?? "http://127.0.0.1:8096";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
	server: { port: 5175, strictPort: true, host: "127.0.0.1", proxy: { "/api": api } },
	build: {
		target: "es2023",
		chunkSizeWarningLimit: 600,
		// der Textkatalog (src/i18n/de.ts) als eigene Datei: braucht jede Seite, ändert sich aber unabhängig vom Code
		rolldownOptions: { output: { codeSplitting: { groups: [{ name: "texts", test: /[\\/]src[\\/]i18n[\\/]/ }] } } },
	},
});
