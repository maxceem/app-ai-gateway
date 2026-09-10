import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { apiStyleFromPath, outputClampStyle, API_STYLES } from "../src/core/api-styles";
import {
  assertApiStyleSupported,
  assertRouteServesProvider,
  ENDPOINT_PROVIDER_TYPES,
  narrowedCapability,
  providersForEndpointStyle,
  routeCanonicalModel,
  routeCapability,
  routeWireModel,
  supportsApiStyle,
  supportsEndpointStyle,
  type ProviderRoute,
} from "../src/core/capabilities";
import { clearAppConfigCache } from "../src/core/config";
import {
  assertGatewayRoute,
  canonicalModel,
  CF_AI_GATEWAY_BASE_URL,
  credentialSource,
  GATEWAY_ADAPTERS,
  gatewayBodyMutation,
  gatewayProbe,
  gatewayUpstream,
  wireModel,
} from "../src/core/gateways";
import { clearProviderCaches } from "../src/core/provider-store";
import { probeProviderGateway } from "../src/core/provider-probe";
import {
  providerAuthValue,
  providerModelAuthor,
  providerProbeHeaders,
  providerRequestHeaders,
  PROVIDER_REGISTRY,
  PROVIDER_TYPES,
  reportsCost,
} from "../src/core/providers";
import { RESERVED_UPSTREAM_HEADERS } from "../src/core/proxyrules";
import * as SHARED from "../src/shared/capabilities";
import type { ProviderGatewayType } from "../src/db/schema";
import type { OutputClampStyle, ProviderType } from "../src/core/types";
import { database } from "../src/db";
import { provider } from "../src/db/schema";
import { gatewayToken, seedApp, seedProvider } from "./helpers";

const CF_AIG = { type: "cf_aig", config: { accountId: "acct-1", gatewayId: "gw-1" } } as const;

/**
 * The provider types verified against a live Cloudflare AI Gateway. Every other
 * type is direct-only by the matrix default, which is what makes adding one a
 * registry change rather than an adapter change.
 */
const CF_AIG_PROVIDERS = ["openai", "anthropic", "xai", "gemini", "perplexity"] as const;

/** The Stage 3 batch: OpenAI-compatible, pass-through only, no gateway mapping. */
const OPENAI_COMPATIBLE_PROVIDERS = [
  "deepseek",
  "groq",
  "mistral",
  "together",
  "fireworks",
  "cerebras",
  "moonshot",
  "huggingface",
  "baseten",
  "bytedance",
] as const;

let pending: ExecutionContext[] = [];

beforeEach(() => {
  clearProviderCaches();
  clearAppConfigCache();
});

afterEach(async () => {
  await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
  pending = [];
  vi.restoreAllMocks();
  clearProviderCaches();
  clearAppConfigCache();
});

describe("API style classification", () => {
  it.each([
    ["v1/responses", "responses"],
    ["v1/chat/completions", "chat_completions"],
    ["v1beta/openai/chat/completions", "chat_completions"],
    ["v1/messages", "anthropic_messages"],
    ["v1beta/models/gemini-3.6-flash:generateContent", "gemini_native"],
    // Streaming spells the operation `:streamGenerateContent`, which the
    // gateway has never matched; Gemini's own shape carries it instead.
    ["v1beta/models/gemini-3.6-flash:streamGenerateContent", "other"],
    ["v1/audio/transcriptions", "audio_transcription"],
    ["v1/stt", "audio_transcription"],
    ["v1/embeddings", "other"],
    ["v1/models", "other"],
  ] as const)("reads %s as %s regardless of who serves it", (path, style) => {
    expect(apiStyleFromPath(path)).toBe(style);
  });

  /**
   * The clamp table used to be a single provider-aware path sniff. It is
   * reproduced verbatim here as an oracle: the style split may not change which
   * body field the gateway caps for any request expressible today.
   */
  function legacyClampStyle(providerType: ProviderType, providerPath: string): OutputClampStyle {
    if (providerPath.endsWith("audio/transcriptions") || providerPath === "v1/stt") return "none";
    if (providerPath.includes("chat/completions")) return "chat_completions";
    if (providerPath.endsWith("responses")) return "responses";
    if (providerPath.includes("generateContent")) return "gemini_native";
    if (providerType === "anthropic") return "anthropic";
    if (providerType === "gemini") return "gemini_native";
    return "responses";
  }

  const PATHS = [
    "v1/responses",
    "v1/chat/completions",
    "chat/completions",
    "v1beta/openai/chat/completions",
    "v1/messages",
    "v1/complete",
    "v1/embeddings",
    "v1/models",
    "v1/audio/transcriptions",
    "v1/stt",
    "v1beta/models/gemini-3.6-flash:generateContent",
    "v1beta/models/gemini-3.6-flash:streamGenerateContent",
    "openai/v1/responses",
  ];

  // Scoped to the types that existed before the OpenAI-compatible batch: those
  // are the only ones whose behavior a refactor could regress. The new types
  // clamp their own native shape, asserted separately below.
  it("clamps exactly what the pre-refactor rules clamped", () => {
    for (const providerType of CF_AIG_PROVIDERS) {
      for (const path of PATHS) {
        expect([providerType, path, outputClampStyle(apiStyleFromPath(path), providerType)])
          .toEqual([providerType, path, legacyClampStyle(providerType, path)]);
      }
    }
  });

  it.each(OPENAI_COMPATIBLE_PROVIDERS)(
    "caps a provider-native %s path on the chat-completions field",
    (type) => {
      // These providers' own request shape *is* chat completions, so a path
      // with no cross-provider style still caps the field they read.
      expect(outputClampStyle(apiStyleFromPath("v1/embeddings"), type)).toBe("chat_completions");
      expect(outputClampStyle(apiStyleFromPath("openai/v1/chat/completions"), type))
        .toBe("chat_completions");
    },
  );
});

describe("capability matrix", () => {
  // OpenRouter is the one narrowed entry and is asserted on its own below: its
  // other surfaces report no cost, and its models have no local price.
  const PASS_THROUGH_PROVIDERS = PROVIDER_TYPES.filter((type) => type !== "openrouter");

  it.each(PASS_THROUGH_PROVIDERS)("forwards every API style to %s on a direct route", (type) => {
    for (const style of API_STYLES) {
      expect(supportsApiStyle("direct", type, style)).toBe(true);
    }
  });

  it.each(CF_AIG_PROVIDERS)("forwards every API style to %s through cf_aig", (type) => {
    for (const style of API_STYLES) {
      expect(supportsApiStyle("cf_aig", type, style)).toBe(true);
    }
  });

  it.each(OPENAI_COMPATIBLE_PROVIDERS)("serves %s directly and never through cf_aig", (type) => {
    for (const style of API_STYLES) {
      expect(supportsApiStyle("direct", type, style)).toBe(true);
      // No mapping means direct-only for that gateway: the request is refused at
      // the edge rather than sent to a Cloudflare URL guessed from the name.
      expect(supportsApiStyle("cf_aig", type, style)).toBe(false);
    }
    expect(routeCapability("cf_aig", type)).toBeNull();
    expect(() => assertApiStyleSupported("cf_aig", type, "chat_completions"))
      .toThrow(/does not support this API/u);
    expect(() => assertRouteServesProvider("cf_aig", type))
      .toThrow(/do not serve/u);
    expect(() => assertRouteServesProvider("direct", type)).not.toThrow();
  });

  it("keeps the rest of the batch direct-only on Vercel too", () => {
    // Vercel adds `deepseek` and `moonshot` — the two whose Vercel model IDs
    // really are the provider's own — and nothing else from this batch.
    for (const type of OPENAI_COMPATIBLE_PROVIDERS) {
      const served = type === "deepseek" || type === "moonshot";
      expect([type, routeCapability("vercel", type) !== null]).toEqual([type, served]);
    }
  });

  /**
   * The narrowing is a billing guarantee, not a claim about OpenRouter's API
   * surface: it serves `/responses` and `/messages` too, but neither response
   * reports a cost, and no local price covers its slugs — so those requests
   * could only ever be recorded as unresolved. Refusing them at the edge is the
   * fail-closed half of "a request is only proxied if it can be billed".
   */
  it("offers OpenRouter the one API style it can be billed on", () => {
    expect(routeCapability("direct", "openrouter")).toEqual({
      apiStyles: ["chat_completions"],
      endpointStyles: [],
    });
    expect(supportsApiStyle("direct", "openrouter", "chat_completions")).toBe(true);
    for (const style of API_STYLES.filter((value) => value !== "chat_completions")) {
      expect([style, supportsApiStyle("direct", "openrouter", style)]).toEqual([style, false]);
    }
    expect(() => assertApiStyleSupported("direct", "openrouter", "responses"))
      .toThrow(/does not support this API/u);
    // Aggregator: no gateway maps it, so it is direct-only like the Stage 3 batch.
    expect(routeCapability("cf_aig", "openrouter")).toBeNull();
  });

  it("keeps named-endpoint eligibility where it was", () => {
    expect(ENDPOINT_PROVIDER_TYPES).toEqual(["openai", "xai"]);
    expect(providersForEndpointStyle("responses")).toEqual(["openai", "xai"]);
    expect(providersForEndpointStyle("transcription")).toEqual(["openai", "xai"]);
    for (const route of ["direct", "cf_aig"] as ProviderRoute[]) {
      expect(supportsEndpointStyle(route, "openai", "responses")).toBe(true);
      expect(supportsEndpointStyle(route, "anthropic", "responses")).toBe(false);
    }
  });

  // No gateway adapter declines a provider type today, so the default and the
  // narrowing rule are exercised directly on hypothetical route entries.
  it("treats a provider type with no gateway mapping as direct-only", () => {
    const base = routeCapability("direct", "openai")!;
    expect(narrowedCapability(base, undefined)).toBeNull();
  });

  it("lets a gateway route narrow the API styles it forwards, never widen them", () => {
    const base = routeCapability("direct", "gemini")!;
    const narrowed = narrowedCapability(base, {
      slug: "google",
      apiStyles: ["responses", "chat_completions", "gemini_native"],
    })!;
    expect(narrowed.apiStyles).toEqual(["responses", "chat_completions", "gemini_native"]);
    expect(narrowed.apiStyles).not.toContain("anthropic_messages");
    // A style the provider itself does not expose cannot be added by a route.
    const invented = narrowedCapability(
      { apiStyles: ["responses"], endpointStyles: [] },
      { slug: "google", apiStyles: ["responses", "gemini_native"] },
    )!;
    expect(invented.apiStyles).toEqual(["responses"]);
  });
});

/**
 * The console imports `src/shared/capabilities.ts` rather than keeping its own
 * copy of the provider list, the gateway route tables and the cost-reporting
 * set. These assertions are what make that safe: the shared tables have to be
 * the same objects the Worker enforces with, and the one list the shared module
 * cannot derive — which types report cost, since the parser that proves it lives
 * in the registry — is pinned to the registry here.
 */
describe("the capability matrix the console shares", () => {
  it("routes gateways from the same tables the adapters do", () => {
    for (const type of Object.keys(GATEWAY_ADAPTERS) as ProviderGatewayType[]) {
      expect([type, GATEWAY_ADAPTERS[type].routes]).toEqual([type, SHARED.GATEWAY_ROUTES[type]]);
    }
    expect(Object.keys(SHARED.GATEWAY_ROUTES).sort())
      .toEqual(Object.keys(GATEWAY_ADAPTERS).sort());
  });

  it("describes each provider type with the capability the direct route enforces", () => {
    for (const type of PROVIDER_TYPES) {
      expect([type, SHARED.providerCapability(type)])
        .toEqual([type, routeCapability("direct", type)]);
    }
  });

  it("pins the cost-reporting list to the registry declarations that prove it", () => {
    // The shared list is what the console reads; the declaration is what
    // actually bills. A name on the list with no declaration would tell an
    // operator a model needs no price, and then record every request unresolved.
    const declared = PROVIDER_TYPES.filter((type) => reportsCost(type));
    expect([...SHARED.COST_REPORTING_PROVIDER_TYPES].sort()).toEqual([...declared].sort());
    for (const type of PROVIDER_TYPES) {
      expect([type, SHARED.reportsCost(type)]).toEqual([type, reportsCost(type)]);
    }
  });

  it("publishes a path per API style that classifies back to that style", () => {
    // The console shows these paths as "how to call this". A path that the
    // classifier reads as another style would be a copyable snippet the
    // capability check then refuses.
    for (const [style, path] of Object.entries(SHARED.API_STYLE_PATHS)) {
      // `{model}` is a template the console fills in; the classifier reads the
      // operation, and a real model id sits in the same segment.
      expect([style, apiStyleFromPath(path.replace("{model}", "some-model"))])
        .toEqual([style, style]);
    }
    // Every style but `other`, which names no contract and so has no path.
    expect(Object.keys(SHARED.API_STYLE_PATHS).sort())
      .toEqual(API_STYLES.filter((style) => style !== "other").sort());
  });

  it("shares the style and provider lists rather than restating them", () => {
    expect(SHARED.PROVIDER_TYPES).toBe(PROVIDER_TYPES);
    expect(SHARED.API_STYLES).toBe(API_STYLES);
    expect([...SHARED.ENDPOINT_PROVIDER_TYPES]).toEqual([...ENDPOINT_PROVIDER_TYPES]);
    for (const style of ["responses", "transcription"] as const) {
      expect([style, SHARED.providersForEndpointStyle(style)])
        .toEqual([style, providersForEndpointStyle(style)]);
    }
  });
});

describe("provider registry entries", () => {
  it.each(PROVIDER_TYPES)("reaches %s over a fixed https origin", (type) => {
    const { directBaseUrl, auth } = PROVIDER_REGISTRY[type];
    const url = new URL(directBaseUrl);
    expect(url.protocol).toBe("https:");
    // A base URL that does not end in `/` would swallow the first path
    // character when the provider path is appended to it.
    expect(directBaseUrl.endsWith("/")).toBe(true);
    expect(url.search).toBe("");
    expect(auth.header).toBe(auth.header.toLowerCase());
    // Whatever the scheme is, the credential is what follows it verbatim.
    expect(providerAuthValue(type, "SECRET"))
      .toBe(`${"scheme" in auth ? auth.scheme : ""}SECRET`);
    // Every declared auth header is stripped off client requests on every route.
    expect(RESERVED_UPSTREAM_HEADERS).toContain(auth.header);
  });

  it.each(OPENAI_COMPATIBLE_PROVIDERS)("authenticates %s with a bearer token", (type) => {
    expect(PROVIDER_REGISTRY[type].auth).toEqual({
      header: "authorization",
      scheme: "Bearer ",
    });
  });

  /**
   * Authorship is a curated claim, so it is only made where one answer covers
   * every model the type serves. A host that resells other labs' open-weight
   * models has no such answer and must resolve it per catalog entry instead —
   * saying "a Llama model served by Groq was made by Groq" would be worse than
   * saying nothing.
   */
  it("claims a default author only for a provider that makes its own models", () => {
    const authored = PROVIDER_TYPES.filter((type) => providerModelAuthor(type) !== null);
    expect(authored.sort()).toEqual([
      "anthropic",
      "deepseek",
      "gemini",
      "mistral",
      "moonshot",
      "openai",
      "perplexity",
      "xai",
    ]);
    for (
      const type of [
        "groq",
        "together",
        "fireworks",
        "cerebras",
        "huggingface",
        "baseten",
        "bytedance",
        // An aggregator serves every lab's models: authorship comes from the
        // slug namespace per model, never from the type.
        "openrouter",
      ] as const
    ) {
      expect([type, providerModelAuthor(type)]).toEqual([type, null]);
    }
  });

  it("reaches OpenRouter at its own origin and bills on what it reports", () => {
    // `/api/v1` is OpenRouter's documented server URL, so the client path under
    // the slug is `v1/chat/completions`.
    expect(PROVIDER_REGISTRY.openrouter.directBaseUrl).toBe("https://openrouter.ai/api/");
    expect(PROVIDER_REGISTRY.openrouter.auth).toEqual({
      header: "authorization",
      scheme: "Bearer ",
    });
    expect(reportsCost("openrouter")).toBe(true);
    // The header that makes OpenRouter name the host it routed to. Declared on
    // the spec, so the sanitizer strips a client's version of it everywhere.
    expect(providerRequestHeaders("openrouter")).toEqual({ "x-openrouter-metadata": "enabled" });
    expect(RESERVED_UPSTREAM_HEADERS).toContain("x-openrouter-metadata");
    for (const type of PROVIDER_TYPES.filter((value) => value !== "openrouter")) {
      expect([type, providerRequestHeaders(type)]).toEqual([type, {}]);
    }
  });

  /**
   * The probe reads its extra headers off the spec instead of naming a provider
   * type, so a probe can never test a request shape the registry does not
   * describe. Kept apart from `requestHeaders` deliberately: `anthropic-version`
   * is the *client's* API version on live traffic — every Anthropic SDK sets one
   * — and injecting it server-side would strip that choice and silently
   * downgrade every request to the oldest version.
   */
  it("declares probe headers on the spec rather than in the probe", () => {
    expect(providerProbeHeaders("anthropic")).toEqual({ "anthropic-version": "2023-06-01" });
    // And it stays out of live traffic: not a request header, not reserved, so
    // a client's own version still reaches the upstream.
    expect(providerRequestHeaders("anthropic")).toEqual({});
    expect(RESERVED_UPSTREAM_HEADERS).not.toContain("anthropic-version");
    for (const type of PROVIDER_TYPES.filter((value) => value !== "anthropic")) {
      expect([type, providerProbeHeaders(type)]).toEqual([type, {}]);
    }
  });

  it("carries a provider's probe headers through a gateway probe too", async () => {
    // Cloudflare forwards to Anthropic's real API, which refuses a request with
    // no version header however it arrived.
    const seen: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      seen.push(new Headers(init?.headers));
      return Response.json({ data: [] });
    });
    await probeProviderGateway({ type: "anthropic", gateway: CF_AIG, token: "cf-token" });
    expect(seen[0]?.get("anthropic-version")).toBe("2023-06-01");
    expect(seen[0]?.get("cf-aig-authorization")).toBe("Bearer cf-token");
  });

  it("reports no provider type in this batch as cost-reporting", () => {
    // Fail-closed default: only a route that really returns a per-request cost
    // may bill without a local price, and none of these do.
    for (const type of OPENAI_COMPATIBLE_PROVIDERS) {
      expect([type, reportsCost(type)]).toEqual([type, false]);
    }
  });
});

describe("canonical model identity", () => {
  it("leaves models untouched on a route with no namespace of its own", () => {
    for (const type of PROVIDER_TYPES) {
      for (const route of ["direct", "cf_aig"] as ProviderRoute[]) {
        expect(routeWireModel(route, type, "gemini-3.6-flash")).toBe("gemini-3.6-flash");
        expect(routeCanonicalModel(route, type, "gemini-3.6-flash")).toBe("gemini-3.6-flash");
      }
    }
  });

  it("prepends and strips a route's own prefix, and only its own", () => {
    const route = { slug: "google", modelPrefix: "google/" };
    expect(wireModel(route, "gemini-3.6-flash")).toBe("google/gemini-3.6-flash");
    expect(canonicalModel(route, "google/gemini-3.6-flash")).toBe("gemini-3.6-flash");
    // Another gateway's namespace is data, not a prefix to remove.
    expect(canonicalModel(route, "vertex/gemini-3.6-flash")).toBe("vertex/gemini-3.6-flash");
  });

  it("keeps canonical IDs that contain a slash of their own", () => {
    // "Everything before the first slash" would rename both of these; only the
    // adapter's configured prefix may ever come off.
    const route = { slug: "fal", modelPrefix: "fal/" };
    expect(canonicalModel(route, "fal/fal-ai/fast-sdxl")).toBe("fal-ai/fast-sdxl");
    expect(canonicalModel(undefined, "google/gemini-3.6-flash")).toBe("google/gemini-3.6-flash");
    expect(wireModel(undefined, "meta-llama/llama-4")).toBe("meta-llama/llama-4");
  });
});

describe("provider gateway routing configuration", () => {
  it("refuses a routing configuration for a Cloudflare gateway", () => {
    expect(() => assertGatewayRoute("cf_aig", null)).not.toThrow();
    expect(() => assertGatewayRoute("cf_aig", { modelPrefix: "google/" }))
      .toThrow(/takes no per-provider routing configuration/u);
  });

  it("refuses a routing configuration on a direct instance, which has no gateway", () => {
    expect(() => assertGatewayRoute(null, null)).not.toThrow();
    expect(() => assertGatewayRoute(null, { modelPrefix: "google/" }))
      .toThrow(/routed through a gateway/u);
  });

  it("names the credential a route pays with, or nothing when it is unknown", () => {
    expect(credentialSource(null)).toBe("direct");
    expect(credentialSource({ type: "cf_aig" })).toBe("byok");
  });
});

describe("Cloudflare AI Gateway adapter", () => {
  const adapter = GATEWAY_ADAPTERS.cf_aig;

  it("maps only the provider types verified against a live gateway", () => {
    // Deliberately a subset of PROVIDER_TYPES: a slug read off Cloudflare's docs
    // is a guess about a URL and about whose key that gateway holds, so a type
    // stays direct-only until someone has actually run traffic through it.
    expect(Object.keys(adapter.routes).sort()).toEqual([...CF_AIG_PROVIDERS].sort());
    for (const type of OPENAI_COMPATIBLE_PROVIDERS) {
      expect(adapter.routes[type]).toBeUndefined();
    }
    expect(adapter.routes.openai).toEqual({ slug: "openai", stripPathPrefix: "v1/" });
    for (const type of CF_AIG_PROVIDERS) {
      if (type === "openai") continue;
      expect(adapter.routes[type]?.stripPathPrefix).toBeUndefined();
    }
  });

  it.each([
    ["openai", "v1/responses", `${CF_AI_GATEWAY_BASE_URL}/acct-1/gw-1/openai/responses`],
    ["anthropic", "v1/messages", `${CF_AI_GATEWAY_BASE_URL}/acct-1/gw-1/anthropic/v1/messages`],
    ["xai", "v1/responses", `${CF_AI_GATEWAY_BASE_URL}/acct-1/gw-1/grok/v1/responses`],
    [
      "gemini",
      "v1beta/models/gemini-3.6-flash:generateContent",
      `${CF_AI_GATEWAY_BASE_URL}/acct-1/gw-1/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent`,
    ],
    [
      "perplexity",
      "chat/completions",
      `${CF_AI_GATEWAY_BASE_URL}/acct-1/gw-1/perplexity-ai/chat/completions`,
    ],
  ] as Array<[ProviderType, string, string]>)(
    "builds the %s upstream URL and its own auth headers",
    (type, providerPath, url) => {
      const request = gatewayUpstream({
        gateway: CF_AIG,
        secret: "gateway-token",
        provider: type,
        providerPath,
        query: "?stream=true",
        appId: "app-1",
        userId: "user-1",
      });
      expect(request.url).toBe(`${url}?stream=true`);
      expect(request.headers).toEqual({
        "cf-aig-authorization": "Bearer gateway-token",
        "cf-aig-metadata": JSON.stringify({ app_id: "app-1", user_id: "user-1" }),
      });
      // The provider's own credential header is never part of a gateway call.
      expect(Object.keys(request.headers)).not.toContain(PROVIDER_REGISTRY[type].auth.header);
    },
  );

  it("escapes the account and gateway identifiers it is given", () => {
    const request = gatewayUpstream({
      gateway: { type: "cf_aig", config: { accountId: "acct/1", gatewayId: "gw 1" } },
      secret: "gateway-token",
      provider: "openai",
      providerPath: "v1/responses",
      query: "",
      appId: "app-1",
      userId: "user-1",
    });
    expect(request.url).toBe(`${CF_AI_GATEWAY_BASE_URL}/acct%2F1/gw%201/openai/responses`);
  });

  it("probes through the same URL construction live traffic uses", () => {
    expect(gatewayProbe({
      gateway: CF_AIG,
      secret: "gateway-token",
      provider: "openai",
      path: "v1/models",
    })).toEqual({
      url: `${CF_AI_GATEWAY_BASE_URL}/acct-1/gw-1/openai/models`,
      headers: { "cf-aig-authorization": "Bearer gateway-token" },
    });
    expect(gatewayProbe({
      gateway: CF_AIG,
      secret: "gateway-token",
      provider: "anthropic",
      path: "v1/models",
    })?.url).toBe(`${CF_AI_GATEWAY_BASE_URL}/acct-1/gw-1/anthropic/v1/models`);
  });

  it("sends the credential probe to the adapter's URL, never a second one", async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      urls.push(typeof request === "string" ? request : String(request));
      const sent: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        sent[name] = value;
      });
      headers.push(sent);
      return new Response("{}", { status: 200 });
    });

    await expect(probeProviderGateway({
      type: "anthropic",
      gateway: { type: "cf_aig", config: { accountId: "acct-1", gatewayId: "gw-1" } },
      token: "gateway-token",
    })).resolves.toEqual({ validated: true });
    expect(urls).toEqual([`${CF_AI_GATEWAY_BASE_URL}/acct-1/gw-1/anthropic/v1/models`]);
    expect(headers[0]).toMatchObject({
      "cf-aig-authorization": "Bearer gateway-token",
      "anthropic-version": "2023-06-01",
    });
  });
});

/**
 * Facts checked against Vercel's own documentation and its live public model
 * catalog (August 2026), not against memory: the origin, the three APIs it
 * republishes, and one namespace per provider type. `spacexai/` is why the
 * catalog check exists — the obvious guess for xAI would 404 every request.
 */
describe("Vercel AI Gateway adapter", () => {
  const adapter = GATEWAY_ADAPTERS.vercel;
  const VERCEL = { type: "vercel", config: {} } as const;
  const VERCEL_PROVIDERS = [
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "perplexity",
    "deepseek",
    "moonshot",
  ] as const;

  it("maps only the provider types whose Vercel namespace was verified", () => {
    expect(Object.keys(adapter.routes).sort()).toEqual([...VERCEL_PROVIDERS].sort());
    // Vercel namespaces a model ID by its *author*, so a host that serves other
    // labs' weights has no namespace at all and stays direct-only — as do the
    // types whose Vercel IDs are not the provider's own.
    for (const type of ["groq", "together", "fireworks", "cerebras", "huggingface", "baseten", "mistral", "bytedance", "openrouter"] as const) {
      expect([type, adapter.routes[type]]).toEqual([type, undefined]);
    }
    expect(
      Object.fromEntries(
        VERCEL_PROVIDERS.map((type) => [type, adapter.routes[type]?.modelPrefix]),
      ),
    ).toEqual({
      openai: "openai/",
      anthropic: "anthropic/",
      gemini: "google/",
      xai: "spacexai/",
      perplexity: "perplexity/",
      deepseek: "deepseek/",
      moonshot: "moonshotai/",
    });
  });

  it("carries three client APIs and refuses the native ones it does not have", () => {
    for (const type of VERCEL_PROVIDERS) {
      expect([type, adapter.routes[type]?.apiStyles]).toEqual([
        type,
        ["responses", "chat_completions", "anthropic_messages"],
      ]);
      // Not a URL space per provider: `gemini_native` has no Vercel path, and
      // `v1/audio/transcriptions` answers 404 on this origin.
      expect(supportsApiStyle("vercel", type, "gemini_native")).toBe(false);
      expect(supportsApiStyle("vercel", type, "audio_transcription")).toBe(false);
      expect(supportsApiStyle("vercel", type, "other")).toBe(false);
      for (const style of ["responses", "chat_completions", "anthropic_messages"] as const) {
        expect([type, style, supportsApiStyle("vercel", type, style)]).toEqual([type, style, true]);
      }
    }
    // Named endpoints narrow the same way: a Responses endpoint composes a body
    // Vercel serves, a transcription endpoint one it does not.
    expect(supportsEndpointStyle("vercel", "openai", "responses")).toBe(true);
    expect(supportsEndpointStyle("vercel", "openai", "transcription")).toBe(false);
    expect(supportsEndpointStyle("cf_aig", "openai", "transcription")).toBe(true);
  });

  it.each([
    ["v1/chat/completions", "https://ai-gateway.vercel.sh/v1/chat/completions"],
    ["v1/responses", "https://ai-gateway.vercel.sh/v1/responses"],
    ["v1/messages", "https://ai-gateway.vercel.sh/v1/messages"],
  ])("appends the client path %s verbatim", (providerPath, url) => {
    const request = gatewayUpstream({
      gateway: VERCEL,
      secret: "vck_gateway_token",
      provider: "gemini",
      providerPath,
      query: "?stream=true",
      appId: "app-1",
      userId: "user-1",
    });
    // No account, team, or provider segment, and nothing stripped: Vercel names
    // the provider in the model ID, so one URL space serves all of them.
    expect(request.url).toBe(`${url}?stream=true`);
    expect(request.headers).toEqual({
      authorization: "Bearer vck_gateway_token",
      "ai-reporting-user": "user-1",
      "ai-reporting-tags": "app:app-1",
    });
  });

  it("drops attribution Vercel would reject rather than sending a wrong value", () => {
    const request = gatewayUpstream({
      gateway: VERCEL,
      secret: "vck_gateway_token",
      provider: "openai",
      providerPath: "v1/responses",
      query: "",
      // Over Vercel's documented 256-character limit for `user`; sending a
      // truncated id would attribute the spend to somebody else, and sending
      // the full one would 400 the whole request.
      appId: "app-1",
      userId: "u".repeat(300),
    });
    expect(request.headers["ai-reporting-user"]).toBeUndefined();
    expect(request.headers["ai-reporting-tags"]).toBe("app:app-1");
    expect(request.headers.authorization).toBe("Bearer vck_gateway_token");
  });

  /**
   * User ids come from an issuer's JWT claim, so they are the user's own data:
   * an email address with an accent in it, or anything carrying a control
   * character, is not a legal header value and `Headers.set` throws on it.
   * Unguarded, every request from that user answered 500.
   */
  it.each([
    ["a non-Latin-1 id", "józsef@example.com"],
    ["a full-width id", "ユーザー-1"],
    ["a carriage return", "user-1\r\nx-injected: yes"],
    ["a bare newline", "user\n1"],
    ["a NUL", "user 1"],
    ["a delete character", "user1"],
  ])("drops %s rather than failing the request", (_name, userId) => {
    const request = gatewayUpstream({
      gateway: VERCEL,
      secret: "vck_gateway_token",
      provider: "openai",
      providerPath: "v1/responses",
      query: "",
      appId: "app-1",
      userId,
    });
    expect(request.headers["ai-reporting-user"]).toBeUndefined();
    // The request itself is unaffected: only Vercel's own spend report loses a
    // row, and this deployment records the real user id on the usage event.
    expect(request.headers.authorization).toBe("Bearer vck_gateway_token");
    expect(request.headers["ai-reporting-tags"]).toBe("app:app-1");
    // The whole point: these are values `Headers` accepts without throwing.
    expect(() => new Headers(request.headers)).not.toThrow();
  });

  it("keeps a printable-ASCII id, spaces and all", () => {
    const request = gatewayUpstream({
      gateway: VERCEL,
      secret: "vck_gateway_token",
      provider: "openai",
      providerPath: "v1/responses",
      query: "",
      appId: "app-1",
      userId: "user 1 | ~tenant",
    });
    expect(request.headers["ai-reporting-user"]).toBe("user 1 | ~tenant");
  });

  it("probes the gateway's own credits endpoint, whatever provider it is asked about", () => {
    // Provider-independent because the credential is: one Vercel key per
    // gateway, and the provider keys it may use are in Vercel's dashboard.
    for (const type of VERCEL_PROVIDERS) {
      expect(gatewayProbe({
        gateway: VERCEL,
        secret: "vck_gateway_token",
        provider: type,
        // Perplexity has no probe path of its own; the gateway still has one.
        path: type === "perplexity" ? null : "v1/models",
      })).toEqual({
        url: "https://ai-gateway.vercel.sh/v1/credits",
        headers: { authorization: "Bearer vck_gateway_token" },
      });
    }
    expect(gatewayProbe({
      gateway: VERCEL,
      secret: "vck_gateway_token",
      provider: "groq",
      path: "openai/v1/models",
    })).toBeNull();
  });

  it("claims no credential source, because Vercel documents a fallback", () => {
    // BYOK is *preferred*, and Vercel documents retrying with its own system
    // credentials when a stored key fails. Nothing at configuration time
    // settles which one paid, so nothing is claimed.
    expect(adapter.credentialSource).toBeNull();
    expect(credentialSource({ type: "vercel" })).toBeNull();
  });

  it("accepts the routing configuration it can honour and rejects the rest", () => {
    expect(() => assertGatewayRoute("vercel", null)).not.toThrow();
    expect(() => assertGatewayRoute("vercel", {})).not.toThrow();
    expect(() => assertGatewayRoute("vercel", { modelPrefix: "google/" })).not.toThrow();
    expect(() => assertGatewayRoute("vercel", { providerOnly: ["vertex", "google"] }))
      .not.toThrow();
    expect(() => assertGatewayRoute("vercel", {
      modelPrefix: "google/",
      providerOnly: ["google"],
    })).not.toThrow();
    // A namespace with no separator would concatenate into a model ID nothing
    // serves, which is a 404 an operator cannot diagnose.
    expect(() => assertGatewayRoute("vercel", { modelPrefix: "google" }))
      .toThrow(/end with a slash/u);
  });

  it("pins the serving provider in the body, on every API it carries", () => {
    for (const style of ["responses", "chat_completions", "anthropic_messages"] as const) {
      const body: Record<string, unknown> = { model: "google/gemini-2.5-flash" };
      expect(adapter.mutateBody!({ route: { providerOnly: ["vertex"] }, style, body })).toBe(true);
      expect(body).toEqual({
        model: "google/gemini-2.5-flash",
        providerOptions: { gateway: { only: ["vertex"] } },
      });
    }
  });

  it("overrides a client's pin and keeps every other provider option", () => {
    const body: Record<string, unknown> = {
      model: "google/gemini-2.5-flash",
      providerOptions: {
        google: { thinkingBudget: 1 },
        gateway: { only: ["anything"], sort: "cost" },
      },
    };
    expect(adapter.mutateBody!({
      route: { providerOnly: ["vertex"] },
      style: "chat_completions",
      body,
    })).toBe(true);
    expect(body.providerOptions).toEqual({
      google: { thinkingBudget: 1 },
      // The operator's pin wins; the client's other gateway options survive.
      gateway: { only: ["vertex"], sort: "cost" },
    });
  });

  it("leaves the body alone when no pin is configured", () => {
    const body: Record<string, unknown> = { model: "google/gemini-2.5-flash" };
    for (const route of [null, {}, { modelPrefix: "google/" }, { providerOnly: [] }]) {
      expect(adapter.mutateBody!({ route, style: "chat_completions", body })).toBe(false);
    }
    expect(body).toEqual({ model: "google/gemini-2.5-flash" });
    // A direct row has no gateway to steer, so nothing dispatches at all.
    expect(gatewayBodyMutation({
      gatewayType: null,
      route: { providerOnly: ["vertex"] },
      style: "chat_completions",
      body,
    })).toBe(false);
    // Cloudflare declares no body mutation of its own.
    expect(gatewayBodyMutation({
      gatewayType: "cf_aig",
      route: null,
      style: "chat_completions",
      body,
    })).toBe(false);
    expect(body).toEqual({ model: "google/gemini-2.5-flash" });
  });
});

/**
 * The plan's central claim: a model is the provider's own ID everywhere policy,
 * pricing, and reporting can see it, and only the wire carries a route's
 * namespace. Same canonical ID, three routes, one price row.
 */
describe("canonical model identity across routes", () => {
  it("puts one canonical ID on three different wires", () => {
    const routes: ProviderRoute[] = ["direct", "cf_aig", "vercel"];
    expect(routes.map((route) => routeWireModel(route, "gemini", "gemini-2.5-flash"))).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-flash",
      "google/gemini-2.5-flash",
    ]);
    // And back again: what Vercel echoes is canonicalized by the same prefix.
    expect(routeCanonicalModel("vercel", "gemini", "google/gemini-2.5-flash"))
      .toBe("gemini-2.5-flash");
    // Only the route's own prefix comes off. Another gateway's namespace, or a
    // canonical ID that contains a slash, survives intact.
    expect(routeCanonicalModel("vercel", "gemini", "vertex/gemini-2.5-flash"))
      .toBe("vertex/gemini-2.5-flash");
    expect(routeCanonicalModel("direct", "openrouter", "google/gemini-2.5-flash"))
      .toBe("google/gemini-2.5-flash");
    expect(routeCanonicalModel("vercel", "xai", "spacexai/grok-4.5")).toBe("grok-4.5");
  });

  it("lets a row's own namespace override the adapter default, both ways", () => {
    const override = { modelPrefix: "vertex-anthropic/" };
    expect(routeWireModel("vercel", "anthropic", "claude-opus-5", override))
      .toBe("vertex-anthropic/claude-opus-5");
    expect(routeCanonicalModel("vercel", "anthropic", "vertex-anthropic/claude-opus-5", override))
      .toBe("claude-opus-5");
    // The default still applies to a row that configured nothing.
    expect(routeWireModel("vercel", "anthropic", "claude-opus-5", null))
      .toBe("anthropic/claude-opus-5");
    // A route config on a gateway with no namespace of its own is refused
    // before it can be stored, so nothing here can be reached with one.
    expect(() => assertGatewayRoute("cf_aig", override)).toThrow();
  });
});

/**
 * The strip list is derived from the two registries, so this walks the same
 * declarations: a client value in any header the gateway or a provider
 * authenticates with must never appear upstream, on any route.
 */
describe("declared headers are never client-controlled", () => {
  const MARKER = "attacker-supplied-value";
  const APP_ID = "reserved-headers";

  beforeAll(async () => {
    await seedApp(APP_ID, { proxy: { provider_mode: "all", model_rewrites: {} } });
    await seedProvider({
      type: "openai",
      id: "reserved-headers-openai",
      slug: "openai-aig",
      secret: "cf-aig-run-token",
      gateway: "cf_aig",
      gatewayConfig: { accountId: "acct-1", gatewayId: "gw-1" },
    });
    await seedProvider({
      type: "openai",
      id: "reserved-headers-vercel",
      slug: "openai-vercel",
      secret: "vercel-run-token",
      gateway: "vercel",
    });
  });

  afterAll(async () => {
    for (const id of ["reserved-headers-openai", "reserved-headers-vercel"]) {
      await database(env.DB).delete(provider).where(eq(provider.id, id));
    }
    clearProviderCaches();
  });

  async function proxyWith(input: {
    appId: string;
    slug: string;
    header: string;
    token: string;
  }): Promise<Headers> {
    let upstream = new Headers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      upstream = new Headers(init?.headers);
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const executionCtx = createExecutionContext();
    const response = await worker.fetch(
      new Request(
        `https://example.test/v1/apps/${input.appId}/proxy/${input.slug}/v1/responses`,
        {
          method: "POST",
          headers: {
            // The bearer credential is the gateway's own; every other declared
            // header carries a value the client made up.
            ...Object.fromEntries(RESERVED_UPSTREAM_HEADERS.map((name) => [name, MARKER])),
            [input.header]: input.header === "authorization" ? `Bearer ${input.token}` : MARKER,
            authorization: `Bearer ${input.token}`,
            "content-type": "application/json",
            "x-app-version": "1.2.3",
          },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
        },
      ),
      env,
      executionCtx,
    );
    pending.push(executionCtx);
    expect(response.status).toBe(200);
    await response.text();
    return upstream;
  }

  /**
   * End to end for the same rule, because the failure it prevents was a 500:
   * `Headers.set` throws on a non-ByteString, and the id is an issuer claim, so
   * one user with an accent in their address broke every request they made.
   */
  it.each([
    ["non-Latin-1", "józsef@example.com"],
    ["control-character", "user\r\n-1"],
  ])("serves a %s user id on a vercel route with the header dropped", async (_name, userId) => {
    let upstream = new Headers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      upstream = new Headers(init?.headers);
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const executionCtx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://example.test/v1/apps/${APP_ID}/proxy/openai-vercel/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await gatewayToken(APP_ID, userId)}`,
          "content-type": "application/json",
          "x-app-version": "1.2.3",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      env,
      executionCtx,
    );
    pending.push(executionCtx);
    // Served, not 500ed.
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.get("ai-reporting-user")).toBeNull();
    // Everything else about the route is untouched.
    expect(upstream.get("authorization")).toBe("Bearer vercel-run-token");
    expect(upstream.get("ai-reporting-tags")).toBe(`app:${APP_ID}`);
  });

  it.each(RESERVED_UPSTREAM_HEADERS)(
    "drops a client %s on a direct route",
    async (header) => {
      const token = await gatewayToken(APP_ID);
      const upstream = await proxyWith({ appId: APP_ID, slug: "openai", header, token });
      upstream.forEach((value) => {
        expect(value).not.toContain(MARKER);
        expect(value).not.toContain(token);
      });
      expect(upstream.get("authorization")).toBe("Bearer test-openai-secret");
      expect(upstream.get("cf-aig-authorization")).toBeNull();
      expect(upstream.get("cf-aig-metadata")).toBeNull();
    },
  );

  it.each(RESERVED_UPSTREAM_HEADERS)(
    "drops a client %s on a cf_aig route",
    async (header) => {
      const token = await gatewayToken(APP_ID);
      const upstream = await proxyWith({ appId: APP_ID, slug: "openai-aig", header, token });
      upstream.forEach((value) => {
        expect(value).not.toContain(MARKER);
        expect(value).not.toContain(token);
      });
      // The gateway's own token replaces whatever the client sent, and the
      // provider credential never travels on this route at all.
      expect(upstream.get("cf-aig-authorization")).toBe("Bearer cf-aig-run-token");
      expect(upstream.get("authorization")).toBeNull();
      expect(upstream.get("x-api-key")).toBeNull();
    },
  );

  it.each(RESERVED_UPSTREAM_HEADERS)(
    "drops a client %s on a vercel route",
    async (header) => {
      const token = await gatewayToken(APP_ID);
      const upstream = await proxyWith({ appId: APP_ID, slug: "openai-vercel", header, token });
      upstream.forEach((value) => {
        expect(value).not.toContain(MARKER);
        expect(value).not.toContain(token);
      });
      // Vercel's own token, its own attribution, and no second credential:
      // `x-api-key` would out-rank the bearer at Vercel, and a client value in
      // `ai-reporting-*` would rewrite the operator's Vercel-side spend report.
      expect(upstream.get("authorization")).toBe("Bearer vercel-run-token");
      expect(upstream.get("x-api-key")).toBeNull();
      expect(upstream.get("ai-reporting-tags")).toBe(`app:${APP_ID}`);
      expect(upstream.get("cf-aig-authorization")).toBeNull();
    },
  );
});
