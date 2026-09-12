import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { availableParallelism } from "node:os";
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
            // Tests must not change behavior based on a developer's ignored
            // local Google credentials or OAuth relay from .dev.vars.
            GOOGLE_CLIENT_ID: "",
            GOOGLE_CLIENT_SECRET: "",
            OAUTH_RELAY_URL: "",
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
    // Every worker boots its own workerd and replays the D1 migrations, so
    // the suite is heavy enough that the count matters: on a 12-core machine
    // 2 workers took 107s, 6 took 51s, and 8 took 77s because the runtimes
    // then fight over the CPU. Half the cores, capped, lands on that optimum
    // here without oversubscribing a smaller machine. Re-checked once the barrels
    // reduced the suite to nine files: nine workers measured the same as six.
    maxWorkers: Math.max(2, Math.min(6, Math.floor(availableParallelism() / 2))),
    setupFiles: ["./test/apply-migrations.ts"],
    // The console is a browser app with its own jsdom Vitest project, run by
    // `pnpm run console:test`. Without this it is swept up by the default glob
    // and executed inside the Workers runtime, where there is no DOM.
    include: ["test/**/*.test.ts"],
  },
});
