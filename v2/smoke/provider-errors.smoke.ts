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
 *   refused, reaches the provider in that mode, and is charged at least the
 *   model's standard price, marked an estimate;
 * - the app's key never reaches the provider, and the connection's key does,
 *   in its own header, on a failed call as on a served one.
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
import { cleanUp, keyMark, outcome, responseOutcome, uniqueSlug } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;
const PROVIDER_KEY = "sk-mock-smoke-key";
/** What the mock answers for `mock_status`, which the gateway must pass on as it is. */
const MOCK_ERROR = { message: "Mock error", type: "mock_error", code: "mock_error" };

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

let providerId = "";
const apps: { id: string; key: string }[] = [];
let slug = "";
const run = Date.now().toString(36);

/** An app of its own, so its day totals hold only this check's calls. */
async function newApp(name: string): Promise<{ id: string; key: string }> {
  const app = await admin("POST", "/v2/admin/apps", {
    name,
    config: {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
    },
  });
  assert.equal(app.status, 201, outcome(app));
  const created = { id: app.body.app.id as string, key: app.body.api_key.key as string };
  apps.push(created);
  return created;
}

before(async () => {
  if (skip !== false) return;
  slug = uniqueSlug("smoke-errors");
  const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke provider errors", slug, secret: PROVIDER_KEY, baseUrl: mockUrl });
  assert.equal(provider.status, 201, outcome(provider));
  providerId = provider.body.provider.id;
});

after(async () => {
  await cleanUp([
    ...apps.map(({ id }) => () => admin("DELETE", `/v2/admin/apps/${id}?confirm=${id}`)),
    ...(providerId === "" ? [] : [() => admin("DELETE", `/v2/admin/providers/${providerId}`)]),
  ]);
});

function chat(app: { id: string; key: string }, trace: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL(`/v2/apps/${app.id}/proxy/${slug}/v1/chat/completions`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${app.key}`, "content-type": "application/json", "x-client-trace-id": trace },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: trace }], ...body }),
  });
}

/** What reached the provider: the connection's key in its header, and no client credential anywhere. */
function assertProviderSawOnlyItsKey(response: Response): void {
  assert.equal(response.headers.get("x-mock-client-credentials"), "none");
  assert.equal(response.headers.get("x-mock-key"), keyMark("authorization", PROVIDER_KEY));
}

/** The charges of the request sent with `trace`, once written: they are written after the response. */
async function chargesOf(appId: string, trace: string): Promise<any[]> {
  const path = `/v2/admin/apps/${appId}/charges?trace=${encodeURIComponent(trace)}`;
  for (let tries = 0; tries < 30; tries += 1) {
    if (tries > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    const listed = await admin("GET", path);
    assert.equal(listed.status, 200, outcome(listed));
    if (listed.body.charges.length > 0) return listed.body.charges;
  }
  assert.fail(`no charge was written for ${trace} within a minute`);
}

for (const status of [429, 500]) {
  test(`a provider's ${status} reaches the app as it is, and its charge says so`, { skip, timeout: 90_000 }, async () => {
    const app = await newApp(`Smoke provider ${status}`);
    const trace = `smoke-${status}-${run}`;
    const response = await chat(app, trace, { mock_status: status });
    assert.equal(response.status, status);
    assertProviderSawOnlyItsKey(response);
    // The provider's own error, not one the gateway made up in its place.
    assert.deepEqual(((await response.json()) as { error: unknown }).error, MOCK_ERROR);
    const charges = await chargesOf(app.id, trace);
    assert.equal(charges.length, 1);
    assert.equal(charges[0].status, "provider_error");
    assert.equal(charges[0].http_status, status);
    assert.equal(charges[0].cost_nano, null);
  });
}

// Clients filter and group by a charge's status, so it keeps its meaning
// however the gateway stores it.
test("the day's totals split one failed and one served call by status", { skip, timeout: 150_000 }, async () => {
  const app = await newApp("Smoke provider errors totals");
  const failedTrace = `smoke-failed-${run}`;
  const failed = await chat(app, failedTrace, { mock_status: 429 });
  assert.equal(failed.status, 429);
  await failed.arrayBuffer();
  const servedTrace = `smoke-served-${run}`;
  const served = await chat(app, servedTrace, {});
  assert.equal(served.status, 200, await responseOutcome(served));
  assertProviderSawOnlyItsKey(served);
  await served.arrayBuffer();

  const [failedCharge] = await chargesOf(app.id, failedTrace);
  assert.equal(failedCharge.status, "provider_error");
  const [servedCharge] = await chargesOf(app.id, servedTrace);
  assert.equal(servedCharge.status, "ok");
  assert.ok(servedCharge.cost_nano > 0);

  // The charges' own days, so a run that crosses UTC midnight reads the right ones.
  const days = [failedCharge.usage_day as string, servedCharge.usage_day as string].sort();
  const breakdown = await admin("GET", `/v2/admin/apps/${app.id}/usage/breakdown?by=status&from=${days[0]}&to=${days[1]}`);
  assert.equal(breakdown.status, 200, outcome(breakdown));
  const rows = Object.fromEntries(
    (breakdown.body.rows as { key: string | null; charges: number; failed: number }[]).map((row) => [row.key, { charges: row.charges, failed: row.failed }]),
  );
  assert.deepEqual(rows, { failed: { charges: 1, failed: 1 }, ok: { charges: 1, failed: 0 } });
});

// gpt-4o-mini has a price but none for flex: the request is served at the
// closest known price, never below the standard one, and marked an estimate
// (AGENTS.md). The price list is read first, so a flex price added later
// says this fixture needs another mode, not that the gateway is wrong.
test("a request in a service mode with no price is served, reaches the provider in that mode, and is charged at least the standard price", { skip, timeout: 90_000 }, async () => {
  const prices = await admin("GET", "/v2/admin/prices");
  assert.equal(prices.status, 200, outcome(prices));
  const price = prices.body.prices.openai?.["gpt-4o-mini"] as { input: number; output: number; cached_input?: number; modes?: Record<string, unknown> } | undefined;
  assert.ok(price, "gpt-4o-mini is no longer in the price list: pick another fixture model");
  assert.equal(price.modes?.flex, undefined, "gpt-4o-mini now has a flex price: pick a mode with none for this check");

  const app = await newApp("Smoke provider errors flex");
  const trace = `smoke-flex-${run}`;
  const response = await chat(app, trace, { service_tier: "flex" });
  assert.equal(response.status, 200, await responseOutcome(response));
  assert.equal(response.headers.get("x-mock-service-tier"), "flex");
  await response.arrayBuffer();
  const [charge] = await chargesOf(app.id, trace);
  assert.equal(charge.status, "ok");
  assert.equal(charge.price_is_estimate, true);
  // Dollars per million tokens are nano-dollars per thousandth of a token: x 1,000 per token.
  const cached = charge.cached_input_tokens ?? 0;
  const standard =
    (charge.input_tokens - cached) * price.input * 1000 + cached * (price.cached_input ?? price.input) * 1000 + charge.output_tokens * price.output * 1000;
  assert.ok(charge.input_tokens > 0 && charge.output_tokens > 0, "the charge has no measured tokens");
  assert.ok(charge.cost_nano >= Math.floor(standard), `charged ${charge.cost_nano} nano-dollars, below the standard ${standard}`);
});
