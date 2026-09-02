import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiKeyCache } from "../src/core/apikeys";
import { clearAppConfigCache } from "../src/core/config";
import { clearJwksCache } from "../src/core/issuer";
import app from "../src/index";
import { seedServerApp } from "./helpers";

interface Line {
  level: string;
  message: string;
  [field: string]: unknown;
}

/**
 * Captures the structured lines the Worker emits, by level.
 *
 * `log` writes one JSON document per call, so a test can assert on the fields
 * an operator would actually search on rather than on a formatted string.
 */
function captureLogs(): { warn: Line[]; error: Line[] } {
  const captured = { warn: [] as Line[], error: [] as Line[] };
  const collect = (bucket: Line[]) => (value: unknown) => {
    if (typeof value !== "string") return;
    try {
      bucket.push(JSON.parse(value) as Line);
    } catch {
      // Not one of ours.
    }
  };
  vi.spyOn(console, "warn").mockImplementation(collect(captured.warn));
  vi.spyOn(console, "error").mockImplementation(collect(captured.error));
  return captured;
}

async function post(path: string, body: string, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
    env,
    createExecutionContext(),
  );
}

async function signingFixture(kid: string): Promise<{ publicJwk: JWK; token: () => Promise<string> }> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  return {
    publicJwk,
    token: () =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject("log-user")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(pair.privateKey),
  };
}

beforeEach(() => {
  clearApiKeyCache();
  clearJwksCache();
  clearAppConfigCache();
});

afterEach(() => vi.restoreAllMocks());

describe("gateway error logging", () => {
  it("logs every business rejection once, at a level matching its status", async () => {
    const logs = captureLogs();

    const response = await post(
      "/v1/apps/never-registered/auth/token",
      JSON.stringify({ issuer_token: "x", key_id: "k", assertion: "a", challenge: "c" }),
      { "x-app-version": "4.2.0" },
    );

    expect(response.status).toBe(404);
    const lines = logs.warn.filter((line) => line.message === "gateway_error");
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      level: "warn",
      code: "app_not_found",
      status: 404,
      path: "/v1/apps/never-registered/auth/token",
      method: "POST",
      app: "never-registered",
      appVersion: "4.2.0",
    });
    // Never the credential-bearing request itself.
    expect(JSON.stringify(lines[0])).not.toContain("issuer_token");
    expect(logs.error.filter((line) => line.message === "gateway_error").length).toBe(0);
  });

  it("logs a 5xx rejection at error, carrying the granular reason", async () => {
    const fixture = await signingFixture("log-jwks-down");
    const key = await seedServerApp("log-jwks-down", { issuer: {} });
    const logs = captureLogs();
    // Captured after the spies so the JWKS failure is the only fetch mocked.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const response = await post(
      "/v1/apps/log-jwks-down/auth/token",
      JSON.stringify({ api_key: key, issuer_token: await fixture.token() }),
    );

    expect(response.status).toBe(503);
    const line = logs.error.find((entry) => entry.message === "gateway_error");
    expect(line).toMatchObject({
      level: "error",
      code: "issuer_verification_unavailable",
      reason: "jwks_unreachable",
      status: 503,
      app: "log-jwks-down",
    });
    // Absent rather than null: the header was not sent.
    expect(line).not.toHaveProperty("appVersion");
  });

  it("keeps unexpected exceptions on their own code", async () => {
    await seedServerApp("log-unhandled", { issuer: {} });
    const logs = captureLogs();

    const response = await post("/v1/apps/log-unhandled/auth/token", "{ not json");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "internal_error" } });
    expect(logs.error.some((line) => line.message === "unhandled_error")).toBe(true);
    expect(logs.error.some((line) => line.message === "gateway_error")).toBe(false);
  });
});
