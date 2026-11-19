import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Where the console lives: under `/v2`, beside v1's console on the same host (plan section 9.1). */
const BASE = "/v2/";

/**
 * The v2 Worker's price list, published beside the console as
 * `/v2/models.json`, as v1 publishes its own: a static file anyone can read.
 */
function modelPrices(): Plugin {
  return {
    name: "model-prices",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "models.json",
        source: readFileSync(path.resolve(import.meta.dirname, "../src/pricing/models.json"), "utf8"),
      });
    },
  };
}

/** The paths the v2 Worker answers itself, sent to `wrangler dev` while developing. */
const WORKER_PATHS = ["/v2/admin", "/v2/auth", "/v2/console", "/v2/oauth", "/v2/cli", "/v2/mcp", "/.well-known"];

export default defineConfig({
  base: BASE,
  plugins: [react(), tailwindcss(), modelPrices()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // The v2 API's contracts: the operation catalog and its schemas. Plain
      // zod, with no Hono or Worker code behind it.
      "@contracts": path.resolve(import.meta.dirname, "../src/contracts"),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    // Run the v2 Worker with `wrangler dev` (port 8787) beside this server.
    proxy: Object.fromEntries(WORKER_PATHS.map((prefix) => [prefix, "http://localhost:8787"])),
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    reporters: ["default", ["../../scripts/test-ledger/reporter.mjs", { suite: "v2-console" }]],
    restoreMocks: true,
    // The same settings as v1's console suite, for the same reasons: building
    // the test window is the cost, so workers reuse it across files.
    pool: "threads",
    isolate: false,
    testTimeout: 20_000,
  },
  build: {
    // The Worker serves `dist/` as its static assets, so a file at
    // `dist/v2/assets/x.js` answers `/v2/assets/x.js`.
    outDir: "dist/v2",
    emptyOutDir: true,
    sourcemap: false,
  },
});
