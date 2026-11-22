/**
 * Usage read back through the management API (step 7b-3): a call is made,
 * then found as a charge, in the app's month and the account's month, and
 * through the tools the CLI and MCP call. Deleting the app keeps its usage.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * The provider is the mock in `smoke/mock/`, so nothing is billed. Skipped
 * when V2_MANAGEMENT_KEY, V2_MOCK_URL or V2_BASE_URL is not set.
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
let deleted = false;

before(async () => {
  if (skip !== false) return;
  slug = `smoke-usage-${Date.now().toString(36)}`;
  const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke usage", slug, secret: "sk-mock-smoke-key", baseUrl: mockUrl });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  providerId = provider.body.provider.id;
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke usage read",
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
    },
  });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  appId = app.body.app.id;
  appKey = app.body.api_key.key;
});

after(async () => {
  if (appId !== "" && !deleted) await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
  if (providerId !== "") await admin("DELETE", `/v2/admin/providers/${providerId}`);
});

/** Asks until `check` passes, for up to a minute: the ledger is written after the response. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let tries = 0; tries < 30 && !check(value); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    value = await read();
  }
  return value;
}

test("a call is read back as a charge, in the app's and the account's month, and through the tools", { skip }, async () => {
  const response = await fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": "smoke-user" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] }),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();

  const charges = await eventually(
    () => admin("GET", `/v2/admin/apps/${appId}/charges`),
    (result) => result.status === 200 && result.body.charges.length > 0,
  );
  assert.equal(charges.status, 200, JSON.stringify(charges.body));
  const [charge] = charges.body.charges;
  assert.equal(charge.kind, "attempt");
  assert.equal(charge.status, "ok");
  assert.equal(charge.end_user_id, "smoke-user");
  assert.equal(charge.model, "gpt-4o-mini");
  assert.ok(charge.cost_nano > 0);

  const month = new Date().toISOString().slice(0, 7);
  const usage = await admin("GET", `/v2/admin/apps/${appId}/usage?month=${month}`);
  assert.equal(usage.status, 200);
  assert.equal(usage.body.charges, 1);
  assert.equal(usage.body.cost_nano, charge.cost_nano);

  const byUser = await admin("GET", `/v2/admin/apps/${appId}/usage/breakdown?by=user`);
  assert.deepEqual(byUser.body.rows.map((row: { key: string }) => row.key), ["smoke-user"]);
  const days = await admin("GET", `/v2/admin/apps/${appId}/usage/timeseries`);
  assert.equal(days.body.buckets.length, 1);

  const tool = await admin("POST", "/v2/cli/tools/get_usage", { app: appId, month });
  assert.equal(tool.status, 200, JSON.stringify(tool.body));
  assert.equal(tool.body.result.charges, 1);

  // Deleting the app keeps its usage in the account's month.
  assert.equal((await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`)).status, 200);
  deleted = true;
  const account = await admin("GET", `/v2/admin/usage?month=${month}`);
  assert.equal(account.status, 200);
  const line = account.body.apps.find((row: { app_id: string }) => row.app_id === appId);
  assert.ok(line, "the deleted app keeps its line");
  assert.equal(line.deleted, true);
  assert.equal(line.cost_nano, charge.cost_nano);
  assert.notEqual(account.body.first_usage_day, null);
});
