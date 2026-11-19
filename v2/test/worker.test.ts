import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("the v2 Worker", () => {
  it("answers the health check", async () => {
    const response = await exports.default.fetch("https://gateway.test/v2/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "app-ai-gateway", api: "v2" });
  });

  it.each(["/v2", "/v2/", "/v2/apps/a/nothing", "/v1/healthz", "/"])(
    "answers %s with a JSON 404",
    async (path) => {
      const response = await exports.default.fetch(`https://gateway.test${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    },
  );

  // A browser loading one of the console's pages, which have no file of their
  // own: the Worker hands it to the console's static files, which route it.
  // The test runs without a console build, so the files answer 404, but not
  // with the API's JSON.
  it.each(["/v2/access", "/v2/oauth/consent?id=x", "/v2/device?user_code=ABCD-EFGH", "/v2/settings/password", "/v2/login/", "/v2/settings/password/", "/v2/apps", "/v2/apps/my-app/limits", "/v2/providers", "/v2/prices"])(
    "hands a browser's %s to the console",
    async (path) => {
      const response = await exports.default.fetch(`https://gateway.test${path}`, {
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      expect(response.headers.get("content-type") ?? "").not.toContain("application/json");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    },
  );

  // Only the console's own pages: an API path called the wrong way, or a
  // missing file, stays the API's JSON 404 even for a browser.
  it.each([
    "/v2/apps/a/auth/challenge",
    "/v2/assets/missing.js",
    "/v2/nothing-here",
    "/v2/login/missing.js",
    "/v2/login/extra",
    "/v2/settings/account/extra",
    "/v2/settings/v1.2",
    "/v2/login//",
    "/v2/apps/my-app/limits/extra",
  ])(
    "answers a browser's %s with the API's JSON 404",
    async (path) => {
      const response = await exports.default.fetch(`https://gateway.test${path}`, {
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    },
  );

  it("still answers a script calling a page's path with the API's JSON 404", async () => {
    const response = await exports.default.fetch("https://gateway.test/v2/oauth/consent", {
      headers: { accept: "application/json" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("keeps the OAuth endpoints with the Worker, beside the consent page", async () => {
    const response = await exports.default.fetch("https://gateway.test/v2/oauth/token", {
      method: "POST",
      headers: { accept: "text/html" },
    });
    // Not the console's host, so the OAuth server answers its own JSON 404.
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
