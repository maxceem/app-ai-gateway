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
          bindings: {
            JWT_SECRET: "test-jwt-secret-with-at-least-thirty-two-bytes",
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
