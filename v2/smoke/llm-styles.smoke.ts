/**
 * Each text API style through a live v2 deployment (plan step 3): Chat
 * Completions, Responses, Anthropic Messages and Gemini, each answered as
 * JSON and as a stream, each written as one charge with the right units.
 * OpenRouter's own cost report is checked through the mock's chat answer.
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
import { after, before, test } from "node:test";
import { check, cleanUp, expectCode, expectResponse, expectStatus, fail, keyMark, readJson, same, uniqueSlug, send } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await send(path, base, {
    method,
    headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await readJson(response) };
}

/** One connection per provider type, all pointed at the mock. */
const CONNECTIONS = {
  openai: ["openai.chat", "openai.responses"],
  anthropic: ["anthropic.messages"],
  gemini: ["gemini.generate.v1beta", "gemini.stream.v1beta"],
  openrouter: ["openrouter.chat"],
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
    const slug = uniqueSlug(`smoke-${type}`);
    // Each connection its own fixture key, so a gateway that sends another connection's key is seen.
    const created = await admin("POST", "/v2/admin/providers", { type, name: `Smoke ${type}`, slug, secret: `sk-mock-smoke-${type}`, baseUrl: mockUrl });
    expectStatus(created, 201, "created");
    providerIds.push(created.body.provider.id);
    slugs[type] = slug;
  }
  const providers = Object.fromEntries((Object.keys(CONNECTIONS) as Type[]).map((type) => [slugs[type], { operations: [...CONNECTIONS[type]] }]));
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke LLM styles",
    config: { authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, routing: { providers } },
  });
  expectStatus(app, 201, "app");
  appId = app.body.app.id;
  appKey = app.body.api_key.key;
});

after(async () => {
  // Every step runs, even after one fails.
  await cleanUp([
    ...(appId === "" ? [] : [() => admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`)]),
    ...providerIds.map((id) => () => admin("DELETE", `/v2/admin/providers/${id}`)),
  ]);
});

/** Each provider type's key header, as the provider itself reads it (v1's key-and-header check). */
const KEY_HEADERS: Record<Type, string> = { openai: "authorization", anthropic: "x-api-key", gemini: "x-goog-api-key", openrouter: "authorization" };

/** Calls a proxy path; checks the status and the key the mock saw. Returns the response, its body unread. */
async function call(type: Type, path: string, body: Record<string, unknown>, user: string): Promise<Response> {
  const response = await send(`/v2/apps/${appId}/proxy/${slugs[type]}/${path}`, base, {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": user },
    body: JSON.stringify(body),
  });
  await expectResponse(response, 200, "the call");
  // The connection's own key, alone, in its provider's own header and scheme; never the app's key.
  same(response.headers.get("x-mock-key"), keyMark(KEY_HEADERS[type], `fixture-${type}`), "the provider did not get its own key in its own header");
  same(response.headers.get("x-mock-client-credentials"), "none", "a client credential reached the provider");
  return response;
}

/** The user's usage once its one charge is written (it is written after the answer). */
async function usageOf(user: string): Promise<{ charges: number; cost_nano: number; input_tokens: number; output_tokens: number }> {
  for (let tries = 0; tries < 20; tries += 1) {
    const found = await admin("GET", `/v2/admin/apps/${appId}/users/${encodeURIComponent(user)}`);
    if (found.status === 200 && found.body.user.usage.charges > 0) return found.body.user.usage;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail("no charge was written within a minute");
}

const STYLES: { name: string; type: Type; path: (stream: boolean) => string; body: (stream: boolean) => Record<string, unknown> }[] = [
  {
    name: "Chat Completions",
    type: "openai",
    path: () => "v1/chat/completions",
    body: (stream) => ({ model: "gpt-4o-mini", stream, messages: [{ role: "user", content: "Hi" }] }),
  },
  {
    name: "Responses",
    type: "openai",
    path: () => "v1/responses",
    body: (stream) => ({ model: "gpt-5.6-luna", stream, input: "Hi" }),
  },
  {
    name: "Anthropic Messages",
    type: "anthropic",
    path: () => "v1/messages",
    body: (stream) => ({ model: "claude-sonnet-5", stream, max_tokens: 16, messages: [{ role: "user", content: "Hi" }] }),
  },
  {
    name: "Gemini",
    type: "gemini",
    path: (stream) => `v1beta/models/gemini-3.5-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
    body: () => ({ contents: [{ role: "user", parts: [{ text: "Hi" }] }] }),
  },
];

for (const style of STYLES) {
  for (const stream of [false, true]) {
    test(`${style.name}${stream ? ", streamed," : ""} is written as one priced charge with its tokens`, { skip }, async () => {
      const user = `smoke-${style.type}-${stream ? "s" : "j"}-${style.name.length}-${run}`;
      // Read to the end: a streamed answer is charged once it is whole. Never printed.
      await (await call(style.type, style.path(stream), style.body(stream), user)).text();
      const usage = await usageOf(user);
      same(usage.charges, 1, "not exactly one charge");
      check(usage.input_tokens > 0, "no input tokens on the charge");
      same(usage.output_tokens, 5, "the charge's output tokens are not the mock's");
      check(usage.cost_nano > 0, "the charge has no cost");
    });
  }
}

test("OpenRouter is billed at the cost its answer reports", { skip }, async () => {
  const user = `smoke-openrouter-${run}`;
  const response = await call("openrouter", "v1/chat/completions", { model: "mock-lab/unlisted-model", messages: [{ role: "user", content: "Hi" }] }, user);
  const reported = ((await readJson(response)) as { usage: { prompt_tokens: number; cost: number } }).usage;
  const usage = await usageOf(user);
  same(usage.charges, 1, "usage.charges is not 1");
  // The mock reports $1 per million prompt tokens: 1,000 nano-dollars a token.
  same(usage.cost_nano, reported.prompt_tokens * 1000, "usage.cost_nano is not reported.prompt_tokens * 1000");
});

test("a background Responses request is refused before it reaches the provider", { skip }, async () => {
  const response = await send(`/v2/apps/${appId}/proxy/${slugs.openai}/v1/responses`, base, {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": `smoke-bg-${run}` },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "Hi", background: true }),
  });
  same(response.status, 400, "response.status is not 400");
  expectCode(await readJson(response), "invalid_request", "response");
});
