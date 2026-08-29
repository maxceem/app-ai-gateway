import { describe, expect, it } from "vitest";
import { validateAppConfigJson } from "../src/core/config";
import { providersForEndpointStyle } from "../src/core/capabilities";
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

  it("validates selected policies against configured provider instance slugs", () => {
    const providers = {
      "openai-dev": {
        id: "provider-openai-dev",
        slug: "openai-dev",
        type: "openai" as const,
        route: "direct" as const,
        pricing: null,
      },
    };
    expect(() => validateAppConfigJson(serverConfig({
      proxy: {
        "openai-dev": {
          allowed_paths: ["v1/responses"],
          allowed_models: ["gpt-5.6-sol"],
        },
      },
    }), {}, providers)).not.toThrow();
    expect(() => validateAppConfigJson(serverConfig({
      proxy: {
        openai: {
          allowed_paths: ["v1/responses"],
          allowed_models: ["gpt-5.6-sol"],
        },
      },
    }), {}, providers)).toThrowError("Unknown provider instance openai");
  });

  it("rejects rewrite targets that are absent from every price catalog", () => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: { model_rewrites: { alias: "released-today" } },
    }))).toThrowError("has no configured price");
  });

  // A rewrite target names a model, not an instance, so it is priced against the
  // shipped catalog. An organization that has not added a provider yet must
  // still be able to save an app that rewrites models.
  it("prices rewrite targets from the catalog even with no configured providers", () => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: { model_rewrites: { "client-alias": "gpt-5.6-sol" } },
    }), {}, {})).not.toThrow();
    expect(() => validateAppConfigJson(serverConfig({
      proxy: { model_rewrites: { "client-alias": "released-today" } },
    }), {}, {})).toThrowError("has no configured price");
  });

  it("prices a rewrite target from an instance override the catalog does not know", () => {
    expect(() => validateAppConfigJson(serverConfig({
      proxy: { model_rewrites: { "client-alias": "released-today" } },
    }), {}, {
      "openai-dev": {
        id: "provider-openai-dev",
        slug: "openai-dev",
        type: "openai" as const,
        route: "direct" as const,
        pricing: { "released-today": { input: 1, output: 2 } },
      },
    })).not.toThrow();
  });

  // Slugs, model names, and endpoint slugs are all attacker-influenced keys, and
  // several of them are legal keys on Object.prototype. An unguarded lookup
  // would let "constructor" pass validation as an instance nobody configured.
  it("never resolves a provider instance or rewrite from Object.prototype", () => {
    const selected = (slug: string) => serverConfig({
      proxy: { [slug]: { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] } },
    });
    expect(() => validateAppConfigJson(selected("constructor"), {}, {}))
      .toThrowError("Unknown provider instance constructor");
    expect(() => validateAppConfigJson(selected("__proto__"), {}, {}))
      .toThrowError("Invalid provider instance slug __proto__");
    expect(() => validateAppConfigJson(serverConfig({
      endpoints: { chat: { api_style: "responses", provider: "constructor", model: "gpt-5.6-luna" } },
    }), {}, {})).toThrowError("endpoints.chat.provider constructor is not configured");

    // A real instance named "constructor" is still perfectly usable.
    expect(() => validateAppConfigJson(selected("constructor"), {}, {
      constructor: {
        id: "provider-constructor",
        slug: "constructor",
        type: "openai" as const,
        route: "direct" as const,
        pricing: null,
      },
    })).not.toThrow();
  });

  it("stores prototype-shaped model rewrite keys as ordinary entries", () => {
    // Configuration arrives as JSON, and JSON.parse makes "__proto__" an own
    // key — unlike an object literal, where it is prototype-assignment syntax.
    const stored = validateAppConfigJson(serverConfig({
      proxy: {
        model_rewrites: JSON.parse(
          '{"__proto__": "gpt-5.6-sol", "constructor": "gpt-5.6-sol"}',
        ) as Record<string, string>,
      },
    }), {}, {});
    const rewrites = stored.routing.model_rewrites;
    // Written as own keys rather than swallowed by the prototype, and the map
    // itself answers for nothing else.
    expect(Object.hasOwn(rewrites, "__proto__")).toBe(true);
    expect(Object.hasOwn(rewrites, "constructor")).toBe(true);
    expect(Object.getPrototypeOf(rewrites)).toBeNull();
    expect(JSON.parse(JSON.stringify(stored)).routing.model_rewrites).toMatchObject({
      constructor: "gpt-5.6-sol",
    });
  });

  // Deleting a provider must not brick later edits of apps that name its slug.
  it("tolerates already-stored slugs but not newly introduced ones", () => {
    const config = serverConfig({
      proxy: { "openai-dev": { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] } },
    });
    expect(() => validateAppConfigJson(config, {}, {})).toThrowError(
      "Unknown provider instance openai-dev",
    );
    expect(() => validateAppConfigJson(config, {}, {}, new Set(["openai-dev"])))
      .not.toThrow();
    expect(() => validateAppConfigJson(config, {}, {}, new Set(["openai-prod"])))
      .toThrowError("Unknown provider instance openai-dev");
    const endpointConfig = serverConfig({
      endpoints: {
        chat: { api_style: "responses", provider: "openai-dev", model: "gpt-5.6-luna" },
      },
    });
    expect(() => validateAppConfigJson(endpointConfig, {}, {})).toThrowError(
      "endpoints.chat.provider openai-dev is not configured",
    );
    expect(() => validateAppConfigJson(endpointConfig, {}, {}, new Set(["openai-dev"])))
      .not.toThrow();
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

  it("derives named-endpoint eligibility from provider registry capabilities", () => {
    expect(providersForEndpointStyle("responses")).toEqual(["openai", "xai"]);
    expect(providersForEndpointStyle("transcription")).toEqual(["openai", "xai"]);
  });

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
      }))).toThrowError(`endpoints.chat.provider ${provider} is a ${provider} instance, which does not support responses`);
      expect(() => validateAppConfigJson(serverConfig({
        endpoints: { chat: { ...chat, fallback: [{ provider, model: "gpt-5.6-luna" }] } },
      }))).toThrowError(`endpoints.chat.fallback[0].provider ${provider} is a ${provider} instance, which does not support responses`);
    },
  );

  /**
   * The provider type is eligible; its *route* is not. Vercel serves no
   * transcription API, so an endpoint naming a Vercel-routed instance is
   * refused on save rather than stored and discovered on its first request.
   */
  it("rejects an endpoint style the instance's own route cannot carry", () => {
    const instance = (route: "direct" | "cf_aig" | "vercel") => ({
      "openai-routed": {
        id: "provider-openai-routed",
        slug: "openai-routed",
        type: "openai" as const,
        route,
        pricing: null,
      },
    });
    const transcribe = serverConfig({
      endpoints: {
        speech: {
          api_style: "transcription",
          provider: "openai-routed",
          model: "gpt-4o-transcribe",
        },
      },
    });
    expect(() => validateAppConfigJson(transcribe, {}, instance("vercel"))).toThrowError(
      "endpoints.speech.provider openai-routed is a openai instance routed through a vercel gateway, which does not support transcription",
    );
    // The same endpoint is fine on either route that reaches OpenAI's own API.
    for (const route of ["direct", "cf_aig"] as const) {
      expect(() => validateAppConfigJson(transcribe, {}, instance(route))).not.toThrow();
    }
    // A Responses endpoint works on all three: Vercel serves that one.
    const respond = serverConfig({
      endpoints: {
        chat: { api_style: "responses", provider: "openai-routed", model: "gpt-5.6-luna" },
      },
    });
    for (const route of ["direct", "cf_aig", "vercel"] as const) {
      expect(() => validateAppConfigJson(respond, {}, instance(route))).not.toThrow();
    }
  });

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
