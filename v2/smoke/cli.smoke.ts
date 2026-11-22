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
    assert.equal(connected.code, 0, JSON.stringify(connected.json.error));
    assert.equal(connected.json.result.credential, "environment");

    const listed = await agw(home, "app", "list");
    assert.equal(listed.code, 0, JSON.stringify(listed.json.error));
    assert.ok(Array.isArray(listed.json.result.apps));

    const added = await agw(home, "app", "add", "--type", "ios", "--name", "agw smoke", "--team-id", "ABCDE12345", "--bundle-id", "com.example.agwsmoke");
    assert.equal(added.code, 0, JSON.stringify(added.json.error));
    created = added.json.result.app.id as string;
    assert.equal(added.json.result.key, null);

    const paused = await agw(home, "app", "update", created, "--status", "disabled");
    assert.equal(paused.code, 0, JSON.stringify(paused.json.error));
    assert.equal(paused.json.result.app.status, "disabled");
  } finally {
    if (created) {
      const removed = await agw(home, "app", "remove", created, "--yes");
      assert.equal(removed.code, 0, JSON.stringify(removed.json.error));
    }
    await rm(home, { recursive: true, force: true });
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
  return { status: response.status, body: await response.json() };
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
  const conversations = { store: false, keep: { images: false, audio: true, files: false }, retention_days: 30 };
  return [
    {
      authentication: { type: "api_key", end_user: { source: "issuer", issuer } },
      routing,
      limits: {
        per_user: { requests: { per_minute: 30, per_day: 1000 }, spending: { monthly_nano: 5_000_000_000, scope: "user" } },
        per_app: { requests: { per_minute: 600, per_day: null }, spending: { monthly_nano: 50_000_000_000 } },
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
        per_user: { requests: { per_minute: 30, per_day: 1000 }, spending: { monthly_nano: 5_000_000_000, scope: "apple_account" } },
        per_app: { requests: { per_minute: 600, per_day: null }, spending: { monthly_nano: 50_000_000_000 } },
      },
      presets,
      conversations,
    },
  ];
}

test("agw 2 renames an app with every option set, and writes its settings back intact; model list runs", { skip: skipRoundTrip }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agw-smoke-"));
  const slug = `smoke-cli-${Date.now().toString(36)}`;
  const mock = mockUrl.endsWith("/") ? mockUrl : `${mockUrl}/`;
  const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke CLI", slug, secret: "sk-mock-smoke-key", baseUrl: mock });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  const created: string[] = [];
  try {
    const connected = await agw(home, "deployment", "connect", "--url", new URL(consoleUrl).origin);
    assert.equal(connected.code, 0, JSON.stringify(connected.json.error));

    const models = await agw(home, "model", "list");
    assert.equal(models.code, 0, JSON.stringify(models.json.error));
    assert.equal(typeof models.json.result, "object");

    for (const [index, config] of everyOption(slug, mock).entries()) {
      const app = await admin("POST", "/v2/admin/apps", { name: `agw smoke every option ${index}`, config });
      assert.equal(app.status, 201, JSON.stringify(app.body));
      const id = app.body.app.id as string;
      created.push(id);
      const before = await admin("GET", `/v2/admin/apps/${id}`);
      const renamed = await agw(home, "app", "update", id, "--name", `agw smoke every option ${index} renamed`);
      assert.equal(renamed.code, 0, JSON.stringify(renamed.json.error));
      const after = await admin("GET", `/v2/admin/apps/${id}`);
      assert.equal(after.body.app.name, `agw smoke every option ${index} renamed`);
      assert.deepEqual(after.body.app.config, before.body.app.config);
    }
  } finally {
    for (const id of created) await admin("DELETE", `/v2/admin/apps/${id}?confirm=${id}`);
    await admin("DELETE", `/v2/admin/providers/${provider.body.provider.id}`);
    await rm(home, { recursive: true, force: true });
  }
});
