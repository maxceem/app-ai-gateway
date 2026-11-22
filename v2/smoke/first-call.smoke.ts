/**
 * The first complete call against a live v2 deployment, with everything made
 * through the management API and removed afterwards.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * The provider is the mock in `smoke/mock/`, so nothing is billed. The keys
 * come from the environment only, never from a file in the repository.
 * Skipped when V2_MANAGEMENT_KEY or V2_MOCK_URL is not set.
 */
import { after, before, test } from "node:test";
import { check, expectCode, expectStatus, holds, readJson, same, uniqueSlug } from "./support.ts";

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
  return { status: response.status, body: await readJson(response) };
}

let providerId = "";
let appId = "";
let appKey = "";
let slug = "";

before(async () => {
  if (skip !== false) return;
  slug = uniqueSlug("smoke");
  const provider = await admin("POST", "/v2/admin/providers", {
    type: "openai",
    name: "Smoke mock",
    slug,
    secret: "sk-mock-smoke-key",
    baseUrl: mockUrl,
  });
  expectStatus(provider, 201, "provider");
  // Saved first, so a failed check below still removes it.
  providerId = provider.body.provider.id;
  // Write-only: the create answer holds the hint, never the key itself. Checked
  // before the hint, so a key copied into the hint is never printed.
  check(!holds(provider.body, "sk-mock-smoke-key"), "the provider create response holds the submitted key");
  check(provider.body.provider.secretHint === "-key", "the provider create response has the wrong key hint");
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke first call",
    config: {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
    },
  });
  expectStatus(app, 201, "app");
  appId = app.body.app.id;
  appKey = app.body.api_key.key;
});

after(async () => {
  if (appId !== "") await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
  if (providerId !== "") await admin("DELETE", `/v2/admin/providers/${providerId}`);
});

function chat(body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a chat call answers with the provider's JSON", { skip }, async () => {
  const response = await chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] });
  same(response.status, 200, "response.status is not 200");
  const body = (await readJson(response)) as { usage?: { prompt_tokens?: number } };
  check((body.usage?.prompt_tokens ?? 0) > 0, "(body.usage?.prompt_tokens ?? 0) > 0");
});

test("a streamed chat call ends with its usage", { skip }, async () => {
  const response = await chat({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "Hi" }] });
  same(response.status, 200, "response.status is not 200");
  const text = await response.text();
  // Tested, never printed: a stream is the provider's text.
  check(/"usage"/u.test(text), "the stream has no usage");
  check(/data: \[DONE\]/u.test(text), "the stream does not end with [DONE]");
});

test("a model the app does not allow is refused", { skip }, async () => {
  const response = await chat({ model: "gpt-4o", messages: [] });
  same(response.status, 403, "response.status is not 403");
  expectCode(await readJson(response), "model_not_allowed", "response");
});

test("a provider error is passed through", { skip }, async () => {
  const response = await chat({ model: "gpt-4o-mini", messages: [], mock_status: 429 });
  same(response.status, 429, "response.status is not 429");
  expectCode(await readJson(response), "mock_error", "response");
});
