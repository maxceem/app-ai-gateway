/**
 * Offline checks of the smoke checks' mock provider (`smoke/mock/`): the
 * things the smoke checks lean on to judge the gateway, a test issuer's JWKS,
 * the mark of the provider key that came in, and the mark of a client
 * credential that reached the provider.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import mock, { clientCredentialHeaders, clientCredentialPlaces, jwksFromPath, keyMarks } from "../smoke/mock/index.ts";
import { keyMark } from "../smoke/support.ts";

const PUBLIC_KEY = { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0", kid: "smoke-1", alg: "ES256" };

function encoded(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe("the smoke mock", () => {
  it("answers the key a /jwks/ path names as a JWKS, public fields only, with no provider key", async () => {
    const response = await mock.fetch(new Request(`https://mock.test/jwks/${encoded({ ...PUBLIC_KEY, d: "secret-half" })}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [PUBLIC_KEY] });
    expect(jwksFromPath("/jwks/not-json")).toBeNull();
    expect(jwksFromPath(`/jwks/${encoded({ kid: "no-kty" })}`)).toBeNull();
  });

  it("marks the request headers that carried a client credential, or none", async () => {
    const clean = await mock.fetch(
      new Request("https://mock.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-mock-smoke-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(clean.status).toBe(200);
    expect(clean.headers.get("x-mock-client-credentials")).toBe("none");

    expect(
      clientCredentialHeaders(
        new Headers({
          authorization: "Bearer sk-mock-smoke-key",
          "x-app-key": "agw_app_0123456789",
          "x-forwarded-token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl",
        }),
      ),
    ).toEqual(["x-app-key", "x-forwarded-token"]);
  });

  it("marks a client credential in the URL or the body too, on a failed answer as on a served one", async () => {
    const failed = await mock.fetch(
      new Request("https://mock.test/v1/chat/completions?token=agw_app_0123456789", {
        method: "POST",
        headers: { authorization: "Bearer sk-mock-smoke-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", mock_status: 429, note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl" }),
      }),
    );
    expect(failed.status).toBe(429);
    expect(failed.headers.get("x-mock-client-credentials")).toBe("url,body");
    // The body was read for the check and still reached the answer whole.
    expect(await failed.json()).toEqual({ error: { message: "Mock error", type: "mock_error", code: "mock_error" } });
    expect(clientCredentialPlaces(new Request("https://mock.test/v1/models"), null)).toEqual([]);
  });

  it("marks each provider key header with a fingerprint of its key, never the key", async () => {
    const fingerprint = createHash("sha256").update("sk-mock-smoke-key").digest("hex").slice(0, 16);
    expect(await keyMarks(new Headers({ authorization: "Bearer sk-mock-smoke-key" }))).toBe(`authorization:${fingerprint}`);
    expect(await keyMarks(new Headers({ "x-api-key": "sk-mock-smoke-key" }))).toBe(`x-api-key:${fingerprint}`);
    expect(await keyMarks(new Headers({ "x-goog-api-key": "sk-mock-other" }))).not.toBe(`x-goog-api-key:${fingerprint}`);
    expect(await keyMarks(new Headers({ authorization: "Bearer a", "x-api-key": "b" }))).toMatch(/^authorization:[0-9a-f]{16},x-api-key:[0-9a-f]{16}$/u);
    expect(await keyMarks(new Headers())).toBe("missing");
    // What a smoke check compares with: the same fingerprint, worked out from its own test key.
    expect(keyMark("x-api-key", "sk-mock-smoke-key")).toBe(`x-api-key:${fingerprint}`);

    const answered = await mock.fetch(
      new Request("https://mock.test/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "sk-mock-smoke-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(answered.status).toBe(200);
    expect(answered.headers.get("x-mock-key")).toBe(`x-api-key:${fingerprint}`);
    expect(JSON.stringify([...answered.headers])).not.toContain("sk-mock-smoke-key");
  });

  it("says which service mode reached it", async () => {
    const answered = await mock.fetch(
      new Request("https://mock.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-mock-smoke-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", service_tier: "flex", messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(answered.headers.get("x-mock-service-tier")).toBe("flex");
  });
});
