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
            CF_AIG_BASE_URL: "https://gateway.ai.cloudflare.com/v1/local-account/test-gateway",
            JWT_SECRET: "test-jwt-secret-with-at-least-thirty-two-bytes",
            BETTER_AUTH_SECRET: "test-better-auth-secret-with-at-least-thirty-two-bytes",
            CF_AIG_TOKEN: "test-cf-aig-token",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    maxWorkers: 2,
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
