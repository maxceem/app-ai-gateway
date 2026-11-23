/**
 * Who may sign up, Google sign-in through an OAuth relay, the guard against a
 * Google identity taking over someone else's sign-in, and the flood limits on
 * the OAuth and device-code endpoints.
 *
 * Ported from v1's `identity-registration.test.ts`,
 * `identity-oauth-relay.test.ts` and the flood-limit cases of `oauth.test.ts`
 * and `cli-login.test.ts`. v1's claim and unclaimed-account cases are not
 * here: v2 has no unclaimed accounts (owner, 2026-11-19). Password sign-in
 * and sign-up limits are in `flood-limiter.test.ts` and `sign-in.test.ts`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { createIdentity, CLI_CLIENT_ID } from "../src/auth/identity.ts";
import { OAUTH_PATHS } from "../src/management/oauth-routes.ts";
import { LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedHuman } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);
afterEach(() => vi.restoreAllMocks());

const API = "https://gateway.test";
const CONSOLE = "https://console.gateway.test";
const RELAY = "https://dev-oauth.example.test";
const GOOGLE_CLIENT_ID = "test-google-client";

function deployment(overrides: Record<string, unknown>): Env {
  return { ...env, OAUTH_RELAY_URL: undefined, ...overrides } as unknown as Env;
}

function withGoogle(overrides: Record<string, unknown> = {}): Env {
  return deployment({ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: "test-google-secret", ...overrides });
}

async function call(environment: Env, path: string, init: RequestInit & { base?: string; address?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.address !== undefined) headers.set("cf-connecting-ip", init.address);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${init.base ?? API}${path}`, { ...init, headers, redirect: "manual" }), environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function authPost(environment: Env, path: string, body: Record<string, unknown>, address = "198.51.100.1"): Promise<Response> {
  return call(environment, `/v2/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: API },
    body: JSON.stringify(body),
    address,
  });
}

async function startGoogle(environment: Env): Promise<{ response: Response; url: URL }> {
  const response = await authPost(environment, "sign-in/social", { provider: "google", callbackURL: "/v2/apps", errorCallbackURL: "/v2/login" });
  expect(response.status, await response.clone().text()).toBe(200);
  return { response, url: new URL(((await response.clone().json()) as { url: string }).url) };
}

describe("Google sign-in through an OAuth relay", () => {
  it("sends the browser to the relay, which knows the way back to this origin, keeping the state cookies", async () => {
    const { response, url } = await startGoogle(withGoogle({ OAUTH_RELAY_URL: RELAY }));

    expect(url.origin).toBe(RELAY);
    expect(url.pathname).toBe("/start");
    expect(url.searchParams.get("return")).toBe(`${API}/v2/auth/callback/google`);
    const next = new URL(url.searchParams.get("next")!);
    expect(next.hostname).toBe("accounts.google.com");
    // Google redirects to the one URI the relay registered, and the token
    // exchange presents the same value.
    expect(next.searchParams.get("redirect_uri")).toBe(`${RELAY}/callback/google`);
    expect(next.searchParams.get("state")?.length).toBeGreaterThan(20);
    // The callback that comes back through the relay is checked against these.
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("takes a relay with a trailing slash or a path, using only its origin", async () => {
    const { url } = await startGoogle(withGoogle({ OAUTH_RELAY_URL: `${RELAY}/some/path/` }));
    expect(url.origin).toBe(RELAY);
    expect(new URL(url.searchParams.get("next")!).searchParams.get("redirect_uri")).toBe(`${RELAY}/callback/google`);
  });

  it("goes straight to Google with this origin's own callback when no relay is set", async () => {
    const { url } = await startGoogle(withGoogle());
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${API}/v2/auth/callback/google`);
  });

  it("refuses to run with a relay that is not an absolute http(s) URL", async () => {
    await expect(createIdentity(withGoogle({ OAUTH_RELAY_URL: "dev-oauth.example.test" }), API))
      .rejects.toMatchObject({ status: 503, code: "service_unavailable" });
    await expect(createIdentity(withGoogle({ OAUTH_RELAY_URL: "ftp://dev-oauth.example.test" }), API))
      .rejects.toMatchObject({ status: 503, code: "service_unavailable" });
  });

  it("ignores the relay where Google sign-in is off", async () => {
    const identity = await createIdentity(deployment({ OAUTH_RELAY_URL: "not a url" }), API);
    expect(identity.config.google).toBeUndefined();
  });
});

/** A Google ID token for `email`, signed by a key the stubbed Google key set serves. */
async function googleIdToken(email: string, subject: string): Promise<string> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = `google-${subject}`;
  publicJwk.alg = "RS256";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [publicJwk] }));
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, email_verified: true, name: "Google User" })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setSubject(subject)
    .setIssuer("https://accounts.google.com")
    .setAudience(GOOGLE_CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(pair.privateKey);
}

async function googleSignIn(environment: Env, email: string, subject: string): Promise<Response> {
  return authPost(environment, "sign-in/social", {
    provider: "google",
    callbackURL: "/v2/apps",
    idToken: { token: await googleIdToken(email, subject) },
  });
}

/** The people and sign-in methods an email has, as stored. */
async function signInsOf(email: string): Promise<{ users: number; providers: string[] }> {
  const users = await env.DB.prepare("SELECT id FROM mgmt_user WHERE email = ? COLLATE NOCASE").bind(email).all<{ id: string }>();
  const ids = users.results.map((row) => row.id);
  if (ids.length === 0) return { users: 0, providers: [] };
  const providers = await env.DB
    .prepare(`SELECT provider_id FROM mgmt_user_account WHERE user_id IN (${ids.map(() => "?").join(",")}) ORDER BY provider_id`)
    .bind(...ids)
    .all<{ provider_id: string }>();
  return { users: ids.length, providers: providers.results.map((row) => row.provider_id) };
}

function unique(name: string): string {
  return `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}

describe("who may sign up", () => {
  it("refuses a password sign-up the self-hosted list does not name, before any password work", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const email = unique("unlisted");
    const refused = await authPost(deployment({ ALLOWED_REGISTRATION_EMAILS: "someone-else@example.test" }), "sign-up/email", {
      name: "Unlisted",
      email,
      password: "correct-horse-42",
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "registration_disabled" } });
    expect((await signInsOf(email)).users).toBe(0);
  });

  it("closes sign-up with an empty list", async () => {
    const closed = deployment({ ALLOWED_REGISTRATION_EMAILS: "" });
    const refused = await authPost(closed, "sign-up/email", { name: "Anyone", email: unique("anyone"), password: "correct-horse-42" });
    expect(refused.status).toBe(403);
    const capabilities = (await (await call(closed, "/v2/console/capabilities")).json()) as { registrationOpen: boolean };
    expect(capabilities.registrationOpen).toBe(false);
  });

  it("stays open on a hosted deployment whatever the list says", async () => {
    const hosted = deployment({ ALLOWED_REGISTRATION_EMAILS: "", BILLING: {} });
    const capabilities = (await (await call(hosted, "/v2/console/capabilities")).json()) as { registrationOpen: boolean };
    expect(capabilities.registrationOpen).toBe(true);
  });

  it("lets a listed Google email register into an account of its own, and refuses an unlisted one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const listed = unique("listed-google");
    const unlisted = unique("unlisted-google");
    const environment = withGoogle({ ALLOWED_REGISTRATION_EMAILS: listed });

    const admitted = await googleSignIn(environment, listed, `sub-${crypto.randomUUID()}`);
    expect(admitted.status, await admitted.clone().text()).toBe(200);
    expect(await signInsOf(listed)).toEqual({ users: 1, providers: ["google"] });
    const owned = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mgmt_organization_user m JOIN mgmt_user u ON u.id = m.user_id WHERE u.email = ? AND m.role = 'owner'",
    ).bind(listed).first<{ n: number }>();
    expect(owned?.n).toBe(1);

    const refused = await googleSignIn(environment, unlisted, `sub-${crypto.randomUUID()}`);
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "registration_disabled" } });
    expect((await signInsOf(unlisted)).users).toBe(0);
  });

  it("still signs in a Google person the list no longer names", async () => {
    const email = unique("dropped-google");
    const subject = `sub-${crypto.randomUUID()}`;
    expect((await googleSignIn(withGoogle({ ALLOWED_REGISTRATION_EMAILS: email }), email, subject)).status).toBe(200);
    vi.restoreAllMocks();

    const again = await googleSignIn(withGoogle({ ALLOWED_REGISTRATION_EMAILS: "" }), email, subject);
    expect(again.status, await again.clone().text()).toBe(200);
    expect((await signInsOf(email)).users).toBe(1);
  });
});

describe("Google sign-in onto an email that already has a sign-in", () => {
  it("never signs a Google identity into the account someone registered with that email", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const human = await seedHuman(unique("password-owner"));
    const before = await signInsOf(human.email);

    const attempt = await googleSignIn(withGoogle({ ALLOWED_REGISTRATION_EMAILS: "*" }), human.email, `sub-${crypto.randomUUID()}`);

    expect(attempt.status).toBeGreaterThanOrEqual(400);
    // No Google sign-in was linked to the existing person, and no second person was made.
    expect(await signInsOf(human.email)).toEqual(before);
  });
});

/** Google's token endpoint, stubbed: an exchange answers with an ID token for `email`. */
function stubGoogleExchange(email: string, subject: string) {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("=", "");
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      access_token: "test-google-access",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: [encode({ alg: "RS256" }), encode({ sub: subject, email, email_verified: true, name: "Google User" }), "test-signature"].join("."),
    }),
  );
}

/** Starts Google's redirect flow and comes back to the callback, as the browser would. */
async function googleRedirect(environment: Env, email: string, subject: string): Promise<Response> {
  const started = await authPost(environment, "sign-in/social", { provider: "google", callbackURL: `${API}/v2/apps`, errorCallbackURL: "/v2/login" });
  expect(started.status, await started.clone().text()).toBe(200);
  const state = new URL(((await started.clone().json()) as { url: string }).url).searchParams.get("state")!;
  const cookie = started.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  stubGoogleExchange(email, subject);
  return call(environment, `/v2/auth/callback/google?code=mock-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie, "sec-fetch-mode": "navigate", accept: "text/html,application/xhtml+xml" },
    address: "198.51.100.9",
  });
}

const startsSession = (response: Response) => response.headers.getSetCookie().some((cookie) => /session_token=[^;]+/u.test(cookie) && !cookie.includes("Max-Age=0"));

describe("Google's redirect callback", () => {
  it("signs a listed email in and goes on to where the sign-in began, and signs the same Google identity in again as the same person", async () => {
    const email = unique("redirect-listed");
    const subject = `sub-${crypto.randomUUID()}`;
    const environment = withGoogle({ ALLOWED_REGISTRATION_EMAILS: email });
    const callback = await googleRedirect(environment, email, subject);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${API}/v2/apps`);
    expect(startsSession(callback)).toBe(true);
    expect(await signInsOf(email)).toEqual({ users: 1, providers: ["google"] });
    vi.restoreAllMocks();

    const again = await googleRedirect(environment, email, subject);
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe(`${API}/v2/apps`);
    expect(startsSession(again)).toBe(true);
    expect(await signInsOf(email)).toEqual({ users: 1, providers: ["google"] });
  });

  it("sends an unlisted email back to the sign-in page, clears the flow's cookies, and starts no session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const email = unique("redirect-unlisted");
    const callback = await googleRedirect(withGoogle({ ALLOWED_REGISTRATION_EMAILS: "someone-else@example.test" }), email, `sub-${crypto.randomUUID()}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/v2/login?error=registration_disabled");
    expect(callback.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
    expect(startsSession(callback)).toBe(false);
    expect((await signInsOf(email)).users).toBe(0);
  });

  it("refuses to sign a Google identity into someone's password sign-in, and starts no session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const human = await seedHuman(unique("redirect-victim"));
    const sessionsBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user_session WHERE user_id = ?").bind(human.userId).first<{ n: number }>();

    const callback = await googleRedirect(withGoogle({ ALLOWED_REGISTRATION_EMAILS: "*" }), human.email, `sub-${crypto.randomUUID()}`);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location") ?? "").toContain("error=");
    expect(callback.headers.get("location") ?? "").not.toContain("/v2/apps");
    expect(startsSession(callback)).toBe(false);
    const linked = await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user_account WHERE user_id = ? AND provider_id = 'google'").bind(human.userId).first<{ n: number }>();
    expect(linked?.n).toBe(0);
    const sessionsAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user_session WHERE user_id = ?").bind(human.userId).first<{ n: number }>();
    expect(sessionsAfter?.n).toBe(sessionsBefore?.n);
  });
});

describe("flood limits on the OAuth endpoints", () => {
  function startDevice(address: string): Promise<Response> {
    return call(env, OAUTH_PATHS.deviceAuthorization, {
      base: CONSOLE,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLI_CLIENT_ID, scope: "manage" }).toString(),
      address,
    });
  }

  it("lets one address keep at most ten CLI sign-in codes waiting, and only that address", async () => {
    const address = `203.0.113.${Math.floor(Math.random() * 200) + 20}`;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const started = await startDevice(address);
      expect(started.status, `attempt ${attempt}`).toBe(200);
    }
    const refused = await startDevice(address);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    await expect(refused.json()).resolves.toMatchObject({ error: "slow_down" });
    expect((await startDevice("192.0.2.77")).status).toBe(200);
  });

  it("counts codes an address asked for, even ones declined at once, and slows it down past the hourly limit", async () => {
    const human = await seedHuman();
    const address = `203.0.113.${Math.floor(Math.random() * 200) + 20}`;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const started = await startDevice(address);
      expect(started.status, `attempt ${attempt}`).toBe(200);
      const { user_code: userCode } = (await started.json()) as { user_code: string };
      // Declined at once, so it no longer waits: only the gateway's own count remains.
      const lookup = await call(env, "/v2/console/device/lookup", {
        base: CONSOLE,
        method: "POST",
        headers: { "content-type": "application/json", origin: CONSOLE, cookie: human.cookie, "x-console-request": "1" },
        body: JSON.stringify({ userCode }),
        address: `2001:db8:${attempt}::1`,
      });
      const { id } = (await lookup.json()) as { id: string };
      const denied = await call(env, `/v2/console/device/${id}/deny`, {
        base: CONSOLE,
        method: "POST",
        headers: { "content-type": "application/json", origin: CONSOLE },
        body: JSON.stringify({ userCode }),
      });
      expect(denied.status).toBe(200);
    }
    const refused = await startDevice(address);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/u);
    await expect(refused.json()).resolves.toMatchObject({ error: "slow_down" });
  });

  it("answers too many authorization requests from one address with an error page", async () => {
    const address = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
    const authorize = () =>
      call(env, `${OAUTH_PATHS.authorize}?client_id=${CLI_CLIENT_ID}&response_type=code`, { base: CONSOLE, address });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await authorize()).status).not.toBe(429);
    }
    const refused = await authorize();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/u);
    expect(refused.headers.get("content-type") ?? "").toContain("text/html");
  });

  it("limits how many sign-in codes one address may look up", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const human = await seedHuman();
    const address = `192.0.2.${Math.floor(Math.random() * 200) + 20}`;
    const lookup = () =>
      call(env, "/v2/console/device/lookup", {
        base: CONSOLE,
        method: "POST",
        headers: { "content-type": "application/json", origin: CONSOLE, cookie: human.cookie, "x-console-request": "1" },
        body: JSON.stringify({ userCode: "ABCD-EFGH" }),
        address,
      });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await lookup()).status).toBe(404);
    }
    const refused = await lookup();
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });
  });
});
