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
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { outcome, readJson, uniqueSlug } from "./support.ts";

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
    assert.equal(created.status, 201, outcome(created));
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
  assert.equal(app.status, 201, outcome(app));
  appId = app.body.app.id;
  appKey = app.body.api_key.key;
});

after(async () => {
  if (appId !== "") await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
  for (const id of providerIds) await admin("DELETE", `/v2/admin/providers/${id}`);
});

async function post(path: string, body: Record<string, unknown>, user: string): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": user },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await readJson(response) };
}

/** The user's usage once `charges` charges are written (they are written after the answer). */
async function usageOf(user: string, charges: number): Promise<{ charges: number; failed: number; cost_nano: number }> {
  for (let tries = 0; tries < 20; tries += 1) {
    const found = await admin("GET", `/v2/admin/apps/${appId}/users/${encodeURIComponent(user)}`);
    if (found.status === 200 && found.body.user.usage.charges >= charges) return found.body.user.usage;
    // real-timer: polls a live deployment until the charges land, with a deadline.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`no ${charges} charges for ${user}`);
}

test("a rewritten model is sent and billed as its target", { skip }, async () => {
  const user = `rewrite-${run}`;
  const answer = await post(`/v2/apps/${appId}/proxy/${slugs.working}/v1/chat/completions`, { model: "house-model", messages: [{ role: "user", content: "hi" }] }, user);
  assert.equal(answer.status, 200, outcome(answer));
  // The mock answers with the model it was sent.
  assert.ok(answer.body.model === "gpt-4o-mini", "the answer is not from the preset's model");
  const usage = await usageOf(user, 1);
  assert.equal(usage.charges, 1);
  assert.ok(usage.cost_nano > 0, "billed at the rewritten model's price");
});

test("a preset falls back after a 503: two charges, the failed one with no cost", { skip }, async () => {
  const user = `fallback-${run}`;
  const answer = await post(`/v2/apps/${appId}/presets/chain`, { messages: [{ role: "user", content: "hi" }] }, user);
  assert.equal(answer.status, 200, outcome(answer));
  const usage = await usageOf(user, 2);
  assert.equal(usage.charges, 2);
  assert.equal(usage.failed, 1);
  assert.ok(usage.cost_nano > 0);
});

test("a preset is not retried after a 400: the error is passed through, one charge", { skip }, async () => {
  const user = `strict-${run}`;
  const answer = await post(`/v2/apps/${appId}/presets/strict`, { messages: [{ role: "user", content: "hi" }] }, user);
  assert.equal(answer.status, 400);
  assert.ok(answer.body.error?.code === "mock_failure", `not the provider's error: ${outcome(answer)}`);
  const usage = await usageOf(user, 1);
  assert.equal(usage.charges, 1);
  assert.equal(usage.failed, 1);
  assert.equal(usage.cost_nano, 0);
});

// A request the app's own settings refuse is answered as before and shows up
// as a refusal sample, so a developer can see what their app asked for (v1's
// endpoints.smoke.ts). Samples are one a minute per caller and reason.
test("a preset the app does not have is refused and recorded as a refusal sample", { skip, timeout: 90_000 }, async () => {
  const user = `missing-${run}`;
  const answer = await post(`/v2/apps/${appId}/presets/smoke-missing-${run}`, { messages: [{ role: "user", content: "hi" }] }, user);
  assert.equal(answer.status, 404);
  assert.ok(answer.body.error?.code === "preset_not_found", `not preset_not_found: ${outcome(answer)}`);
  let sample: { reason: string; user_id: string | null } | undefined;
  for (let tries = 0; tries < 30 && sample === undefined; tries += 1) {
    if (tries > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    const found = await admin("GET", `/v2/admin/apps/${appId}/rejection-events?reason=preset_not_found&user=${encodeURIComponent(user)}`);
    assert.equal(found.status, 200, outcome(found));
    sample = found.body.events[0];
  }
  assert.ok(sample, "no refusal sample was recorded within a minute");
  assert.equal(sample.reason, "preset_not_found");
  assert.equal(sample.user_id, user);
});
