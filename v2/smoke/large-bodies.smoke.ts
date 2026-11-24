/**
 * Large answers through a live v2 deployment: an image of several MB, a
 * Responses stream whose closing event holds several MB of output, and a long
 * transcript, each with its usage after the large payload. Each must be
 * written as one priced charge with its exact tokens or seconds: the gateway
 * reads every answer whole as it streams past, whatever its size.
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

/** The size of each large payload: well past what the gateway once kept of an answer (1.25 MB). */
const LARGE = 6 * 1024 * 1024;

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await namedFetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const run = Date.now().toString(36);
let providerId = "";
let slug = "";
let appId = "";
let appKey = "";

before(async () => {
  if (skip !== false) return;
  slug = `smoke-large-${run}`;
  const created = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke large answers", slug, secret: "sk-mock-smoke-key", baseUrl: mockUrl });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  providerId = created.body.provider.id;
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke large answers",
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: ["openai.responses", "openai.images", "openai.transcription"] } } },
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

async function call(path: string, body: BodyInit, user: string, contentType?: string): Promise<number> {
  const response = await namedFetch(new URL(`/v2/apps/${appId}/proxy/${slug}/${path}`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "x-end-user-id": user, ...(contentType ? { "content-type": contentType } : {}) },
    body,
  });
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  return (await response.arrayBuffer()).byteLength;
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

test("a several-MB image answer is billed on the tokens it reports after the image", { skip }, async () => {
  const user = `smoke-large-image-${run}`;
  const bytes = await call("v1/images/generations", JSON.stringify({ model: "gpt-image-1", prompt: "a cat", mock_output_bytes: LARGE }), user, "application/json");
  assert.ok(bytes > LARGE);
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  assert.equal(usage.output_tokens, 1056);
  assert.ok(usage.cost_nano > 0, JSON.stringify(usage));
});

test("a Responses stream whose closing event holds several MB is billed on that event's usage", { skip }, async () => {
  const user = `smoke-large-responses-${run}`;
  const bytes = await call("v1/responses", JSON.stringify({ model: "gpt-5.6-luna", stream: true, input: "Hi", mock_output_bytes: LARGE }), user, "application/json");
  assert.ok(bytes > LARGE * 2, "the payload is in the response twice: the created event's and the closing one's");
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  assert.equal(usage.output_tokens, 5);
  assert.ok(usage.input_tokens > 0, JSON.stringify(usage));
});

test("a several-MB transcript is billed on the seconds it reports after the text", { skip }, async () => {
  const user = `smoke-large-transcript-${run}`;
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("mock_seconds", "12.34");
  form.append("mock_output_bytes", String(LARGE));
  form.append("file", new Blob([new Uint8Array(4096).fill(7)], { type: "audio/mpeg" }));
  const bytes = await call("v1/audio/transcriptions", form, user);
  assert.ok(bytes > LARGE);
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  // $0.006 a minute on 12.34 s: 6,000,000 × 12,340 ÷ 60,000.
  assert.equal(usage.cost_nano, 1_234_000);
});
