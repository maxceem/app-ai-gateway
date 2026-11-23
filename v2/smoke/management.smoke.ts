/**
 * The step 1d management API against a live v2 deployment: app PATCH,
 * validate and check, end users, the price list and the provider key test.
 * Everything it makes is removed afterwards.
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

let providerId = "";
let appId = "";
let appKey = "";
let slug = "";

const config = () => ({
  authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
  routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
});

before(async () => {
  if (skip !== false) return;
  slug = `smoke-mgmt-${Date.now().toString(36)}`;
  const provider = await admin("POST", "/v2/admin/providers", {
    type: "openai",
    name: "Smoke management",
    slug,
    secret: "sk-mock-smoke-key",
    baseUrl: mockUrl,
  });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  providerId = provider.body.provider.id;
});

after(async () => {
  if (appId !== "") await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
  if (providerId !== "") await admin("DELETE", `/v2/admin/providers/${providerId}`);
});

test("the price list names priced models", { skip }, async () => {
  const prices = await admin("GET", "/v2/admin/prices");
  assert.equal(prices.status, 200);
  assert.equal(typeof prices.body.prices.openai["gpt-4o-mini"].input, "number");
});

test("the provider types name their API styles, and the custom type", { skip }, async () => {
  const listed = await admin("GET", "/v2/admin/provider-types");
  assert.equal(listed.status, 200);
  const openai = listed.body.types.find((entry: { type: string }) => entry.type === "openai");
  assert.ok(openai?.styles.includes("openai-chat"), "openai does not list the openai-chat style");
  assert.equal(listed.body.types.at(-1)?.type, "custom");
});

test("a key test reports a good key, a rejected one, and stores nothing", { skip }, async () => {
  const good = await admin("POST", "/v2/admin/providers/test", { type: "openai", secret: "sk-mock-smoke-key", baseUrl: mockUrl });
  assert.deepEqual(good, { status: 200, body: { validated: true } });
  const rejected = await admin("POST", "/v2/admin/providers/test", { type: "openai", secret: "sk-mock-rejected", baseUrl: mockUrl });
  assert.deepEqual(rejected.body, { validated: false, reason: "rejected", status: 401 });
  const listed = await admin("GET", "/v2/admin/providers");
  assert.ok(!JSON.stringify(listed.body).includes("sk-mock-rejected"));
});

test("a draft is validated, created, patched and checked", { skip }, async () => {
  const draft = await admin("POST", "/v2/admin/app-drafts/validate", { name: "Smoke management", config: config() });
  assert.deepEqual(draft, { status: 200, body: { valid: true } });
  const created = await admin("POST", "/v2/admin/apps", { name: "Smoke management", config: config() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  appId = created.body.app.id;
  appKey = created.body.api_key.key;

  const patched = await admin("PATCH", `/v2/admin/apps/${appId}`, {
    revision: 1,
    operations: [{ op: "replace", path: "/config/limits/per_user/requests/per_day", value: 1000 }],
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.app.revision, 2);
  assert.equal(patched.body.app.config.limits.per_user.requests.per_day, 1000);
  const stale = await admin("PATCH", `/v2/admin/apps/${appId}`, {
    revision: 1,
    operations: [{ op: "replace", path: "/name", value: "Stale" }],
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "app_revision_conflict");

  const validated = await admin("POST", `/v2/admin/apps/${appId}/validate`, { name: "Smoke management", config: config() });
  assert.deepEqual(validated.body, { valid: true, app_id: appId });
  const checked = await admin("GET", `/v2/admin/apps/${appId}/check`);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.ready, true);
  assert.deepEqual(checked.body.providers, [{ id: providerId, slug, status: "active" }]);
});

test("the app's first request, as the gateway writes it, is served", { skip }, async () => {
  assert.notEqual(appId, "", "the app is created by the test before");
  const snippet = await admin("GET", `/v2/admin/apps/${appId}/snippet`);
  assert.equal(snippet.status, 200);
  // Never the app's key: only the variable it is read from.
  assert.ok(!JSON.stringify(snippet.body).includes(appKey), "the snippet holds the app key");
  const [chat] = snippet.body.examples;
  assert.equal(chat?.operation, "openai.chat");
  assert.ok(String(chat.curl).includes("$APP_AI_GATEWAY_KEY"), "the curl does not read the key from APP_AI_GATEWAY_KEY");
  const response = await fetch(chat.url, {
    method: chat.method,
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": "user-123" },
    body: JSON.stringify(chat.body),
  });
  assert.equal(response.status, 200);
  await response.text();
});

test("a header user shows in the user list after a call, with its usage", { skip }, async () => {
  assert.notEqual(appId, "", "the app is created by the test before");
  const user = `smoke-user-${Date.now().toString(36)}`;
  const response = await fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": user },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] }),
  });
  assert.equal(response.status, 200);
  await response.text();
  // The charge is written after the answer; give it a moment.
  let found: any = null;
  for (let tries = 0; tries < 20 && found === null; tries += 1) {
    const listed = await admin("GET", `/v2/admin/apps/${appId}/users`);
    assert.equal(listed.status, 200);
    found = listed.body.users.find((entry: { id: string }) => entry.id === user) ?? null;
    if (found === null) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(found !== null, "the header user is listed");
  assert.equal(found.is_virtual, true);
  assert.ok(found.usage.charges >= 1);
  assert.ok(found.usage.cost_nano > 0);
  // A virtual user has no row to block.
  assert.equal((await admin("POST", `/v2/admin/apps/${appId}/users/${user}/block`)).status, 404);
});
