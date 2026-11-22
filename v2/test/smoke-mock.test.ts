/**
 * Offline checks of the smoke checks' mock provider (`smoke/mock/`): the
 * things the smoke checks lean on to judge the gateway, a test issuer's JWKS,
 * the mark of the provider key that came in, and the mark of a client
 * credential that reached the provider.
 */
import { describe, expect, it } from "vitest";
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

  it("marks a client credential that was percent-encoded in the path or the query", () => {
    expect(clientCredentialPlaces(new Request("https://mock.test/v1/models?t=%61gw_app_0123456789"), null)).toEqual(["url"]);
    expect(clientCredentialPlaces(new Request("https://mock.test/v1/%61gw_app_0123456789/models"), null)).toEqual(["url"]);
    expect(clientCredentialPlaces(new Request("https://mock.test/v1/models?%61gw_app_0123456789=1"), null)).toEqual(["url"]);
    // A path part that does not decode is looked at as it came.
    expect(clientCredentialPlaces(new Request("https://mock.test/v1/%E0%A4%A/models"), null)).toEqual([]);
  });

  it("marks each provider key header with a fixed label for a fixture key, and `unexpected` for anything else", async () => {
    expect(keyMarks(new Headers({ authorization: "Bearer sk-mock-smoke-openai" }))).toBe("authorization:bearer fixture-openai");
    expect(keyMarks(new Headers({ authorization: "Token sk-mock-smoke-openai" }))).toBe("authorization:token fixture-openai");
    expect(keyMarks(new Headers({ "x-api-key": "sk-mock-smoke-anthropic" }))).toBe("x-api-key:fixture-anthropic");
    // A fixture key with a scheme where none belongs, an unknown key, or one only the prototype knows.
    expect(keyMarks(new Headers({ "x-goog-api-key": "Bearer sk-mock-smoke-gemini" }))).toBe("x-goog-api-key:unexpected");
    expect(keyMarks(new Headers({ authorization: "Bearer sk-live-0123456789" }))).toBe("authorization:unexpected");
    expect(keyMarks(new Headers({ authorization: "sk-mock-smoke-key" }))).toBe("authorization:unexpected");
    expect(keyMarks(new Headers({ "x-api-key": "constructor" }))).toBe("x-api-key:unexpected");
    expect(keyMarks(new Headers({ authorization: "Bearer a", "x-api-key": "b" }))).toBe("authorization:unexpected,x-api-key:unexpected");
    expect(keyMarks(new Headers())).toBe("missing");
    // What a smoke check compares with.
    expect(keyMark("authorization", "fixture-openai")).toBe("authorization:bearer fixture-openai");
    expect(keyMark("x-api-key", "fixture-anthropic")).toBe("x-api-key:fixture-anthropic");

    const answered = await mock.fetch(
      new Request("https://mock.test/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "sk-mock-smoke-anthropic", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(answered.status).toBe(200);
    expect(answered.headers.get("x-mock-key")).toBe("x-api-key:fixture-anthropic");
    expect(JSON.stringify([...answered.headers])).not.toContain("sk-mock-smoke-anthropic");
  });

  it("says flex reached it, and echoes no other service mode", async () => {
    const tier = async (value: unknown) =>
      (
        await mock.fetch(
          new Request("https://mock.test/v1/chat/completions", {
            method: "POST",
            headers: { authorization: "Bearer sk-mock-smoke-key", "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-4o-mini", service_tier: value, messages: [{ role: "user", content: "Hi" }] }),
          }),
        )
      ).headers.get("x-mock-service-tier");
    expect(await tier("flex")).toBe("flex");
    expect(await tier("priority")).toBeNull();
    expect(await tier("sk-live-0123456789")).toBeNull();
    expect(await tier("flex\nx-evil: 1")).toBeNull();
  });
});
