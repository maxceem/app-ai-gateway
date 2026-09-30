import { describe, expect, it } from "vitest";
import { draftIssues, draftProblem } from "./draft-problems";
import type { Draft } from "@/lib/app-draft";
import type { AuthenticationDraft } from "./config-types";

const draft = (authentication: AuthenticationDraft, name = "My app"): Draft => ({
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

const problem = (draft: Draft) => draftProblem(draft, draftIssues(draft));

/** A server app with the given routing, limits or endpoints. */
const configured = (config: Record<string, unknown>): Draft => ({
  name: "My app",
  status: "active",
  config: {
    authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
    ...config,
  } as Draft["config"],
});

const restricted = (policy: Record<string, unknown>) =>
  configured({ routing: { providers: { mode: "selected", selected: { openai: policy } }, model_rewrites: {} } });

describe("draftProblem", () => {
  it("passes a complete draft", () => {
    expect(problem(draft({ type: "api_key", end_user: { source: "issuer", issuer } }))).toBeNull();
    expect(problem(draft({ type: "api_key", end_user: { source: "none" } }))).toBeNull();
  });

  it("names the first thing the Worker would refuse", () => {
    expect(problem(draft({ type: "api_key", end_user: { source: "none" } }, "  "))).toMatch(/name/i);
    expect(problem(draft({
      type: "apple_app_attest",
      app_attest: { team_id: "", bundle_id: "com.example" },
      end_user: { source: "app_install" },
    }))).toMatch(/team id/i);
    // Present but malformed: the schema's own wording, not a console rule.
    expect(problem(draft({
      type: "apple_app_attest",
      app_attest: { team_id: "abcde12345", bundle_id: "com.example" },
      end_user: { source: "app_install" },
    }))).toMatch(/team_id must contain ten uppercase letters or digits/u);
    expect(problem(draft({
      type: "apple_app_attest",
      app_attest: { team_id: "ABCDE12345", bundle_id: "example" },
      end_user: { source: "app_install" },
    }))).toMatch(/bundle_id must be a reverse DNS identifier/u);
    // Past the form's own prompts, the schema has the last word: a draft it
    // would refuse is never offered as saveable.
    expect(problem(draft({
      type: "api_key",
      end_user: { source: "header", header: "authorization" },
    }))).toMatch(/authentication\.end_user\.header/u);
    expect(problem(draft({ type: "api_key", end_user: { source: "header", header: " " } })))
      .toMatch(/header name/i);
    // Half-typed on the Auth policy page: the Worker stores lists, so an empty
    // list counts as missing too.
    expect(problem(draft({
      type: "api_key",
      end_user: { source: "issuer", issuer: { ...issuer, audience: [] } },
    }))).toMatch(/identity provider/i);
    expect(problem(draft({
      type: "api_key",
      end_user: {
        source: "issuer",
        issuer: {
          ...issuer,
          entitlement: "revenuecat",
          required_claims: [{ path: "revenueCatEntitlements", contains: "" }],
        },
      },
    }))).toMatch(/subscription check/i);
  });

  /**
   * The sections past Auth policy are lists the operator fills a row at a
   * time, so a half-filled row is the usual reason a save is refused. The
   * sentence names the field and the row rather than the value's path.
   */
  it("words a refusal from the other sections by field and row", () => {
    expect(problem(restricted({ allowed_paths: [""], allowed_models: [] })))
      .toBe("Enter the endpoint path for openai.");
    expect(problem(restricted({ allowed_paths: [{ path: "" }], allowed_models: [] })))
      .toBe("Enter the endpoint path for openai.");
    expect(problem(restricted({ allowed_paths: [{ path: "v1/responses", fixed_model: "" }], allowed_models: [] })))
      .toBe("Enter the fixed model for openai, or leave it empty.");
    expect(problem(restricted({ allowed_paths: [], allowed_models: [""] })))
      .toBe("Enter the model name for openai.");
    expect(problem(restricted({ allowed_paths: [], allowed_models: [], max_output_tokens: 0 })))
      .toBe("Max output tokens for openai must be a whole number above 0.");

    const limits = (per_user: Record<string, unknown>) => configured({
      limits: {
        per_user,
        per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
      },
    });
    expect(problem(limits({ requests: { per_minute: 0, per_day: null }, spending: { monthly_usd: null } })))
      .toBe("Per-user requests per minute must be a whole number above 0.");
    expect(problem(limits({ requests: { per_minute: null, per_day: 1.5 }, spending: { monthly_usd: null } })))
      .toBe("Per-user requests per day must be a whole number above 0.");
    expect(problem(limits({ requests: { per_minute: null, per_day: null }, spending: { monthly_usd: -1 } })))
      .toBe("Per-user monthly spending budget must be 0 or more.");

    const endpoint = (fields: Record<string, unknown>, slug = "chat") => configured({
      endpoints: { [slug]: { api_style: "responses", provider: "openai", model: "gpt-5.6-luna", ...fields } },
    });
    expect(problem(endpoint({ model: "" }))).toBe("Choose a model for the custom endpoint chat.");
    expect(problem(endpoint({ provider: "" }))).toBe("Choose a provider for the custom endpoint chat.");
    expect(problem(endpoint({ fallback: [{ provider: "xai", model: "" }] })))
      .toBe("Choose a model for fallback 1 of the custom endpoint chat.");
    expect(problem(endpoint({}, "Bad Slug")))
      .toBe('The custom endpoint slug "Bad Slug" is not valid: use 1-64 characters from a-z, 0-9 and -.');
  });
});
