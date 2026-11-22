/**
 * Custom providers through a live v2 deployment (plan step 5b, section 4.5):
 * a provider the gateway does not know, at a base URL with the key in the
 * header its connection names. A path with an API style is metered by that
 * style at the connection's rates; a plain path is passed through. Saving
 * refuses a `{name}` part where an endpoint's name is, and an address the
 * origin guard does not allow. Everything is made through the management API and removed
 * afterwards.
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
import { admin, check, cleanUp, expectResponse, expectStatus, holds, poll, readJson, same, sameJson, send, TEST_TIMEOUT_MS, uniqueSlug } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;

const run = Date.now().toString(36);
const slug = uniqueSlug("smoke-custom");
const providerIds: string[] = [];
const appIds: string[] = [];
let appId = "";
let appKey = "";

const AUTH = { header: "x-api-key", format: "{key}" };
const PATHS = [
  { method: "POST", path: "v1/chat/completions", style: "openai-chat" },
  { method: "GET", path: "v1/echo/{id}" },
];

before(async () => {
  if (skip !== false) return;
  const created = await admin("POST", "/v2/admin/providers", {
    type: "custom",
    name: "Smoke custom",
    slug,
    secret: "sk-mock-smoke-custom-key",
    baseUrl: mockUrl,
    auth: AUTH,
    passthrough: PATHS,
    // $1 and $2 per million tokens.
    pricing: { "local-llm": { input: 1, output: 2 } },
  });
  expectStatus(created, 201, "created");
  // Saved first, so a failed check below still removes it.
  providerIds.push(created.body.provider.id);
  // Write-only: the create answer never holds the key it was given.
  check(!holds(created.body, "sk-mock-smoke-custom-key"), "the provider create response holds the submitted key");
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke custom",
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: ["custom.openai-chat", "passthrough"] } } },
    },
  });
  expectStatus(app, 201, "app");
  appIds.push(app.body.app.id);
  ({ id: appId } = app.body.app);
  appKey = app.body.api_key.key;
});

after(async () => {
  await cleanUp([
    ...appIds.map((id) => () => admin("DELETE", `/v2/admin/apps/${id}?confirm=${id}`)),
    ...providerIds.map((id) => () => admin("DELETE", `/v2/admin/providers/${id}`)),
  ]);
});

async function call(method: string, path: string, user: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
  return send(`/v2/apps/${appId}/proxy/${slug}/${path}`, base, {
    method,
    headers: { authorization: `Bearer ${appKey}`, "x-end-user-id": user, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

/** The user's usage once `count` charges are written (they are written after the answer). */
async function usageOf(user: string, count = 1): Promise<{ charges: number; cost_nano: number }> {
  return poll(async () => {
    const found = await admin("GET", `/v2/admin/apps/${appId}/users/${encodeURIComponent(user)}`);
    return found.status === 200 && found.body.user.usage.charges >= count ? found.body.user.usage : undefined;
  }, "no charge was written within a minute");
}

test("a custom provider shows its base URL, key header and paths back, never its key", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const read = await admin("GET", `/v2/admin/providers/${providerIds[0]}`);
  expectStatus(read, 200, "read");
  same(read.body.provider.type, "custom", "read.body.provider.type is not \"custom\"");
  check(sameJson(read.body.provider.auth, AUTH), "the provider's key header is not what was saved");
  check(sameJson(read.body.provider.passthrough, PATHS), "the provider's paths are not what was saved");
  check(!holds(read.body, "sk-mock-smoke-custom-key"), "the provider read response holds its key");
});

test("a path with an API style is metered by that style, at the connection's rates", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const user = `smoke-custom-chat-${run}`;
  const body = JSON.stringify({ model: "local-llm", messages: [{ role: "user", content: "hi" }] });
  const response = await call("POST", "v1/chat/completions", user, { body, headers: { "content-type": "application/json" } });
  await expectResponse(response, 200, "response");
  const usage = ((await readJson(response)) as { usage: { prompt_tokens: number; completion_tokens: number } }).usage;
  const charged = await usageOf(user);
  same(charged.charges, 1, "charged.charges is not 1");
  // 1,000 nano-dollars per input token, 2,000 per output token.
  same(charged.cost_nano, usage.prompt_tokens * 1_000 + usage.completion_tokens * 2_000, "charged.cost_nano is not usage.prompt_tokens * 1_000 + usage.completion_tokens * 2_000");
});

test("a plain path is passed through with the key in the named header, and charged unpriced", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const user = `smoke-custom-echo-${run}`;
  const response = await call("GET", "v1/echo/abc", user);
  await expectResponse(response, 200, "response");
  const echoed = (await readJson(response)) as { method: string; path: string; forwarded: string[] };
  check(echoed.path === "/v1/echo/abc", "the provider was sent another path");
  check(echoed.forwarded.includes("x-api-key"), "the provider got no key in the named header");
  const charged = await usageOf(user);
  same(charged.cost_nano, 0, "charged.cost_nano is not 0");
});

test("a path the custom provider does not list is refused, and nothing is sent", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const response = await call("POST", "v1/responses", `smoke-custom-closed-${run}`, { body: "{}", headers: { "content-type": "application/json" } });
  await expectResponse(response, 403, "response");
});

test("saving refuses a {name} part where an endpoint's name is, and addresses the origin guard does not allow", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const attempt = (fields: Record<string, unknown>) =>
    admin("POST", "/v2/admin/providers", { type: "custom", name: "Smoke refused", slug: uniqueSlug("smoke-custom-no"), secret: "sk-mock-smoke-custom-key", auth: AUTH, ...fields });
  for (const fields of [
    // The base URL holds `v1`, so a part right after it stands where an endpoint's name is.
    { baseUrl: "https://api.openai.com/v1/", passthrough: [{ method: "GET", path: "{thing}/details" }] },
    { baseUrl: "http://llm.example.com/" },
    { baseUrl: "https://10.0.0.8/" },
    { baseUrl: "https://localhost/" },
    { baseUrl: "https://gateway.ai.cloudflare.com/v1/a/g/openai/" },
  ]) {
    const refused = await attempt(fields);
    if (refused.status === 201) providerIds.push(refused.body.provider.id);
    expectStatus(refused, 400, "a provider with refused fields");
  }
});
