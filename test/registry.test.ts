import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { apiStyleFromPath, outputClampStyle, API_STYLES } from "../src/core/api-styles";
import {
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
  gatewayProbe,
  gatewayUpstream,
  wireModel,
} from "../src/core/gateways";
import { clearProviderCaches } from "../src/core/provider-store";
import { probeProviderGateway } from "../src/core/provider-probe";
import { PROVIDER_REGISTRY, PROVIDER_TYPES } from "../src/core/providers";
import { RESERVED_UPSTREAM_HEADERS } from "../src/core/proxyrules";
import type { OutputClampStyle, ProviderType } from "../src/core/types";
import { database } from "../src/db";
import { provider } from "../src/db/schema";
import { gatewayToken, seedApp, seedProvider } from "./helpers";

const CF_AIG = { type: "cf_aig", config: { accountId: "acct-1", gatewayId: "gw-1" } } as const;

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

  it("clamps exactly what the pre-refactor rules clamped", () => {
    for (const providerType of PROVIDER_TYPES) {
      for (const path of PATHS) {
        expect([providerType, path, outputClampStyle(apiStyleFromPath(path), providerType)])
          .toEqual([providerType, path, legacyClampStyle(providerType, path)]);
      }
    }
  });
});

describe("capability matrix", () => {
  it.each(PROVIDER_TYPES)("forwards every API style to %s on a direct route", (type) => {
    for (const style of API_STYLES) {
      expect(supportsApiStyle("direct", type, style)).toBe(true);
    }
  });

  it.each(PROVIDER_TYPES)("forwards every API style to %s through cf_aig", (type) => {
    for (const style of API_STYLES) {
      expect(supportsApiStyle("cf_aig", type, style)).toBe(true);
    }
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

  it("maps every provider type Cloudflare serves, with the openai v1 strip", () => {
    expect(Object.keys(adapter.routes).sort()).toEqual([...PROVIDER_TYPES].sort());
    expect(adapter.routes.openai).toEqual({ slug: "openai", stripPathPrefix: "v1/" });
    for (const type of PROVIDER_TYPES) {
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
      accountId: "acct-1",
      gatewayId: "gw-1",
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
  });

  afterAll(async () => {
    await database(env.DB).delete(provider).where(eq(provider.id, "reserved-headers-openai"));
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
});
