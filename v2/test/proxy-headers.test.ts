/**
 * Which headers cross the gateway (`src/proxy/headers.ts`): toward the
 * provider only what official SDKs need, never a credential or the gateway's
 * own headers; toward the app the provider's headers, less what would be
 * wrong or private.
 *
 * Ported from v1's `proxy.test.ts` (`X-Client-SDK` never forwarded, the
 * custom token header, `Retry-After` passed on). Passthrough's declared
 * headers end to end are in `passthrough.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { clientResponseHeaders, mayCarryCredential, upstreamHeaders } from "../src/proxy/headers.ts";

function sent(headers: Record<string, string>, extra: readonly string[] = []): Record<string, string> {
  return Object.fromEntries(upstreamHeaders(new Headers(headers), extra));
}

describe("toward the provider", () => {
  it("sends what official SDKs need", () => {
    expect(
      sent({
        "content-type": "application/json",
        accept: "text/event-stream",
        "accept-language": "en",
        "user-agent": "OpenAI/Python 1.0",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "tools-2024",
        "openai-beta": "assistants=v2",
        "x-goog-api-client": "genai-js/1.0",
        "idempotency-key": "retry-1",
        "x-stainless-lang": "python",
        "x-stainless-retry-count": "0",
      }),
    ).toEqual({
      "content-type": "application/json",
      accept: "text/event-stream",
      "accept-language": "en",
      "user-agent": "OpenAI/Python 1.0",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "tools-2024",
      "openai-beta": "assistants=v2",
      "x-goog-api-client": "genai-js/1.0",
      "idempotency-key": "retry-1",
      "x-stainless-lang": "python",
      "x-stainless-retry-count": "0",
    });
  });

  it("never sends the caller's credentials, proof or the gateway's own headers", () => {
    expect(
      sent({
        authorization: "Bearer agw_app_key",
        cookie: "session=1",
        "x-api-key": "sk-client-supplied",
        "x-goog-api-key": "client-key",
        "x-appattest-proof": "v1.1.AAAAAAAAAAAAAAAAAAAAAA.abc",
        "x-client-sdk": "AppAIGateway-Swift/2.0.0",
        "x-app-version": "2.0.0",
        "x-end-user-id": "player-1",
        "x-firebase-token": "eyJhbGciOi...",
        "x-conversation-storage": "off",
        "x-forwarded-for": "203.0.113.1",
        "cf-connecting-ip": "203.0.113.1",
        host: "gateway.test",
      }),
    ).toEqual({});
  });

  it("never sends a header whose name says it may carry a credential, even one a list lets through", () => {
    expect(sent({ "x-stainless-api-key": "sk-x", "x-stainless-session": "s", "x-stainless-os": "MacOS" })).toEqual({ "x-stainless-os": "MacOS" });
    expect(sent({ "x-goog-upload-protocol": "resumable", "x-goog-upload-token": "t" }, ["x-goog-upload-"])).toEqual({
      "x-goog-upload-protocol": "resumable",
    });
    expect(sent({ "x-api-key": "sk-x" }, ["x-api-key"])).toEqual({});
  });

  it.each([
    ["authorization", true],
    ["x-api-key", true],
    ["x-auth-token", true],
    ["proxy-authorization", true],
    ["x_client_secret", true],
    ["idempotency-key", false],
    ["x-stainless-os", false],
    ["keyboard-layout", false],
  ])("reads %s as possibly a credential: %s", (name, expected) => {
    expect(mayCarryCredential(name)).toBe(expected);
  });
});

describe("toward the app", () => {
  it("passes the provider's headers on, Retry-After and rate-limit headers included", () => {
    const headers = clientResponseHeaders(
      new Headers({
        "content-type": "application/json",
        "retry-after": "20",
        "x-ratelimit-remaining-requests": "0",
        "x-request-id": "req_123",
      }),
      "authorization",
    );
    expect(Object.fromEntries(headers)).toEqual({
      "content-type": "application/json",
      "retry-after": "20",
      "x-ratelimit-remaining-requests": "0",
      "x-request-id": "req_123",
    });
  });

  it("drops what would be wrong after the body is sent again, a provider cookie, the key's organization, and the key header", () => {
    const headers = clientResponseHeaders(
      new Headers({
        "content-length": "10",
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
        "set-cookie": "provider=1",
        "openai-organization": "org-secret",
        "openai-project": "proj_secret",
        "x-api-key": "sk-echoed",
        "x-kept": "yes",
      }),
      "x-api-key",
    );
    expect(Object.fromEntries(headers)).toEqual({ "x-kept": "yes" });
  });
});
