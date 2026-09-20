import { describe, expect, it } from "vitest";
import { normalizeAppConfigDraft, toAppWrite } from "./config-conversion";
import type { AppConfigDraft } from "./config-types";

const base = (): AppConfigDraft => ({
  authentication: { type: "api_key" },
  routing: { providers: { mode: "all" } },
});

describe("console configuration conversion", () => {
  it("rejects an incomplete issuer before a request can be made", () => {
    const draft = base();
    draft.authentication = {
      type: "api_key",
      end_user: {
        source: "issuer",
        issuer: {
          jwks_url: "https://issuer.example.test/jwks.json",
          issuer: "https://issuer.example.test",
          audience: "my-app",
          required_claims: [],
          max_token_lifetime_seconds: 3600,
        },
      },
    };

    expect(() => toAppWrite({ name: "My app", config: draft }))
      .toThrowError("authentication.issuer.user_id_claim must be a non-empty string");
  });

  it("materializes editable maps and filters deselected provider entries", () => {
    const draft = base();
    draft.routing = {
      providers: {
        mode: "selected",
        selected: {
          openai: { allowed_models: ["gpt-5-mini"] },
          removed: undefined,
        },
      },
    };

    expect(normalizeAppConfigDraft(draft).routing).toEqual({
      providers: {
        mode: "selected",
        selected: {
          openai: { allowed_paths: [], allowed_models: ["gpt-5-mini"] },
        },
      },
      model_rewrites: {},
    });
  });

  it("preserves provider-native endpoint params", () => {
    const draft = base();
    draft.endpoints = {
      summarize: {
        api_style: "responses",
        provider: "openai",
        model: "gpt-5-mini",
        params: { reasoning: { effort: "low" }, vendor_extension: [1, true, null] },
      },
    };

    expect(normalizeAppConfigDraft(draft).endpoints?.summarize?.params).toEqual(
      draft.endpoints.summarize?.params,
    );
  });
});
