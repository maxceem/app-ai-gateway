import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { devToken, seedApp } from "./helpers";

const ORIGIN = "https://example.test";

async function login(): Promise<string> {
  const response = await exports.default.fetch(`${ORIGIN}/v1/console/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test-admin-secret" }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toContain("gw_console=");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Max-Age=604800");
  return cookie!.split(";")[0]!;
}

describe("console session", () => {
  it("rejects a wrong admin token without issuing a cookie", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/v1/console/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-the-admin-secret" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("authenticates admin requests with the session cookie", async () => {
    const cookie = await login();
    const response = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: { cookie, "x-console-request": "1" },
    });
    expect(response.status).toBe(200);
  });

  it("refuses a cookie sent without the console request header", async () => {
    const cookie = await login();
    const response = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, { headers: { cookie } });
    expect(response.status).toBe(401);
  });

  it("refuses a gateway access token as a console session", async () => {
    await seedApp("console-token-confusion");
    // Same signing secret, different audience: a leaked user token must not
    // become an admin session.
    const token = await devToken("console-token-confusion");
    const response = await exports.default.fetch(`${ORIGIN}/v1/admin/apps`, {
      headers: { cookie: `gw_console=${token}`, "x-console-request": "1" },
    });
    expect(response.status).toBe(401);
  });

  it("reports and clears the session", async () => {
    const cookie = await login();
    const status = await exports.default.fetch(`${ORIGIN}/v1/console/session`, { headers: { cookie } });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ authenticated: true, environment: "local" });

    const cleared = await exports.default.fetch(`${ORIGIN}/v1/console/session`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
