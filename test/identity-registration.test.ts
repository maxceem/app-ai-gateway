import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaimRegistrationAuth, createIdentityAuth } from "../src/auth/identity";
import worker from "../src/index";
import { registrationDisabledRedirect } from "../src/routes/identity-auth";
import { derive, digest } from "../src/routes/cli/security";
import { seedHuman } from "./helpers";

vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "https://example.test";
const GOOGLE_CLIENT_ID = "test-google-client";

function runtime(options: { additional?: boolean; cloud?: boolean; google?: boolean } = {}): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "BILLING") return options.cloud ? {} : undefined;
      if (property === "ALLOW_ADDITIONAL_REGISTRATIONS") {
        return options.additional ? "true" : "false";
      }
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

type PreparedStatement = ReturnType<Env["DB"]["prepare"]>;

function interceptFirst(
  statement: PreparedStatement,
  runFirst: (run: () => Promise<unknown>) => Promise<unknown>,
): PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => interceptFirst(target.bind(...values), runFirst);
      }
      if (property === "first") return () => runFirst(() => target.first());
      if (property === "all") return () => runFirst(() => target.all());
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Makes two initializers observe the same empty state before either may write.
 * Without this barrier, password hashing often serializes requests enough that
 * even a check-then-act implementation appears safe.
 */
function registrationBarrierEnv(base: Env, skipReads: number): Env {
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const db = new Proxy(base.DB, {
    get(target, property, receiver) {
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (query: string) => {
        const statement = target.prepare(query);
        const registrationRead = query.includes("human_exists");
        if (!registrationRead) return statement;
        return interceptFirst(statement, async (run) => {
          const result = await run();
          arrivals += 1;
          if (arrivals <= skipReads) return result;
          if (arrivals === skipReads + 2) release();
          await barrier;
          return result;
        });
      };
    },
  });
  return new Proxy(base, {
    get(target, property, receiver) {
      return property === "DB" ? db : Reflect.get(target, property, receiver);
    },
  }) as Env;
}

function signupWinsBootstrapEnv(base: Env): { env: Env; guardedInsertCount: () => number } {
  let signupFinalReady!: () => void;
  const signupFinal = new Promise<void>((resolve) => {
    signupFinalReady = resolve;
  });
  let bootstrapReady!: () => void;
  const bootstrapChecked = new Promise<void>((resolve) => {
    bootstrapReady = resolve;
  });
  let signupInserted!: () => void;
  const inserted = new Promise<void>((resolve) => {
    signupInserted = resolve;
  });
  let bootstrapBatchFinished!: () => void;
  const bootstrapBatch = new Promise<void>((resolve) => {
    bootstrapBatchFinished = resolve;
  });
  let registrationReads = 0;
  let guardedInserts = 0;
  let bootstrapMayBatch = false;
  const db = new Proxy(base.DB, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: PreparedStatement[]) => {
          const result = await target.batch(statements);
          if (bootstrapMayBatch) bootstrapBatchFinished();
          return result;
        };
      }
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (query: string) => {
        const statement = target.prepare(query);
        if (query.includes("human_exists")) {
          registrationReads += 1;
          if (registrationReads === 1) return statement; // Public route pre-check.
          return interceptFirst(statement, async (run) => {
            const result = await run();
            signupFinalReady();
            await bootstrapChecked;
            return result;
          });
        }
        if (query.includes("UNION ALL SELECT 1 FROM mgmt_user WHERE kind='human'")) {
          return interceptFirst(statement, async (run) => {
            const result = await run();
            await signupFinal;
            bootstrapReady();
            await inserted;
            bootstrapMayBatch = true;
            return result;
          });
        }
        const normalized = query.toLowerCase().replaceAll('"', "").replace(/\s+/gu, " ");
        if (normalized.includes("insert into mgmt_user")) {
          return interceptFirst(statement, async (run) => {
            const result = await run();
            guardedInserts += 1;
            signupInserted();
            // Keep signup between user insertion and account provisioning until
            // bootstrap's guarded batch has observed the new human.
            await bootstrapBatch;
            return result;
          });
        }
        return statement;
      };
    },
  });
  const proxied = new Proxy(base, {
    get(target, property, receiver) {
      return property === "DB" ? db : Reflect.get(target, property, receiver);
    },
  }) as Env;
  return { env: proxied, guardedInsertCount: () => guardedInserts };
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
      "app_usage_event",
      "app_usage_rollup",
      "app_api_key",
      "app_user",
      "app",
      "provider",
      "provider_gateway",
      "mgmt_handoff",
      "mgmt_resource_receipt",
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

describe("self-hosted registration policy", () => {
  it("atomically admits only one of two first public registrations", async () => {
    const testEnv = registrationBarrierEnv(runtime(), 2);
    const responses = await Promise.all([
      signUp(testEnv, "race-one@example.test"),
      signUp(testEnv, "race-two@example.test"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_user WHERE kind='human'").first("n"))
      .toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_user_account").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_organization").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_organization_user").first("n"))
      .toBe(1);
  });

  it("atomically chooses one initializer between public signup and CLI bootstrap", async () => {
    const barrier = signupWinsBootstrapEnv(runtime());
    const testEnv = barrier.env;
    const [signup, bootstrap] = await Promise.all([
      signUp(testEnv, "signup-race@example.test"),
      worker.request(`${ORIGIN}/v1/cli/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          pollToken: crypto.randomUUID(),
        }),
      }, testEnv),
    ]);
    expect(signup.status, await signup.clone().text()).toBe(200);
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_organization").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_organization_user").first("n"))
      .toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_user_account").first("n"))
      .toBe(signup.status === 200 ? 1 : 0);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_resource_receipt").first("n"))
      .toBe(bootstrap.status === 200 ? 1 : 0);
    expect(barrier.guardedInsertCount()).toBe(1);
  });

  it("preserves adapter ids, dates, and selected fields on guarded creates", async () => {
    const testEnv = runtime({ additional: true });
    const auth = createIdentityAuth(testEnv, ORIGIN, { suppressDefaultOrganization: true });
    const context = await auth.auth.$context;
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    const updatedAt = new Date("2026-02-03T04:05:06.000Z");
    const selected = await context.adapter.create({
      model: "user",
      forceAllowId: true,
      select: ["id", "email"],
      data: {
        id: "pinned-user-id",
        name: "Pinned",
        email: "pinned@example.test",
        emailVerified: true,
        image: null,
        kind: "human",
        createdAt,
        updatedAt,
      },
    });
    expect(selected).toEqual({ id: "pinned-user-id", email: "pinned@example.test" });
    const row = await env.DB.prepare(
      "SELECT id,email,email_verified,kind,created_at,updated_at FROM mgmt_user WHERE email=?",
    ).bind("pinned@example.test").first<Record<string, unknown>>();
    expect(row).toEqual({
      id: "pinned-user-id",
      email: "pinned@example.test",
      email_verified: 1,
      kind: "human",
      created_at: createdAt.getTime(),
      updated_at: updatedAt.getTime(),
    });

    const generatedData = {
      id: "ignored-user-id",
      name: "Generated",
      email: "generated@example.test",
      kind: "human",
      emailVerified: false,
      createdAt,
      updatedAt,
    };
    const generated = await context.adapter.create<{ id?: string; name: string; email: string }>({
      model: "user",
      forceAllowId: false,
      data: generatedData,
    });
    expect(generated.id).not.toBe("ignored-user-id");
    expect(generated.id).toEqual(expect.any(String));
  });

  it("lets the first person register as an account owner, then blocks new people but preserves sign-in", async () => {
    const testEnv = runtime();
    const before = await worker.request(`${ORIGIN}/v1/console/capabilities`, {}, testEnv);
    await expect(before.json()).resolves.toMatchObject({ registrationOpen: true });

    const first = await signUp(testEnv, "first@example.test");
    expect(first.status, await first.clone().text()).toBe(200);
    const ownership = await env.DB.prepare(
      `SELECT m.organization_id, m.role FROM mgmt_organization_user m
       JOIN mgmt_user u ON u.id=m.user_id WHERE u.email=?`,
    ).bind("first@example.test").first<{ organization_id: string; role: string }>();
    expect(ownership).toMatchObject({ role: "owner" });

    const after = await worker.request(`${ORIGIN}/v1/console/capabilities`, {}, testEnv);
    await expect(after.json()).resolves.toMatchObject({ registrationOpen: false });
    const blocked = await signUp(testEnv, "second@example.test");
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toEqual({
      error: {
        code: "registration_disabled",
        message: "Public registration is disabled for this deployment",
      },
    });

    const login = await authRequest(testEnv, "sign-in/email", {
      email: "first@example.test",
      password: "correct-horse-42",
    });
    expect(login.status, await login.clone().text()).toBe(200);
  });

  it("gives an enabled additional registration its own isolated account", async () => {
    const existing = await seedHuman("existing@example.test");
    const testEnv = runtime({ additional: true });
    const response = await signUp(testEnv, "additional@example.test");
    expect(response.status, await response.clone().text()).toBe(200);

    const newUser = await env.DB.prepare("SELECT id FROM mgmt_user WHERE email=?")
      .bind("additional@example.test")
      .first<{ id: string }>();
    const memberships = await env.DB.prepare(
      "SELECT organization_id,role FROM mgmt_organization_user WHERE user_id=?",
    ).bind(newUser!.id).all<{ organization_id: string; role: string }>();
    expect(memberships.results).toHaveLength(1);
    expect(memberships.results[0]).toMatchObject({ role: "owner" });
    expect(memberships.results[0]!.organization_id).not.toBe(existing.organizationId);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_organization_user WHERE organization_id=? AND user_id=?",
      ).bind(existing.organizationId, newUser!.id).first("n"),
    ).toBe(0);
  });

  it("keeps a machine-initialized deployment claim-only even when additional registration is enabled", async () => {
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
    const testEnv = runtime({ additional: true });

    const capabilities = await worker.request(`${ORIGIN}/v1/console/capabilities`, {}, testEnv);
    await expect(capabilities.json()).resolves.toMatchObject({ registrationOpen: false });
    expect((await signUp(testEnv, "visitor@example.test")).status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user WHERE kind='human'").first("n"))
      .toBe(0);
  });

  it("applies the fresh human gate to trusted claim registration after a human exists", async () => {
    await seedHuman("owner@example.test");
    const response = await createClaimRegistrationAuth(runtime(), ORIGIN).auth.api.signUpEmail({
      body: {
        name: "Second claimant",
        email: "second-claimant@example.test",
        password: "claim-password-42",
      },
      asResponse: true,
    });
    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user WHERE email=?")
        .bind("second-claimant@example.test")
        .first("n"),
    ).toBe(0);
  });
});

describe("Google registration policy", () => {
  it("uses the same atomic first-owner gate for Google and password registration", async () => {
    const token = await googleIdToken("google-race@example.test", "google-race");
    const testEnv = registrationBarrierEnv(runtime({ google: true }), 1);
    const [password, google] = await Promise.all([
      signUp(testEnv, "password-race@example.test"),
      authRequest(testEnv, "sign-in/social", {
        provider: "google",
        callbackURL: ORIGIN,
        idToken: { token },
      }),
    ]);
    expect([password.status, google.status].sort()).toEqual([200, 403]);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_user WHERE kind='human'").first("n"))
      .toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_user_account").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_organization").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_organization_user").first("n"))
      .toBe(1);
  });

  it("lets Google create the first owner, blocks a second new person, and still signs the owner in", async () => {
    const testEnv = runtime({ google: true });
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

  it("keeps successful HTTPS redirect callbacks open for the first and existing Google user", async () => {
    const testEnv = runtime({ google: true });
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

  it("rechecks the database at a redirect callback after registration closes", async () => {
    const testEnv = runtime({ google: true });
    const started = await startGoogleRedirect(testEnv);

    const first = await signUp(testEnv, "password-owner@example.test");
    expect(first.status, await first.clone().text()).toBe(200);
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
      .toBe(1);
  });

  it("normalizes a denied Google claim callback after another human registers", async () => {
    const testEnv = runtime({ google: true });
    const operationId = "claim-google-policy-test";
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
      `INSERT INTO mgmt_handoff(
        id,kind,request_json,organization_id,initiating_user_id,initiating_credential_id,
        submission_proof_hash,poll_proof_hash,expires_at,created_at,updated_at)
       VALUES (?, 'claim', '{}', 'claim-account', 'claim-service', 'claim-key', 'proof', 'poll', ?, ?, ?)`,
    ).bind(operationId, expires, now, now).run();
    const claimAuth = createClaimRegistrationAuth(testEnv, ORIGIN);
    const started = await claimAuth.auth.api.signInSocial({
      body: { provider: "google", callbackURL: `${ORIGIN}/after-claim` },
      headers: new Headers({ origin: ORIGIN }),
      asResponse: true,
    });
    const authorization = new URL(((await started.clone().json()) as { url: string }).url);
    const encoded = btoa(JSON.stringify({ id: operationId, expires }));
    const signature = await derive(testEnv.BETTER_AUTH_SECRET, `claim-oauth:${encoded}`);

    await seedHuman("other-owner@example.test");
    mockGoogleTokenExchange("denied-claim@example.test", "denied-claim");
    const callback = await googleCallback(
      testEnv,
      started,
      authorization.searchParams.get("state")!,
      `cli_claim_oauth=${encoded}.${signature}`,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/login?error=registration_disabled");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_user WHERE email=?")
        .bind("denied-claim@example.test")
        .first("n"),
    ).toBe(0);
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
    const testEnv = runtime({ additional: true, google: true });
    const operationId = "claim-google-takeover";
    const submissionToken = "claim-submission-proof-0123456789abcdef";
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
      `INSERT INTO mgmt_handoff(
        id,kind,request_json,organization_id,initiating_user_id,initiating_credential_id,
        submission_proof_hash,poll_proof_hash,expires_at,created_at,updated_at)
       VALUES (?, 'claim', '{}', 'takeover-account', 'takeover-service', 'takeover-key', ?, 'poll', ?, ?, ?)`,
    ).bind(operationId, await digest(submissionToken), expires, now, now).run();
    // The email already signs in with a password, so Google must not open it.
    const squatted = await seedHuman("claim-victim@example.test");

    const started = await worker.request(
      `${ORIGIN}/v1/cli/browser/${operationId}/google`,
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
      `${ORIGIN}/cli/approve/${operationId}?error=account_not_linked`,
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
  it("stays open independently of the self-host additional-registration flag", async () => {
    const response = await worker.request(`${ORIGIN}/v1/console/capabilities`, {}, runtime({ cloud: true }));
    await expect(response.json()).resolves.toMatchObject({
      billing: true,
      registrationOpen: true,
    });
  });
});
