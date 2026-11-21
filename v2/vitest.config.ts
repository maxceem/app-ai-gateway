import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The optional conversation bucket (step 7), so conversation storage can be tested.
          r2Buckets: ["CONVERSATIONS"],
          bindings: {
            JWT_SECRET: "test-jwt-secret-with-at-least-thirty-two-bytes",
            BETTER_AUTH_SECRET: "test-better-auth-secret-with-at-least-32-bytes",
            // The console and the OAuth issuer (`https://console.gateway.test/v2`).
            CONSOLE_ORIGIN: "https://console.gateway.test",
            // A test-only vault key: 32 zero bytes.
            SECRET_VAULT_LOCAL_KEK_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    include: ["test/**/*.test.ts"],
    // Every run goes to the test ledger when one is set up (scripts/test-ledger/).
    reporters: ["default", ["../scripts/test-ledger/reporter.mjs", { suite: "v2" }]],
  },
});
