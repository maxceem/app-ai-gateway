import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The console is served as static assets by the Worker itself, so in development
// it proxies to `wrangler dev` on the same paths it will use in production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // The shared capability matrix, one directory up and outside this package.
      // It imports nothing, so bundling it costs the tables themselves and
      // pulls no server dependency into the browser build.
      "@shared": path.resolve(import.meta.dirname, "../src/shared"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://localhost:8787",
        // Better Auth rejects state-changing requests whose Origin is not
        // trusted, and the Worker trusts only its own origin — which it derives
        // from the request URL, i.e. the Host header. Host and Origin must
        // therefore both point at the proxy target, or every sign-in POST
        // fails in development.
        changeOrigin: true,
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
    // The interaction tests are CPU-bound, not waiting on anything: rendering a
    // page and driving a modal through jsdom costs ~15ms per simulated
    // keystroke, so the heaviest of them spend over a second of real work even
    // with the machine to themselves. Run in parallel across every file that
    // work contends and the same test takes three to four times as long, which
    // put the slowest ones within a few hundred milliseconds of the 5s default
    // and made them fail on load rather than on merit. The timeout is here to
    // catch a test that has genuinely hung, so it is sized against that: 20s is
    // far more than the slowest test needs and still far less than forever.
    testTimeout: 20_000,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Assets are public; shipping ~6 MB of source maps on every deploy is not
    // worth it for a console whose source lives in this repo.
    sourcemap: false,
  },
});
