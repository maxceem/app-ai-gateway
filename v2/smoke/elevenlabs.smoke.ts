/**
 * ElevenLabs through a live v2 deployment (plan step 4b): text to speech
 * billed by the credits its `character-cost` header reports, or by the
 * request's characters when the header is missing, and speech to text billed
 * at ElevenLabs' own dollar figure, with its webhook fields removed.
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
const slug = `smoke-eleven-${run}`;
const VOICE = "JBFqnCBsd6RMkjVDRZzb";
let providerId = "";
let appId = "";
let appKey = "";

before(async () => {
  if (skip !== false) return;
  const created = await admin("POST", "/v2/admin/providers", {
    type: "elevenlabs",
    name: "Smoke ElevenLabs",
    slug,
    secret: "sk-mock-smoke-eleven",
    baseUrl: mockUrl,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  providerId = created.body.provider.id;
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke ElevenLabs",
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: {
        providers: {
          [slug]: {
            operations: ["elevenlabs.tts", "elevenlabs.tts_stream", "elevenlabs.stt"],
            models: ["eleven_multilingual_v2", "eleven_flash_v2_5", "scribe_v2"],
          },
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
  if (providerId !== "") await admin("DELETE", `/v2/admin/providers/${providerId}`);
});

async function call(path: string, body: BodyInit, user: string, contentType?: string): Promise<Response> {
  return fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/${path}`, base), {
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
    // real-timer: polls the live deployment until the charge written after the answer appears.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`no charge for ${user}`);
}

test("text to speech passes the audio through and is billed by the credits its header reports", { skip }, async () => {
  const user = `smoke-tts-${run}`;
  const text = "Hello from the gateway cost test.";
  const response = await call(`v1/text-to-speech/${VOICE}`, JSON.stringify({ text, model_id: "eleven_multilingual_v2" }), user, "application/json");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal((await response.arrayBuffer()).byteLength, 1024);
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  // 33 credits at $0.00008 each.
  assert.equal(usage.cost_nano, 2_640_000);
});

test("a streamed answer with no credits header is billed on the request's characters", { skip }, async () => {
  const user = `smoke-tts-missing-${run}`;
  const body = JSON.stringify({ text: "Hello", model_id: "eleven_flash_v2_5", mock_no_cost_header: true });
  const response = await call(`v1/text-to-speech/${VOICE}/stream`, body, user, "application/json");
  assert.equal(response.status, 200, await response.clone().text());
  await response.arrayBuffer();
  const usage = await usageOf(user);
  // 5 characters at $40 per million.
  assert.equal(usage.cost_nano, 200_000);
});

test("speech to text is billed at ElevenLabs' own dollar figure, and no webhook field reaches it", { skip }, async () => {
  const user = `smoke-stt-${run}`;
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("webhook", "true");
  form.append("file", new Blob([new Uint8Array(1024).fill(7)], { type: "audio/wav" }));
  const response = await call("v1/speech-to-text", form, user);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("x-mock-webhook-received"), "false");
  await response.text();
  const usage = await usageOf(user);
  // $0.0005, as the provider sent it.
  assert.equal(usage.cost_nano, 500_000);
});
