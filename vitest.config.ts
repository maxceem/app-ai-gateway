import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc", environment: "local" },
        miniflare: {
          bindings: {
            JWT_SECRET: "test-jwt-secret-with-at-least-thirty-two-bytes",
            BETTER_AUTH_SECRET: "test-better-auth-secret-with-at-least-thirty-two-bytes",
            SECRET_VAULT_MODE: "local",
            SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "1",
            SECRET_VAULT_LOCAL_KEK_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    maxWorkers: 2,
    setupFiles: ["./test/apply-migrations.ts"],
    // The console is a browser app with its own jsdom Vitest project, run by
    // `pnpm run console:test`. Without this it is swept up by the default glob
    // and executed inside the Workers runtime, where there is no DOM.
    include: ["test/**/*.test.ts"],
  },
});
