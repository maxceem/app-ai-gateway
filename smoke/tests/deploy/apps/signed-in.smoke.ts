import { generateKeyPair, exportJWK } from "jose";
import { expect, test } from "vitest";
import { need } from "../../../src/env.ts";
import { admin, call, smokeId } from "../../../src/gateway.ts";
import { endUserToken } from "../../../src/issuer.ts";
import { MODEL } from "../../../src/mock/formats.ts";
import { env, errorCode, expectForwardedCleanly, expectStatus, json, state } from "../../support.ts";

// The signed-in path an iOS app takes, minus App Attest: an end-user token from
// the test issuer is exchanged for a gateway token, which then authorizes
// calls; and what such an app refuses. Checked after each deploy rather than
// on a schedule: sign-in is optional for an app, and without App Attest this
// covers only half of what a real iOS app goes through.
const app = state.apps.signedIn;
const issuerKey = need(env, "issuerKey", "SMOKE_ISSUER_KEY");
const appVersion = { "x-app-version": "smoke" };

function exchange(issuerToken: string, headers: Record<string, string> = {}): Promise<Response> {
  return call(env, `/v1/apps/${app.id}/auth/token`, {
    headers,
    body: { issuer_token: issuerToken, api_key: app.key },
  });
}

test("a signed-in user exchanges a token and calls a provider", async () => {
  const exchanged = await exchange(await endUserToken(issuerKey, "smoke-user"));
  await expectStatus(exchanged, 200, "Token exchange");
  const { access_token: token } = await json<{ access_token: string }>(exchanged, "Token exchange");

  const id = smokeId();
  const response = await call(env, `/v1/apps/${app.id}/proxy/smoke-openai/v1/chat/completions`, {
    key: token,
    headers: appVersion,
    body: { model: MODEL, messages: [{ role: "user", content: id }] },
  });
  await expectStatus(response, 200, "Proxied call with a gateway token");
  await expectForwardedCleanly(id, "v1/chat/completions");

  const me = await call(env, `/v1/apps/${app.id}/me`, { key: token, headers: appVersion });
  await expectStatus(me, 200, "GET /me");
});

test("the app key alone is refused once users must sign in", async () => {
  const response = await call(env, `/v1/apps/${app.id}/proxy/smoke-openai/v1/chat/completions`, {
    key: app.key,
    body: { model: MODEL, messages: [{ role: "user", content: smokeId() }] },
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
});

test("a user without the required claim is refused with issuer_claims_missing", async () => {
  const response = await exchange(await endUserToken(issuerKey, "smoke-free-user", { plan: "free" }));
  expect(response.status).toBe(403);
  expect(await errorCode(response)).toBe("issuer_claims_missing");
});

test("a token signed by an unknown key is refused with issuer_token_rejected", async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const forged = JSON.stringify({ ...(await exportJWK(privateKey)), alg: "RS256", kid: "smoke-forged" });
  const response = await exchange(await endUserToken(forged, "smoke-forged-user"));
  expect(response.status).toBe(403);
  expect(await errorCode(response)).toBe("issuer_token_rejected");
});

// Recorded in the background, so it is polled for, as usage is.
const RECORDING_DEADLINE_MS = 60_000;
const CLIENT_SDK = "app-ai-gateway-swift/1.7.0";

test("a token exchange records the client package it names", { timeout: RECORDING_DEADLINE_MS + 15_000 }, async () => {
  const user = "smoke-sdk-user";
  const eventsPath = `/v1/admin/apps/${app.id}/auth-events?event=token_exchange&user=${user}&limit=5`;
  type Events = { events: { id: number; client_sdk?: string | null }[] };
  const newest = async () => (await admin<Events>(env, "GET", eventsPath)).events;
  const before = (await newest())[0]?.id ?? 0;

  const exchanged = await exchange(await endUserToken(issuerKey, user), { ...appVersion, "x-client-sdk": CLIENT_SDK });
  await expectStatus(exchanged, 200, "Token exchange naming its client package");

  const deadline = Date.now() + RECORDING_DEADLINE_MS;
  let recorded: { id: number; client_sdk?: string | null } | undefined;
  while (recorded === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    recorded = (await newest()).find((event) => event.id > before);
  }
  expect(recorded, `no new token exchange was recorded within ${RECORDING_DEADLINE_MS / 1000}s`).toBeDefined();
  expect(recorded?.client_sdk).toBe(CLIENT_SDK);
});
