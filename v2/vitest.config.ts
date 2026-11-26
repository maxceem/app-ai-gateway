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
  "test/relay-tickets.test.ts",
  "test/relay-session.test.ts",
  "test/session-leases.test.ts",
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
                // The test ticket key's public half (\`test/relay-keys.ts\`).
                RELAY_TICKET_PUBLIC_KEY: "UT0iL-macVGQntunvBGGJabK-ieqY-6yQtsovFkmEGU",
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
            {
              // The relay Worker as it is uploaded, with its real session object (\`test/relay-session.test.ts\`):
              // the vault's RelayKeys for keys, a stand-in for the gateway's RelayContract, and a provider
              // stand-in that answers every connect with a WebSocket.
              name: "app-ai-gateway-v2-relay-test",
              modules: true,
              modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
              scriptPath: path.join(import.meta.dirname, "relay/src/index.js"),
              compatibilityDate: "2026-07-24",
              durableObjects: { SESSION: "Session" },
              bindings: { RELAY_TICKET_PUBLIC_KEY: "UT0iL-macVGQntunvBGGJabK-ieqY-6yQtsovFkmEGU" },
              serviceBindings: {
                MAIN: { name: "app-ai-gateway-v2-relay-main-stub", entrypoint: "RelayContract" },
                VAULT: { name: "app-ai-gateway-v2-vault", entrypoint: "RelayKeys" },
              },
              outboundService: "app-ai-gateway-v2-provider-stub",
            },
            {
              // Every provider connect the test relay makes: a WebSocket that stays open.
              name: "app-ai-gateway-v2-provider-stub",
              modules: true,
              // It keeps the key header of the last connect, which the test reads back at /last-key-header,
              // sends one event at once and echoes every frame (one marked "later:" after a while).
              script: [
                "let lastKeyHeader = null;",
                "export default {",
                "  fetch(request) {",
                "    if (new URL(request.url).pathname === \"/last-key-header\") return Response.json({ authorization: lastKeyHeader });",
                "    lastKeyHeader = request.headers.get(\"authorization\");",
                "    const [client, server] = Object.values(new WebSocketPair());",
                "    server.binaryType = \"arraybuffer\";",
                "    server.accept();",
                // Like a provider: an event at once, then each frame echoed back (frame forwarding's test).
                // A frame that starts with "later:" is echoed after 300 ms: a provider frame that lands
                // while the client's link is down (the reconnect tests).
                "    server.send(JSON.stringify({ type: \"session.created\" }));",
                "    server.addEventListener(\"message\", (event) => {",
                "      if (typeof event.data === \"string\" && event.data.startsWith(\"later:\")) setTimeout(() => server.send(event.data), 300);",
                "      else server.send(event.data);",
                "    });",
                "    return new Response(null, { status: 101, webSocket: client });",
                "  },",
                "};",
              ].join("\n"),
              compatibilityDate: "2026-07-24",
            },
            {
              name: "app-ai-gateway-v2-relay-main-stub",
              modules: true,
              script: [
                'import { WorkerEntrypoint } from "cloudflare:workers";',
                "export class RelayContract extends WorkerEntrypoint {",
                "  async open() { return { version: 1, deadline: Date.now() + 60000, mode: \"relayed\", operation: \"openai.realtime\", checkpointIntervalMs: 60000 }; }",
                "  async close() { return { version: 1 }; }",
                "}",
                "export default { fetch() { return new Response(null, { status: 404 }); } };",
              ].join("\n"),
              compatibilityDate: "2026-07-24",
            },
          ],
          // The vault's relay-only entrypoint, so its tests go through the binding the relay uses (step 9a).
          serviceBindings: {
            VAULT_KMS: "app-ai-gateway-v2-vault-kms",
            VAULT_RELAY: { name: "app-ai-gateway-v2-vault", entrypoint: "RelayKeys" },
            RELAY_TEST: "app-ai-gateway-v2-relay-test",
            PROVIDER_STUB: "app-ai-gateway-v2-provider-stub",
          },
          // The optional conversation bucket (step 7), so conversation storage can be tested.
          r2Buckets: ["CONVERSATIONS"],
          bindings: {
            JWT_SECRET: "test-jwt-secret-with-at-least-thirty-two-bytes",
            // A test-only ticket key (\`test/relay-keys.ts\`): \`<x>.<d>\`.
            RELAY_TICKET_PRIVATE_KEY: "UT0iL-macVGQntunvBGGJabK-ieqY-6yQtsovFkmEGU.qZrzCuwpthFVTEuYxPsSryqsfCjHpI-bAwHSFzgzy3o",
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
