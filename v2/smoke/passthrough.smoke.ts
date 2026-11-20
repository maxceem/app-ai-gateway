/**
 * Passthrough paths through a live v2 deployment (plan step 5, section 4.5):
 * paths a connection lists are forwarded as they are to an app that enables
 * `passthrough`, charged at a flat price per request or not priced. Refused
 * paths stay refused even when listed. Everything is made through the
 * management API and removed afterwards.
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

const run = Date.now().toString(36);
const slug = `smoke-pass-${run}`;
const providerIds: string[] = [];
const appIds: string[] = [];
let appKey = "";
let closedAppId = "";
let closedAppKey = "";
let appId = "";

const LISTED = [
  { method: "GET", path: "v1/echo/{id}" },
  { method: "DELETE", path: "v1/echo/{id}" },
  { method: "POST", path: "v1/echo/priced", per_request: 0.002 },
  { method: "POST", path: "v1/audio/translations" },
];

async function newApp(name: string, operations: string[]): Promise<{ id: string; key: string }> {
  const app = await admin("POST", "/v2/admin/apps", {
    name,
    config: { authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, routing: { providers: { [slug]: { operations } } } },
  });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  appIds.push(app.body.app.id);
  return { id: app.body.app.id, key: app.body.api_key.key };
}

before(async () => {
  if (skip !== false) return;
  const created = await admin("POST", "/v2/admin/providers", {
    type: "openai",
    name: "Smoke passthrough",
    slug,
    secret: "sk-mock-smoke-key",
    baseUrl: mockUrl,
    passthrough: LISTED,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  providerIds.push(created.body.provider.id);
  ({ id: appId, key: appKey } = await newApp("Smoke passthrough", ["passthrough"]));
  ({ id: closedAppId, key: closedAppKey } = await newApp("Smoke passthrough closed", ["openai.chat"]));
});

after(async () => {
  for (const id of appIds) await admin("DELETE", `/v2/admin/apps/${id}?confirm=${id}`);
  for (const id of providerIds) await admin("DELETE", `/v2/admin/providers/${id}`);
});

async function call(method: string, path: string, user: string, init: { body?: BodyInit; headers?: Record<string, string>; app?: string; key?: string } = {}): Promise<Response> {
  return fetch(new URL(`/v2/apps/${init.app ?? appId}/proxy/${slug}/${path}`, base), {
    method,
    headers: { authorization: `Bearer ${init.key ?? appKey}`, "x-end-user-id": user, ...init.headers },
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

test("a connection lists its passthrough paths, shown back with their prices", { skip }, async () => {
  const read = await admin("GET", `/v2/admin/providers/${providerIds[0]}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.provider.passthrough, LISTED);
});

test("a listed GET is forwarded as it is, with the key in its header, and charged unpriced", { skip }, async () => {
  const user = `smoke-pass-get-${run}`;
  const response = await call("GET", "v1//echo/abc?limit=2&key=dropped", user, { headers: { "openai-beta": "assistants=v2", "x-not-forwarded": "1" } });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const echoed = JSON.parse(text) as { method: string; path: string; query: string; forwarded: string[] };
  assert.equal(echoed.method, "GET");
  assert.equal(echoed.path, "/v1/echo/abc");
  assert.equal(echoed.query, "?limit=2");
  assert.ok(echoed.forwarded.includes("openai-beta"), text);
  assert.ok(!echoed.forwarded.includes("x-not-forwarded"), text);
  assert.ok(!echoed.forwarded.includes("x-end-user-id"), text);
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  assert.equal(usage.cost_nano, 0);
});

test("a listed DELETE is forwarded with its method", { skip }, async () => {
  const response = await call("DELETE", "v1/echo/abc", `smoke-pass-delete-${run}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal((JSON.parse(text) as { method: string }).method, "DELETE");
});

test("a listed path with a flat price is charged that price per request", { skip }, async () => {
  const user = `smoke-pass-priced-${run}`;
  for (let index = 0; index < 2; index += 1) {
    const response = await call("POST", "v1/echo/priced", user, { body: JSON.stringify({ n: index }), headers: { "content-type": "application/json" } });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal((JSON.parse(text) as { contentType: string }).contentType, "application/json");
  }
  const usage = await usageOf(user, 2);
  assert.equal(usage.charges, 2);
  // $0.002 a request, twice.
  assert.equal(usage.cost_nano, 4_000_000);
});

test("OpenAI translations work once listed, the upload sent as it is", { skip }, async () => {
  const data = new FormData();
  data.append("model", "whisper-1");
  data.append("file", new Blob([new Uint8Array(2048).fill(3)], { type: "audio/mpeg" }), "a.mp3");
  const response = await call("POST", "v1/audio/translations", `smoke-pass-translate-${run}`, { body: data });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(typeof (JSON.parse(text) as { text: unknown }).text, "string");
});

test("a path that is not listed, or not this method, is refused before the provider", { skip }, async () => {
  for (const [method, path] of [
    ["GET", "v1/echo/abc/more"],
    ["PUT", "v1/echo/abc"],
    ["GET", "v1/echo"],
  ] as const) {
    const response = await call(method, path, `smoke-pass-unlisted-${run}`);
    assert.equal(response.status, 403, `${method} ${path}`);
  }
});

test("an app that does not enable passthrough cannot reach a listed path", { skip }, async () => {
  const response = await call("GET", "v1/echo/abc", `smoke-pass-closed-${run}`, { app: closedAppId, key: closedAppKey });
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "path_not_allowed");
});

test("an admin or key path is refused when listed, and stays refused under case and encoding tricks", { skip }, async () => {
  for (const passthrough of [[{ method: "POST", path: "v1/organization/admin_api_keys" }], [{ method: "POST", path: "v1/realtime/client_secrets" }]]) {
    const refused = await admin("PUT", `/v2/admin/providers/${providerIds[0]}`, { revision: 1, passthrough: [...LISTED, ...passthrough] });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
  }
  for (const path of ["v1/organization/admin_api_keys", "V1/ORGANIZATION/admin_api_keys", "v1/%6frganization/admin_api_keys", "v1/echo/../organization/admin_api_keys", "v1/echo/a%2F..%2Forganization"]) {
    const response = await call("POST", path, `smoke-pass-refused-${run}`, { body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(response.status, 403, path);
  }
});

test("a declared operation's path is not taken as a passthrough path", { skip }, async () => {
  const refused = await admin("PUT", `/v2/admin/providers/${providerIds[0]}`, { revision: 1, passthrough: [{ method: "POST", path: "v1/chat/completions" }] });
  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(refused.body), /openai\.chat/u);
});
