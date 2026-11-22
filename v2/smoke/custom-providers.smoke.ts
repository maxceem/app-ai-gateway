/**
 * Custom providers through a live v2 deployment (plan step 5b, section 4.5):
 * a provider the gateway does not know, at a base URL with the key in the
 * header its connection names. A path with an API style is metered by that
 * style at the connection's rates; a plain path is passed through. Saving
 * refuses a `{name}` part where an endpoint's name is, and an address the
 * origin guard does not allow. Everything is made through the management API and removed
 * afterwards.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * The provider is the mock in `smoke/mock/`, so nothing is billed. Skipped
 * when V2_MANAGEMENT_KEY or V2_MOCK_URL is not set.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { holds, outcome } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const run = Date.now().toString(36);
const slug = `smoke-custom-${run}`;
const providerIds: string[] = [];
const appIds: string[] = [];
let appId = "";
let appKey = "";

const AUTH = { header: "x-api-key", format: "{key}" };
const PATHS = [
  { method: "POST", path: "v1/chat/completions", style: "openai-chat" },
  { method: "GET", path: "v1/echo/{id}" },
];

before(async () => {
  if (skip !== false) return;
  const created = await admin("POST", "/v2/admin/providers", {
    type: "custom",
    name: "Smoke custom",
    slug,
    secret: "sk-mock-smoke-custom-key",
    baseUrl: mockUrl,
    auth: AUTH,
    passthrough: PATHS,
    // $1 and $2 per million tokens.
    pricing: { "local-llm": { input: 1, output: 2 } },
  });
  assert.equal(created.status, 201, outcome(created));
  // Write-only: the create answer never holds the key it was given.
  assert.ok(!holds(created.body, "sk-mock-smoke-custom-key"), "the provider create response holds the submitted key");
  providerIds.push(created.body.provider.id);
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke custom",
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: ["custom.openai-chat", "passthrough"] } } },
    },
  });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  appIds.push(app.body.app.id);
  ({ id: appId } = app.body.app);
  appKey = app.body.api_key.key;
});

after(async () => {
  for (const id of appIds) await admin("DELETE", `/v2/admin/apps/${id}?confirm=${id}`);
  for (const id of providerIds) await admin("DELETE", `/v2/admin/providers/${id}`);
});

async function call(method: string, path: string, user: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
  return fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/${path}`, base), {
    method,
    headers: { authorization: `Bearer ${appKey}`, "x-end-user-id": user, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

/** The user's usage once `count` charges are written (they are written after the answer). */
async function usageOf(user: string, count = 1): Promise<{ charges: number; cost_nano: number }> {
  for (let tries = 0; tries < 20; tries += 1) {
    const found = await admin("GET", `/v2/admin/apps/${appId}/users/${encodeURIComponent(user)}`);
    if (found.status === 200 && found.body.user.usage.charges >= count) return found.body.user.usage;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`no charge for ${user}`);
}

test("a custom provider shows its base URL, key header and paths back, never its key", { skip }, async () => {
  const read = await admin("GET", `/v2/admin/providers/${providerIds[0]}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.provider.type, "custom");
  assert.deepEqual(read.body.provider.auth, AUTH);
  assert.deepEqual(read.body.provider.passthrough, PATHS);
  assert.ok(!JSON.stringify(read.body).includes("sk-mock-smoke-custom-key"));
});

test("a path with an API style is metered by that style, at the connection's rates", { skip }, async () => {
  const user = `smoke-custom-chat-${run}`;
  const body = JSON.stringify({ model: "local-llm", messages: [{ role: "user", content: "hi" }] });
  const response = await call("POST", "v1/chat/completions", user, { body, headers: { "content-type": "application/json" } });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const usage = (JSON.parse(text) as { usage: { prompt_tokens: number; completion_tokens: number } }).usage;
  const charged = await usageOf(user);
  assert.equal(charged.charges, 1);
  // 1,000 nano-dollars per input token, 2,000 per output token.
  assert.equal(charged.cost_nano, usage.prompt_tokens * 1_000 + usage.completion_tokens * 2_000);
});

test("a plain path is passed through with the key in the named header, and charged unpriced", { skip }, async () => {
  const user = `smoke-custom-echo-${run}`;
  const response = await call("GET", "v1/echo/abc", user);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const echoed = JSON.parse(text) as { method: string; path: string; forwarded: string[] };
  assert.equal(echoed.path, "/v1/echo/abc");
  assert.ok(echoed.forwarded.includes("x-api-key"), text);
  const charged = await usageOf(user);
  assert.equal(charged.cost_nano, 0);
});

test("a path the custom provider does not list is refused, and nothing is sent", { skip }, async () => {
  const response = await call("POST", "v1/responses", `smoke-custom-closed-${run}`, { body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(response.status, 403, await response.text());
});

test("saving refuses a {name} part where an endpoint's name is, and addresses the origin guard does not allow", { skip }, async () => {
  const attempt = (fields: Record<string, unknown>) =>
    admin("POST", "/v2/admin/providers", { type: "custom", name: "Smoke refused", slug: `smoke-custom-no-${run}`, secret: "sk-mock-smoke-custom-key", auth: AUTH, ...fields });
  for (const fields of [
    // The base URL holds `v1`, so a part right after it stands where an endpoint's name is.
    { baseUrl: "https://api.openai.com/v1/", passthrough: [{ method: "GET", path: "{thing}/details" }] },
    { baseUrl: "http://llm.example.com/" },
    { baseUrl: "https://10.0.0.8/" },
    { baseUrl: "https://localhost/" },
    { baseUrl: "https://gateway.ai.cloudflare.com/v1/a/g/openai/" },
  ]) {
    const refused = await attempt(fields);
    if (refused.status === 201) providerIds.push(refused.body.provider.id);
    assert.equal(refused.status, 400, JSON.stringify([fields, refused.body]));
  }
});
