import { env, exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { registrationDisabledRedirect } from "../src/routes/operator-auth";

const ORIGIN = "https://example.test";
const GOOGLE_CLIENT_ID = "test-google-client";

afterEach(() => vi.restoreAllMocks());

function operatorEnv(overrides: Partial<Record<keyof Env, unknown>>): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property in overrides) return overrides[property as keyof Env];
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

async function signup(email: string): Promise<void> {
  const response = await exports.default.fetch(`${ORIGIN}/v1/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ name: email.split("@")[0], email, password: "correct-horse-42" }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function googleIdToken(email: string, subject: string): Promise<string> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = `google-${subject}`;
  publicJwk.alg = "RS256";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [publicJwk] }));
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email,
    email_verified: true,
    name: "Google Operator",
  })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setSubject(subject)
    .setIssuer("https://accounts.google.com")
    .setAudience(GOOGLE_CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(pair.privateKey);
}

async function googleSignIn(
  email: string,
  subject: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.request(`${ORIGIN}/v1/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify({
      provider: "google",
      callbackURL: ORIGIN,
      idToken: { token: await googleIdToken(email, subject) },
    }),
  }, operatorEnv({
    ALLOW_PUBLIC_REGISTRATION: "false",
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    // These tests exercise Better Auth's direct ID-token path, not the
    // cross-environment OAuth redirect proxy.
    OAUTH_PROXY_PRODUCTION_URL: undefined,
    OAUTH_PROXY_SECRET: undefined,
  }));
}

describe("closed operator registration", () => {
  it("allows existing Google users to sign in", async () => {
    const email = "existing-google@example.test";
    await signup(email);
    const response = await googleSignIn(email, "existing-google-subject");

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("agw_operator_auth.session_token");
    const userCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM console_user WHERE email = ?")
      .bind(email)
      .first<{ count: number }>();
    expect(userCount?.count).toBe(1);
  });

  it("rejects new Google users without creating user or organization rows", async () => {
    const email = "new-google-disabled@example.test";
    const before = await env.DB.prepare("SELECT COUNT(*) AS count FROM console_organization")
      .first<{ count: number }>();
    const response = await googleSignIn(email, "new-google-disabled-subject");

    expect(response.status, await response.clone().text()).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "registration_disabled",
        message: "Public registration is disabled for this deployment",
      },
    });
    const user = await env.DB.prepare("SELECT id FROM console_user WHERE email = ?")
      .bind(email)
      .first();
    const after = await env.DB.prepare("SELECT COUNT(*) AS count FROM console_organization")
      .first<{ count: number }>();
    expect(user).toBeNull();
    expect(after?.count).toBe(before?.count);
  });

  it("returns a rejected browser navigation to the console sign-in screen", async () => {
    const response = await googleSignIn("nav-google-disabled@example.test", "nav-disabled-subject", {
      "sec-fetch-mode": "navigate",
      accept: "text/html,application/xhtml+xml",
    });

    // A top-level navigation cannot render a JSON body, so the operator has to
    // be handed back to a page that can explain what happened.
    expect(response.status, await response.clone().text()).toBe(302);
    expect(response.headers.get("location")).toBe("/login?error=registration_disabled");
  });

  it("still answers script callers with the machine-readable error", async () => {
    const response = await googleSignIn("xhr-google-disabled@example.test", "xhr-disabled-subject", {
      "sec-fetch-mode": "cors",
      accept: "application/json",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "registration_disabled" },
    });
  });

  it("carries the rejected response's cookies and destination onto the redirect", () => {
    const rejected = new Response(null, {
      status: 302,
      headers: { location: "/login?error=signup_disabled&from=%2Fapps%2Fmy-app" },
    });
    // Better Auth clears its transient OAuth state cookies on rejection.
    rejected.headers.append("set-cookie", "agw_operator_auth.state=; Max-Age=0; Path=/");
    rejected.headers.append("set-cookie", "agw_operator_auth.pkce=; Max-Age=0; Path=/");

    const redirect = registrationDisabledRedirect(rejected);

    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(
      "/login?from=%2Fapps%2Fmy-app&error=registration_disabled",
    );
    // Dropping these would leave state cookies the flow no longer owns.
    expect(redirect.headers.getSetCookie()).toEqual([
      "agw_operator_auth.state=; Max-Age=0; Path=/",
      "agw_operator_auth.pkce=; Max-Age=0; Path=/",
    ]);
  });

  it("still redirects when the rejection carries no cookies or destination", () => {
    const redirect = registrationDisabledRedirect(new Response(null, { status: 403 }));

    expect(redirect.headers.get("location")).toBe("/login?error=registration_disabled");
    expect(redirect.headers.getSetCookie()).toEqual([]);
  });

  it("accepts the case-insensitive bearer scheme for management keys", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: { authorization: "bearer agw_mgmt_test-admin-secret" },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  });
});
