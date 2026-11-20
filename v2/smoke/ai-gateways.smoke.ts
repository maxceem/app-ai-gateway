/**
 * Traffic through another AI gateway, through a live v2 deployment (plan step
 * 3c, D13):
 *
 * - Vercel AI Gateway, a provider of its own: a namespaced model is priced
 *   from our list, and the app is named in Vercel's spend attribution.
 * - Cloudflare AI Gateway, a setting on a built-in provider: the request goes
 *   to the gateway's URL with its token and no provider key, and is billed
 *   from the provider's own answer. Run only where the deployment's
 *   test build has the mock as Cloudflare's stand-in (V2_MOCK_CLOUDFLARE=1),
 *   so nothing reaches Cloudflare.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   V2_MOCK_CLOUDFLARE=1 \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * Everything is made through the management API and removed afterwards.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;
const skipCloudflare = skip !== false ? skip : process.env.V2_MOCK_CLOUDFLARE === "1" ? false : "V2_MOCK_CLOUDFLARE=1 is needed";

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const run = Date.now().toString(36);
const vercelSlug = `smoke-vercel-${run}`;
const cloudflareSlug = `smoke-cf-${run}`;
const providerIds: string[] = [];
let appId = "";
let appKey = "";

before(async () => {
  if (skip !== false) return;
  const vercel = await admin("POST", "/v2/admin/providers", {
    type: "vercel",
    name: "Smoke Vercel",
    slug: vercelSlug,
    secret: "sk-mock-smoke-key",
    baseUrl: mockUrl,
  });
  assert.equal(vercel.status, 201, JSON.stringify(vercel.body));
  providerIds.push(vercel.body.provider.id);
  const providers: Record<string, unknown> = { [vercelSlug]: { operations: ["vercel.chat"], models: ["openai/gpt-4o-mini"] } };
  if (skipCloudflare === false) {
    // No provider key: through Cloudflare, the keys it stores are used.
    const cloudflare = await admin("POST", "/v2/admin/providers", {
      type: "openai",
      name: "Smoke Cloudflare",
      slug: cloudflareSlug,
      cloudflareGateway: { accountId: "smoke-account", gatewayId: "smoke-gateway", token: "cf-mock-smoke-token" },
    });
    assert.equal(cloudflare.status, 201, JSON.stringify(cloudflare.body));
    assert.equal(cloudflare.body.provider.secretHint, null);
    providerIds.push(cloudflare.body.provider.id);
    providers[cloudflareSlug] = { operations: ["openai.chat"] };
  }
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke AI gateways",
    config: { authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, routing: { providers } },
  });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  appId = app.body.app.id;
  appKey = app.body.api_key.key;
});

after(async () => {
  if (appId !== "") await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
  for (const id of providerIds) await admin("DELETE", `/v2/admin/providers/${id}`);
});

async function call(slug: string, body: Record<string, unknown>, user: string): Promise<Response> {
  const response = await fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": user },
    body: JSON.stringify(body),
  });
  return response;
}

/** The user's usage once its one charge is written (it is written after the answer). */
async function usageOf(user: string): Promise<{ charges: number; cost_nano: number; input_tokens: number; output_tokens: number }> {
  for (let tries = 0; tries < 20; tries += 1) {
    const found = await admin("GET", `/v2/admin/apps/${appId}/users/${encodeURIComponent(user)}`);
    if (found.status === 200 && found.body.user.usage.charges > 0) return found.body.user.usage;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`no charge for ${user}`);
}

test("a Vercel call is priced from our list under its model's provider, and attributed to the app", { skip }, async () => {
  const user = `smoke-vercel-${run}`;
  const response = await call(vercelSlug, { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] }, user);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(response.headers.get("x-mock-reporting-tags"), `app:${appId}`);
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  assert.equal(usage.output_tokens, 5);
  assert.ok(usage.cost_nano > 0, JSON.stringify(usage));
});

test("a Cloudflare-routed call reaches the gateway with its token and the app's metadata, and is billed", { skip: skipCloudflare }, async () => {
  const user = `smoke-cf-${run}`;
  const response = await call(cloudflareSlug, { model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] }, user);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(response.headers.get("x-mock-via-cloudflare"), "openai");
  assert.deepEqual(JSON.parse(response.headers.get("x-mock-cf-metadata") ?? "{}"), { app_id: appId, user_id: user });
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  assert.equal(usage.output_tokens, 5);
  assert.ok(usage.cost_nano > 0, JSON.stringify(usage));
});

test("a connection that could not be sent is refused when saved", { skip }, async () => {
  const noKey = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke no key", slug: `smoke-nokey-${run}` });
  assert.equal(noKey.status, 400, JSON.stringify(noKey.body));
  const unserved = await admin("POST", "/v2/admin/providers", {
    type: "groq",
    name: "Smoke groq",
    slug: `smoke-groq-cf-${run}`,
    cloudflareGateway: { accountId: "a", gatewayId: "g", token: "cf-mock-smoke-token" },
  });
  assert.equal(unserved.status, 400, JSON.stringify(unserved.body));
});
