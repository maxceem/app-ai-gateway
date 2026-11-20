/**
 * The writes an agent hands to a person (step 2d part 3), on a live v2
 * deployment, as far as they go without a person in a browser:
 *
 * - adding a provider connection opens a step with a console link, the
 *   console's page reads it with the link's proof, and declining it ends it;
 * - creating an app takes two calls: a reservation creates nothing, the
 *   handle creates it once, and sending the handle again repeats the answer;
 * - the approval and reveal pages load on the console's host.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_CONSOLE_URL=https://console.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * No key is entered and none is revealed: that needs a person. Everything it
 * makes is removed afterwards. Skipped without those three settings.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

const base = process.env.V2_BASE_URL ?? "";
const consoleUrl = process.env.V2_CONSOLE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const skip = base === "" || consoleUrl === "" || managementKey === "" ? "V2_BASE_URL, V2_CONSOLE_URL and V2_MANAGEMENT_KEY are needed" : false;
const consoleOrigin = consoleUrl === "" ? "" : new URL(consoleUrl).origin;

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

/** The approval page's own call: on the console's host, from its origin, with nobody signed in. */
async function page(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, consoleOrigin), {
    method: "POST",
    headers: { origin: consoleOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

let appId = "";

after(async () => {
  if (appId !== "") await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
});

test("a provider step opens with a console link, shows what it asks, and can be declined", { skip }, async () => {
  const slug = `smoke-handoff-${Date.now().toString(36)}`;
  const opened = await admin("POST", "/v2/admin/provider-handoffs", { type: "openai", name: "Smoke handoff", slug });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const url = new URL(opened.body.url);
  assert.equal(url.origin, consoleOrigin);
  assert.equal(url.pathname, `/v2/approve/${opened.body.id}`);
  const proof = url.hash.slice(1);

  const pending = await admin("GET", `/v2/admin/operations/${opened.body.id}`);
  assert.equal(pending.body.state, "pending");

  const shown = await page(`/v2/console/handoffs/${opened.body.id}`, { proof });
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.deepEqual(shown.body.review, { type: "openai", name: "Smoke handoff", slug, baseUrl: null, destinations: ["https://api.openai.com/"] });
  const wrong = await page(`/v2/console/handoffs/${opened.body.id}`, { proof: "x".repeat(43) });
  assert.equal(wrong.status, 403);

  const declined = await page(`/v2/console/handoffs/${opened.body.id}/deny`, { proof });
  assert.deepEqual(declined, { status: 200, body: { state: "denied" } });
  const ended = await admin("GET", `/v2/admin/operations/${opened.body.id}`);
  assert.equal(ended.body.state, "expired");
  assert.equal(ended.body.denied, true);
  const late = await page(`/v2/console/handoffs/${opened.body.id}/submit`, { proof, secret: "sk-smoke-never-stored-000000" });
  assert.equal(late.status, 409);
  const providers = await admin("GET", "/v2/admin/providers");
  assert.ok(!providers.body.providers.some((provider: { slug: string }) => provider.slug === slug));
});

test("an app is created once from a reservation, and its key is never in an answer", { skip }, async () => {
  const document = {
    name: "Smoke reserved app",
    config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: {} } },
  };
  const reserved = await admin("POST", "/v2/admin/reserved/apps", document);
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body));
  assert.equal(reserved.body.state, "reserved");

  const created = await admin("POST", "/v2/admin/reserved/apps", { ...document, handle: reserved.body.handle });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.replayed, false);
  appId = created.body.app.id;
  assert.equal(created.body.api_key.key, undefined);
  assert.equal(created.body.reveal_url, `${consoleOrigin}/v2/reveal/${reserved.body.id}`);

  const repeated = await admin("POST", "/v2/admin/reserved/apps", { ...document, handle: reserved.body.handle });
  assert.equal(repeated.body.replayed, true);
  assert.equal(repeated.body.app.id, appId);
  const other = await admin("POST", "/v2/admin/reserved/apps", { ...document, name: "Another", handle: reserved.body.handle });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, "operation_mismatch");

  // A management key never reveals a key: that is a person's, on the console's page.
  const revealed = await fetch(new URL(`/v2/admin/operations/${reserved.body.id}/reveal`, consoleOrigin), {
    method: "POST",
    headers: { authorization: `Bearer ${managementKey}`, origin: consoleOrigin },
  });
  assert.equal(revealed.status, 403);
  assert.ok(!(await revealed.text()).includes('"key":"agw_'));
});

test("the approval and reveal pages load on the console's host", { skip }, async () => {
  for (const path of ["/v2/approve/smoke", "/v2/reveal/smoke"]) {
    const response = await fetch(new URL(path, consoleOrigin), { headers: { accept: "text/html,application/xhtml+xml" } });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
  }
});
