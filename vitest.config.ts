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
          // A second, empty database so a migration can be replayed step by step
          // against realistic data. Test-only: the Worker never binds it.
          d1Databases: { MIGRATION_DB: "migration-test-db" },
          bindings: {
            JWT_SECRET: "test-jwt-secret-with-at-least-thirty-two-bytes",
            BETTER_AUTH_SECRET: "test-better-auth-secret-with-at-least-thirty-two-bytes",
            // Tests must not change behavior based on a developer's ignored
            // local Google/OAuth-proxy credentials from .dev.vars.
            GOOGLE_CLIENT_ID: "",
            GOOGLE_CLIENT_SECRET: "",
            OAUTH_PROXY_SECRET: "",
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
