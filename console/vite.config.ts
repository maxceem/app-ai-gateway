import path from "node:path";
import { defineConfig } from "vite";
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
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Assets are public; shipping ~6 MB of source maps on every deploy is not
    // worth it for a console whose source lives in this repo.
    sourcemap: false,
  },
});
