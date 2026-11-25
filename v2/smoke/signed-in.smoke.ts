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
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { admin, check, checkId, cleanUp, expectCode, expectResponse, expectStatus, keyMark, poll, readJson, same, send, TEST_TIMEOUT_MS, uniqueSlug } from "./support.ts";

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
  return send(`/v2/apps/${appId}/auth/token`, base, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ issuer_token: issuerToken, api_key: appKey }),
  });
}

function chat(key: string): Promise<Response> {
  return send(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, base, {
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
  expectStatus(provider, 201, "provider");
  providerId = checkId(provider.body.provider?.id, "the provider");
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
  expectStatus(app, 201, "app");
  appId = checkId(app.body.app?.id, "the app");
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
async function oneCallThenMe(): Promise<{ user: string; token: string; standing: { user_id: string; limits: Record<string, unknown> }; sameDay: boolean }> {
  const user = uniqueSlug("smoke-user");
  const exchanged = await exchange(await userToken(user));
  await expectResponse(exchanged, 200, "exchanged");
  const { access_token: token } = (await readJson(exchanged)) as { access_token: unknown };
  check(typeof token === "string" && token !== "", "the exchange gave no access token");

  const day = utcDay();
  const response = await chat(token);
  await expectResponse(response, 200, "response");
  // The gateway token is the gateway's own: it never reaches the provider,
  // and the provider gets the connection's key, in its own header.
  same(response.headers.get("x-mock-client-credentials"), "none", "response.headers.get(\"x-mock-client-credentials\") is not \"none\"");
  same(response.headers.get("x-mock-key"), keyMark("authorization", "fixture-smoke"), "response.headers.get(\"x-mock-key\") is not keyMark(\"authorization\", \"fixture-smoke\")");
  await response.arrayBuffer();

  const me = await send(`/v2/apps/${appId}/me`, base, { headers: { authorization: `Bearer ${token}` } });
  await expectResponse(me, 200, "me");
  const standing = (await readJson(me)) as { user_id: string; limits: Record<string, unknown> };
  return { user, token, standing, sameDay: utcDay() === day };
}

test("a signed-in user exchanges a token, calls a provider, and reads /me", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  // A call and its read that straddle UTC midnight count on two days: once more, with another fresh user.
  // The gateway's clock decides the day, and this runner's may be a little off from it, so a count
  // of 0 is taken as the same straddle seen only by the gateway. A real bug that counts nothing
  // answers 0 for the second fresh user too, and fails below.
  let run = await oneCallThenMe();
  if (!run.sameDay || run.standing.limits.requests_today === 0) run = await oneCallThenMe();
  check(run.sameDay, "the call and /me straddled UTC midnight twice");
  const { user, standing } = run;
  // The user is the issuer's subject, and the limits are the app's configured ones, as apps and the Swift package read them.
  same(standing.user_id, user, "standing.user_id is not user");
  const { limits } = standing;
  same(limits.requests_per_minute, PER_MINUTE, "limits.requests_per_minute is not PER_MINUTE");
  same(limits.requests_per_day, PER_DAY, "limits.requests_per_day is not PER_DAY");
  same(limits.monthly_budget_usd, BUDGET_NANO / 1e9, "limits.monthly_budget_usd is not BUDGET_NANO / 1e9");
  same(limits.budget_scope, "user", "limits.budget_scope is not \"user\"");
  same(limits.blocked, false, "limits.blocked is not false");
  // A fresh user's one call, counted once: what is left is the day's limit less that one.
  same(limits.requests_today, 1, "limits.requests_today is not 1");
  same(limits.requests_remaining, PER_DAY - 1, "limits.requests_remaining is not PER_DAY - 1");
  // The month's spend is null when the account's ledger did not answer in time: read /me again, for a while.
  const cost =
    limits.monthly_cost_usd !== null
      ? limits.monthly_cost_usd
      : await poll(async () => {
          const again = await send(`/v2/apps/${appId}/me`, base, { headers: { authorization: `Bearer ${run.token}` } });
          await expectResponse(again, 200, "again");
          const value = ((await readJson(again)) as { limits: { monthly_cost_usd: unknown } }).limits.monthly_cost_usd;
          return value === null ? undefined : value;
        }, "/me never gave the month's spend");
  check(typeof cost === "number" && cost >= 0, "/me has no monthly cost");
});

test("the app key alone is refused once users must sign in", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const response = await chat(appKey);
  await expectResponse(response, 401, "response");
  expectCode(await readJson(response), "auth_required", "response");
});

test("a user without the required claim is refused with issuer_claims_missing", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const response = await exchange(await userToken("smoke-free-user", { plan: "free" }));
  await expectResponse(response, 403, "the token exchange");
  expectCode(await readJson(response), "issuer_claims_missing", "response");
});

test("a token signed by an unknown key is refused with issuer_token_rejected", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const forger = await generateKeyPair("ES256");
  const response = await exchange(await userToken("smoke-forged-user", { plan: "pro" }, forger.privateKey));
  await expectResponse(response, 403, "the token exchange");
  expectCode(await readJson(response), "issuer_token_rejected", "response");
});

test("a token exchange records the client package it names", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const user = "smoke-sdk-user";
  const exchanged = await exchange(await userToken(user), { "x-client-sdk": CLIENT_SDK, "x-app-version": "1.0.0" });
  await expectResponse(exchanged, 200, "exchanged");
  await exchanged.arrayBuffer();
  // Recorded after the response, so it is asked for until it is there.
  const path = `/v2/admin/apps/${appId}/auth-events?event=token_exchange&user=${user}&limit=5`;
  const recorded = await poll(async () => {
    const listed = await admin("GET", path);
    expectStatus(listed, 200, "the auth events");
    return listed.body.events?.[0] as { client_sdk: string | null; outcome: string } | undefined;
  }, "no token exchange was recorded within a minute");
  same(recorded.outcome, "ok", "recorded.outcome is not \"ok\"");
  same(recorded.client_sdk, CLIENT_SDK, "recorded.client_sdk is not CLIENT_SDK");
});
