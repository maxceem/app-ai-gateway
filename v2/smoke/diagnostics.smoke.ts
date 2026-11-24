/**
 * Diagnostics read back through the management API (step 7b-4): a refused
 * request and a refused sign-in are made, then found in the app's refusal
 * samples, its sign-in attempts and its sign-in summary, and through the
 * tools the CLI and MCP call.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * Nothing reaches a provider. Skipped when V2_MANAGEMENT_KEY, V2_MOCK_URL or
 * V2_BASE_URL is not set.
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

before(async () => {
  if (skip !== false) return;
  slug = `smoke-diag-${Date.now().toString(36)}`;
  const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke diagnostics", slug, secret: "sk-mock-smoke-key", baseUrl: mockUrl });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  providerId = provider.body.provider.id;
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke diagnostics",
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
  if (appId !== "") await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
  if (providerId !== "") await admin("DELETE", `/v2/admin/providers/${providerId}`);
});

/** Asks until `check` passes, for up to a minute: events are written after the response. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let tries = 0; tries < 30 && !check(value); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    value = await read();
  }
  return value;
}

test("a refused request and a refused sign-in are read back, in the summary and through the tools", { skip }, async () => {
  // A model the app does not allow: refused before any provider is reached.
  const refused = await fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": "smoke-diag-user" },
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
  });
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as any).error.code, "model_not_allowed");

  // A sign-in this app cannot take: an app-key app with no issuer refuses a token exchange.
  const signIn = await fetch(new URL(`/v2/apps/${appId}/auth/token`, base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: appKey, issuer_token: "not-a-token" }),
  });
  assert.ok(signIn.status >= 400 && signIn.status < 500, `sign-in answered ${signIn.status}`);
  await signIn.arrayBuffer();

  const rejections = await eventually(
    () => admin("GET", `/v2/admin/apps/${appId}/rejection-events`),
    (result) => result.body.events?.length > 0,
  );
  assert.equal(rejections.status, 200);
  assert.deepEqual(
    rejections.body.events.map((event: any) => [event.reason, event.user_id, event.model]),
    [["model_not_allowed", "smoke-diag-user", "gpt-4o"]],
  );

  const attempts = await eventually(
    () => admin("GET", `/v2/admin/apps/${appId}/auth-events`),
    (result) => result.body.events?.length > 0,
  );
  assert.equal(attempts.status, 200);
  assert.equal(attempts.body.events[0].event, "token_exchange");
  assert.notEqual(attempts.body.events[0].outcome, "ok");

  const summary = await admin("GET", `/v2/admin/apps/${appId}/auth-events/summary?days=2`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.token_exchange.total, 1);
  assert.equal(summary.body.token_exchange.ok, 0);
  assert.equal(summary.body.rejection_samples.reduce((sum: number, row: any) => sum + row.count, 0), 1);

  const viaTool = await admin("POST", "/v2/cli/tools/list_rejection_events", { app: appId });
  assert.equal(viaTool.status, 200);
  assert.equal(viaTool.body.result.events.length, 1);
  const summaryTool = await admin("POST", "/v2/cli/tools/get_auth_event_summary", { app: appId, days: 2 });
  assert.equal(summaryTool.status, 200);
});
