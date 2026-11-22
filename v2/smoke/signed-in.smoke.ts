/**
 * The signed-in path an app takes, minus App Attest, through a live v2
 * deployment (v1's `signed-in.smoke.ts`): an end-user token from a test
 * issuer is exchanged for a gateway token, which then authorizes calls and
 * `/me`; and what such an app refuses.
 *
 * The issuer is this check's own: it makes a key pair, and the app's JWKS URL
 * is the mock's `/jwks/<public key>`, so no key is stored anywhere.
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
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;

const ISSUER = "https://smoke.app-ai-gateway.invalid";
const AUDIENCE = "app-ai-gateway-smoke";
const CLIENT_SDK = "app-ai-gateway-swift/1.7.0";

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
let signingKey: CryptoKey;
const kid = `smoke-${Date.now().toString(36)}`;

/** An end-user token from the test issuer, with the required claim unless `claims` replaces it. */
function userToken(subject: string, claims: Record<string, unknown> = { plan: "pro" }, key: CryptoKey = signingKey): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

function exchange(issuerToken: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(new URL(`/v2/apps/${appId}/auth/token`, base), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ issuer_token: issuerToken, api_key: appKey }),
  });
}

function chat(key: string): Promise<Response> {
  return fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-app-version": "1.0.0" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] }),
  });
}

before(async () => {
  if (skip !== false) return;
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = pair.privateKey;
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256" };
  const jwksPath = Buffer.from(JSON.stringify(publicJwk)).toString("base64url");
  slug = `smoke-signin-${Date.now().toString(36)}`;
  const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke signed in", slug, secret: "sk-mock-smoke-key", baseUrl: mockUrl });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  providerId = provider.body.provider.id;
  const mock = mockUrl.endsWith("/") ? mockUrl : `${mockUrl}/`;
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke signed in",
    config: {
      authentication: {
        type: "api_key",
        end_user: {
          source: "issuer",
          issuer: {
            jwks_url: `${mock}jwks/${jwksPath}`,
            issuer: ISSUER,
            audience: AUDIENCE,
            user_id_claim: "sub",
            required_claims: [{ path: "plan", equals: "pro" }],
            max_token_lifetime_seconds: 3600,
          },
        },
      },
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

test("a signed-in user exchanges a token, calls a provider, and reads /me", { skip }, async () => {
  const exchanged = await exchange(await userToken("smoke-user"));
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const { access_token: token } = (await exchanged.json()) as { access_token: string };

  const response = await chat(token);
  assert.equal(response.status, 200, await response.clone().text());
  // The gateway token is the gateway's own: it never reaches the provider.
  assert.equal(response.headers.get("x-mock-client-credentials"), "none");
  await response.arrayBuffer();

  const me = await fetch(new URL(`/v2/apps/${appId}/me`, base), { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200, await me.clone().text());
  await me.arrayBuffer();
});

test("the app key alone is refused once users must sign in", { skip }, async () => {
  const response = await chat(appKey);
  assert.ok(response.status >= 400 && response.status < 500, `answered ${response.status}`);
  await response.arrayBuffer();
});

test("a user without the required claim is refused with issuer_claims_missing", { skip }, async () => {
  const response = await exchange(await userToken("smoke-free-user", { plan: "free" }));
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "issuer_claims_missing");
});

test("a token signed by an unknown key is refused with issuer_token_rejected", { skip }, async () => {
  const forger = await generateKeyPair("ES256");
  const response = await exchange(await userToken("smoke-forged-user", { plan: "pro" }, forger.privateKey));
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "issuer_token_rejected");
});

test("a token exchange records the client package it names", { skip, timeout: 90_000 }, async () => {
  const user = "smoke-sdk-user";
  const exchanged = await exchange(await userToken(user), { "x-client-sdk": CLIENT_SDK, "x-app-version": "1.0.0" });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  await exchanged.arrayBuffer();
  // Recorded after the response, so it is asked for until it is there.
  const path = `/v2/admin/apps/${appId}/auth-events?event=token_exchange&user=${user}&limit=5`;
  let recorded: { client_sdk: string | null; outcome: string } | undefined;
  for (let tries = 0; tries < 30 && recorded === undefined; tries += 1) {
    if (tries > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    recorded = (await admin("GET", path)).body.events?.[0];
  }
  assert.ok(recorded, "no token exchange was recorded within a minute");
  assert.equal(recorded.outcome, "ok");
  assert.equal(recorded.client_sdk, CLIENT_SDK);
});
