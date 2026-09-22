import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";

/**
 * Two things that used to be a wrapper app's job.
 *
 * The identity library is deferred per function now (`cfAuth()` in
 * `src/auth/identity`), so the application token exchange no longer needs an
 * app of its own behind an `import()` and is mounted straight onto the entry
 * app — where its failures meet the one `onError` directly rather than through
 * a rethrow. And because nothing may import the library to recognise its
 * errors, `isCfAuthError` identifies them by shape; a cf-auth rejection that
 * stopped being recognised would answer `internal_error` instead of the code
 * below. Neither has a test anywhere else.
 */

/** Silences the structured lines these rejections emit, and keeps them. */
function captureLogs(): { warn: unknown[]; error: unknown[] } {
  const captured = { warn: [] as unknown[], error: [] as unknown[] };
  vi.spyOn(console, "warn").mockImplementation((value) => captured.warn.push(value));
  vi.spyOn(console, "error").mockImplementation((value) => captured.error.push(value));
  return captured;
}

function request(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://example.test${path}`, init), env, createExecutionContext());
}

afterEach(() => vi.restoreAllMocks());

describe("entry app routing", () => {
  it("formats an application token exchange rejection itself", async () => {
    captureLogs();

    const response = await request("/v1/apps/never-registered-routing/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "nope" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "app_not_found", message: "App is not registered" },
    });
    // Only a proxied or endpoint request carries timings. The header appearing
    // here would mean something other than this app's `onError` answered.
    expect(response.headers.get("server-timing")).toBeNull();
  });

  it("maps a cf-auth rejection onto the gateway's own code", async () => {
    captureLogs();

    // cf-auth refuses an unauthenticated caller with its own error type, which
    // is recognised by shape and mapped onto a gateway code.
    const response = await request("/v1/admin/apps");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
  });
});
