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
          // The vault Worker (`vault/`), uploaded as it is, behind the VAULT binding.
          // Most tests run its modules in this Worker instead (`test/local-vault.ts`);
          // `vault-binding.test.ts` goes through the binding. Its provider is a stand-in
          // that echoes what reached it, so no test call leaves the machine.
          workers: [
            {
              name: "app-ai-gateway-v2-vault",
              modules: true,
              modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
              scriptPath: path.join(import.meta.dirname, "vault/src/index.js"),
              compatibilityDate: "2026-07-24",
              compatibilityFlags: ["enable_request_signal"],
              bindings: {
                SECRET_VAULT_MODE: "local",
                SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "1",
                SECRET_VAULT_LOCAL_KEK_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
              },
              outboundService: async (request: Request) =>
                // A provider answer that carries the vault's own headers: the vault must drop them.
                new URL(request.url).pathname.endsWith("/reserved")
                  ? new Response("ok", { headers: { "x-agw-vault-error": "destination_refused", "x-agw-vault": "{}" } })
                  : Response.json(
                  { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() },
                  { headers: { "x-echo": "1", authorization: request.headers.get("authorization") ?? "" } },
                ),
            },
          ],
          // The optional conversation bucket (step 7), so conversation storage can be tested.
          r2Buckets: ["CONVERSATIONS"],
          bindings: {
            JWT_SECRET: "test-jwt-secret-with-at-least-thirty-two-bytes",
            BETTER_AUTH_SECRET: "test-better-auth-secret-with-at-least-32-bytes",
            // The console and the OAuth issuer (`https://console.gateway.test/v2`).
            CONSOLE_ORIGIN: "https://console.gateway.test",
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
