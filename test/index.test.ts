import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedApp } from "./helpers";

describe("AI Gateway", () => {
  it("serves the health check", async () => {
    const response = await exports.default.fetch("https://example.test/v1/healthz");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "ai-gateway" });
  });

  it("keeps App Attest routes available when development access is disabled per app", async () => {
    const appId = "attest-only-auth";
    await seedApp(appId, {
      auth: {
        jwks_url: "https://issuer.test/.well-known/jwks.json",
        appattest_environments: ["production"],
      },
    });

    const devResponse = await exports.default.fetch(
      `https://example.test/v1/apps/${appId}/auth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issuer_token: "token", dev_secret: "not-configured" }),
      },
    );
    expect(devResponse.status).toBe(403);
    await expect(devResponse.json()).resolves.toMatchObject({
      error: { code: "auth_required", message: "Development access is not enabled for this app" },
    });

    const registerResponse = await exports.default.fetch(
      `https://example.test/v1/apps/${appId}/auth/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(registerResponse.status).toBe(400);
    await expect(registerResponse.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "issuer_token is required" },
    });
  });
});
