import { describe, expect, it } from "vitest";
import { validateAppConfigJson } from "../src/core/config";
import { serverConfig } from "./helpers";

describe("canonical app configuration", () => {
  it("accepts explicit all-provider mode", () => {
    expect(() => validateAppConfigJson(serverConfig())).not.toThrow();
  });

  it("allows selected mode without a provider to disable all providers", () => {
    const config = serverConfig() as any;
    config.routing.providers = { mode: "selected", selected: {} };
    expect(() => validateAppConfigJson(config)).not.toThrow();
  });

  it.each([
    ["unset", { allowed_paths: [], allowed_models: [] }],
    ["set", { allowed_paths: [], allowed_models: [], max_output_tokens: 8192 }],
  ])("accepts max_output_tokens when %s", (_label, openai) => {
    expect(() => validateAppConfigJson(serverConfig({ proxy: { openai } }))).not.toThrow();
  });

  it.each([0, -1, 1.5, "8192"])('rejects invalid max_output_tokens value %s', (value) => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: { openai: { allowed_paths: [], allowed_models: [], max_output_tokens: value } },
    }))).toThrowError("openai.max_output_tokens");
  });

  it("rejects missing discriminators instead of inferring legacy defaults", () => {
    expect(() => validateAppConfigJson({ authentication: {}, routing: {}, limits: {} }))
      .toThrowError("authentication.type");
  });

  it.each([
    ["authentication.development_access", (config: any) => {
      config.authentication.development_access = true;
    }],
    ["authentication.app_attest.environments", (config: any) => {
      config.authentication = {
        type: "apple_app_attest",
        issuer: {
          jwks_url: "https://issuer.test/jwks",
          user_id_claim: "sub",
          required_claims: [],
          max_token_lifetime_seconds: 3600,
        },
        app_attest: {
          team_id: "AAAAAAAAAA",
          bundle_id: "com.example.test",
          environments: ["development"],
        },
      };
    }],
  ])("rejects removed config field %s", (field, mutate) => {
    const config = serverConfig();
    mutate(config);
    expect(() => validateAppConfigJson(config)).toThrowError(`${field} is no longer supported`);
  });

  it("rejects allowlisted and fixed models without provider pricing", () => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: {
        openai: { allowed_paths: [], allowed_models: ["released-today"] },
      },
    }))).toThrowError("has no configured price");
    expect(() => validateAppConfigJson(serverConfig({
      proxy: {
        xai: {
          allowed_paths: [{ path: "v1/stt", fixed_model: "released-today" }],
          allowed_models: [],
        },
      },
    }))).toThrowError("has no configured price");
  });

  it("accepts an unpriced client alias when it rewrites to a priced provider model", () => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: {
        openai: { allowed_paths: [], allowed_models: ["client-alias"] },
        model_rewrites: { "client-alias": "gpt-5.6-sol" },
      },
    }))).not.toThrow();
  });

  it("rejects rewrite targets that are absent from every price catalog", () => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: { model_rewrites: { alias: "released-today" } },
    }))).toThrowError("has no configured price");
  });
});

describe("named endpoint configuration", () => {
  const chat = {
    api_style: "responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    params: { reasoning: { effort: "low" } },
    max_output_tokens: 4096,
    fallback: [{ provider: "xai", model: "grok-4.5" }],
  };

  it("keeps a valid endpoints block verbatim in the stored configuration", () => {
    const stored = validateAppConfigJson(serverConfig({
      endpoints: {
        chat,
        transcribe: {
          api_style: "transcription",
          provider: "openai",
          model: "gpt-4o-mini-transcribe",
        },
      },
    }));
    expect(stored.endpoints).toEqual({
      chat,
      transcribe: {
        api_style: "transcription",
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
      },
    });
  });

  it("omits the block entirely when an app configures no endpoints", () => {
    expect(validateAppConfigJson(serverConfig())).not.toHaveProperty("endpoints");
  });

  it.each(["Chat", "chat_completions", "", "a".repeat(65), "chat/1"])(
    "rejects the invalid slug %s",
    (slug) => {
      expect(() => validateAppConfigJson(serverConfig({ endpoints: { [slug]: chat } })))
        .toThrowError("is not a valid slug");
    },
  );

  it("rejects a model without a configured price", () => {
    expect(() => validateAppConfigJson(serverConfig({
      endpoints: { chat: { api_style: "responses", provider: "openai", model: "released-today" } },
    }))).toThrowError("has no configured price");
  });

  it("rejects a fallback model without a configured price", () => {
    expect(() => validateAppConfigJson(serverConfig({
      endpoints: {
        chat: { ...chat, fallback: [{ provider: "xai", model: "released-today" }] },
      },
    }))).toThrowError("endpoints.chat.fallback[0].model");
  });

  it.each(["gemini", "anthropic", "perplexity"])(
    "rejects the unsupported endpoint provider %s",
    (provider) => {
      expect(() => validateAppConfigJson(serverConfig({
        endpoints: { chat: { api_style: "responses", provider, model: "gpt-5.6-luna" } },
      }))).toThrowError("endpoints.chat.provider must be one of openai, xai");
      expect(() => validateAppConfigJson(serverConfig({
        endpoints: { chat: { ...chat, fallback: [{ provider, model: "gpt-5.6-luna" }] } },
      }))).toThrowError("endpoints.chat.fallback[0].provider must be one of openai, xai");
    },
  );

  it("rejects an unknown api_style", () => {
    expect(() => validateAppConfigJson(serverConfig({
      endpoints: { chat: { ...chat, api_style: "chat_completions" } },
    }))).toThrowError("endpoints.chat.api_style must be one of responses, transcription");
  });

  it.each([0, -1, 1.5, "4096"])("rejects the invalid max_output_tokens %s", (value) => {
    expect(() => validateAppConfigJson(serverConfig({
      endpoints: { chat: { ...chat, max_output_tokens: value } },
    }))).toThrowError("endpoints.chat.max_output_tokens");
  });

  it.each([[[]], ["low"], [null]])("rejects non-object params %s", (params) => {
    expect(() => validateAppConfigJson(serverConfig({
      endpoints: { chat: { ...chat, params } },
    }))).toThrowError("endpoints.chat.params");
  });
});
