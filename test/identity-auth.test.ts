import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT_RATE_LIMITS } from "../src/core/endpoint-rate-limit";
import { createIdentityAuth } from "../src/auth/identity";
import worker from "../src/index";
import { seedHuman, seedServerApp, serverConfig } from "./helpers";
import { resolveDeployment } from "../src/policy/deployment";

// Signing up hashes a password with scrypt in pure JS (workerd has no
// node:crypto scrypt), which costs about two and a half seconds on an idle
// machine and several times that while the other test workers, and the
// console's suite beside them, compete for the CPU. Only the two tests whose
// subject is registration do it; everything else needs an authenticated
// operator rather than a sign-up, and `seedHuman` mints one. The timeout is
// sized for the two that remain.
vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "https://example.test";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  expect(value).toContain("HttpOnly");
  return value!.split(";")[0]!;
}

/** A real registration, for the one test that is about registering. */
async function signup(email: string): Promise<{ cookie: string; organizationId: string }> {
  const response = await worker.request(`${ORIGIN}/v1/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ name: email.split("@")[0], email, password: "correct-horse-42" }),
  }, new Proxy(env, { get(target, key) { return key === "BILLING" ? {} : key === "ALLOW_ADDITIONAL_REGISTRATIONS" ? "true" : Reflect.get(target, key); } }) as Env);
  expect(response.status, await response.clone().text()).toBe(200);
  const user = await env.DB.prepare("SELECT id FROM mgmt_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  const membership = await env.DB.prepare(
    "SELECT organization_id FROM mgmt_organization_user WHERE user_id = ?",
  ).bind(user!.id).first<{ organization_id: string }>();
  return { cookie: cookieFrom(response), organizationId: membership!.organization_id };
}

function sessionHeaders(cookie: string, json = false): Record<string, string> {
  return {
    cookie,
    "x-console-request": "1",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function userIdFor(email: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM mgmt_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  return row!.id;
}

/** Adds a second organization directly; cf-auth exposes creation only in-process. */
async function seedOrganization(name: string, userId: string, role = "owner"): Promise<string> {
  const now = new Date().toISOString();
  const organizationId = `org-${name}`;
  await env.DB.prepare(
    "INSERT INTO mgmt_organization (id, name, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(organizationId, name, userId, now, now).run();
  await env.DB.prepare(
    "INSERT INTO mgmt_organization_user (id, organization_id, user_id, role, status, joined_at) VALUES (?, ?, ?, ?, 'active', ?)",
  ).bind(`membership-${name}`, organizationId, userId, role, now).run();
  return organizationId;
}

async function createApp(cookie: string, name: string) {
  return exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ name, config: serverConfig() }),
  });
}

/** The id the gateway assigned, which is the only place a caller learns it. */
async function createdAppId(response: Response): Promise<string> {
  expect(response.status).toBe(201);
  return (await response.json<{ app: { id: string } }>()).app.id;
}

async function passwordSignIn(email: string, password: string): Promise<Response> {
  return worker.request(`${ORIGIN}/v1/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  }, env);
}

async function sessionFor(cookie: string) {
  return (await createIdentityAuth(resolveDeployment(env), env, ORIGIN)).auth.api.getSession({
    headers: new Headers({ cookie }),
  });
}

describe("operator authentication", () => {
  it("accepts the case-insensitive bearer scheme for management keys", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: { authorization: "bearer agw_mgmt_test-admin-secret" },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it("does not accept data-plane keys on the operator plane", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: { authorization: "Bearer agw_not-a-management-key" },
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "auth_required" } });
  });

  it("signs up, bootstraps an owner organization, and manages a one-time management key", async () => {
    const { cookie } = await signup("bootstrap@example.test");

    const missingCsrfHeader = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: { cookie },
    });
    expect(missingCsrfHeader.status).toBe(401);

    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/keys`, {
      method: "POST",
      headers: sessionHeaders(cookie, true),
      body: JSON.stringify({ name: "Automation" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json<{ key: { id: string; plaintext: string; tokenHint: string } }>();
    expect(body.key.plaintext).toMatch(/^agw_mgmt_/u);
    expect(body.key.tokenHint).toBe(body.key.plaintext.slice(-4));

    const keyAccess = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: { authorization: `Bearer ${body.key.plaintext}` },
    });
    expect(keyAccess.status).toBe(200);

    // A key that could mint a key would outlive being revoked, so the whole
    // surface is session-only: reading the list is refused the same way.
    const keyCannotMintKeys = await exports.default.fetch(`${ORIGIN}/v1/admin/keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.key.plaintext}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Escalation" }),
    });
    expect(keyCannotMintKeys.status).toBe(403);
    await expect(keyCannotMintKeys.json()).resolves.toMatchObject({
      error: { code: "session_required" },
    });

    const keyCannotListKeys = await exports.default.fetch(`${ORIGIN}/v1/admin/keys`, {
      headers: { authorization: `Bearer ${body.key.plaintext}` },
    });
    expect(keyCannotListKeys.status).toBe(403);

    const keyCannotRevokeKeys = await exports.default.fetch(
      `${ORIGIN}/v1/admin/keys/${body.key.id}/revoke`,
      { method: "POST", headers: { authorization: `Bearer ${body.key.plaintext}` } },
    );
    expect(keyCannotRevokeKeys.status).toBe(403);

    const listed = await exports.default.fetch(`${ORIGIN}/v1/admin/keys`, {
      headers: sessionHeaders(cookie),
    });
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listedText).not.toContain(body.key.plaintext);
    expect(listedText).toContain(body.key.tokenHint);

    const revoked = await exports.default.fetch(
      `${ORIGIN}/v1/admin/keys/${body.key.id}/revoke`,
      { method: "POST", headers: sessionHeaders(cookie) },
    );
    expect(revoked.status).toBe(200);
    const rejected = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: { authorization: `Bearer ${body.key.plaintext}` },
    });
    expect(rejected.status).toBe(401);
  });

  it("returns the stable registration-disabled error when public signup is off", async () => {
    const closedEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "ALLOW_ADDITIONAL_REGISTRATIONS") return "false";
        return Reflect.get(target, property, receiver);
      },
    }) as Env;
    const response = await worker.request(
      `${ORIGIN}/v1/auth/sign-up/email`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          name: "Closed",
          email: "closed@example.test",
          password: "correct-horse-42",
        }),
      },
      closedEnv,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "registration_disabled" },
    });
  });

  it("lets members read their organization but rejects mutations", async () => {
    const { cookie, organizationId } = await seedHuman("member@example.test");
    await env.DB.prepare(
      "UPDATE mgmt_organization_user SET role = 'member' WHERE organization_id = ?",
    ).bind(organizationId).run();

    const read = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: sessionHeaders(cookie),
    });
    expect(read.status).toBe(200);

    const validation = await exports.default.fetch(
      `${ORIGIN}/v1/admin/apps/member-validation/validate`,
      {
        method: "POST",
        headers: sessionHeaders(cookie, true),
        body: JSON.stringify({ name: "Candidate", config: serverConfig() }),
      },
    );
    expect(validation.status, await validation.clone().text()).toBe(200);

    await seedServerApp("validate", { organizationId });
    const validateNamedAppMutation = await exports.default.fetch(
      `${ORIGIN}/v1/admin/apps/validate`,
      {
        method: "PUT",
        headers: sessionHeaders(cookie, true),
        body: "{}",
      },
    );
    expect(validateNamedAppMutation.status).toBe(403);
    await expect(validateNamedAppMutation.json()).resolves.toMatchObject({
      error: { code: "forbidden" },
    });

    const write = await createApp(cookie, "member-cannot-create");
    expect(write.status).toBe(403);
    await expect(write.json()).resolves.toMatchObject({ error: { code: "forbidden" } });

    await env.DB.prepare(
      "UPDATE mgmt_organization_user SET role = 'admin' WHERE organization_id = ?",
    ).bind(organizationId).run();
    expect((await createApp(cookie, "admin-can-create")).status).toBe(201);
  });

  it("reports the caller's identity, organization and role to operator clients", async () => {
    const { cookie, organizationId } = await seedHuman("session-shape@example.test");

    const response = await exports.default.fetch(`${ORIGIN}/v1/admin/session`, {
      headers: sessionHeaders(cookie),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      session: {
        user: { email: string };
        organization: { id: string };
        role: string;
        memberships: unknown[];
        credentialType: string;
      };
    }>();
    expect(body.session.user.email).toBe("session-shape@example.test");
    expect(body.session.organization.id).toBe(organizationId);
    expect(body.session.role).toBe("owner");
    expect(body.session.memberships).toHaveLength(1);
    expect(body.session.credentialType).toBe("session");
  });

  it("lets a read-only member switch between the organizations they belong to", async () => {
    const { cookie, organizationId } = await seedHuman("switcher@example.test");
    const userId = await userIdFor("switcher@example.test");
    const secondOrganizationId = await seedOrganization("second-tenant", userId, "member");
    // Selection replaces the console's cached session, so its account metadata
    // must be identical to the regular session endpoint's response.
    const expiresAt = "2026-12-14T00:00:00.000Z";
    await env.DB.prepare("UPDATE mgmt_organization SET expires_at = ? WHERE id = ?")
      .bind(expiresAt, secondOrganizationId).run();

    const listed = await exports.default.fetch(`${ORIGIN}/v1/admin/organizations`, {
      headers: sessionHeaders(cookie),
    });
    expect(listed.status).toBe(200);
    const organizations = await listed.json<{ organizations: Array<{ organization: { id: string } }> }>();
    expect(organizations.organizations.map((entry) => entry.organization.id)).toEqual(
      expect.arrayContaining([organizationId, secondOrganizationId]),
    );

    // Demote the caller everywhere: switching must not require mutation rights.
    await env.DB.prepare("UPDATE mgmt_organization_user SET role = 'member' WHERE user_id = ?")
      .bind(userId).run();

    // Authorization is declared on the operation now, so a verb no operation
    // is mounted on is simply not a route. It used to be refused as an
    // unauthorized mutation by a path rule that ran before routing did.
    const wrongVerb = await exports.default.fetch(`${ORIGIN}/v1/admin/organizations/select`, {
      method: "PUT",
      headers: sessionHeaders(cookie, true),
      body: JSON.stringify({ organizationId: secondOrganizationId }),
    });
    expect(wrongVerb.status).toBe(404);
    await expect(wrongVerb.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "Route not found" },
    });

    const selected = await exports.default.fetch(`${ORIGIN}/v1/admin/organizations/select`, {
      method: "POST",
      headers: sessionHeaders(cookie, true),
      body: JSON.stringify({ organizationId: secondOrganizationId }),
    });
    expect(selected.status, await selected.clone().text()).toBe(200);
    await expect(selected.json()).resolves.toMatchObject({
      session: { organization: { id: secondOrganizationId, expiresAt }, role: "member" },
    });
    expect(selected.headers.get("set-cookie")).toContain("agw_identity_current_organization");

    const foreign = await exports.default.fetch(`${ORIGIN}/v1/admin/organizations/select`, {
      method: "POST",
      headers: sessionHeaders(cookie, true),
      body: JSON.stringify({ organizationId: "org-not-mine" }),
    });
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
  });

  it("keeps a session out of an organization whose deadline has passed", async () => {
    const { cookie, organizationId } = await seedHuman("deadline-seat@example.test");
    const userId = await userIdFor("deadline-seat@example.test");
    const expired = await seedOrganization("expired-tenant", userId);
    await env.DB.prepare("UPDATE mgmt_organization SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), expired)
      .run();

    // The library refuses it, so the console never gets a session pointed there.
    const selected = await exports.default.fetch(`${ORIGIN}/v1/admin/organizations/select`, {
      method: "POST",
      headers: sessionHeaders(cookie, true),
      body: JSON.stringify({ organizationId: expired }),
    });
    expect(selected.status).toBe(403);
    await expect(selected.json()).resolves.toMatchObject({
      error: { code: "account_expired" },
    });

    // Naming it in the cookie is no way in either: the live organization wins.
    const session = await exports.default.fetch(`${ORIGIN}/v1/admin/session`, {
      headers: {
        ...sessionHeaders(cookie),
        cookie: `${cookie}; agw_identity_current_organization=${expired}`,
      },
    });
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      session: { organization: { id: organizationId } },
    });
    // Still listed, so the console can say which organization is unavailable.
    const listed = await exports.default.fetch(`${ORIGIN}/v1/admin/organizations`, {
      headers: sessionHeaders(cookie),
    });
    const organizations = await listed.json<{
      organizations: Array<{ organization: { id: string } }>;
    }>();
    expect(organizations.organizations.map((entry) => entry.organization.id)).toContain(expired);
  });

  it("keeps management-key callers out of organization switching", async () => {
    const { cookie, organizationId } = await seedHuman("machine-seat@example.test");
    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/keys`, {
      method: "POST",
      headers: sessionHeaders(cookie, true),
      body: JSON.stringify({ name: "Automation" }),
    });
    const { key } = await created.json<{ key: { plaintext: string } }>();

    for (const request of [
      new Request(`${ORIGIN}/v1/admin/organizations`, {
        headers: { authorization: `Bearer ${key.plaintext}` },
      }),
      new Request(`${ORIGIN}/v1/admin/organizations/select`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.plaintext}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ organizationId }),
      }),
    ]) {
      const response = await exports.default.fetch(request);
      expect(response.status, request.url).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "session_required" },
      });
    }
  });

  it("keeps applications and every nested admin surface invisible across organizations", async () => {
    const first = await seedHuman("isolation-one@example.test");
    const second = await seedHuman("isolation-two@example.test");
    const firstApp = await createdAppId(await createApp(first.cookie, "org one app"));
    const secondApp = await createdAppId(await createApp(second.cookie, "org two app"));

    const firstList = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: sessionHeaders(first.cookie),
    });
    const firstBody = await firstList.json<{ apps: Array<{ id: string }> }>();
    expect(firstBody.apps.map((app) => app.id)).toContain(firstApp);
    expect(firstBody.apps.map((app) => app.id)).not.toContain(secondApp);

    for (const path of [
      `/v1/admin/apps/${secondApp}`,
      `/v1/admin/apps/${secondApp}/keys`,
      `/v1/admin/apps/${secondApp}/users`,
      `/v1/admin/apps/${secondApp}/usage/timeseries`,
      `/v1/admin/apps/${secondApp}/events`,
    ]) {
      const response = await exports.default.fetch(`${ORIGIN}${path}`, {
        headers: sessionHeaders(first.cookie),
      });
      expect(response.status, path).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "app_not_found" },
      });
    }
  });
});

describe("password changes", () => {
  it("forces JSON false to revoke other sessions and preserves them after a wrong password", async () => {
    const email = `password-json-${crypto.randomUUID()}@example.test`;
    const first = await signup(email);
    const secondResponse = await passwordSignIn(email, "correct-horse-42");
    expect(secondResponse.status, await secondResponse.clone().text()).toBe(200);
    const secondCookie = cookieFrom(secondResponse);

    const wrong = await worker.request(`${ORIGIN}/v1/auth/change-password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: first.cookie,
      },
      body: JSON.stringify({
        currentPassword: "wrong-password",
        newPassword: "new-correct-horse-43",
        revokeOtherSessions: false,
      }),
    }, env);
    expect(wrong.status).toBe(400);
    await expect(sessionFor(first.cookie)).resolves.not.toBeNull();
    await expect(sessionFor(secondCookie)).resolves.not.toBeNull();

    const changed = await worker.request(`${ORIGIN}/v1/auth/change-password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: first.cookie,
      },
      body: JSON.stringify({
        currentPassword: "correct-horse-42",
        newPassword: "new-correct-horse-43",
        revokeOtherSessions: false,
      }),
    }, env);
    expect(changed.status, await changed.clone().text()).toBe(200);
    const rotatedCookie = cookieFrom(changed);
    await expect(sessionFor(first.cookie)).resolves.toBeNull();
    await expect(sessionFor(secondCookie)).resolves.toBeNull();
    await expect(sessionFor(rotatedCookie)).resolves.not.toBeNull();
    expect((await passwordSignIn(email, "correct-horse-42")).status).not.toBe(200);
    expect((await passwordSignIn(email, "new-correct-horse-43")).status).toBe(200);
  });

  it("rejects forms and forces an omitted flag for JSON and direct auth.api calls", async () => {
    const email = `password-omitted-${crypto.randomUUID()}@example.test`;
    const first = await signup(email);
    const secondResponse = await passwordSignIn(email, "correct-horse-42");
    expect(secondResponse.status, await secondResponse.clone().text()).toBe(200);
    const secondCookie = cookieFrom(secondResponse);

    const formRejected = await worker.request(`${ORIGIN}/v1/auth/change-password`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        cookie: first.cookie,
      },
      body: new URLSearchParams({
        currentPassword: "correct-horse-42",
        newPassword: "form-changed-password-43",
      }).toString(),
    }, env);
    expect(formRejected.status).toBe(415);
    await expect(sessionFor(first.cookie)).resolves.not.toBeNull();
    await expect(sessionFor(secondCookie)).resolves.not.toBeNull();
    const unchangedPasswordResponse = await passwordSignIn(email, "correct-horse-42");
    expect(
      unchangedPasswordResponse.status,
      await unchangedPasswordResponse.clone().text(),
    ).toBe(200);
    const unchangedPasswordCookie = cookieFrom(unchangedPasswordResponse);
    expect((await passwordSignIn(email, "form-changed-password-43")).status).not.toBe(200);

    const jsonChanged = await worker.request(`${ORIGIN}/v1/auth/change-password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: first.cookie,
      },
      body: JSON.stringify({
        currentPassword: "correct-horse-42",
        newPassword: "json-changed-password-44",
      }),
    }, env);
    expect(jsonChanged.status, await jsonChanged.clone().text()).toBe(200);
    const jsonRotatedCookie = cookieFrom(jsonChanged);
    await expect(sessionFor(first.cookie)).resolves.toBeNull();
    await expect(sessionFor(secondCookie)).resolves.toBeNull();
    await expect(sessionFor(unchangedPasswordCookie)).resolves.toBeNull();
    await expect(sessionFor(jsonRotatedCookie)).resolves.not.toBeNull();

    const otherResponse = await passwordSignIn(email, "json-changed-password-44");
    expect(otherResponse.status, await otherResponse.clone().text()).toBe(200);
    const otherCookie = cookieFrom(otherResponse);
    const direct = await (await createIdentityAuth(resolveDeployment(env), env, ORIGIN)).auth.api.changePassword({
      body: {
        currentPassword: "json-changed-password-44",
        newPassword: "direct-changed-password-45",
      },
      headers: new Headers({ cookie: jsonRotatedCookie }),
      asResponse: true,
    });
    expect(direct.status, await direct.clone().text()).toBe(200);
    const directRotatedCookie = cookieFrom(direct);
    await expect(sessionFor(jsonRotatedCookie)).resolves.toBeNull();
    await expect(sessionFor(otherCookie)).resolves.toBeNull();
    await expect(sessionFor(directRotatedCookie)).resolves.not.toBeNull();
  });
});

/**
 * One password sign-in attempt, from a named address.
 *
 * The password is deliberately left out of the body. Better Auth refuses an
 * incomplete body before it reaches the handler that would hash one, and a hash
 * here is about two and a half seconds of pure-JS scrypt — eleven of them would
 * cost more than the rest of this suite. The gateway's limit runs before Better
 * Auth either way, so the attempt is counted all the same, and the `400` is the
 * proof that the limit was not what refused it.
 */
async function signInAttempt(email: string, address: string): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}/v1/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "cf-connecting-ip": address,
    },
    body: JSON.stringify({ email }),
  });
}

async function expectRateLimited(
  response: Response,
  scope: string,
  retryAfter: string,
): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(429);
  expect(response.headers.get("retry-after")).toBe(retryAfter);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: "rate_limited", data: { scope } },
  });
}

// Ten seconds into a ten-minute boundary, a day out. Both sign-in windows are
// aligned to the clock rather than to the first attempt, so an unanchored test
// that straddled one would see its counter reset and the refusal it asserts on
// never arrive. A boundary both windows share also fixes both waits: fifty
// seconds of the minute, and five hundred and ninety of the ten minutes.
const SIGN_IN_WINDOW_ANCHOR = Math.floor((Date.now() + 86_400_000) / 600_000) * 600_000 + 10_000;

/**
 * Freezes the clock for one test, without faking the timers a request runs on.
 *
 * Only `Date` is replaced: `workerd` schedules the request itself, and the
 * Durable Object alarm behind these counters, on real timers.
 */
function anchorSignInWindows(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SIGN_IN_WINDOW_ANCHOR);
}

describe("password sign-in throttling", () => {
  afterEach(() => vi.useRealTimers());

  it("refuses a flood from one address and leaves every other address alone", async () => {
    anchorSignInWindows();
    const address = crypto.randomUUID();
    for (let spent = 0; spent < ENDPOINT_RATE_LIMITS.sign_in_address.limit; spent++) {
      const allowed = await signInAttempt(`flood-${spent}@example.test`, address);
      expect(allowed.status, `attempt ${spent}`).toBe(400);
    }

    await expectRateLimited(
      await signInAttempt("flood-again@example.test", address),
      "sign_in_address",
      "50",
    );

    const elsewhere = await signInAttempt("flood-0@example.test", crypto.randomUUID());
    expect(elsewhere.status).toBe(400);
  });

  it("refuses guesses at one account however many addresses they come from", async () => {
    anchorSignInWindows();
    const email = `grind-${crypto.randomUUID()}@example.test`;
    for (let spent = 0; spent < ENDPOINT_RATE_LIMITS.sign_in_email.limit; spent++) {
      const allowed = await signInAttempt(email, crypto.randomUUID());
      expect(allowed.status, `attempt ${spent}`).toBe(400);
    }

    // Spelled differently on purpose: one account is one counter whatever case
    // and padding the attempt arrives with.
    await expectRateLimited(
      await signInAttempt(`  ${email.toUpperCase()}  `, crypto.randomUUID()),
      "sign_in_email",
      "590",
    );

    const other = await signInAttempt(
      `other-${crypto.randomUUID()}@example.test`,
      crypto.randomUUID(),
    );
    expect(other.status).toBe(400);
  });

  it("counts a form-encoded attempt against the same account as a JSON one", async () => {
    anchorSignInWindows();
    const email = `form-${crypto.randomUUID()}@example.test`;
    for (let spent = 0; spent < ENDPOINT_RATE_LIMITS.sign_in_email.limit - 1; spent++) {
      const allowed = await signInAttempt(email, crypto.randomUUID());
      expect(allowed.status, `attempt ${spent}`).toBe(400);
    }

    // Better Auth takes these credentials form-encoded as readily as it takes
    // them as JSON, so an email counter that only read JSON would be bypassed
    // by changing one header.
    const encoded = await exports.default.fetch(`${ORIGIN}/v1/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        "cf-connecting-ip": crypto.randomUUID(),
      },
      body: new URLSearchParams({ email }).toString(),
    });
    expect(encoded.status).not.toBe(429);

    await expectRateLimited(
      await signInAttempt(email, crypto.randomUUID()),
      "sign_in_email",
      "590",
    );
  });

  it("counts an unreadable body against the address it came from", async () => {
    anchorSignInWindows();
    const address = crypto.randomUUID();
    for (let spent = 0; spent < ENDPOINT_RATE_LIMITS.sign_in_address.limit; spent++) {
      const response = await exports.default.fetch(`${ORIGIN}/v1/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "cf-connecting-ip": address,
        },
        body: "not json at all",
      });
      expect(response.status, `attempt ${spent}`).not.toBe(429);
    }

    await expectRateLimited(
      await signInAttempt("readable@example.test", address),
      "sign_in_address",
      "50",
    );
  });
});
