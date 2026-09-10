import { describe, expect, it } from "vitest";
import { draftProblem } from "./draft-problems";
import type { Draft } from "@/hooks/use-app-draft";
import type { AuthenticationConfig } from "./config-types";

const draft = (authentication: AuthenticationConfig, name = "My app"): Draft => ({
  name,
  status: "active",
  config: { authentication, routing: { providers: { mode: "all" }, model_rewrites: {} } },
});

const issuer = {
  provider: "firebase" as const,
  jwks_url: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  issuer: "https://securetoken.google.com/my-app",
  audience: "my-app",
  user_id_claim: "sub",
  required_claims: [],
  max_token_lifetime_seconds: 86400,
};

describe("draftProblem", () => {
  it("passes a complete draft", () => {
    expect(draftProblem(draft({ type: "api_key", end_user: { source: "issuer", issuer } }))).toBeNull();
    expect(draftProblem(draft({ type: "api_key" }))).toBeNull();
  });

  it("names the first thing the Worker would refuse", () => {
    expect(draftProblem(draft({ type: "api_key" }, "  "))).toMatch(/name/i);
    expect(draftProblem(draft({
      type: "apple_app_attest",
      app_attest: { team_id: "", bundle_id: "com.example" },
      end_user: { source: "app_install" },
    }))).toMatch(/team id/i);
    expect(draftProblem(draft({ type: "api_key", end_user: { source: "header", header: " " } })))
      .toMatch(/header name/i);
    // Half-typed on the Auth policy page: the Worker stores lists, so an empty
    // list counts as missing too.
    expect(draftProblem(draft({
      type: "api_key",
      end_user: { source: "issuer", issuer: { ...issuer, audience: [] } },
    }))).toMatch(/identity provider/i);
    expect(draftProblem(draft({
      type: "api_key",
      end_user: {
        source: "issuer",
        issuer: { ...issuer, entitlement: "revenuecat", required_claims: [{ path: "entitlements", contains: "" }] },
      },
    }))).toMatch(/subscription check/i);
  });
});
