import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The console is served as static assets by the Worker itself, so in development
// it proxies to `wrangler dev` on the same paths it will use in production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://localhost:8787",
        changeOrigin: false,
        // Better Auth rejects state-changing requests whose Origin is not
        // trusted, and the Worker trusts only its own origin. The browser sends
        // the dev server's origin, so rewrite it to the proxy target or every
        // sign-in POST fails in development.
        headers: { origin: "http://localhost:8787" },
      },
    },
  },
  test: {
    // Auth screens and capability gating are only meaningful when rendered, so
    // the suite runs in a DOM. The pure `lib/*` tests are unaffected by it.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Assets are public; shipping ~6 MB of source maps on every deploy is not
    // worth it for a console whose source lives in this repo.
    sourcemap: false,
  },
});
