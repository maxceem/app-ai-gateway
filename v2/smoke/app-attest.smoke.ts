/**
 * An iOS app's App Attest sign-in through a live v2 deployment, as far as it
 * can go off a device (v1's `ios.smoke.ts`): the challenge is issued and says
 * the exchange takes an App Store transaction, a failure on the device is
 * recorded once per challenge, and anything that is not a real attestation is
 * refused as a client error, never a gateway failure.
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
import { cleanUp, outcome, responseOutcome, uniqueSlug } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;
const headers = { "content-type": "application/json", "x-app-version": "1.0.0" };

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
let slug = "";

before(async () => {
  if (skip !== false) return;
  slug = uniqueSlug("smoke-attest");
  const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke App Attest", slug, secret: "sk-mock-smoke-key", baseUrl: mockUrl });
  assert.equal(provider.status, 201, outcome(provider));
  providerId = provider.body.provider.id;
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke App Attest",
    config: {
      authentication: { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.agwsmoke" } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
    },
  });
  assert.equal(app.status, 201, outcome(app));
  appId = app.body.app.id;
});

after(async () => {
  await cleanUp([
    ...(appId === "" ? [] : [() => admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`)]),
    ...(providerId === "" ? [] : [() => admin("DELETE", `/v2/admin/providers/${providerId}`)]),
  ]);
});

function post(path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(`/v2/apps/${appId}/${path}`, base), { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function challenge(): Promise<{ challenge: string; expires_in: number; accepts_app_transaction?: boolean }> {
  const response = await post("auth/challenge");
  assert.equal(response.status, 200, await responseOutcome(response));
  return (await response.json()) as { challenge: string; expires_in: number; accepts_app_transaction?: boolean };
}

// The Swift package sends the App Store transaction, and signs over it, only
// when the challenge says the exchange reads one; a deployment that stopped
// saying so would silently put every iOS app back on per-install budgets.
test("an iOS app is issued a challenge that says the exchange takes an App Store transaction", { skip }, async () => {
  const issued = await challenge();
  assert.ok(issued.challenge.length > 10);
  assert.ok(issued.expires_in > 0);
  assert.equal(issued.accepts_app_transaction, true);
});

test("a failure on the device is recorded once per challenge, and can be read back", { skip, timeout: 90_000 }, async () => {
  const { challenge: issued } = await challenge();
  // A code no other run of this check sends, to find this run's event.
  const code = Math.floor(Math.random() * 1_000_000_000);
  const report = { challenge: issued, step: "attest_key", error: { domain: "smoke", code } };
  const first = await post("auth/failure", report);
  assert.equal(first.status, 200, await responseOutcome(first));
  assert.equal(((await first.json()) as { recorded: boolean }).recorded, true);
  const again = await post("auth/failure", report);
  assert.equal(again.status, 200, await responseOutcome(again));
  assert.equal(((await again.json()) as { recorded: boolean }).recorded, false);

  // The flag says it was recorded; the diagnostics read says it really was, once.
  const path = `/v2/admin/apps/${appId}/auth-events?event=challenge&outcome=client_failed&limit=50`;
  let found: { reason: string | null; outcome: string }[] = [];
  for (let tries = 0; tries < 30 && found.length === 0; tries += 1) {
    if (tries > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    const listed = await admin("GET", path);
    assert.equal(listed.status, 200, outcome(listed));
    found = (listed.body.events as { reason: string | null; outcome: string }[]).filter((event) => event.reason === `attest_key:smoke:${code}`);
  }
  assert.equal(found.length, 1, "the device's failure was not read back exactly once within a minute");
});

test("a forged registration is refused with attest_failed", { skip }, async () => {
  const { challenge: issued } = await challenge();
  const response = await post("auth/register", { key_id: "c21va2Uta2V5LWlkLWZvci1hLXNtb2tlLWNoZWNr", attestation: "c21va2U=", challenge: issued });
  assert.equal(response.status, 403, await responseOutcome(response));
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "attest_failed");
});

test("the app's proxy refuses a call without a gateway token with auth_required", { skip }, async () => {
  const response = await post(`proxy/${slug}/v1/chat/completions`, { model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] });
  assert.equal(response.status, 401, await responseOutcome(response));
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "auth_required");
});
