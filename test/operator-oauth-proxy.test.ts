import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createOperatorAuth } from "../src/auth/operator";

function operatorEnv(overrides: Partial<Record<keyof Env, unknown>>): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property in overrides) return overrides[property as keyof Env];
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

describe("operator OAuth proxy", () => {
  it("routes OAuth through the configured stable deployment", () => {
    const auth = createOperatorAuth(operatorEnv({
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      OAUTH_PROXY_PRODUCTION_URL: "https://console.example.com",
      OAUTH_PROXY_SECRET: "shared-proxy-secret",
    }), "http://feature.app-ai-gateway.localhost:8080/v1/auth/sign-in/social");

    expect(auth.config.baseUrl).toBe("http://feature.app-ai-gateway.localhost:8080");
    expect(auth.config.oauthProxy).toEqual({
      productionUrl: "https://console.example.com",
      secret: "shared-proxy-secret",
    });
  });

  it("sends Google the stable production callback from a branch origin", async () => {
    const branchOrigin = "http://feature.app-ai-gateway.localhost:8080";
    const productionOrigin = "https://console.example.com";
    const auth = createOperatorAuth(operatorEnv({
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      OAUTH_PROXY_PRODUCTION_URL: productionOrigin,
      OAUTH_PROXY_SECRET: "shared-proxy-secret",
    }), `${branchOrigin}/v1/auth/sign-in/social`);

    const response = await auth.handler(new Request(`${branchOrigin}/v1/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: branchOrigin },
      body: JSON.stringify({ provider: "google", callbackURL: branchOrigin }),
    }));
    expect(response.status, await response.clone().text()).toBe(200);

    const body = await response.json<{ url: string }>();
    const googleUrl = new URL(body.url);
    expect(googleUrl.searchParams.get("redirect_uri")).toBe(
      `${productionOrigin}/v1/auth/callback/google`,
    );
    expect(googleUrl.searchParams.get("state")?.length).toBeGreaterThan(100);
  });

  it("leaves non-Google deployments unchanged when only the public proxy URL is present", () => {
    const auth = createOperatorAuth(operatorEnv({
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      OAUTH_PROXY_PRODUCTION_URL: "https://console.example.com",
      OAUTH_PROXY_SECRET: undefined,
    }), "https://self-hosted.example/v1/auth/sign-in/social");

    expect(auth.config.oauthProxy).toBeUndefined();
  });

  it("rejects partially configured Google OAuth proxy settings", () => {
    expect(() => createOperatorAuth(operatorEnv({
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      OAUTH_PROXY_PRODUCTION_URL: "https://console.example.com",
      OAUTH_PROXY_SECRET: undefined,
    }), "http://feature.app-ai-gateway.localhost:8080/v1/auth/sign-in/social")).toThrowError(
      /must be configured together/u,
    );
  });
});
