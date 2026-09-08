import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { createOperatorAuth, relaySocialSignIn } from "../src/auth/operator";

// A local instance answers on whatever host the worktree or port gives it,
// which is exactly what Google will not let anyone register.
const ORIGIN = "http://feature.app-ai-gateway.localhost:8080";
const RELAY = "https://dev-oauth.example.test";

function operatorEnv(overrides: Partial<Record<keyof Env, unknown>>): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property in overrides) return overrides[property as keyof Env];
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

async function signInUrl(relayUrl: string | undefined): Promise<URL> {
  const response = await worker.request(`${ORIGIN}/v1/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ provider: "google", callbackURL: ORIGIN }),
  }, operatorEnv({
    GOOGLE_CLIENT_ID: "test-google-client",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    OAUTH_RELAY_URL: relayUrl,
  }));

  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json<{ url: string; redirect?: boolean }>();
  return new URL(body.url);
}

describe("operator OAuth relay", () => {
  it("sends the browser to the relay, which knows the way back to this origin", async () => {
    const url = await signInUrl(RELAY);

    expect(url.origin).toBe(RELAY);
    expect(url.pathname).toBe("/start");
    expect(url.searchParams.get("return")).toBe(`${ORIGIN}/v1/auth/callback/google`);

    const next = new URL(url.searchParams.get("next")!);
    expect(next.hostname).toBe("accounts.google.com");
    // Google is asked to redirect to the one URI the relay has registered, and
    // Better Auth will present the same value at the token endpoint.
    expect(next.searchParams.get("redirect_uri")).toBe(`${RELAY}/callback/google`);
    expect(next.searchParams.get("state")?.length).toBeGreaterThan(20);
  });

  it("tolerates surrounding whitespace and a trailing slash", async () => {
    const url = await signInUrl(`  ${RELAY}/  `);

    expect(url.origin).toBe(RELAY);
    expect(url.pathname).toBe("/start");
    expect(new URL(url.searchParams.get("next")!).searchParams.get("redirect_uri")).toBe(
      `${RELAY}/callback/google`,
    );
  });

  it("goes straight to Google with this origin's own callback when unset", async () => {
    const url = await signInUrl(undefined);

    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/v1/auth/callback/google`);
  });

  it("configures the redirect URI only when a relay is set", () => {
    const withRelay = createOperatorAuth(operatorEnv({
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
      OAUTH_RELAY_URL: RELAY,
    }), `${ORIGIN}/v1/auth/sign-in/social`);
    expect(withRelay.config.google?.redirectURI).toBe(`${RELAY}/callback/google`);

    const without = createOperatorAuth(operatorEnv({
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
      OAUTH_RELAY_URL: undefined,
    }), `${ORIGIN}/v1/auth/sign-in/social`);
    expect(without.config.google?.redirectURI).toBeUndefined();
  });

  it("carries every Set-Cookie of the rewritten response through untouched", async () => {
    // Better Auth answers sign-in/social with the OAuth `state` cookie (and,
    // with PKCE, the verifier) attached. Rebuilding the body must not drop
    // them: the callback that comes back through the relay is verified against
    // exactly these, on this origin.
    const stateCookie = "agw_operator_auth.state=state-value; Path=/; HttpOnly; SameSite=Lax";
    const verifierCookie = "agw_operator_auth.pkce_verifier=verifier-value; Path=/; HttpOnly";
    const googleUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=state-value";
    const headers = new Headers({ "content-type": "application/json", "content-length": "1234" });
    headers.append("set-cookie", stateCookie);
    headers.append("set-cookie", verifierCookie);

    const rewritten = await relaySocialSignIn(
      operatorEnv({ OAUTH_RELAY_URL: RELAY }),
      `${ORIGIN}/v1/auth/sign-in/social`,
      new Response(JSON.stringify({ url: googleUrl, redirect: true }), { status: 200, headers }),
    );

    expect(rewritten.headers.getSetCookie()).toEqual([stateCookie, verifierCookie]);
    expect(rewritten.headers.get("content-length")).toBeNull();
    expect(rewritten.headers.get("content-type")).toContain("application/json");
    expect(rewritten.status).toBe(200);

    const body = await rewritten.json<{ url: string; redirect: boolean }>();
    expect(body.redirect).toBe(true);
    const url = new URL(body.url);
    expect(url.origin).toBe(RELAY);
    expect(url.pathname).toBe("/start");
    expect(url.searchParams.get("next")).toBe(googleUrl);
  });

  it("rejects a relay URL that is not an absolute http(s) URL", () => {
    expect(() => createOperatorAuth(operatorEnv({
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
      OAUTH_RELAY_URL: "dev-oauth.example.test",
    }), `${ORIGIN}/v1/auth/sign-in/social`)).toThrowError(/absolute http\(s\) URL/u);
  });
});
