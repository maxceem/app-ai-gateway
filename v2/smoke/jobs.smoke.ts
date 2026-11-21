/**
 * fal's queue through a live v2 deployment (plan step 6a): a job submitted
 * through the gateway gets a signed job id and polling links on the gateway,
 * its estimate counts at once, polls are free, and reading its result
 * settles it to the units fal billed. Everything is made through the
 * management API and removed afterwards.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * fal is the mock in `smoke/mock/`, so nothing is billed. Skipped when
 * V2_MANAGEMENT_KEY or V2_MOCK_URL is not set.
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
const falSlug = `smoke-falq-${run}`;
let providerId = "";
let appId = "";
let appKey = "";

before(async () => {
  if (skip !== false) return;
  const created = await admin("POST", "/v2/admin/providers", { type: "fal", name: "Smoke fal queue", slug: falSlug, secret: "sk-mock-smoke-fal", baseUrl: mockUrl });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  providerId = created.body.provider.id;
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke fal queue",
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [falSlug]: { operations: ["fal.queue"], models: ["fal-ai/flux/dev"] } } },
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

function headers(user: string): Record<string, string> {
  return { authorization: `Bearer ${appKey}`, "x-end-user-id": user };
}

async function submit(user: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(`/v2/apps/${appId}/proxy/${falSlug}/queue/fal-ai/flux/dev`, base), {
    method: "POST",
    headers: { ...headers(user), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(url: string, user: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { headers: headers(user) });
  return { status: response.status, body: await response.json() };
}

/** The user's usage once it reaches `cost` nano-dollars over `charges` charges (charges are written after the answer). */
async function usageReaches(user: string, charges: number, cost: number): Promise<{ charges: number; cost_nano: number }> {
  let last: unknown = null;
  for (let tries = 0; tries < 30; tries += 1) {
    const found = await admin("GET", `/v2/admin/apps/${appId}/users/${encodeURIComponent(user)}`);
    last = found.body;
    if (found.status === 200 && found.body.user.usage.charges === charges && found.body.user.usage.cost_nano === cost) return found.body.user.usage;
    // real-timer: polls the live deployment until the charges written after the answer appear.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`usage of ${user} never reached ${charges} charges and ${cost}: ${JSON.stringify(last)}`);
}

test("a queue job gets a signed job id and gateway links, and its estimate counts at once", { skip }, async () => {
  const user = `smoke-falq-submit-${run}`;
  // Two 4-megapixel images: 8 units at $0.025, as an estimate.
  const submitted = await submit(user, { prompt: "a lighthouse", num_images: 2, image_size: { width: 2048, height: 2048 } });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const jobId = String(submitted.body.request_id);
  assert.ok(jobId.startsWith("j1."), jobId);
  assert.equal(submitted.body.status_url, new URL(`/v2/apps/${appId}/jobs/${jobId}/status`, base).toString());
  assert.equal(submitted.body.response_url, new URL(`/v2/apps/${appId}/jobs/${jobId}`, base).toString());
  assert.equal(submitted.body.cancel_url, undefined);
  await usageReaches(user, 1, 200_000_000);

  // Polls are free: the status answers through the gateway and adds no charge.
  const status = await get(submitted.body.status_url, user);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.status, "COMPLETED");
  assert.equal(status.body.response_url, submitted.body.response_url);

  // The result settles the job to what fal billed: 2 units, $0.05.
  const result = await get(submitted.body.response_url, user);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.images.length, 2);
  await usageReaches(user, 2, 50_000_000);
});

test("a job that fails with 0 units costs nothing once its result is read", { skip }, async () => {
  const user = `smoke-falq-fail-${run}`;
  const submitted = await submit(user, { prompt: "a lighthouse", mock_fail: true });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  await usageReaches(user, 1, 25_000_000);
  const result = await get(submitted.body.response_url, user);
  assert.equal(result.status, 422);
  await usageReaches(user, 2, 0);
});

test("a job id that is not this app's own is unknown", { skip }, async () => {
  const user = `smoke-falq-forged-${run}`;
  const forged = await get(new URL(`/v2/apps/${appId}/jobs/j1.e30.AAAA/status`, base).toString(), user);
  assert.equal(forged.status, 404);
  assert.equal(forged.body.error.code, "job_not_found");
  // A real job id, asked for by another end user of the same app.
  const submitted = await submit(`smoke-falq-owner-${run}`, { prompt: "a lighthouse" });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const other = await get(submitted.body.status_url, user);
  assert.equal(other.status, 404);
});
