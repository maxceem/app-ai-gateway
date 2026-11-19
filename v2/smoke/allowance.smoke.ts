/**
 * The plan allowance on a hosted deployment, against the billing mock
 * (`smoke/billing-mock/`), which gives the account `smoke-allowance` a plan of
 * 3 requests per period.
 *
 *   V2_BASE_URL=… V2_MOCK_URL=… V2_ALLOWANCE_MANAGEMENT_KEY=<a key for smoke-allowance> pnpm run smoke
 *
 * The count lasts the whole period, so a later run may be refused from its
 * first call: the check sends until it is refused, at most limit + 1 calls.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_ALLOWANCE_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip =
  base === "" || managementKey === "" || mockUrl === "" ? "V2_BASE_URL, V2_MOCK_URL and V2_ALLOWANCE_MANAGEMENT_KEY are needed" : false;
const PLAN_LIMIT = 3;

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

before(async () => {
  if (skip !== false) return;
  slug = `allowance-${Date.now().toString(36)}`;
  const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Allowance mock", slug, secret: "sk-mock-allowance-key", baseUrl: mockUrl });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  providerId = provider.body.provider.id;
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke allowance",
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

test("the plan allowance refuses once it is used up, with the period in the refusal", { skip }, async () => {
  let refused: { status: number; retryAfter: string | null; body: any } | null = null;
  for (let call = 0; call <= PLAN_LIMIT && refused === null; call += 1) {
    const response = await fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, base), {
      method: "POST",
      headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] }),
    });
    const body = await response.json();
    if (response.status === 429) refused = { status: response.status, retryAfter: response.headers.get("retry-after"), body };
    else assert.equal(response.status, 200, JSON.stringify(body));
  }
  assert.ok(refused !== null, `not refused within ${PLAN_LIMIT + 1} calls`);
  assert.equal(refused.body.error.code, "billing_request_quota_exceeded");
  assert.equal(refused.body.error.data.limit, PLAN_LIMIT);
  assert.equal(refused.body.error.data.used, PLAN_LIMIT);
  assert.match(String(refused.body.error.data.periodStart), /T00:00:00\.000Z$/u, "a plan period starts at 00:00 UTC");
  assert.ok(Number(refused.retryAfter) > 0);
});
