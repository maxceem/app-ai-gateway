import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { serverConfig } from "./helpers";

const ORIGIN = "https://example.test";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  expect(value).toContain("HttpOnly");
  return value!.split(";")[0]!;
}

async function signup(email: string): Promise<{ cookie: string; organizationId: string }> {
  const response = await exports.default.fetch(`${ORIGIN}/v1/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ name: email.split("@")[0], email, password: "correct-horse-42" }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const user = await env.DB.prepare("SELECT id FROM console_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  const membership = await env.DB.prepare(
    "SELECT organization_id FROM console_organization_user WHERE user_id = ?",
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
  const row = await env.DB.prepare("SELECT id FROM console_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  return row!.id;
}

/** Adds a second organization directly; cf-auth exposes creation only in-process. */
async function seedOrganization(name: string, userId: string, role = "owner"): Promise<string> {
  const now = new Date().toISOString();
  const organizationId = `org-${name}`;
  await env.DB.prepare(
    "INSERT INTO console_organization (id, name, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(organizationId, name, userId, now, now).run();
  await env.DB.prepare(
    "INSERT INTO console_organization_user (id, organization_id, user_id, role, status, joined_at) VALUES (?, ?, ?, ?, 'active', ?)",
  ).bind(`membership-${name}`, organizationId, userId, role, now).run();
  return organizationId;
}

async function createApp(cookie: string, id: string) {
  return exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
    method: "POST",
    headers: sessionHeaders(cookie, true),
    body: JSON.stringify({ id, name: id, config: serverConfig() }),
  });
}

describe("operator authentication", () => {
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
    const body = await created.json<{ key: { id: string; plaintext: string } }>();
    expect(body.key.plaintext).toMatch(/^agw_mgmt_/u);

    const keyAccess = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: { authorization: `Bearer ${body.key.plaintext}` },
    });
    expect(keyAccess.status).toBe(200);

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

    const listed = await exports.default.fetch(`${ORIGIN}/v1/admin/keys`, {
      headers: sessionHeaders(cookie),
    });
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listedText).not.toContain(body.key.plaintext);

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
        if (property === "ALLOW_PUBLIC_REGISTRATION") return "false";
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
    const { cookie, organizationId } = await signup("member@example.test");
    await env.DB.prepare(
      "UPDATE console_organization_user SET role = 'member' WHERE organization_id = ?",
    ).bind(organizationId).run();

    const read = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: sessionHeaders(cookie),
    });
    expect(read.status).toBe(200);

    const write = await createApp(cookie, "member-cannot-create");
    expect(write.status).toBe(403);
    await expect(write.json()).resolves.toMatchObject({ error: { code: "forbidden" } });

    await env.DB.prepare(
      "UPDATE console_organization_user SET role = 'admin' WHERE organization_id = ?",
    ).bind(organizationId).run();
    expect((await createApp(cookie, "admin-can-create")).status).toBe(201);
  });

  it("reports the caller's identity, organization and role to operator clients", async () => {
    const { cookie, organizationId } = await signup("session-shape@example.test");

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
    const { cookie, organizationId } = await signup("switcher@example.test");
    const userId = await userIdFor("switcher@example.test");
    const secondOrganizationId = await seedOrganization("second-tenant", userId, "member");

    const listed = await exports.default.fetch(`${ORIGIN}/v1/admin/organizations`, {
      headers: sessionHeaders(cookie),
    });
    expect(listed.status).toBe(200);
    const organizations = await listed.json<{ organizations: Array<{ organization: { id: string } }> }>();
    expect(organizations.organizations.map((entry) => entry.organization.id)).toEqual(
      expect.arrayContaining([organizationId, secondOrganizationId]),
    );

    // Demote the caller everywhere: switching must not require mutation rights.
    await env.DB.prepare("UPDATE console_organization_user SET role = 'member' WHERE user_id = ?")
      .bind(userId).run();

    const wrongVerb = await exports.default.fetch(`${ORIGIN}/v1/admin/organizations/select`, {
      method: "PUT",
      headers: sessionHeaders(cookie, true),
      body: JSON.stringify({ organizationId: secondOrganizationId }),
    });
    expect(wrongVerb.status).toBe(403);
    await expect(wrongVerb.json()).resolves.toMatchObject({ error: { code: "forbidden" } });

    const selected = await exports.default.fetch(`${ORIGIN}/v1/admin/organizations/select`, {
      method: "POST",
      headers: sessionHeaders(cookie, true),
      body: JSON.stringify({ organizationId: secondOrganizationId }),
    });
    expect(selected.status, await selected.clone().text()).toBe(200);
    await expect(selected.json()).resolves.toMatchObject({
      session: { organization: { id: secondOrganizationId }, role: "member" },
    });
    expect(selected.headers.get("set-cookie")).toContain("agw_operator_current_organization");

    const foreign = await exports.default.fetch(`${ORIGIN}/v1/admin/organizations/select`, {
      method: "POST",
      headers: sessionHeaders(cookie, true),
      body: JSON.stringify({ organizationId: "org-not-mine" }),
    });
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
  });

  it("keeps management-key callers out of organization switching", async () => {
    const { cookie, organizationId } = await signup("machine-seat@example.test");
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
    const first = await signup("isolation-one@example.test");
    const second = await signup("isolation-two@example.test");
    expect((await createApp(first.cookie, "org-one-app")).status).toBe(201);
    expect((await createApp(second.cookie, "org-two-app")).status).toBe(201);

    const firstList = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: sessionHeaders(first.cookie),
    });
    const firstBody = await firstList.json<{ apps: Array<{ id: string }> }>();
    expect(firstBody.apps.map((app) => app.id)).toContain("org-one-app");
    expect(firstBody.apps.map((app) => app.id)).not.toContain("org-two-app");

    for (const path of [
      "/v1/admin/apps/org-two-app",
      "/v1/admin/apps/org-two-app/keys",
      "/v1/admin/apps/org-two-app/users",
      "/v1/admin/apps/org-two-app/usage/timeseries",
      "/v1/admin/apps/org-two-app/events",
    ]) {
      const response = await exports.default.fetch(`${ORIGIN}${path}`, {
        headers: sessionHeaders(first.cookie),
      });
      expect(response.status, path).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "app_not_found" },
      });
    }
  }, 10_000);
});
