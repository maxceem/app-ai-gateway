/**
 * Transcription, images, embeddings and speech through a live v2 deployment
 * (plan step 3a, part 2): each written as one charge, billed in the unit its
 * model's price is in. A transcription is sent as a multipart upload.
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

const CONNECTIONS = {
  openai: ["openai.transcription", "openai.images", "openai.embeddings", "openai.speech"],
  groq: ["groq.transcription.openai"],
  bytedance: ["bytedance.images"],
  gemini: ["gemini.embed.v1beta"],
} as const;
type Type = keyof typeof CONNECTIONS;

const run = Date.now().toString(36);
const slugs: Partial<Record<Type, string>> = {};
const providerIds: string[] = [];
let appId = "";
let appKey = "";

before(async () => {
  if (skip !== false) return;
  for (const type of Object.keys(CONNECTIONS) as Type[]) {
    const slug = `smoke-media-${type}-${run}`;
    const created = await admin("POST", "/v2/admin/providers", { type, name: `Smoke media ${type}`, slug, secret: "sk-mock-smoke-key", baseUrl: mockUrl });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    providerIds.push(created.body.provider.id);
    slugs[type] = slug;
  }
  const providers = Object.fromEntries((Object.keys(CONNECTIONS) as Type[]).map((type) => [slugs[type], { operations: [...CONNECTIONS[type]] }]));
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke media APIs",
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

async function call(type: Type, path: string, body: BodyInit, user: string, contentType?: string): Promise<Response> {
  return namedFetch(new URL(`/v2/apps/${appId}/proxy/${slugs[type]}/${path}`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "x-end-user-id": user, ...(contentType ? { "content-type": contentType } : {}) },
    body,
  });
}

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}

const AUDIO = new Blob([new Uint8Array(4096).fill(7)], { type: "audio/mpeg" });

/** The user's usage once its one charge is written (it is written after the answer). */
async function usageOf(user: string): Promise<{ charges: number; cost_nano: number; input_tokens: number; output_tokens: number }> {
  for (let tries = 0; tries < 20; tries += 1) {
    const found = await admin("GET", `/v2/admin/apps/${appId}/users/${encodeURIComponent(user)}`);
    if (found.status === 200 && found.body.user.usage.charges > 0) return found.body.user.usage;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`no charge for ${user}`);
}

test("an OpenAI transcription upload of a time-priced model is billed on its seconds", { skip }, async () => {
  const user = `smoke-stt-min-${run}`;
  const response = await call("openai", "v1/audio/transcriptions", form({ model: "whisper-1", mock_seconds: "12.34", file: AUDIO }), user);
  assert.equal(response.status, 200, await response.clone().text());
  await response.text();
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  // $0.006 a minute on 12.34 s: 6,000,000 × 12,340 ÷ 60,000.
  assert.equal(usage.cost_nano, 1_234_000);
  assert.equal(usage.input_tokens, 0);
});

test("a Groq transcription is sent as verbose_json and billed by the hour on its duration", { skip }, async () => {
  const user = `smoke-stt-hour-${run}`;
  const response = await call("groq", "openai/v1/audio/transcriptions", form({ model: "whisper-large-v3", mock_seconds: "90", file: AUDIO }), user);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  // The mock answers `duration` only to verbose_json: the gateway changed the format.
  assert.equal((JSON.parse(text) as { duration: number }).duration, 90);
  const usage = await usageOf(user);
  // $0.111 an hour on 90 s: 111,000,000 × 90,000 ÷ 3,600,000.
  assert.equal(usage.cost_nano, 2_775_000);
});

test("a transcription format with no usage is refused before the provider", { skip }, async () => {
  const response = await call("openai", "v1/audio/transcriptions", form({ model: "whisper-1", response_format: "text", file: AUDIO }), `smoke-stt-text-${run}`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /response_format/u);
});

const PRICED: { name: string; type: Type; path: string; body: Record<string, unknown>; tokens: boolean }[] = [
  { name: "OpenAI images", type: "openai", path: "v1/images/generations", body: { model: "gpt-image-1", prompt: "a cat" }, tokens: true },
  { name: "Seedream images, per image", type: "bytedance", path: "images/generations", body: { model: "seedream-4-0-250828", prompt: "a cat", n: 2 }, tokens: false },
  { name: "OpenAI embeddings", type: "openai", path: "v1/embeddings", body: { model: "text-embedding-3-small", input: "hello" }, tokens: true },
  { name: "Gemini embeddings", type: "gemini", path: "v1beta/models/gemini-embedding-001:embedContent", body: { content: { parts: [{ text: "hello" }] } }, tokens: true },
  { name: "OpenAI speech streamed as events", type: "openai", path: "v1/audio/speech", body: { model: "gpt-4o-mini-tts", input: "hello", stream_format: "sse" }, tokens: true },
];

for (const api of PRICED) {
  test(`${api.name} is written as one priced charge`, { skip }, async () => {
    const user = `smoke-${api.type}-${api.name.length}-${run}`;
    const response = await call(api.type, api.path, JSON.stringify(api.body), user, "application/json");
    assert.equal(response.status, 200, await response.clone().text());
    await response.arrayBuffer();
    const usage = await usageOf(user);
    assert.equal(usage.charges, 1);
    assert.ok(usage.cost_nano > 0, JSON.stringify(usage));
    if (api.tokens) assert.ok(usage.input_tokens > 0, JSON.stringify(usage));
    // Two Seedream images at $0.03 each.
    else assert.equal(usage.cost_nano, 60_000_000);
  });
}

test("speech answered as plain audio is served, its cost left unknown as in v1", { skip }, async () => {
  const user = `smoke-tts-audio-${run}`;
  const response = await call("openai", "v1/audio/speech", JSON.stringify({ model: "gpt-4o-mini-tts", input: "hello" }), user, "application/json");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal((await response.arrayBuffer()).byteLength, 1024);
  const usage = await usageOf(user);
  assert.equal(usage.charges, 1);
  assert.equal(usage.cost_nano, 0);
});
