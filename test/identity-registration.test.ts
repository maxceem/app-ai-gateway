import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityAuth } from "../src/auth/identity";
import worker from "../src/index";
import { registrationDisabledRedirect } from "../src/routes/identity-auth";
import { derive, digest } from "../src/routes/cli/security";
import { seedHuman } from "./helpers";
import { resolveDeployment } from "../src/policy/deployment";

vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "https://example.test";
const GOOGLE_CLIENT_ID = "test-google-client";

function runtime(options: { emails?: string; cloud?: boolean; google?: boolean } = {}): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "BILLING") return options.cloud ? {} : undefined;
      if (property === "ALLOWED_REGISTRATION_EMAILS") return options.emails ?? "";
      if (property === "GOOGLE_CLIENT_ID") {
        return options.google ? GOOGLE_CLIENT_ID : undefined;
      }
      if (property === "GOOGLE_CLIENT_SECRET") {
        return options.google ? "test-google-secret" : undefined;
      }
      if (property === "OAUTH_RELAY_URL") return undefined;
      // The CLI handoff routes refuse a deployment without an identity.
      if (property === "DEPLOYMENT_ID") return "registration-test-deployment";
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

async function authRequest(testEnv: Env, path: string, body: Record<string, unknown>) {
  return worker.request(`${ORIGIN}/v1/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  }, testEnv);
}

async function signUp(testEnv: Env, email: string) {
  return authRequest(testEnv, "sign-up/email", {
    name: email.split("@")[0],
    email,
    password: "correct-horse-42",
  });
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
    name: "Google User",
  })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setSubject(subject)
    .setIssuer("https://accounts.google.com")
    .setAudience(GOOGLE_CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(pair.privateKey);
}

async function googleSignIn(testEnv: Env, email: string, subject: string) {
  return authRequest(testEnv, "sign-in/social", {
    provider: "google",
    callbackURL: ORIGIN,
    idToken: { token: await googleIdToken(email, subject) },
  });
}

function mockGoogleTokenExchange(email: string, subject: string) {
  const jwt = [
    btoa(JSON.stringify({ alg: "RS256" })),
    btoa(JSON.stringify({
      sub: subject,
      email,
      email_verified: true,
      name: "Google User",
    })),
    "test-signature",
  ].join(".");
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    access_token: "test-google-access",
    token_type: "Bearer",
    expires_in: 3600,
    id_token: jwt,
  }));
}

async function startGoogleRedirect(testEnv: Env, errorCallbackURL?: string) {
  const started = await authRequest(testEnv, "sign-in/social", {
    provider: "google",
    callbackURL: `${ORIGIN}/after-google`,
    // The console names one, so a refusal lands on its sign-in screen rather
    // than on Better Auth's own error page.
    ...(errorCallbackURL === undefined ? {} : { errorCallbackURL }),
  });
  expect(started.status).toBe(200);
  const authorization = new URL(((await started.clone().json()) as { url: string }).url);
  return {
    response: started,
    state: authorization.searchParams.get("state")!,
  };
}

async function googleCallback(testEnv: Env, started: Response, state: string, extraCookie = "") {
  const cookie = [
    ...started.headers.getSetCookie().map((value) => value.split(";")[0]),
    extraCookie,
  ].filter(Boolean).join("; ");
  return worker.request(
    `${ORIGIN}/v1/auth/callback/google?code=mock-code&state=${encodeURIComponent(state)}`,
    {
      headers: {
        cookie,
        "sec-fetch-mode": "navigate",
        accept: "text/html,application/xhtml+xml",
      },
    },
    testEnv,
  );
}

beforeEach(async () => {
  await env.DB.batch(
    [
      "app_auth_challenge",
      "app_auth_event",
      "app_rejection_event",
      "app_usage_event",
      "app_usage_rollup",
      "app_api_key",
      "app_user",
      "app",
      "provider",
      "provider_gateway",
      "mgmt_operation",
      "mgmt_verification",
      "mgmt_user_account",
      "mgmt_user_session",
      "mgmt_api_key",
      "mgmt_organization_user",
      "mgmt_organization",
      "mgmt_user",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});

afterEach(() => vi.restoreAllMocks());

/** The account each listed person owns, by email. */
async function ownedAccount(email: string): Promise<string | undefined> {
  const row = await env.DB.prepare(
    `SELECT m.organization_id FROM mgmt_organization_user m
     JOIN mgmt_user u ON u.id=m.user_id WHERE u.email=? AND m.role='owner'`,
  ).bind(email).first<{ organization_id: string }>();
  return row?.organization_id;
}

describe("self-hosted registration policy", () => {
  it("registers each listed email into an account of its own and refuses anyone else", async () => {
    const testEnv = runtime({ emails: "first@example.test, Second@Example.test" });
    const capabilities = await worker.request(`${ORIGIN}/v1/console/capabilities`, {}, testEnv);
    await expect(capabilities.json()).resolves.toMatchObject({ registrationOpen: true });

    const first = await signUp(testEnv, "first@example.test");
    expect(first.status, await first.clone().text()).toBe(200);
    const second = await signUp(testEnv, "second@example.test");
    expect(second.status, await second.clone().text()).toBe(200);
    const firstAccount = await ownedAccount("first@example.test");
    const secondAccount = await ownedAccount("second@example.test");
    expect(firstAccount).toBeDefined();
    expect(secondAccount).toBeDefined();
    expect(secondAccount).not.toBe(firstAccount);

    const refused = await signUp(testEnv, "stranger@example.test");
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({
      error: {
        code: "registration_disabled",
        message: "This email address is not allowed to register on this deployment",
      },
    });
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_user WHERE email=?")
      .bind("stranger@example.test").first("n")).toBe(0);
  });

  it("closes sign-up with an empty list, yet still signs in a person it no longer lists", async () => {
    const listed = await signUp(runtime({ emails: "former@example.test" }), "former@example.test");
    expect(listed.status, await listed.clone().text()).toBe(200);

    const testEnv = runtime();
    const capabilities = await worker.request(`${ORIGIN}/v1/console/capabilities`, {}, testEnv);
    await expect(capabilities.json()).resolves.toMatchObject({ registrationOpen: false });
    expect((await signUp(testEnv, "former-friend@example.test")).status).toBe(403);

    const login = await authRequest(testEnv, "sign-in/email", {
      email: "former@example.test",
      password: "correct-horse-42",
    });
    expect(login.status, await login.clone().text()).toBe(200);
  });

  it("gives a listed person an account of their own beside the CLI's unclaimed one", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mgmt_user(id,name,email,email_verified,kind,created_at,updated_at) VALUES ('service-owner','CLI service',NULL,0,'service',?,?)",
      ).bind(Date.now(), Date.now()),
      env.DB.prepare(
        "INSERT INTO mgmt_organization(id,name,created_by_user_id,created_at,updated_at) VALUES ('machine-account','My account','service-owner',?,?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO mgmt_organization_user(id,organization_id,user_id,role,status,joined_at) VALUES ('machine-owner','machine-account','service-owner','owner','active',?)",
      ).bind(now),
    ]);
    const response = await signUp(runtime({ emails: "visitor@example.test" }), "visitor@example.test");
    expect(response.status, await response.clone().text()).toBe(200);

    const account = await ownedAccount("visitor@example.test");
    expect(account).toBeDefined();
    expect(account).not.toBe("machine-account");
    // Only a claim takes over the CLI's account.
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mgmt_organization_user WHERE organization_id='machine-account'",
    ).first("n")).toBe(1);
  });

  it("admits a claim registration whatever the list says, and gives it no account of its own", async () => {
    await seedHuman("owner@example.test");
    const claimEnv = runtime();
    const response = await (await createIdentityAuth(
      resolveDeployment(claimEnv),
      claimEnv,
      ORIGIN,
      { claimRegistration: true },
    )).auth.api.signUpEmail({
      body: {
        name: "Claimant",
        email: "claimant@example.test",
        password: "claim-password-42",
      },
      asResponse: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
         WHERE u.email=?`,
      ).bind("claimant@example.test").first("n"),
    ).toBe(0);
  });
});

describe("Google registration policy", () => {
  it("lets a listed Google email register, refuses an unlisted one, and still signs the first in", async () => {
    const testEnv = runtime({ google: true, emails: "google-owner@example.test" });
    const first = await googleSignIn(testEnv, "google-owner@example.test", "google-owner");
    expect(first.status, await first.clone().text()).toBe(200);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
         WHERE u.email='google-owner@example.test' AND m.role='owner'`,
      ).first("n"),
    ).toBe(1);

    const blocked = await googleSignIn(testEnv, "new-google@example.test", "new-google");
    expect(blocked.status, await blocked.clone().text()).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "registration_disabled" },
    });
    const existing = await googleSignIn(testEnv, "google-owner@example.test", "google-owner");
    expect(existing.status, await existing.clone().text()).toBe(200);
  });

  it("keeps successful HTTPS redirect callbacks open for a listed and an existing Google user", async () => {
    const testEnv = runtime({ google: true, emails: "redirect-owner@example.test" });
    const exchange = mockGoogleTokenExchange("redirect-owner@example.test", "redirect-owner");
    const firstStart = await startGoogleRedirect(testEnv);
    const first = await googleCallback(testEnv, firstStart.response, firstStart.state);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(`${ORIGIN}/after-google`);
    expect(first.headers.getSetCookie().some((cookie) => cookie.includes("session_token="))).toBe(true);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user WHERE email=?")
        .bind("redirect-owner@example.test")
        .first("n"),
    ).toBe(1);

    exchange.mockResolvedValue(Response.json({
      access_token: "test-google-access-2",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: [
        btoa(JSON.stringify({ alg: "RS256" })),
        btoa(JSON.stringify({
          sub: "redirect-owner",
          email: "redirect-owner@example.test",
          email_verified: true,
          name: "Google User",
        })),
        "test-signature",
      ].join("."),
    }));
    const existingStart = await startGoogleRedirect(testEnv);
    const existing = await googleCallback(testEnv, existingStart.response, existingStart.state);
    expect(existing.status).toBe(302);
    expect(existing.headers.get("location")).toBe(`${ORIGIN}/after-google`);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user WHERE email=?")
        .bind("redirect-owner@example.test")
        .first("n"),
    ).toBe(1);
  });

  it("refuses an unlisted email at the redirect callback", async () => {
    const testEnv = runtime({ google: true, emails: "someone-else@example.test" });
    const started = await startGoogleRedirect(testEnv);
    mockGoogleTokenExchange("stale-google@example.test", "stale-google-user");
    const callback = await googleCallback(testEnv, started.response, started.state);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/login?error=registration_disabled");
    expect(callback.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user WHERE email=?")
        .bind("stale-google@example.test")
        .first("n"),
    ).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_organization").first("n"))
      .toBe(0);
  });

  it("admits an unlisted Google email at a claim's callback, and only with the claim's signed grant", async () => {
    const testEnv = runtime({ google: true });
    // A claim is opened under the id the CLI knows it by — `op:` and its
    // token's digest, which the row also keeps as `poll_token_hash`.
    const tokenDigest = "c".repeat(64);
    const operationId = `op:${tokenDigest}`;
    const proof = "0123456789abcdef".repeat(4);
    const expires = Date.now() + 10 * 60_000;
    const now = Date.now();
    const iso = new Date(now).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mgmt_user(id,name,email,email_verified,kind,created_at,updated_at) VALUES ('claim-service','CLI',NULL,0,'service',?,?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO mgmt_organization(id,name,created_by_user_id,created_at,updated_at) VALUES ('claim-account','Claim account','claim-service',?,?)",
      ).bind(iso, iso),
    ]);
    await env.DB.prepare(
      `INSERT INTO mgmt_operation(
        id,kind,state,request_hash,poll_token_hash,organization_id,opener_user_id,opener_credential_id,
        browser_proof_hash,expires_at,retain_until,created_at,updated_at)
       VALUES (?, 'claim', 'pending', 'hash', ?, 'claim-account', 'claim-service', 'claim-key', ?, ?, ?, ?, ?)`,
    ).bind(operationId, tokenDigest, await digest(proof), expires, expires, now, now).run();
    const claimAuth = await createIdentityAuth(resolveDeployment(testEnv), testEnv, ORIGIN, {
      claimRegistration: true,
    });
    const startClaim = async () => {
      const started = await claimAuth.auth.api.signInSocial({
        body: { provider: "google", callbackURL: `${ORIGIN}/after-claim` },
        headers: new Headers({ origin: ORIGIN }),
        asResponse: true,
      });
      return { started, state: new URL(((await started.clone().json()) as { url: string }).url).searchParams.get("state")! };
    };
    const encoded = btoa(JSON.stringify({ id: operationId, expires }));
    const signature = await derive(testEnv.BETTER_AUTH_SECRET, `claim-oauth:${encoded}`);
    mockGoogleTokenExchange("claimant@example.test", "claimant");

    // Without the grant, the callback is an ordinary registration, which this
    // deployment's empty list refuses.
    const forged = await startClaim();
    const refused = await googleCallback(testEnv, forged.started, forged.state, `cli_claim_oauth=${encoded}.forged`);
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toBe("/login?error=registration_disabled");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user WHERE email=?")
        .bind("claimant@example.test")
        .first("n"),
    ).toBe(0);

    // Each exchange answers with a response of its own.
    mockGoogleTokenExchange("claimant@example.test", "claimant");
    const granted = await startClaim();
    const admitted = await googleCallback(testEnv, granted.started, granted.state, `cli_claim_oauth=${encoded}.${signature}`);
    expect(admitted.status).toBe(302);
    expect(admitted.headers.get("location")).toBe(`${ORIGIN}/after-claim`);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user WHERE email=?")
        .bind("claimant@example.test")
        .first("n"),
    ).toBe(1);
  });

  it("carries rejected navigation cookies and destination onto the sign-in redirect", () => {
    const rejected = new Response(null, {
      status: 302,
      headers: { location: "/login?error=signup_disabled&from=%2Fapps%2Fmy-app" },
    });
    rejected.headers.append("set-cookie", "agw_identity_auth.state=; Max-Age=0; Path=/");
    rejected.headers.append("set-cookie", "agw_identity_auth.pkce=; Max-Age=0; Path=/");

    const redirect = registrationDisabledRedirect(rejected);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(
      "/login?from=%2Fapps%2Fmy-app&error=registration_disabled",
    );
    expect(redirect.headers.getSetCookie()).toEqual([
      "agw_identity_auth.state=; Max-Age=0; Path=/",
      "agw_identity_auth.pkce=; Max-Age=0; Path=/",
    ]);
  });
});

describe("Google sign-in onto an email that already has a sign-in", () => {
  it("refuses to sign a Google identity into the account someone else registered with that email", async () => {
    // Registration is open on the cloud deployment and no email is ever
    // verified, so whoever registers an address first must not inherit the
    // Google sign-ins for it.
    const testEnv = runtime({ cloud: true, google: true });
    const registered = await signUp(testEnv, "victim@example.test");
    expect(registered.status, await registered.clone().text()).toBe(200);
    const squatted = await env.DB.prepare("SELECT id FROM mgmt_user WHERE email=?")
      .bind("victim@example.test")
      .first<{ id: string }>();
    const sessionsBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mgmt_user_session WHERE user_id=?",
    ).bind(squatted!.id).first("n");

    const hijack = await googleSignIn(testEnv, "victim@example.test", "victim-google-subject");

    expect(hijack.status, await hijack.clone().text()).toBe(401);
    await expect(hijack.json()).resolves.toMatchObject({ code: "OAUTH_LINK_ERROR" });
    expect(hijack.headers.getSetCookie().some((cookie) => cookie.includes("session_token=")))
      .toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_user_account WHERE user_id=? AND provider_id='google'",
      ).bind(squatted!.id).first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user_session WHERE user_id=?")
        .bind(squatted!.id)
        .first("n"),
    ).toBe(sessionsBefore);
  });

  it("returns a refused Google claim to the approval page with its reason", async () => {
    // The claim flow is the one Google entry point that does not end on the
    // sign-in screen: the claimant carries on here with a password, so the
    // refusal has to come back to the page they started on.
    const testEnv = runtime({ google: true });
    // A claim is opened under the id the CLI knows it by — `op:` and its
    // token's digest, which the row also keeps as `poll_token_hash` — and the
    // engine's proofs are SHA-256-sized hex.
    const tokenDigest = "d".repeat(64);
    const operationId = `op:${tokenDigest}`;
    const submissionToken = "0123456789abcdef".repeat(4);
    const expires = Date.now() + 10 * 60_000;
    const now = Date.now();
    const iso = new Date(now).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mgmt_user(id,name,email,email_verified,kind,created_at,updated_at) VALUES ('takeover-service','CLI',NULL,0,'service',?,?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO mgmt_organization(id,name,created_by_user_id,created_at,updated_at) VALUES ('takeover-account','Claim account','takeover-service',?,?)",
      ).bind(iso, iso),
    ]);
    await env.DB.prepare(
      `INSERT INTO mgmt_operation(
        id,kind,state,request_hash,poll_token_hash,organization_id,opener_user_id,opener_credential_id,
        browser_proof_hash,expires_at,retain_until,created_at,updated_at)
       VALUES (?, 'claim', 'pending', 'hash', ?, 'takeover-account', 'takeover-service', 'takeover-key', ?, ?, ?, ?, ?)`,
    ).bind(operationId, tokenDigest, await digest(submissionToken), expires, expires, now, now).run();
    // The email already signs in with a password, so Google must not open it.
    const squatted = await seedHuman("claim-victim@example.test");

    const started = await worker.request(
      `${ORIGIN}/v1/cli/browser/${encodeURIComponent(operationId)}/google`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ submissionToken }),
      },
      testEnv,
    );
    expect(started.status, await started.clone().text()).toBe(200);
    const authorization = new URL(((await started.clone().json()) as { url: string }).url);
    mockGoogleTokenExchange("claim-victim@example.test", "claim-victim-google");

    const callback = await googleCallback(
      testEnv,
      started,
      authorization.searchParams.get("state")!,
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      `${ORIGIN}/cli/approve/${encodeURIComponent(operationId)}?error=account_not_linked`,
    );
    expect(callback.headers.getSetCookie().some((cookie) => cookie.includes("session_token=")))
      .toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_user_account WHERE user_id=? AND provider_id='google'",
      ).bind(squatted.userId).first("n"),
    ).toBe(0);
  });

  it("refuses the same takeover at the redirect callback", async () => {
    // Seeded rather than registered over HTTP: the refusal turns on the email
    // already belonging to a user with no Google account, and seeding one
    // costs a fraction of hashing a password.
    const testEnv = runtime({ cloud: true, google: true });
    const squatted = await seedHuman("redirect-victim@example.test");
    const started = await startGoogleRedirect(testEnv, "/login");
    mockGoogleTokenExchange("redirect-victim@example.test", "redirect-victim-google");

    const callback = await googleCallback(testEnv, started.response, started.state);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/login?error=account_not_linked");
    expect(callback.headers.getSetCookie().some((cookie) => cookie.includes("session_token=")))
      .toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_user_account WHERE user_id=? AND provider_id='google'",
      ).bind(squatted.userId).first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user_session WHERE user_id=?")
        .bind(squatted.userId)
        .first("n"),
    ).toBe(1); // The one `seedHuman` created; the callback added none.
  });
});

describe("cloud registration", () => {
  it("stays open whatever a self-host's list says", async () => {
    const response = await worker.request(`${ORIGIN}/v1/console/capabilities`, {}, runtime({ cloud: true }));
    await expect(response.json()).resolves.toMatchObject({
      billing: true,
      registrationOpen: true,
    });
  });
});
