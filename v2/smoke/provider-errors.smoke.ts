/**
 * What a provider's failure and an unpriced service mode look like through a
 * live v2 deployment, read back from the charges (v1's
 * `upstream-errors.smoke.ts` and the service-mode check of
 * `proxy-openai.smoke.ts`):
 *
 * - a provider's 429 and 500 reach the app as they are;
 * - each attempt's charge says how it ended: `ok`, or `provider_error` with
 *   the provider's status and no cost, and the day's totals split by it;
 * - a request in a service mode the model has no price for is served, never
 *   refused, and its charge says its cost is an estimate;
 * - the app's key never reaches the provider.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * Skipped when V2_MANAGEMENT_KEY, V2_MOCK_URL or V2_BASE_URL is not set.
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

let providerId = "";
let appId = "";
let appKey = "";
let slug = "";
const run = Date.now().toString(36);

before(async () => {
  if (skip !== false) return;
  slug = `smoke-errors-${run}`;
  const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke provider errors", slug, secret: "sk-mock-smoke-key", baseUrl: mockUrl });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  providerId = provider.body.provider.id;
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke provider errors",
    config: {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
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

function chat(trace: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-client-trace-id": trace },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: trace }], ...body }),
  });
}

/** The charges of the request sent with `trace`, once written: they are written after the response. */
async function chargesOf(trace: string): Promise<any[]> {
  const path = `/v2/admin/apps/${appId}/charges?trace=${encodeURIComponent(trace)}`;
  for (let tries = 0; tries < 30; tries += 1) {
    if (tries > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    const listed = await admin("GET", path);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    if (listed.body.charges.length > 0) return listed.body.charges;
  }
  assert.fail(`no charge was written for ${trace} within a minute`);
}

for (const status of [429, 500]) {
  test(`a provider's ${status} reaches the app as ${status}`, { skip }, async () => {
    const response = await chat(`smoke-${status}-${run}`, { mock_status: status });
    assert.equal(response.status, status);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "mock_error");
  });
}

// Clients filter and group by a charge's status, so it keeps its meaning
// however the gateway stores it.
test("a charge says whether the provider failed the attempt, and the day's totals split by it", { skip, timeout: 150_000 }, async () => {
  const failedTrace = `smoke-failed-${run}`;
  const failed = await chat(failedTrace, { mock_status: 429 });
  assert.equal(failed.status, 429);
  await failed.arrayBuffer();
  const servedTrace = `smoke-served-${run}`;
  const served = await chat(servedTrace, {});
  assert.equal(served.status, 200);
  // The app's key is the gateway's own: it never reaches the provider.
  assert.equal(served.headers.get("x-mock-client-credentials"), "none");
  await served.arrayBuffer();

  const [failedCharge] = await chargesOf(failedTrace);
  assert.equal(failedCharge.status, "provider_error");
  assert.equal(failedCharge.http_status, 429);
  assert.equal(failedCharge.cost_nano, null);
  const [servedCharge] = await chargesOf(servedTrace);
  assert.equal(servedCharge.status, "ok");
  assert.ok(servedCharge.cost_nano > 0);

  const today = new Date().toISOString().slice(0, 10);
  const breakdown = await admin("GET", `/v2/admin/apps/${appId}/usage/breakdown?by=status&from=${today}&to=${today}`);
  assert.equal(breakdown.status, 200, JSON.stringify(breakdown.body));
  const keys = breakdown.body.rows.map((row: { key: string | null }) => row.key).sort();
  assert.deepEqual(keys, ["failed", "ok"]);
});

// gpt-4o-mini has a price but none for flex: the request is served at the
// closest known price, never refused, and marked an estimate (AGENTS.md).
test("a request in a service mode with no price is served and its charge is an estimate", { skip, timeout: 90_000 }, async () => {
  const trace = `smoke-flex-${run}`;
  const response = await chat(trace, { service_tier: "flex" });
  assert.equal(response.status, 200, await response.clone().text());
  await response.arrayBuffer();
  const [charge] = await chargesOf(trace);
  assert.equal(charge.status, "ok");
  assert.equal(charge.price_is_estimate, true);
  assert.ok(charge.cost_nano > 0);
});
