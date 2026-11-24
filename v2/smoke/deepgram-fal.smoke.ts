/**
 * Deepgram and fal's `fal.run` through a live v2 deployment (plan step 4c):
 * Deepgram's prerecorded speech to text, sent as raw audio and billed by the
 * seconds its answer reports, and a fal image model billed by the units its
 * `x-fal-billable-units` header reports. Everything is made through the
 * management API and removed afterwards.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * The providers are the mock in `smoke/mock/`, so nothing is billed. Skipped
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
const deepgramSlug = `smoke-deepgram-${run}`;
const falSlug = `smoke-fal-${run}`;
const providerIds: string[] = [];
let appId = "";
let appKey = "";

before(async () => {
  if (skip !== false) return;
  for (const [type, slug] of [
    ["deepgram", deepgramSlug],
    ["fal", falSlug],
  ] as const) {
    const created = await admin("POST", "/v2/admin/providers", { type, name: `Smoke ${type}`, slug, secret: `sk-mock-smoke-${type}`, baseUrl: mockUrl });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    providerIds.push(created.body.provider.id);
  }
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke Deepgram and fal",
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: {
        providers: {
          [deepgramSlug]: { operations: ["deepgram.listen"], models: ["nova-3"] },
          [falSlug]: { operations: ["fal.run"], models: ["fal-ai/flux/dev"] },
        },
      },
    },
  });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  appId = app.body.app.id;
  appKey = app.body.api_key.key;
});

after(async () => {
  if (appId !== "") await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
  for (const id of providerIds) await admin("DELETE", `/v2/admin/providers/${id}`);
});

async function call(slug: string, path: string, body: BodyInit, user: string, contentType: string): Promise<Response> {
  return namedFetch(new URL(`/v2/apps/${appId}/proxy/${slug}/${path}`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "x-end-user-id": user, "content-type": contentType },
    body,
  });
}

/** The user's usage once its one charge is written (it is written after the answer). */
async function usageOf(user: string): Promise<{ charges: number; cost_nano: number }> {
  for (let tries = 0; tries < 20; tries += 1) {
    const found = await admin("GET", `/v2/admin/apps/${appId}/users/${encodeURIComponent(user)}`);
    if (found.status === 200 && found.body.user.usage.charges > 0) return found.body.user.usage;
    // real-timer: polls the live deployment until the charge written after the answer appears.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`no charge for ${user}`);
}

const AUDIO = new Uint8Array(4096).fill(7);

test("Deepgram gets the raw audio as sent, and bills the seconds its answer reports", { skip }, async () => {
  const user = `smoke-dg-${run}`;
  const response = await call(deepgramSlug, "v1/listen?model=nova-3&smart_format=true", AUDIO, user, "audio/wav");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-mock-received-bytes"), "4096");
  assert.equal(response.headers.get("x-mock-model"), "nova-3");
  assert.equal(((await response.json()) as { metadata: { duration: number } }).metadata.duration, 30);
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  // 30 seconds at $0.0043 a minute.
  assert.equal(usage.cost_nano, 2_150_000);
});

test("Deepgram bills multilingual audio at its own rate, on every channel", { skip }, async () => {
  const user = `smoke-dg-multi-${run}`;
  const response = await call(deepgramSlug, "v1/listen?model=nova-3&language=multi&multichannel=true", AUDIO, user, "audio/wav");
  assert.equal(response.status, 200, await response.clone().text());
  await response.json();
  const usage = await usageOf(user);
  // 30 seconds on 2 channels at $0.0052 a minute.
  assert.equal(usage.cost_nano, 5_200_000);
});

test("Deepgram's callback never reaches it, and the answer is still billed", { skip }, async () => {
  const user = `smoke-dg-callback-${run}`;
  const callback = encodeURIComponent("https://callback.example.com/hook");
  const response = await call(deepgramSlug, `v1/listen?model=nova-3&callback=${callback}`, AUDIO, user, "audio/wav");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-mock-callback-received"), "false");
  await response.json();
  assert.equal((await usageOf(user)).cost_nano, 2_150_000);
});

test("Deepgram bills a priced add-on on top of the model's rate", { skip }, async () => {
  const user = `smoke-dg-redact-${run}`;
  const response = await call(deepgramSlug, "v1/listen?model=nova-3&redact=pii", AUDIO, user, "audio/wav");
  assert.equal(response.status, 200, await response.clone().text());
  await response.json();
  // 30 seconds at $0.0043 + $0.0020 redaction a minute.
  assert.equal((await usageOf(user)).cost_nano, 3_150_000);
});

test("Deepgram bills the language it detected", { skip }, async () => {
  const user = `smoke-dg-detect-${run}`;
  const response = await call(deepgramSlug, "v1/listen?model=nova-3&detect_language=true", AUDIO, user, "audio/wav");
  assert.equal(response.status, 200, await response.clone().text());
  await response.json();
  // French, at the monolingual $0.0043 a minute, not the multilingual rate.
  assert.equal((await usageOf(user)).cost_nano, 2_150_000);
});

test("fal.run bills the units its header reports", { skip }, async () => {
  const user = `smoke-fal-${run}`;
  const response = await call(falSlug, "run/fal-ai/flux/dev", JSON.stringify({ prompt: "a lighthouse", num_images: 2 }), user, "application/json");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(((await response.json()) as { images: unknown[] }).images.length, 2);
  // 2 units at $0.025 each.
  assert.equal((await usageOf(user)).cost_nano, 50_000_000);
});

test("fal.run with no units header is billed on the images asked for", { skip }, async () => {
  const user = `smoke-fal-missing-${run}`;
  const body = JSON.stringify({ prompt: "a lighthouse", num_images: 3, mock_no_units: true });
  const response = await call(falSlug, "run/fal-ai/flux/dev", body, user, "application/json");
  assert.equal(response.status, 200, await response.clone().text());
  await response.json();
  // 3 images at $0.025 each, as an estimate.
  assert.equal((await usageOf(user)).cost_nano, 75_000_000);
});

test("fal.run with no units header works the units out from the requested size", { skip }, async () => {
  const user = `smoke-fal-size-${run}`;
  const body = JSON.stringify({ prompt: "a lighthouse", num_images: 2, image_size: { width: 2048, height: 2048 }, mock_no_units: true });
  const response = await call(falSlug, "run/fal-ai/flux/dev", body, user, "application/json");
  assert.equal(response.status, 200, await response.clone().text());
  await response.json();
  // Two 4-megapixel images: 8 units at $0.025 each, as an estimate.
  assert.equal((await usageOf(user)).cost_nano, 200_000_000);
});

test("fal.run refuses a model with no price before calling fal", { skip }, async () => {
  const user = `smoke-fal-unpriced-${run}`;
  const response = await call(falSlug, "run/fal-ai/some-unpriced-model", JSON.stringify({ prompt: "x" }), user, "application/json");
  assert.equal(response.status, 403, await response.clone().text());
  await response.text();
});
