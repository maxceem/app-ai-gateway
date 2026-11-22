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
import { cleanUp, keyMark, outcome, readJson, responseOutcome, uniqueSlug } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;

const ISSUER = "https://smoke.app-ai-gateway.invalid";
const PROVIDER_KEY = "sk-mock-smoke-key";
/** Each user's limits on this app, away from their defaults, so `/me` shows the configured values. */
const PER_MINUTE = 60;
const PER_DAY = 1000;
const BUDGET_NANO = 5_000_000_000;
const AUDIENCE = "app-ai-gateway-smoke";
const CLIENT_SDK = "app-ai-gateway-swift/1.7.0";

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await readJson(response) };
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
  slug = uniqueSlug("smoke-signin");
  const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke signed in", slug, secret: PROVIDER_KEY, baseUrl: mockUrl });
  assert.equal(provider.status, 201, outcome(provider));
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
      limits: {
        per_user: {
          requests: { per_minute: PER_MINUTE, per_day: PER_DAY },
          spending: { monthly_nano: BUDGET_NANO, scope: "user" },
        },
      },
    },
  });
  assert.equal(app.status, 201, outcome(app));
  appId = app.body.app.id;
  appKey = app.body.api_key.key;
});

after(async () => {
  await cleanUp([
    ...(appId === "" ? [] : [() => admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`)]),
    ...(providerId === "" ? [] : [() => admin("DELETE", `/v2/admin/providers/${providerId}`)]),
  ]);
});

/** The UTC day now: the day `/me` counts requests in. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A fresh user exchanges a token, makes one call and reads `/me`. Returns
 * what `/me` said, and whether the UTC day stayed the same from the call to
 * the read, so the day's count is exact.
 */
async function oneCallThenMe(): Promise<{ user: string; standing: { user_id: string; limits: Record<string, unknown> }; sameDay: boolean }> {
  const user = uniqueSlug("smoke-user");
  const exchanged = await exchange(await userToken(user));
  assert.equal(exchanged.status, 200, await responseOutcome(exchanged));
  const { access_token: token } = (await readJson(exchanged)) as { access_token: unknown };
  assert.ok(typeof token === "string" && token !== "", "the exchange gave no access token");

  const day = utcDay();
  const response = await chat(token);
  assert.equal(response.status, 200, await responseOutcome(response));
  // The gateway token is the gateway's own: it never reaches the provider,
  // and the provider gets the connection's key, in its own header.
  assert.equal(response.headers.get("x-mock-client-credentials"), "none");
  assert.equal(response.headers.get("x-mock-key"), keyMark("authorization", "fixture-smoke"));
  await response.arrayBuffer();

  const me = await fetch(new URL(`/v2/apps/${appId}/me`, base), { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200, await responseOutcome(me));
  const standing = (await readJson(me)) as { user_id: string; limits: Record<string, unknown> };
  return { user, standing, sameDay: utcDay() === day };
}

test("a signed-in user exchanges a token, calls a provider, and reads /me", { skip }, async () => {
  // A call and its read that straddle UTC midnight count on two days: once more, with another fresh user.
  let run = await oneCallThenMe();
  if (!run.sameDay) run = await oneCallThenMe();
  assert.ok(run.sameDay, "the call and /me straddled UTC midnight twice");
  const { user, standing } = run;
  // The user is the issuer's subject, and the limits are the app's configured ones, as apps and the Swift package read them.
  assert.equal(standing.user_id, user);
  const { limits } = standing;
  assert.equal(limits.requests_per_minute, PER_MINUTE);
  assert.equal(limits.requests_per_day, PER_DAY);
  assert.equal(limits.monthly_budget_usd, BUDGET_NANO / 1e9);
  assert.equal(limits.budget_scope, "user");
  assert.equal(limits.blocked, false);
  // A fresh user's one call, counted once: what is left is the day's limit less that one.
  assert.equal(limits.requests_today, 1);
  assert.equal(limits.requests_remaining, PER_DAY - 1);
  assert.ok(typeof limits.monthly_cost_usd === "number" && limits.monthly_cost_usd >= 0, "/me has no monthly cost");
});

test("the app key alone is refused once users must sign in", { skip }, async () => {
  const response = await chat(appKey);
  assert.equal(response.status, 401, await responseOutcome(response));
  assert.equal(((await readJson(response)) as { error: { code: string } }).error.code, "auth_required");
});

test("a user without the required claim is refused with issuer_claims_missing", { skip }, async () => {
  const response = await exchange(await userToken("smoke-free-user", { plan: "free" }));
  assert.equal(response.status, 403);
  assert.equal(((await readJson(response)) as { error: { code: string } }).error.code, "issuer_claims_missing");
});

test("a token signed by an unknown key is refused with issuer_token_rejected", { skip }, async () => {
  const forger = await generateKeyPair("ES256");
  const response = await exchange(await userToken("smoke-forged-user", { plan: "pro" }, forger.privateKey));
  assert.equal(response.status, 403);
  assert.equal(((await readJson(response)) as { error: { code: string } }).error.code, "issuer_token_rejected");
});

test("a token exchange records the client package it names", { skip, timeout: 90_000 }, async () => {
  const user = "smoke-sdk-user";
  const exchanged = await exchange(await userToken(user), { "x-client-sdk": CLIENT_SDK, "x-app-version": "1.0.0" });
  assert.equal(exchanged.status, 200, await responseOutcome(exchanged));
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
