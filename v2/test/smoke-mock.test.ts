/**
 * Offline checks of the smoke checks' mock provider (`smoke/mock/`): the two
 * things the smoke checks lean on to judge the gateway, a test issuer's JWKS
 * and the mark of a client credential that reached the provider.
 */
import { describe, expect, it } from "vitest";
import mock, { clientCredentialHeaders, jwksFromPath } from "../smoke/mock/index.ts";

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
});
