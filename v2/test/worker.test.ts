import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("the v2 Worker", () => {
  it("answers the health check", async () => {
    const response = await exports.default.fetch("https://gateway.test/v2/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "app-ai-gateway", api: "v2", vault: "ok", email: "off" });
  });

  it("reports a key vault that is not set up as misconfigured, and still answers", async () => {
    const { default: worker } = await import("../src/index.ts");
    const broken = { ...env, SECRET_VAULT_MODE: "neither" } as unknown as Env;
    const response = await worker.fetch(new Request("https://gateway.test/v2/healthz"), broken, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, vault: "misconfigured" });
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
  it.each(["/v2/access", "/v2/oauth/consent?id=x", "/v2/device?user_code=ABCD-EFGH", "/v2/settings/password", "/v2/login/", "/v2/settings/password/", "/v2/apps", "/v2/apps/my-app/limits", "/v2/providers", "/v2/prices", "/v2/approve/5ee48248-54f1", "/v2/reveal/5ee48248-54f1", "/v2/verify-email"])(
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

describe("the gateway's release and price list (v1's CLI capabilities)", () => {
  async function capabilities(): Promise<Record<string, unknown>> {
    const response = await exports.default.fetch(new Request("https://gateway.test/v2/console/capabilities"));
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it("reports its release, the one the CLI is released with", async () => {
    const gateway = (await import("../package.json")).version;
    const cli = (await import("../cli/package.json")).version;
    expect(cli).toBe(gateway);
    expect((await capabilities()).serverVersion).toBe(gateway);
  });

  it("names its price list by a revision that follows the prices, with no day until the deploy script records one", async () => {
    const { prices } = (await capabilities()) as { prices: { revision: string; updated: string | null } };
    expect(prices.revision).toMatch(/^[0-9a-f]{12}$/u);
    expect(prices.updated).toBeNull();
    // The merged list the Worker bills with: main's copy and v2's own entries.
    const { PRICE_FILE } = await import("../src/pricing/price-file.ts");
    expect(Object.keys((await import("../src/pricing/models.v2.json")).default).every((provider) => Object.hasOwn(PRICE_FILE, provider))).toBe(true);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(PRICE_FILE))));
    expect(prices.revision).toBe([...digest.slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  });
});
