import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The files that send provider keys, or exchange the tokens that carry the
 * app's credential, run a second time with the test account's split keys on
 * (plan step 8j, `test/split-keys.ts`).
 */
const SPLIT_KEY_FILES = [
  "test/auth-routes.test.ts",
  "test/proxy.test.ts",
  "test/passthrough.test.ts",
  "test/presets.test.ts",
  "test/jobs.test.ts",
  "test/conversations.test.ts",
  "test/custom-providers.test.ts",
  "test/deepgram-fal.test.ts",
  "test/elevenlabs.test.ts",
  "test/media.test.ts",
  "test/providers.test.ts",
  "test/pricing-units.test.ts",
];

/**
 * Time limits for a test and for a setup hook. Vitest's defaults (5 s and 10 s)
 * are hit by tests that are only slow because the machine is busy, for example
 * when several full runs share it, and every such failure costs a rerun. A test
 * that is really stuck still fails, only later. The console suites use the same 20 s test limit.
 */
const TIME_LIMITS = { testTimeout: 20_000, hookTimeout: 30_000 };

/** The Workers test pool, with the test account's split keys on or off. */
const workers = (splitKeys: boolean) =>
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
            {
              // The same vault in kms mode, for the deadline tests (`test/vault-deadline.test.ts`):
              // its cf-kms stand-in hands out one fixed data key, and never answers a decrypt for a
              // wrapped key named "stall". Providers answer 503, so a held answer can be kept.
              name: "app-ai-gateway-v2-vault-kms",
              modules: true,
              modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
              scriptPath: path.join(import.meta.dirname, "vault/src/index.js"),
              compatibilityDate: "2026-07-24",
              compatibilityFlags: ["enable_request_signal"],
              bindings: {
                SECRET_VAULT_MODE: "kms",
                SECRET_VAULT_KMS_URL: "https://kms.example.test",
                SECRET_VAULT_KMS_TOKEN: "kms-token",
              },
              outboundService: async (request: Request) => {
                const url = new URL(request.url);
                if (url.host !== "kms.example.test") return Response.json({ error: { code: "busy" } }, { status: 503 });
                const body = (await request.json()) as { wrappedKey?: string };
                if (url.pathname.endsWith("/v1/decrypt") && body.wrappedKey === "stall") return new Promise<Response>(() => undefined);
                return Response.json({ plaintextKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", wrappedKey: "fixed", kekVersion: 1 });
              },
            },
          ],
          serviceBindings: { VAULT_KMS: "app-ai-gateway-v2-vault-kms" },
          // The optional conversation bucket (step 7), so conversation storage can be tested.
          r2Buckets: ["CONVERSATIONS"],
          bindings: {
            JWT_SECRET: "test-jwt-secret-with-at-least-thirty-two-bytes",
            BETTER_AUTH_SECRET: "test-better-auth-secret-with-at-least-32-bytes",
            // The console and the OAuth issuer (`https://console.gateway.test/v2`).
            CONSOLE_ORIGIN: "https://console.gateway.test",
            TEST_MIGRATIONS: migrations,
            ...(splitKeys ? { TEST_SPLIT_KEYS: "1" } : {}),
          },
        },
      };
    });

export default defineConfig({
  test: {
    projects: [
      { plugins: [workers(false)], test: { name: "v2", ...TIME_LIMITS, setupFiles: ["./test/apply-migrations.ts"], include: ["test/**/*.test.ts"] } },
      { plugins: [workers(true)], test: { name: "v2-split-keys", ...TIME_LIMITS, setupFiles: ["./test/apply-migrations.ts"], include: SPLIT_KEY_FILES } },
    ],
    // Every run goes to the test ledger when one is set up (scripts/test-ledger/).
    reporters: ["default", ["../scripts/test-ledger/reporter.mjs", { suite: "v2" }]],
  },
});
