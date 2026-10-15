import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/src/**/*.test.ts", "apps/server/test/**/*.test.ts", "apps/web/test/**/*.test.ts"],
		testTimeout: 30_000,
		pool: "forks",
		env: { TZ: "Europe/Berlin" },
	},
});
