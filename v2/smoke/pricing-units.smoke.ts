/**
 * Pricing in units other than tokens through a live v2 deployment (plan step
 * 4a): a call measured from its request (speech answered as plain audio,
 * billed on its input's characters), and customer rates in non-token units.
 * Everything is made through the management API and removed afterwards.
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
import { namedFetch } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await namedFetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const run = Date.now().toString(36);
const slug = `smoke-units-${run}`;
let providerId = "";
let appId = "";
let appKey = "";

// The customer's own prices, in dollars: $10 per million characters (our list says $15), and $0.01 a minute for a
// whisper-style model the price list does not know (the mock answers its duration).
const PRICING = { "tts-1": { per_million_characters: 10 }, "whisper-house": { per_minute: 0.01 } };

before(async () => {
  if (skip !== false) return;
  const created = await admin("POST", "/v2/admin/providers", {
    type: "openai",
    name: "Smoke units",
    slug,
    secret: "sk-mock-smoke-key",
    baseUrl: mockUrl,
    pricing: PRICING,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  providerId = created.body.provider.id;
  // The prices read back in dollars, as they were given.
  assert.deepEqual(created.body.provider.pricing, PRICING);
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke units",
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: ["openai.speech", "openai.transcription"], models: ["tts-1", "whisper-house"] } } },
    },
  });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  appId = app.body.app.id;
  appKey = app.body.api_key.key;
});

after(async () => {
  if (appId !== "") await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
  if (providerId !== "") await admin("DELETE", `/v2/admin/providers/${providerId}`);
});

async function call(path: string, body: BodyInit, user: string, contentType?: string): Promise<Response> {
  return namedFetch(new URL(`/v2/apps/${appId}/proxy/${slug}/${path}`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "x-end-user-id": user, ...(contentType ? { "content-type": contentType } : {}) },
    body,
  });
}

/** The user's usage once its one charge is written (it is written after the answer). */
async function usageOf(user: string): Promise<{ charges: number; cost_nano: number }> {
  for (let tries = 0; tries < 20; tries += 1) {
    const found = await admin("GET", `/v2/admin/apps/${appId}/users/${encodeURIComponent(user)}`);
    if (found.status === 200 && found.body.user.usage.charges > 0) return found.body.user.usage;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`no charge for ${user}`);
}

test("speech answered as plain audio is billed on its input's characters, at the customer's rate", { skip }, async () => {
  const user = `smoke-chars-${run}`;
  const response = await call("v1/audio/speech", JSON.stringify({ model: "tts-1", input: "hello world" }), user, "application/json");
  assert.equal(response.status, 200, await response.clone().text());
  await response.arrayBuffer();
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  // 11 characters at $10 per million: 10,000,000,000 × 11 ÷ 1,000,000.
  assert.equal(usage.cost_nano, 110_000);
});

test("a transcription model priced only by the customer, per minute, is billed on its seconds", { skip }, async () => {
  const user = `smoke-minute-${run}`;
  const form = new FormData();
  form.append("model", "whisper-house");
  form.append("mock_seconds", "30");
  form.append("file", new Blob([new Uint8Array(1024).fill(7)], { type: "audio/mpeg" }));
  const response = await call("v1/audio/transcriptions", form, user);
  assert.equal(response.status, 200, await response.clone().text());
  await response.text();
  const usage = await usageOf(user);
  // $0.01 a minute on 30 s: 10,000,000 × 30,000 ÷ 60,000.
  assert.equal(usage.cost_nano, 5_000_000);
});
