/**
 * Model rewrites and presets with fallback chains through a live v2
 * deployment (plan step 3b):
 *
 * - a rewritten model is sent and billed as the model it is rewritten to;
 * - a preset whose first connection fails with 503 answers from its
 *   fallback, and writes two charges, the failed one with no cost;
 * - a preset whose first connection answers 400 is not retried: the error is
 *   passed through, and one charge is written.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * The provider is the mock in `smoke/mock/`, whose `/fail-{status}/` paths
 * always fail. Skipped when V2_MANAGEMENT_KEY or V2_MOCK_URL is not set.
 */
import { after, before, test } from "node:test";
import { admin, check, expectCode, expectStatus, fail, readJson, same, send, TEST_TIMEOUT_MS, uniqueSlug } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;

const run = Date.now().toString(36);
const providerIds: string[] = [];
let appId = "";
let appKey = "";
const slugs = { working: uniqueSlug("smoke-ok"), busy: uniqueSlug("smoke-503"), refusing: uniqueSlug("smoke-400") };

before(async () => {
  if (skip !== false) return;
  const mock = mockUrl.endsWith("/") ? mockUrl : `${mockUrl}/`;
  const urls = { working: mock, busy: `${mock}fail-503/`, refusing: `${mock}fail-400/` };
  for (const [name, slug] of Object.entries(slugs) as [keyof typeof slugs, string][]) {
    const created = await admin("POST", "/v2/admin/providers", {
      type: "openai",
      name: `Smoke presets ${name}`,
      slug,
      secret: "sk-mock-smoke-key",
      baseUrl: urls[name],
    });
    expectStatus(created, 201, "created");
    providerIds.push(created.body.provider.id);
  }
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke presets",
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: {
        providers: { [slugs.working]: { operations: ["openai.chat"], models: ["house-model"] } },
        model_rewrites: { "house-model": "gpt-4o-mini" },
      },
      presets: {
        chain: { provider: slugs.busy, operation: "openai.chat", model: "gpt-4o-mini", fallback: [{ provider: slugs.working, model: "gpt-4o-mini" }] },
        strict: { provider: slugs.refusing, operation: "openai.chat", model: "gpt-4o-mini", fallback: [{ provider: slugs.working, model: "gpt-4o-mini" }] },
      },
    },
  });
  expectStatus(app, 201, "app");
  appId = app.body.app.id;
  appKey = app.body.api_key.key;
});

after(async () => {
  if (appId !== "") await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
  for (const id of providerIds) await admin("DELETE", `/v2/admin/providers/${id}`);
});

async function post(path: string, body: Record<string, unknown>, user: string): Promise<{ status: number; body: any }> {
  const response = await send(path, base, {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": user },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await readJson(response) };
}

/** The user's usage once `charges` charges are written (they are written after the answer). */
async function usageOf(user: string, charges: number): Promise<{ charges: number; failed: number; cost_nano: number }> {
  for (let tries = 0; tries < 30; tries += 1) {
    const found = await admin("GET", `/v2/admin/apps/${appId}/users/${encodeURIComponent(user)}`);
    if (found.status === 200 && found.body.user.usage.charges >= charges) return found.body.user.usage;
    // real-timer: polls a live deployment until the charges land, with a deadline.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail("the expected charges were not written within a minute");
}

test("a rewritten model is sent and billed as its target", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const user = `rewrite-${run}`;
  const answer = await post(`/v2/apps/${appId}/proxy/${slugs.working}/v1/chat/completions`, { model: "house-model", messages: [{ role: "user", content: "hi" }] }, user);
  expectStatus(answer, 200, "answer");
  // The mock answers with the model it was sent.
  check(answer.body.model === "gpt-4o-mini", "the answer is not from the preset's model");
  const usage = await usageOf(user, 1);
  same(usage.charges, 1, "usage.charges is not 1");
  check(usage.cost_nano > 0, "billed at the rewritten model's price");
});

test("a preset falls back after a 503: two charges, the failed one with no cost", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const user = `fallback-${run}`;
  const answer = await post(`/v2/apps/${appId}/presets/chain`, { messages: [{ role: "user", content: "hi" }] }, user);
  expectStatus(answer, 200, "answer");
  const usage = await usageOf(user, 2);
  same(usage.charges, 2, "usage.charges is not 2");
  same(usage.failed, 1, "usage.failed is not 1");
  check(usage.cost_nano > 0, "usage.cost_nano > 0");
});

test("a preset is not retried after a 400: the error is passed through, one charge", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const user = `strict-${run}`;
  const answer = await post(`/v2/apps/${appId}/presets/strict`, { messages: [{ role: "user", content: "hi" }] }, user);
  expectStatus(answer, 400, "the preset call");
  expectCode(answer.body, "mock_failure", "the provider's error");
  const usage = await usageOf(user, 1);
  same(usage.charges, 1, "usage.charges is not 1");
  same(usage.failed, 1, "usage.failed is not 1");
  same(usage.cost_nano, 0, "usage.cost_nano is not 0");
});

// A request the app's own settings refuse is answered as before and shows up
// as a refusal sample, so a developer can see what their app asked for (v1's
// endpoints.smoke.ts). Samples are one a minute per caller and reason.
test("a preset the app does not have is refused and recorded as a refusal sample", { skip, timeout: 90_000 }, async () => {
  const user = `missing-${run}`;
  const answer = await post(`/v2/apps/${appId}/presets/smoke-missing-${run}`, { messages: [{ role: "user", content: "hi" }] }, user);
  expectStatus(answer, 404, "the preset call");
  expectCode(answer.body, "preset_not_found", "a missing preset");
  let sample: { reason: string; user_id: string | null } | undefined;
  for (let tries = 0; tries < 30 && sample === undefined; tries += 1) {
    if (tries > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    const found = await admin("GET", `/v2/admin/apps/${appId}/rejection-events?reason=preset_not_found&user=${encodeURIComponent(user)}`);
    expectStatus(found, 200, "found");
    sample = found.body.events[0];
  }
  check(sample, "no refusal sample was recorded within a minute");
  same(sample.reason, "preset_not_found", "sample.reason is not \"preset_not_found\"");
  same(sample.user_id, user, "sample.user_id is not user");
});
