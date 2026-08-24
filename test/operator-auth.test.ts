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
  const user = await env.DB.prepare("SELECT id FROM operator_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  const membership = await env.DB.prepare(
    "SELECT organization_id FROM operator_organization_user WHERE user_id = ?",
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
      "UPDATE operator_organization_user SET role = 'member' WHERE organization_id = ?",
    ).bind(organizationId).run();

    const read = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: sessionHeaders(cookie),
    });
    expect(read.status).toBe(200);

    const write = await createApp(cookie, "member-cannot-create");
    expect(write.status).toBe(403);
    await expect(write.json()).resolves.toMatchObject({ error: { code: "forbidden" } });

    await env.DB.prepare(
      "UPDATE operator_organization_user SET role = 'admin' WHERE organization_id = ?",
    ).bind(organizationId).run();
    expect((await createApp(cookie, "admin-can-create")).status).toBe(201);
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
      "/v1/admin/apps/org-two-app/development-credential",
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
