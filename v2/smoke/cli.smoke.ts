/**
 * agw 2 against a live v2 deployment (step 2e), run from its sources with a
 * management key from the environment and state of its own:
 *
 * - `deployment connect` checks the key and stores no credential;
 * - a gateway command, built from the tool list, lists the apps;
 * - the built-in `app add`, `app update` and the gateway's `app remove`
 *   change a throwaway iOS app, which is removed again.
 *
 *   V2_CONSOLE_URL=https://console.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * Skipped without both. Nothing is left behind.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertHolds, cleanUp, cliOutcome, outcome, readJson, uniqueSlug } from "./support.ts";

const consoleUrl = process.env.V2_CONSOLE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const skip = consoleUrl === "" || managementKey === "" ? "V2_CONSOLE_URL and V2_MANAGEMENT_KEY are needed" : false;
const bin = fileURLToPath(new URL("../cli/src/bin.ts", import.meta.url));

/** One `agw` run with `--json`, its document parsed. */
function agw(home: string, ...argv: string[]): Promise<{ code: number; json: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...argv, "--json"], {
      env: {
        ...process.env,
        XDG_STATE_HOME: join(home, "state"),
        XDG_CACHE_HOME: join(home, "cache"),
        AGW_MANAGEMENT_KEY: managementKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code: code ?? 1, json: JSON.parse(out) });
      } catch {
        reject(new Error(`agw ${argv.join(" ")} printed no JSON document`));
      }
    });
  });
}

test("agw 2 connects with a management key and manages an app", { skip }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agw-smoke-"));
  let created: string | undefined;
  try {
    const connected = await agw(home, "deployment", "connect", "--url", new URL(consoleUrl).origin);
    assert.equal(connected.code, 0, cliOutcome(connected));
    assert.equal(connected.json.result.credential, "environment");

    const listed = await agw(home, "app", "list");
    assert.equal(listed.code, 0, cliOutcome(listed));
    assert.ok(Array.isArray(listed.json.result.apps));

    const added = await agw(home, "app", "add", "--type", "ios", "--name", "agw smoke", "--team-id", "ABCDE12345", "--bundle-id", "com.example.agwsmoke");
    assert.equal(added.code, 0, cliOutcome(added));
    created = added.json.result.app.id as string;
    // An iOS app has no app key: say so without ever printing one that came back.
    assert.ok(added.json.result.key === null, "agw app add returned an app key for an iOS app");

    const paused = await agw(home, "app", "update", created, "--status", "disabled");
    assert.equal(paused.code, 0, cliOutcome(paused));
    assert.equal(paused.json.result.app.status, "disabled");
  } finally {
    // The remote clean-up and the local one each run, whatever the other did.
    try {
      const id = created;
      await cleanUp(
        id === undefined
          ? []
          : [
              async () => {
                const removed = await agw(home, "app", "remove", id, "--yes");
                return { status: removed.code === 0 ? 200 : 500 };
              },
            ],
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

const base = process.env.V2_BASE_URL ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skipRoundTrip = skip !== false ? skip : base === "" || mockUrl === "" ? "V2_BASE_URL and V2_MOCK_URL are needed" : false;

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await readJson(response) };
}

/** A public key for the issuer settings below. Saving never fetches it. */
const JWK = "eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6ImY4M09KM0QyeEYxQmc4dnViOXRMZTFnSE16Vjc2ZThUdXM5dVBIdlJWRVUiLCJ5IjoieF9GRXpSdTltMzZITE5fdHVlNjU5TE5wWFc2cEN5U3Rpa1lqS0lXSTVhMCIsImtpZCI6InNtb2tlLTEiLCJhbGciOiJFUzI1NiJ9";

/**
 * Every optional app setting a released `agw` must read and write back
 * intact, each set away from its default (v1's `EVERY_OPTION`). A release
 * that adds an optional app setting adds it here too: these are what
 * published CLIs are asked to keep.
 */
function everyOption(slug: string, mock: string): Record<string, unknown>[] {
  const issuer = {
    jwks_url: `${mock}jwks/${JWK}`,
    issuer: ["https://smoke.app-ai-gateway.invalid"],
    audience: ["app-ai-gateway-smoke"],
    user_id_claim: "sub",
    token_header: "x-smoke-user-token",
    required_claims: [
      { path: "plan", equals: "pro" },
      { path: "roles", contains: ["pro"] },
    ],
    max_token_lifetime_seconds: 3600,
    provider: "custom",
    entitlement: "custom",
  };
  const routing = {
    providers: { [slug]: { operations: ["openai.chat", "openai.responses"], models: ["gpt-4o-mini"], max_output_tokens: 512 } },
    model_rewrites: { "smoke-alias": "gpt-4o-mini" },
  };
  const presets = {
    "smoke-preset": {
      provider: slug,
      operation: "openai.chat",
      model: "gpt-4o-mini",
      params: { temperature: 0 },
      max_output_tokens: 256,
      fallback: [{ provider: slug, operation: "openai.chat", model: "gpt-4o-mini" }],
    },
  };
  // Each away from its default: storing is off and every kind is kept by default.
  const conversations = { store: true, keep: { images: false, audio: false, files: false }, retention_days: 30 };
  return [
    {
      authentication: { type: "api_key", end_user: { source: "issuer", issuer } },
      routing,
      limits: {
        // A server app's budget can only be per user: the scope is still written, so it must survive.
        per_user: { requests: { per_minute: 30, per_day: 1000 }, spending: { monthly_nano: 5_000_000_000, scope: "user" } },
        per_app: { requests: { per_minute: 600, per_day: 20_000 }, spending: { monthly_nano: 50_000_000_000 } },
      },
      presets,
      conversations,
    },
    {
      authentication: {
        type: "apple_app_attest",
        end_user: { source: "issuer", issuer },
        app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.agwsmoke", environments: ["production", "development"], verify_on: "token_exchange" },
      },
      routing,
      limits: {
        // An iOS app's budget is per Apple Account by default: per install is away from it.
        per_user: { requests: { per_minute: 30, per_day: 1000 }, spending: { monthly_nano: 5_000_000_000, scope: "install" } },
        per_app: { requests: { per_minute: 600, per_day: 20_000 }, spending: { monthly_nano: 50_000_000_000 } },
      },
      presets,
      conversations,
    },
  ];
}

test("agw 2 renames an app with every option set, and writes its settings back intact; model list runs", { skip: skipRoundTrip }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agw-smoke-"));
  const slug = uniqueSlug("smoke-cli");
  const mock = mockUrl.endsWith("/") ? mockUrl : `${mockUrl}/`;
  let providerId = "";
  const created: string[] = [];
  try {
    const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke CLI", slug, secret: "sk-mock-smoke-key", baseUrl: mock });
    assert.equal(provider.status, 201, outcome(provider));
    providerId = provider.body.provider.id;
    const connected = await agw(home, "deployment", "connect", "--url", new URL(consoleUrl).origin);
    assert.equal(connected.code, 0, cliOutcome(connected));

    // The price list itself, as v1's check reads it: a known provider, and a number for a known model.
    const models = await agw(home, "model", "list");
    assert.equal(models.code, 0, cliOutcome(models));
    const prices = (models.json.result as { prices?: Record<string, Record<string, { input?: unknown }>> } | null)?.prices;
    assert.ok(prices?.openai, "agw model list gave no OpenAI prices");
    assert.equal(typeof prices.openai["gpt-4o-mini"]?.input, "number");

    for (const [index, config] of everyOption(slug, mock).entries()) {
      const app = await admin("POST", "/v2/admin/apps", { name: `agw smoke every option ${index}`, config });
      assert.equal(app.status, 201, outcome(app));
      const id = app.body.app.id as string;
      created.push(id);
      // The baseline: what the server saved, checked to hold every value the fixture set,
      // so a setting dropped on creation is not compared against itself below.
      const before = await admin("GET", `/v2/admin/apps/${id}`);
      assert.equal(before.status, 200, outcome(before));
      assertHolds(before.body.app.config, config, `app ${index} config`);
      const baseline = before.body.app.config;
      // What agw reads before it writes: \`agw app show\` gives the baseline, whole.
      const shown = await agw(home, "app", "show", id);
      assert.equal(shown.code, 0, cliOutcome(shown));
      assertHolds(shown.json.result?.app?.config, baseline, `app ${index} config agw show printed`);
      assertHolds(baseline, shown.json.result?.app?.config, `app ${index} config agw show printed`);
      const renamed = await agw(home, "app", "update", id, "--name", `agw smoke every option ${index} renamed`);
      assert.equal(renamed.code, 0, cliOutcome(renamed));
      // What agw printed, and what the server holds after the rename: the baseline, whole.
      assert.equal(renamed.json.result?.app?.name, `agw smoke every option ${index} renamed`);
      assertHolds(renamed.json.result?.app?.config, baseline, `app ${index} config agw printed`);
      assertHolds(baseline, renamed.json.result?.app?.config, `app ${index} config agw printed`);
      const after = await admin("GET", `/v2/admin/apps/${id}`);
      assert.equal(after.status, 200, outcome(after));
      assert.equal(after.body.app.name, `agw smoke every option ${index} renamed`);
      assertHolds(after.body.app.config, baseline, `app ${index} config after the rename`);
      assertHolds(baseline, after.body.app.config, `app ${index} config after the rename`);
    }
  } finally {
    // The remote clean-up and the local one each run, whatever the other did.
    try {
      await cleanUp([
        ...created.map((id) => () => admin("DELETE", `/v2/admin/apps/${id}?confirm=${id}`)),
        ...(providerId === "" ? [] : [() => admin("DELETE", `/v2/admin/providers/${providerId}`)]),
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
