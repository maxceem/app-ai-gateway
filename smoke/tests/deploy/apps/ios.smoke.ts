import { expect, test } from "vitest";
import { call, smokeId } from "../../../src/gateway.ts";
import { MODEL } from "../../../src/mock/formats.ts";
import { env, expectStatus, json, state } from "../../support.ts";

// App Attest cannot be produced off a device, so the iOS path is checked up to
// the attestation: the challenge is issued, and anything that is not a real
// attestation is refused as a client error rather than failing the gateway.
const app = state.apps.ios;
const headers = { "x-app-version": "smoke" };

test("an iOS app is issued an App Attest challenge", async () => {
  const response = await call(env, `/v1/apps/${app.id}/auth/challenge`, { method: "POST", headers });
  await expectStatus(response, 200, "App Attest challenge");
  const body = await json<{ challenge: string; expires_in: number }>(response, "App Attest challenge");
  expect(body.challenge.length).toBeGreaterThan(10);
  expect(body.expires_in).toBeGreaterThan(0);
});

// The Swift package sends the App Store transaction, and signs over it, only
// when the challenge says the exchange reads one; a deployment that stopped
// saying so would silently put every iOS app back on per-install budgets.
test("an iOS app's challenge says the exchange accepts an App Store transaction", async () => {
  const response = await call(env, `/v1/apps/${app.id}/auth/challenge`, { method: "POST", headers });
  await expectStatus(response, 200, "App Attest challenge");
  const body = await json<{ accepts_app_transaction?: boolean }>(response, "App Attest challenge");
  expect(body.accepts_app_transaction).toBe(true);
});

test("a forged App Attest registration is refused as a client error", async () => {
  const response = await call(env, `/v1/apps/${app.id}/auth/register`, {
    headers,
    body: { key_id: "c21va2U=", attestation: "c21va2U=", challenge: "smoke" },
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
});

test("an iOS app's proxy refuses a call without a gateway token", async () => {
  const response = await call(env, `/v1/apps/${app.id}/proxy/smoke-openai/v1/chat/completions`, {
    headers,
    body: { model: MODEL, messages: [{ role: "user", content: smokeId() }] },
  });
  expect(response.status).toBe(401);
});
