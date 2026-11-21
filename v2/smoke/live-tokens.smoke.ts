/**
 * Live-session token paths through a live v2 deployment (plan step 5, D4):
 * a path that mints a short-lived secret for a live call is refused unless
 * the listing opts in (`live_token: true`). Once it does, each mint is sent
 * with its window locked to 60 seconds, whatever the client asked for, and
 * charged as a `live_token` call. Everything is made through the management
 * API and removed afterwards.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * The provider is the mock in `smoke/mock/`, which echoes the body it got,
 * so nothing is billed. Skipped when V2_MANAGEMENT_KEY or V2_MOCK_URL is not
 * set.
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
const TOKEN_PATH = "v1/realtime/client_secrets";
const providerIds: string[] = [];
const appIds: string[] = [];
/** A connection that opts its token path in, and one that lists only another path. */
const optedIn = { slug: `smoke-live-${run}`, appId: "", key: "" };
const plain = { slug: `smoke-live-plain-${run}`, appId: "", key: "" };

async function connection(slug: string, passthrough: unknown[]): Promise<{ status: number; body: any }> {
  return admin("POST", "/v2/admin/providers", { type: "openai", name: `Smoke ${slug}`, slug, secret: "sk-mock-smoke-key", baseUrl: mockUrl, passthrough });
}

async function newApp(slug: string): Promise<{ id: string; key: string }> {
  const app = await admin("POST", "/v2/admin/apps", {
    name: `Smoke ${slug}`,
    config: { authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, routing: { providers: { [slug]: { operations: ["passthrough"] } } } },
  });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  appIds.push(app.body.app.id);
  return { id: app.body.app.id, key: app.body.api_key.key };
}

before(async () => {
  if (skip !== false) return;
  const opted = await connection(optedIn.slug, [{ method: "POST", path: TOKEN_PATH, live_token: true }]);
  assert.equal(opted.status, 201, JSON.stringify(opted.body));
  providerIds.push(opted.body.provider.id);
  const other = await connection(plain.slug, [{ method: "GET", path: "v1/echo/{id}" }]);
  assert.equal(other.status, 201, JSON.stringify(other.body));
  providerIds.push(other.body.provider.id);
  ({ id: optedIn.appId, key: optedIn.key } = await newApp(optedIn.slug));
  ({ id: plain.appId, key: plain.key } = await newApp(plain.slug));
});

after(async () => {
  for (const id of appIds) await admin("DELETE", `/v2/admin/apps/${id}?confirm=${id}`);
  for (const id of providerIds) await admin("DELETE", `/v2/admin/providers/${id}`);
});

async function mint(target: { slug: string; appId: string; key: string }, user: string, body: string): Promise<Response> {
  return fetch(new URL(`/v2/apps/${target.appId}/proxy/${target.slug}/${TOKEN_PATH}`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${target.key}`, "x-end-user-id": user, "content-type": "application/json" },
    body,
  });
}

test("a token path is not saved without the opt-in, and the connection shows the opt-in back", { skip }, async () => {
  const refused = await connection(`smoke-live-no-${run}`, [{ method: "POST", path: TOKEN_PATH }]);
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /live_token/u);
  const read = await admin("GET", `/v2/admin/providers/${providerIds[0]}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.provider.passthrough, [{ method: "POST", path: TOKEN_PATH, live_token: true }]);
});

test("a token path a connection did not opt in to is refused before the provider", { skip }, async () => {
  const response = await mint(plain, `smoke-live-refused-${run}`, "{}");
  assert.equal(response.status, 403, await response.text());
});

test("a mint is sent with its window locked to 60 seconds, whatever the client asked for", { skip }, async () => {
  const asked = { expires_after: { anchor: "created_at", seconds: 3600 }, session: { type: "realtime", model: "gpt-realtime" } };
  const response = await mint(optedIn, `smoke-live-${run}`, JSON.stringify(asked));
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const answered = JSON.parse(text) as { value: string; received: { expires_after: { anchor: string; seconds: number }; session: unknown } };
  assert.equal(answered.value, "ek_mock_smoke");
  assert.deepEqual(answered.received.expires_after, { anchor: "created_at", seconds: 60 });
  assert.deepEqual(answered.received.session, asked.session);
});

test("a mint with no window asked for gets the 60-second one", { skip }, async () => {
  const response = await mint(optedIn, `smoke-live-empty-${run}`, "");
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal((JSON.parse(text) as { received: { expires_after: { seconds: number } } }).received.expires_after.seconds, 60);
});

test("each mint is charged to the user who asked for it", { skip }, async () => {
  const user = `smoke-live-charged-${run}`;
  const response = await mint(optedIn, user, "{}");
  assert.equal(response.status, 200, await response.text());
  for (let tries = 0; tries < 20; tries += 1) {
    const found = await admin("GET", `/v2/admin/apps/${optedIn.appId}/users/${encodeURIComponent(user)}`);
    if (found.status === 200 && found.body.user.usage.charges >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`no charge for ${user}`);
});
