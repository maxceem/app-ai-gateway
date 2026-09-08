import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { publicApiHost, publicApiOrigin } from "../src/core/public-api-url";
import worker from "../src/index";

const CONSOLE_ORIGIN = "https://console.example.test";
const API_ORIGIN = "https://api.example.test";

const NOT_FOUND = { error: { code: "invalid_request", message: "Route not found" } };

function withPublicApiUrl(value: string | undefined): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "PUBLIC_API_URL") return value;
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

async function request(url: string, publicApiUrl?: string, init?: RequestInit): Promise<Response> {
  const executionCtx = createExecutionContext();
  const response = await worker.fetch(new Request(url, init), withPublicApiUrl(publicApiUrl), executionCtx);
  await waitOnExecutionContext(executionCtx);
  return response;
}

describe("PUBLIC_API_URL", () => {
  it("is absent from the capabilities response until a deployment sets it", async () => {
    const response = await request(`${CONSOLE_ORIGIN}/v1/console/capabilities`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.hasOwn(body, "apiBaseUrl")).toBe(false);
  });

  it("advertises the configured origin, normalized to no trailing slash", async () => {
    const response = await request(`${CONSOLE_ORIGIN}/v1/console/capabilities`, `${API_ORIGIN}/`);
    await expect(response.json()).resolves.toMatchObject({ apiBaseUrl: API_ORIGIN });
  });

  it("names itself when a deployment configures something that is not an origin", () => {
    // A misconfiguration here would otherwise print a base URL no client can
    // call, so each rule fails loudly with the variable's own name.
    for (const value of [
      "http://api.example.test",
      "https://api.example.test/v1",
      "https://user:pass@api.example.test",
      "https://api.example.test/?a=1",
      "api.example.test",
    ]) {
      expect(() => publicApiOrigin(withPublicApiUrl(value)), value).toThrow(/PUBLIC_API_URL/u);
    }
  });

  it("allows plain http on loopback so the second host can be tried locally", () => {
    expect(publicApiOrigin(withPublicApiUrl("http://localhost:8787"))).toBe("http://localhost:8787");
    expect(publicApiHost(withPublicApiUrl("http://127.0.0.1:8787"))).toBe("127.0.0.1:8787");
  });
});

/**
 * The API host publishes application routes only. Operator authentication is
 * gone there, so no session cookie exists for that host in the first place.
 */
describe("the application client host", () => {
  it("hides the operator surface", async () => {
    for (const path of ["/v1/console/capabilities", "/v1/auth/sign-in/email"]) {
      const response = await request(`${API_ORIGIN}${path}`, API_ORIGIN, {
        method: path.startsWith("/v1/auth") ? "POST" : "GET",
        ...(path.startsWith("/v1/auth")
          ? {
              headers: { "content-type": "application/json", origin: API_ORIGIN },
              body: JSON.stringify({ email: "ada@example.test", password: "correct-horse-42" }),
            }
          : {}),
      });
      expect([path, response.status]).toEqual([path, 404]);
      await expect(response.json()).resolves.toEqual(NOT_FOUND);
    }
  });

  it("still answers the health check", async () => {
    const response = await request(`${API_ORIGIN}/v1/healthz`, API_ORIGIN);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("leaves the console host serving everything it served before", async () => {
    const response = await request(`${CONSOLE_ORIGIN}/v1/console/capabilities`, API_ORIGIN);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ apiBaseUrl: API_ORIGIN });
  });

  it("is an ordinary host while the variable is unset", async () => {
    const response = await request(`${API_ORIGIN}/v1/console/capabilities`);
    expect(response.status).toBe(200);
  });
});
