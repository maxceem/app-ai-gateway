import { describe, expect, it } from "vitest";
import { providersForEndpointStyle } from "../src/core/capabilities";
import { AppConfigSchema } from "../src/contracts/schemas";
import { parseAppConfig } from "../src/shared/app-config";
import { serverConfig, validateConfig } from "./helpers";

/**
 * One grammar, one shape.
 *
 * Everything below exercises `AppConfigSchema` — through `parseAppConfig`, which
 * is the only way in, or through `validateConfig`, which adds the
 * organization-scoped reference and price checks a management write also makes.
 * There is no second parser to agree with any more, which is the point of the
 * first two tests here: what the schema produces is what is stored, so a parse
 * of a stored configuration has to be the identity.
 */
describe("the application configuration grammar", () => {
  const everyFeature = () => ({
    authentication: {
      type: "apple_app_attest",
      app_attest: {
        team_id: "AAAAAAAAAA",
        bundle_id: "com.example.test",
        environments: ["production", "development"],
      },
      end_user: {
        source: "issuer",
        issuer: {
          jwks_url: "https://issuer.test/jwks",
          issuer: "https://issuer.test/",
          audience: ["my-app", "my-app-next"],
          user_id_claim: "sub",
          token_header: "X-Id-Token",
          required_claims: [{ path: "entitlements", contains: "pro" }],
          max_token_lifetime_seconds: 3600,
          provider: "firebase",
          entitlement: "revenuecat",
        },
      },
    },
    routing: {
      providers: {
        mode: "selected",
        selected: {
          openai: {
            allowed_paths: ["v1/responses", { path: "v1/stt", fixed_model: "gpt-4o-mini-transcribe", clamp: "none" }],
            allowed_models: ["gpt-5.6-sol"],
            max_output_tokens: 128,
          },
        },
      },
      model_rewrites: { "client-alias": "gpt-5.6-sol" },
    },
    limits: {
      per_user: { requests: { per_minute: 10, per_day: 300 }, spending: { monthly_usd: 5 } },
      per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
    },
    endpoints: {
      chat: {
        api_style: "responses",
        provider: "openai",
        model: "gpt-5.6-luna",
        params: { reasoning: { effort: "low" } },
        max_output_tokens: 4096,
        fallback: [{ provider: "xai", model: "grok-4.5" }],
      },
    },
  });

  // The property the whole refactoring rests on: what is stored is what was
  // parsed, so parsing it again has to change nothing. A normalization that
  // only survived one round trip would mean the stored form and the accepted
  // form had quietly become two different languages again.
  it("parses its own output back to itself", () => {
    const once = parseAppConfig(everyFeature());
    expect(parseAppConfig(once)).toEqual(once);
  });

  it("applies every default on a minimal configuration", () => {
    const parsed = parseAppConfig({
      authentication: { type: "api_key" },
      routing: { providers: { mode: "all" }, model_rewrites: {} },
    });
    expect(parsed.endpoints).toEqual({});
    expect(parsed.limits).toEqual({
      per_user: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
      per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
    });
  });

  /*
   * Stored rows predate the defaults. A configuration written before `limits`
   * and `environments` were always materialised must still load, or a
   * deployment's own applications go offline on the upgrade that added them.
   */
  it("still reads a stored configuration written before the defaults existed", () => {
    const parsed = parseAppConfig({
      authentication: {
        type: "apple_app_attest",
        app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.test" },
        end_user: { source: "app_install" },
      },
      routing: { providers: { mode: "all" }, model_rewrites: {} },
    });
    expect(parsed.authentication.type === "apple_app_attest"
      && parsed.authentication.app_attest.environments).toEqual(["production"]);
    expect(parsed.limits.per_app.requests.per_minute).toBeNull();
    expect(parsed.endpoints).toEqual({});
  });

  it("refuses a key it does not define, wherever it appears", () => {
    expect(() => parseAppConfig({ ...serverConfig(), surprise: true }))
      .toThrowError("Unrecognized key");
    const withDevelopmentAccess = serverConfig({
      authentication: { type: "api_key", development_access: true },
    });
    expect(() => parseAppConfig(withDevelopmentAccess))
      .toThrowError('authentication: Unrecognized key: "development_access"');
  });

  it("rejects a missing discriminator instead of inferring a legacy default", () => {
    expect(() => parseAppConfig({ authentication: {}, routing: {} }))
      .toThrowError("authentication.type");
  });

  describe("authentication.issuer", () => {
    const withIssuer = (issuer: Record<string, unknown>) => serverConfig({
      authentication: {
        type: "api_key",
        end_user: {
          source: "issuer",
          issuer: {
            jwks_url: "https://issuer.test/jwks",
            issuer: "https://issuer.test/",
            audience: "test-audience",
            user_id_claim: "sub",
            required_claims: [],
            max_token_lifetime_seconds: 3600,
            ...issuer,
          },
        },
      },
    });
    const parsedIssuer = (config: unknown): Record<string, unknown> =>
      (parseAppConfig(config) as never as {
        authentication: { end_user: { issuer: Record<string, unknown> } };
      }).authentication.end_user.issuer;

    it("stores a single issuer and audience as the one-element list", () => {
      const issuer = parsedIssuer(withIssuer({}));
      expect(issuer.issuer).toEqual(["https://issuer.test/"]);
      expect(issuer.audience).toEqual(["test-audience"]);
    });

    it("keeps a list of alternatives as it was written", () => {
      const issuer = parsedIssuer(withIssuer({ audience: ["one", "two"] }));
      expect(issuer.audience).toEqual(["one", "two"]);
    });

    it.each([[[]], [""], [null], [["one", ""]]])(
      "refuses the issuer value %s",
      (audience) => {
        expect(() => parseAppConfig(withIssuer({ audience }))).toThrowError(
          "authentication.end_user.issuer.audience",
        );
      },
    );

    it("canonicalizes the JWKS URL it stores", () => {
      expect(parsedIssuer(withIssuer({ jwks_url: "https://issuer.test" })).jwks_url)
        .toBe("https://issuer.test/");
    });

    it.each(["http://issuer.test/jwks", "not a url", "ftp://issuer.test/jwks"])(
      "refuses the JWKS URL %s",
      (jwks_url) => {
        expect(() => parseAppConfig(withIssuer({ jwks_url })))
          .toThrowError("authentication.end_user.issuer.jwks_url");
      },
    );

    it("lowercases a token header and refuses an empty one", () => {
      expect(parsedIssuer(withIssuer({ token_header: "X-Id-Token" })).token_header)
        .toBe("x-id-token");
      expect(() => parseAppConfig(withIssuer({ token_header: "" })))
        .toThrowError("authentication.end_user.issuer.token_header");
    });

    it.each([null, 0, -1, 1.5])("refuses the token lifetime %s", (value) => {
      expect(() => parseAppConfig(withIssuer({ max_token_lifetime_seconds: value })))
        .toThrowError("authentication.end_user.issuer.max_token_lifetime_seconds");
    });

    it("keeps which provider and which paid check the block was written for", () => {
      const issuer = parsedIssuer(withIssuer({ provider: "firebase", entitlement: "revenuecat" }));
      expect(issuer.provider).toBe("firebase");
      expect(issuer.entitlement).toBe("revenuecat");
    });

    // The gateway reads neither, but a name nothing in this build knows is a
    // name the console cannot reopen its form from, so it is refused on the way
    // in rather than stored and misread later.
    it.each([["provider", "okta"], ["entitlement", 7]])(
      "refuses the unknown %s label",
      (field, value) => {
        expect(() => parseAppConfig(withIssuer({ [field]: value })))
          .toThrowError(`authentication.end_user.issuer.${field}`);
      },
    );

    it.each([
      ["both", { path: "p", contains: "a", equals: 1 }],
      ["neither", { path: "p" }],
    ])("refuses a claim requirement naming %s of contains and equals", (_case, requirement) => {
      expect(() => parseAppConfig(withIssuer({ required_claims: [requirement] })))
        .toThrowError("Claim requirements need exactly one of contains or equals");
    });

    it("accepts one of the two, and refuses an empty claim path", () => {
      expect(() => parseAppConfig(withIssuer({ required_claims: [{ path: "p", equals: true }] })))
        .not.toThrow();
      expect(() => parseAppConfig(withIssuer({ required_claims: [{ path: "", contains: "a" }] })))
        .toThrowError("required_claims.0.path");
    });
  });

  describe("authentication.end_user.header", () => {
    const withHeader = (header: unknown) => serverConfig({
      authentication: { type: "api_key", end_user: { source: "header", header } },
    });

    it("lowercases the stored name, since header lookups ignore case", () => {
      const parsed = parseAppConfig(withHeader("X-Tenant-User")) as never as {
        authentication: { end_user: { header: string } };
      };
      expect(parsed.authentication.end_user.header).toBe("x-tenant-user");
    });

    it.each([
      ["authorization", "authorization"],
      // Every provider auth header is a credential carrier too: naming one would
      // read the caller's gateway key as its own user id and then store it.
      ["a provider auth header", "x-api-key"],
      ["a Google provider auth header", "x-goog-api-key"],
      ["the version header", "x-app-version"],
      ["content-type", "content-type"],
    ])("refuses %s, which the gateway already uses", (_case, header) => {
      expect(() => parseAppConfig(withHeader(header)))
        .toThrowError("the gateway already uses that header");
    });

    it.each([
      ["an empty name", ""],
      ["a name with a space", "x tenant user"],
      ["a name with a colon", "x-tenant:user"],
      ["an over-long name", "x-".padEnd(80, "a")],
    ])("refuses %s", (_case, header) => {
      expect(() => parseAppConfig(withHeader(header)))
        .toThrowError("authentication.end_user.header");
    });
  });

  describe("authentication.app_attest", () => {
    const appleConfig = (appAttest: Record<string, unknown> = {}) => ({
      ...serverConfig(),
      authentication: {
        type: "apple_app_attest",
        app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.test", ...appAttest },
        end_user: { source: "app_install" },
      },
    });
    const parsedAttest = (config: unknown): Record<string, unknown> =>
      (parseAppConfig(config) as never as {
        authentication: { app_attest: Record<string, unknown> };
      }).authentication.app_attest;

    it("defaults an unnamed environment list to production alone", () => {
      expect(parsedAttest(appleConfig()).environments).toEqual(["production"]);
    });

    it("keeps an explicit opt-in", () => {
      expect(parsedAttest(appleConfig({ environments: ["production", "development"] })).environments)
        .toEqual(["production", "development"]);
    });

    it.each([
      ["an empty list", []],
      ["an unknown environment", ["staging"]],
      ["a duplicate", ["production", "production"]],
      ["a non-array", "development"],
    ])("refuses %s", (_case, environments) => {
      expect(() => parseAppConfig(appleConfig({ environments })))
        .toThrowError("authentication.app_attest.environments");
    });

    // Moved here from the CLI, which was the only thing that ever checked them.
    it.each(["abcde12345", "AAAAAAAAA", "AAAAAAAAAAA", ""])(
      "refuses the team id %s",
      (team_id) => {
        expect(() => parseAppConfig(appleConfig({ team_id })))
          .toThrowError("team_id must contain ten uppercase letters or digits");
      },
    );

    it.each(["com", "", "com..example", "com example"])(
      "refuses the bundle id %s",
      (bundle_id) => {
        expect(() => parseAppConfig(appleConfig({ bundle_id })))
          .toThrowError("bundle_id must be a reverse DNS identifier");
      },
    );
  });

  describe("routing.providers", () => {
    it("accepts all mode, and refuses a selection alongside it", () => {
      expect(() => parseAppConfig(serverConfig())).not.toThrow();
      const config = serverConfig() as { routing: { providers: unknown } };
      config.routing.providers = { mode: "all", selected: {} };
      expect(() => parseAppConfig(config)).toThrowError("routing.providers");
    });

    it("requires a selection in selected mode, and accepts an empty one", () => {
      const withProviders = (providers: unknown) => {
        const config = serverConfig() as { routing: { providers: unknown } };
        config.routing.providers = providers;
        return config;
      };
      expect(() => parseAppConfig(withProviders({ mode: "selected" })))
        .toThrowError("routing.providers");
      // Selected-but-empty disables every provider, which is a position an
      // operator can take and not the same as all mode.
      expect(() => parseAppConfig(withProviders({ mode: "selected", selected: {} }))).not.toThrow();
    });

    it("refuses an unknown mode", () => {
      const config = serverConfig() as { routing: { providers: unknown } };
      config.routing.providers = { mode: "some", selected: {} };
      expect(() => parseAppConfig(config))
        .toThrowError("routing.providers.mode must be all or selected");
    });

    it.each([
      ["a bad slug", "Openai"],
      ["a prototype key", "constructor"],
    ])("refuses %s as a provider instance key", (_case, slug) => {
      expect(() => parseAppConfig(serverConfig({
        proxy: { [slug]: { allowed_paths: [], allowed_models: [] } },
      }))).toThrowError(`routing.providers.selected.${slug}`);
    });

    it.each([
      ["unset", { allowed_paths: [], allowed_models: [] }],
      ["set", { allowed_paths: [], allowed_models: [], max_output_tokens: 8192 }],
    ])("accepts max_output_tokens when %s", (_label, openai) => {
      expect(() => validateConfig(serverConfig({ proxy: { openai } }))).not.toThrow();
    });

    it.each([0, -1, 1.5, "8192"])("refuses the max_output_tokens %s", (value) => {
      expect(() => parseAppConfig(serverConfig({
        proxy: { openai: { allowed_paths: [], allowed_models: [], max_output_tokens: value } },
      }))).toThrowError("routing.providers.selected.openai.max_output_tokens");
    });

    it("refuses an empty model or path entry", () => {
      expect(() => parseAppConfig(serverConfig({
        proxy: { openai: { allowed_paths: [], allowed_models: [""] } },
      }))).toThrowError("allowed_models.0");
      expect(() => parseAppConfig(serverConfig({
        proxy: { openai: { allowed_paths: [{ path: "v1/responses", fixed_model: "" }], allowed_models: [] } },
      }))).toThrowError("allowed_paths.0");
    });
  });

  describe("routing.model_rewrites", () => {
    const rewrites = (model_rewrites: unknown) =>
      serverConfig({ proxy: { model_rewrites } });

    it("refuses an empty key or an empty target", () => {
      expect(() => parseAppConfig(rewrites({ "": "gpt-5.6-sol" })))
        .toThrowError("routing.model_rewrites");
      expect(() => parseAppConfig(rewrites({ alias: "" })))
        .toThrowError("routing.model_rewrites.alias");
    });

    /*
     * Model names, provider slugs and endpoint slugs are all keys a client
     * chooses, and several of them are legal names on `Object.prototype`. The
     * lookups themselves are own-property-only, and refusing the keys means
     * nothing can be stored that poses the question in the first place.
     */
    it.each(["constructor", "prototype"])("refuses the reserved key %s", (key) => {
      expect(() => parseAppConfig(rewrites(JSON.parse(`{"${key}": "gpt-5.6-sol"}`))))
        .toThrowError(`routing.model_rewrites.${key}`);
    });

    // `__proto__` never reaches a check: it is dropped before the key schema
    // sees it. The outcome is the one that matters — it is never stored.
    it("never stores a __proto__ rewrite", () => {
      const parsed = parseAppConfig(rewrites(JSON.parse('{"__proto__": "gpt-5.6-sol"}')));
      expect(Object.hasOwn(parsed.routing.model_rewrites, "__proto__")).toBe(false);
      expect(parsed.routing.model_rewrites).toEqual({});
    });
  });

  describe("limits", () => {
    // Per-user limits need somebody to apply to, so these exercise an
    // application that identifies its users rather than the userless default.
    const withUsers = () => serverConfig({
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    });
    const scope = (over: Record<string, unknown> = {}) => ({
      requests: { per_minute: 10, per_day: 300 },
      spending: { monthly_usd: 5 },
      ...over,
    });
    const withLimits = (limits: unknown) => ({ ...withUsers(), limits });

    it("keeps a configured block through the round trip", () => {
      expect(parseAppConfig(withLimits({ per_user: scope(), per_app: scope() })).limits)
        .toEqual({ per_user: scope(), per_app: scope() });
    });

    it("fills in a scope the configuration did not write", () => {
      expect(parseAppConfig(withLimits({ per_user: scope() })).limits.per_app)
        .toEqual({ requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } });
    });

    it.each([0, -1, 1.5, "10"])("refuses a request limit of %s", (value) => {
      expect(() => parseAppConfig(withLimits({
        per_user: scope({ requests: { per_minute: value, per_day: null } }),
        per_app: scope(),
      }))).toThrowError("limits.per_user.requests.per_minute");
    });

    it.each([-1, "5"])("refuses a monthly budget of %s", (value) => {
      expect(() => parseAppConfig(withLimits({
        per_user: scope({ spending: { monthly_usd: value } }),
        per_app: scope(),
      }))).toThrowError("limits.per_user.spending.monthly_usd");
    });

    // Past this the budget stops being the number that was typed once it is
    // converted to the whole microdollars the limiter counts in.
    it("refuses a budget too large to meter", () => {
      expect(() => parseAppConfig(withLimits({
        per_user: scope({ spending: { monthly_usd: 1e12 } }),
        per_app: scope(),
      }))).toThrowError("monthly_usd is too large");
    });

    /*
     * An application that identifies no end users has nobody for a per-user
     * limit to apply to, so configuring one would be a cap the operator
     * believes in and the gateway never applies.
     */
    it("refuses per-user limits on an application with no end users", () => {
      expect(() => parseAppConfig({ ...serverConfig(), limits: { per_user: scope() } }))
        .toThrowError("limits.per_user: needs an authentication.end_user source");
      // All-null is not a configured limit, so it is accepted on the same app.
      expect(() => parseAppConfig({
        ...serverConfig(),
        limits: {
          per_user: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
        },
      })).not.toThrow();
    });
  });

  describe("endpoints", () => {
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

    it("keeps a valid endpoints block verbatim", () => {
      const transcribe = {
        api_style: "transcription",
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
      };
      expect(validateConfig(serverConfig({ endpoints: { chat, transcribe } })).endpoints)
        .toEqual({ chat, transcribe });
    });

    it.each(["Chat", "chat_completions", "", "a".repeat(65), "chat/1", "constructor"])(
      "refuses the invalid slug %s",
      (slug) => {
        expect(() => parseAppConfig(serverConfig({ endpoints: { [slug]: chat } })))
          .toThrowError("is not a valid slug");
      },
    );

    it("refuses an unknown api_style", () => {
      expect(() => parseAppConfig(serverConfig({
        endpoints: { chat: { ...chat, api_style: "chat_completions" } },
      }))).toThrowError("endpoints.chat.api_style");
    });

    it.each([0, -1, 1.5, "4096"])("refuses the max_output_tokens %s", (value) => {
      expect(() => parseAppConfig(serverConfig({
        endpoints: { chat: { ...chat, max_output_tokens: value } },
      }))).toThrowError("endpoints.chat.max_output_tokens");
    });

    it.each([[[]], ["low"], [null]])("refuses non-object params %s", (params) => {
      expect(() => parseAppConfig(serverConfig({
        endpoints: { chat: { ...chat, params } },
      }))).toThrowError("endpoints.chat.params");
    });

    it("refuses a target with no model", () => {
      expect(() => parseAppConfig(serverConfig({
        endpoints: { chat: { ...chat, model: "" } },
      }))).toThrowError("endpoints.chat.model");
    });

    // An unguarded lookup would let a target resolve through Object.prototype
    // as an instance nobody configured. `SlugSchema` refuses the reserved names
    // outright, at both ends: no provider row can hold one either.
    it.each(["constructor", "prototype"])("refuses the reserved target slug %s", (provider) => {
      expect(() => parseAppConfig(serverConfig({
        endpoints: { chat: { ...chat, provider } },
      }))).toThrowError("endpoints.chat.provider: key cannot be");
      expect(() => parseAppConfig(serverConfig({
        endpoints: { chat: { ...chat, fallback: [{ provider, model: "m" }] } },
      }))).toThrowError("endpoints.chat.fallback.0.provider: key cannot be");
    });
  });
});

/**
 * The checks a management write makes on top of the grammar: they need the
 * organization's own provider rows, so they live beside the schema rather than
 * inside it.
 */
describe("organization-scoped configuration references", () => {
  it("rejects allowlisted and fixed models without provider pricing", () => {
    expect(() => validateConfig(serverConfig({
      proxy: {
        openai: { allowed_paths: [], allowed_models: ["released-today"] },
      },
    }))).toThrowError("has no configured price");
    expect(() => validateConfig(serverConfig({
      proxy: {
        xai: {
          allowed_paths: [{ path: "v1/stt", fixed_model: "released-today" }],
          allowed_models: [],
        },
      },
    }))).toThrowError("has no configured price");
  });

  it("accepts an unpriced client alias when it rewrites to a priced provider model", () => {
    expect(() => validateConfig(serverConfig({
      proxy: {
        openai: { allowed_paths: [], allowed_models: ["client-alias"] },
        model_rewrites: { "client-alias": "gpt-5.6-sol" },
      },
    }))).not.toThrow();
  });

  /**
   * Configuration is judged by the same predicate a request is. An OpenRouter
   * row's models are billable because the route reports what it charged, so
   * restricting an app to its slugs must save — the old price-only check
   * refused every one of them for want of a catalog entry that, by design, will
   * never exist.
   */
  it("accepts model restrictions on a cost-reporting instance", () => {
    const providers = {
      router: {
        id: "provider-openrouter",
        slug: "router",
        type: "openrouter" as const,
        route: "direct" as const,
        pricing: null,
        status: "active" as const,
      },
    };
    expect(() => validateConfig(serverConfig({
      proxy: {
        router: {
          allowed_paths: [{ path: "v1/chat/completions", fixed_model: "qwen/qwen3-max" }],
          allowed_models: ["google/gemini-3.6-flash", "meta-llama/llama-4-scout"],
        },
      },
    }), providers)).not.toThrow();
  });

  /** The fail-closed half: a type that bills on a local price still needs one. */
  it("still refuses an unpriced model on an instance that does not report cost", () => {
    const providers = {
      main: {
        id: "provider-openai",
        slug: "main",
        type: "openai" as const,
        route: "direct" as const,
        pricing: null,
        status: "active" as const,
      },
    };
    expect(() => validateConfig(serverConfig({
      proxy: { main: { allowed_paths: [], allowed_models: ["gpt-not-in-any-catalog"] } },
    }), providers)).toThrowError("has no configured price");
    expect(() => validateConfig(serverConfig({
      proxy: {
        main: {
          allowed_paths: [{ path: "v1/responses", fixed_model: "gpt-not-in-any-catalog" }],
          allowed_models: [],
        },
      },
    }), providers)).toThrowError("has no configured price");
  });

  it("validates selected policies against configured provider instance slugs", () => {
    const providers = {
      "openai-dev": {
        id: "provider-openai-dev",
        slug: "openai-dev",
        type: "openai" as const,
        route: "direct" as const,
        pricing: null,
        status: "active" as const,
      },
    };
    expect(() => validateConfig(serverConfig({
      proxy: {
        "openai-dev": {
          allowed_paths: ["v1/responses"],
          allowed_models: ["gpt-5.6-sol"],
        },
      },
    }), providers)).not.toThrow();
    expect(() => validateConfig(serverConfig({
      proxy: {
        openai: {
          allowed_paths: ["v1/responses"],
          allowed_models: ["gpt-5.6-sol"],
        },
      },
    }), providers)).toThrowError("Unknown provider instance openai");
  });

  it("rejects rewrite targets that are absent from every price catalog", () => {
    // Scoped to instances that bill on a local price, which is what makes the
    // check a check: a cost-reporting instance can bill *any* model name, so an
    // organization that runs one is answered "yes" for every target — correctly,
    // and the case below asserts exactly that.
    expect(() => validateConfig(serverConfig({
      proxy: { model_rewrites: { alias: "released-today" } },
    }), {
      openai: {
        id: "p1",
        slug: "openai",
        type: "openai",
        route: "direct",
        pricing: null,
        status: "active",
      },
    })).toThrowError("has no configured price");
  });

  /**
   * The other half of the same rule. An OpenRouter row bills on the cost
   * OpenRouter reports, so its slugs are deliberately absent from the shipped
   * catalog — refusing to save a rewrite that targets one would be demanding a
   * price the proxy never asks for.
   */
  it("accepts a rewrite target only a cost-reporting instance can bill", () => {
    expect(() => validateConfig(serverConfig({
      proxy: { model_rewrites: { fast: "google/gemini-3.6-flash" } },
    }), {
      router: {
        id: "p2",
        slug: "router",
        type: "openrouter",
        route: "direct",
        pricing: null,
        status: "active",
      },
    })).not.toThrow();
  });

  // A rewrite target names a model, not an instance, so it is priced against the
  // shipped catalog. An organization that has not added a provider yet must
  // still be able to save an app that rewrites models.
  it("prices rewrite targets from the catalog even with no configured providers", () => {
    expect(() => validateConfig(serverConfig({
      proxy: { model_rewrites: { "client-alias": "gpt-5.6-sol" } },
    }), {})).not.toThrow();
    expect(() => validateConfig(serverConfig({
      proxy: { model_rewrites: { "client-alias": "released-today" } },
    }), {})).toThrowError("has no configured price");
  });

  it("prices a rewrite target from an instance override the catalog does not know", () => {
    expect(() => validateConfig(serverConfig({
      proxy: { model_rewrites: { "client-alias": "released-today" } },
    }), {
      "openai-dev": {
        id: "provider-openai-dev",
        slug: "openai-dev",
        type: "openai" as const,
        route: "direct" as const,
        pricing: { "released-today": { input: 1, output: 2 } },
        status: "active" as const,
      },
    })).not.toThrow();
  });

  // Deleting a provider must not brick later edits of apps that name its slug.
  it("tolerates already-stored slugs but not newly introduced ones", () => {
    const config = serverConfig({
      proxy: { "openai-dev": { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] } },
    });
    expect(() => validateConfig(config, {})).toThrowError(
      "Unknown provider instance openai-dev",
    );
    expect(() => validateConfig(config, {}, new Set(["openai-dev"])))
      .not.toThrow();
    expect(() => validateConfig(config, {}, new Set(["openai-prod"])))
      .toThrowError("Unknown provider instance openai-dev");
    const endpointConfig = serverConfig({
      endpoints: {
        chat: { api_style: "responses", provider: "openai-dev", model: "gpt-5.6-luna" },
      },
    });
    expect(() => validateConfig(endpointConfig, {})).toThrowError(
      "endpoints.chat.provider openai-dev is not configured",
    );
    expect(() => validateConfig(endpointConfig, {}, new Set(["openai-dev"])))
      .not.toThrow();
  });

  it("rejects an endpoint model without a configured price", () => {
    expect(() => validateConfig(serverConfig({
      endpoints: { chat: { api_style: "responses", provider: "openai", model: "released-today" } },
    }))).toThrowError("has no configured price");
    expect(() => validateConfig(serverConfig({
      endpoints: {
        chat: {
          api_style: "responses",
          provider: "openai",
          model: "gpt-5.6-luna",
          fallback: [{ provider: "xai", model: "released-today" }],
        },
      },
    }))).toThrowError("endpoints.chat.fallback[0].model");
  });

  it.each(["gemini", "anthropic", "perplexity"])(
    "rejects the unsupported endpoint provider %s",
    (provider) => {
      expect(() => validateConfig(serverConfig({
        endpoints: { chat: { api_style: "responses", provider, model: "gpt-5.6-luna" } },
      }))).toThrowError(`endpoints.chat.provider ${provider} is a ${provider} instance, which does not support responses`);
      expect(() => validateConfig(serverConfig({
        endpoints: {
          chat: {
            api_style: "responses",
            provider: "openai",
            model: "gpt-5.6-luna",
            fallback: [{ provider, model: "gpt-5.6-luna" }],
          },
        },
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
        status: "active" as const,
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
    expect(() => validateConfig(transcribe, instance("vercel"))).toThrowError(
      "endpoints.speech.provider openai-routed is a openai instance routed through a vercel gateway, which does not support transcription",
    );
    // The same endpoint is fine on either route that reaches OpenAI's own API.
    for (const route of ["direct", "cf_aig"] as const) {
      expect(() => validateConfig(transcribe, instance(route))).not.toThrow();
    }
    // A Responses endpoint works on all three: Vercel serves that one.
    const respond = serverConfig({
      endpoints: {
        chat: { api_style: "responses", provider: "openai-routed", model: "gpt-5.6-luna" },
      },
    });
    for (const route of ["direct", "cf_aig", "vercel"] as const) {
      expect(() => validateConfig(respond, instance(route))).not.toThrow();
    }
  });

  /**
   * A row attached to a gateway with no adapter has no describable capabilities,
   * so it cannot back an endpoint. Approving it because its route reads as
   * unknown would be the accept-then-502 the save-time check exists to avoid.
   */
  it("rejects an endpoint on an instance whose gateway has no adapter", () => {
    const unroutable = {
      "openai-routed": {
        id: "provider-openai-routed",
        slug: "openai-routed",
        type: "openai" as const,
        route: null,
        pricing: null,
        status: "active" as const,
      },
    };
    for (const style of ["responses", "transcription"] as const) {
      expect(() => validateConfig(
        serverConfig({
          endpoints: {
            one: { api_style: style, provider: "openai-routed", model: "gpt-5.6-luna" },
          },
        }),
        unroutable,
      )).toThrowError(
        `endpoints.one.provider openai-routed is routed through a provider gateway this deployment has no adapter for, so it cannot serve ${style} endpoints`,
      );
    }
  });
});

/** The public schema and the one the gateway parses with are the same object. */
describe("the published schema", () => {
  it("accepts what the parser produces", () => {
    expect(AppConfigSchema.safeParse(parseAppConfig(serverConfig())).success).toBe(true);
  });
});
