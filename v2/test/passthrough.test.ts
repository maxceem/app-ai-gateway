/**
 * Passthrough paths (plan section 4.5, step 5): paths a connection lists,
 * forwarded as they are to apps that enable `passthrough`, at a flat price per
 * request or `not_priced`. The provider is mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { callGap, resolvePassthrough } from "../src/pricing/billability.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { compilePassthrough, ProviderMatcher, upstreamRoute, upstreamTargets } from "../src/providers/matcher.ts";
import { matchTemplate, parseTemplate } from "../src/providers/path.ts";
import { upstreamRequest } from "../src/providers/route.ts";
import { openai } from "../src/providers/openai.ts";
import { readPassthrough, storedPassthrough } from "../src/providers/passthrough.ts";
import { isExtraClientHeader, mayCarryCredential } from "../src/proxy/headers.ts";
import { callCharge, type CallAttempt } from "../src/proxy/call-charge.ts";
import { STANDARD_MODE } from "../src/usage/service-modes.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedAccount, seedAppKey, seedManagementKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const SECRET = "sk-test-provider-key-4321";

let fetchSpy: MockInstance<typeof fetch>;

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("matching a listed path", () => {
  const matcher = new ProviderMatcher(openai);
  const listed = compilePassthrough([
    { method: "GET", path: "v1/organization/{thing}" },
    { method: "GET", path: "v1/{area}/users" },
    { method: "GET", path: "v1/files/{file_id}" },
  ]);

  it.each([
    "v1/organization/admin_api_keys",
    "V1/Organization/admin_api_keys",
    "v1/%6Frganization/admin_api_keys",
    "v1/%4F%52GANIZATION/users",
    "/v1//organization/users/",
    "v1/organization",
  ])("keeps the admin API refused even when listed: %s", (path) => {
    expect(matcher.match("GET", path, { passthrough: listed })).toMatchObject({ kind: "refused", reason: "refused_path" });
  });

  it.each(["v1/files/../organization/users", "v1/files/%2E%2E/organization", "v1/files/a%2Forganization", "v1/files/a%5Cb", "v1/files/%00", "v1/files/%E0%A4%A"])(
    "refuses a path that could mean another one upstream: %s",
    (path) => {
      expect(matcher.match("GET", path, { passthrough: listed })).toMatchObject({ kind: "refused", reason: "bad_path" });
    },
  );

  it("sends the path as it was checked, never as it was written", () => {
    expect(matcher.match("GET", "v1///files/file%2Dabc/", { passthrough: listed })).toMatchObject({
      kind: "passthrough",
      upstream: { host: "main", path: "/v1/files/file-abc" },
    });
  });

  it("compares a listed path's literals exactly: case is not folded for it", () => {
    expect(matcher.match("GET", "V1/FILES/file-abc", { passthrough: listed })).toEqual({ kind: "refused", reason: "not_declared" });
  });

  it("reports a refused path that takes every request a listing could match", () => {
    const [refused, partial, files] = listed as [any, any, any];
    expect(matcher.refusedCovering(refused)).toBe("v1/organization/*");
    // `v1/organization/users` is refused on its own, but `v1/teams/users` is not.
    expect(matcher.refusedCovering(partial)).toBeNull();
    expect(matcher.refusedCovering(files)).toBeNull();
  });

  const overlap = (method: "GET" | "POST", path: string, on: ProviderMatcher = matcher) => on.overlappingOperation(compilePassthrough([{ method, path }])[0]!);

  it.each([
    ["POST", "v1/chat/completions", "openai.chat"],
    ["POST", "v1/chat/{what}", "openai.chat"],
    ["POST", "v1/chat/comp{rest}", "openai.chat"],
    ["POST", "v1/{endpoint}", "openai.responses"],
    ["POST", "{version}/embeddings", "openai.embeddings"],
    ["GET", "v1/{endpoint}", "openai.realtime"],
  ] as const)("finds %s %s overlapping %s", (method, path, operation) => {
    expect(overlap(method, path)).toBe(operation);
  });

  it("finds a broad listing with several parts overlapping some operation", () => {
    expect(overlap("POST", "v1/{a}/{b}")).not.toBeNull();
    expect(overlap("POST", "{a}/{b}/{c}")).not.toBeNull();
  });

  it.each([
    ["GET", "v1/chat/completions"],
    ["GET", "v1/files/{file_id}"],
    ["POST", "v1/moderations"],
    ["POST", "v1/audio/translations"],
    ["POST", "v1/files/{file_id}/content"],
    ["POST", "v1/chat/x{rest}"],
  ] as const)("finds no overlap for the narrow listing %s %s", (method, path) => {
    expect(overlap(method, path)).toBeNull();
  });

  it("overlaps a `{name...}` part only through a value its list allows", () => {
    const fal = new ProviderMatcher(BUILT_IN_PROVIDERS.fal!);
    // The priced-models list takes any model.
    expect(overlap("POST", "run/{owner}/{model}", fal)).toBe("fal.run");
    expect(overlap("POST", "{x}/{owner}/{model}", fal)).not.toBeNull();
  });

  it("takes only plain path characters in a listing", () => {
    for (const path of ["v1/files/%2e%2e", "v1/files /x", "v1/files?x=1", "v1/files#x", "v1\\files", "v1/fi*les"]) {
      expect(() => compilePassthrough([{ method: "GET", path }]), path).toThrow();
    }
    expect(() => compilePassthrough([{ method: "GET", path: "v1/files/{file_id}:content" }])).not.toThrow();
  });

  it("never refuses a declared operation of any built-in provider by its own refused paths, on any route", () => {
    const routes = [
      { baseUrl: null, cloudflareGateway: null },
      { baseUrl: null, cloudflareGateway: { accountId: "a", gatewayId: "g" } },
      { baseUrl: "https://example.com/v1/", cloudflareGateway: null },
      { baseUrl: "https://example.com/openai/v1/", cloudflareGateway: null },
    ];
    for (const description of Object.values(BUILT_IN_PROVIDERS)) for (const connection of routes) {
      const route = upstreamRoute(description, connection);
      const matcher = new ProviderMatcher(description);
      for (const operation of description.operations) {
        const path = operation.match.path
          .split("/")
          .map((segment) => segment.replace(/\{[A-Za-z_][A-Za-z0-9_]*\.\.\.\}/u, (part) => {
            const list = operation.multiSegment?.[part.slice(1, -4)];
            return Array.isArray(list) ? list[0]! : "some/model";
          }).replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/u, "x1"))
          .join("/");
        expect(matcher.match(operation.match.method, path, { route }), `${operation.name}: ${path} ${JSON.stringify(connection)}`).not.toMatchObject({ reason: "refused_path" });
      }
    }
  });

  it.each([
    ["openai", "POST", "v1/realtime/client_secrets"],
    ["openai", "POST", "v1/organization/admin_api_keys"],
    ["anthropic", "POST", "v1/organizations/api_keys"],
    ["openrouter", "POST", "v1/keys"],
    ["openrouter", "POST", "v1/auth/keys"],
    ["openrouter", "GET", "v1/credits"],
    ["xai", "GET", "v1/api-key"],
    ["gemini", "POST", "v1alpha/auth_tokens"],
    ["gemini", "POST", "v1beta/tunedModels/m1/permissions"],
    ["deepgram", "POST", "v1/projects/p1/keys"],
    ["elevenlabs", "GET", "v1/convai/conversation/token"],
    ["elevenlabs", "POST", "v1/single-use-token/realtime_scribe"],
    ["fireworks", "POST", "v1/accounts/acct/users/u1/apiKeys"],
    ["perplexity", "POST", "generate_auth_token"],
    ["deepseek", "GET", "user/balance"],
    ["moonshot", "GET", "v1/users/me/balance"],
    ["vercel", "GET", "v1/credits"],
  ])("refuses %s %s %s, whatever is listed", (type, method, path) => {
    const description = BUILT_IN_PROVIDERS[type]!;
    const passthrough = compilePassthrough([{ method: method as "GET", path }]);
    expect(new ProviderMatcher(description).match(method, path, { passthrough })).toMatchObject({ kind: "refused", reason: "refused_path" });
  });
});

describe("judging a listing where the provider reads it", () => {
  const CLOUDFLARE = { baseUrl: null, cloudflareGateway: { accountId: "a", gatewayId: "g" } };
  const BASE_V1 = { baseUrl: "https://example.com/v1/", cloudflareGateway: null };
  const compiled = (method: "GET" | "POST", path: string) => compilePassthrough([{ method, path }])[0]!;

  it.each([
    ["Cloudflare", CLOUDFLARE],
    ["a base URL ending in /v1/", BASE_V1],
    ["a base URL with OpenAI's Azure path", { baseUrl: "https://example.com/openai/v1/", cloudflareGateway: null }],
  ] as const)("refuses on OpenAI through %s what the provider reads as a refused path or a declared operation", (_, connection) => {
    const route = upstreamRoute(openai, connection);
    const matcher = new ProviderMatcher(openai);
    expect(matcher.refusedCovering(compiled("POST", "realtime/client_secrets"), route)).toBe("v1/realtime/client_secrets/*");
    expect(matcher.refusedCovering(compiled("GET", "organization/{x}"), route)).toBe("v1/organization/*");
    expect(matcher.overlappingOperation(compiled("POST", "responses"), route)).not.toBeNull();
    // Straight to OpenAI, these paths are not ones it serves under `v1/`.
    expect(matcher.refusedCovering(compiled("POST", "realtime/client_secrets"))).toBeNull();
  });

  it("refuses those paths at serve too, where the request really goes", () => {
    const matcher = new ProviderMatcher(openai);
    const passthrough = compilePassthrough([{ method: "POST", path: "realtime/client_secrets" }, { method: "GET", path: "organization/{x}" }]);
    for (const connection of [CLOUDFLARE, BASE_V1]) {
      const route = upstreamRoute(openai, connection);
      expect(matcher.match("POST", "realtime/client_secrets", { passthrough, route })).toMatchObject({ reason: "refused_path" });
      expect(matcher.match("GET", "organization/admin_api_keys", { passthrough, route })).toMatchObject({ reason: "refused_path" });
    }
    expect(matcher.match("POST", "realtime/client_secrets", { passthrough })).toMatchObject({ kind: "passthrough" });
  });

  it("judges a declared operation without each way a base URL may be mounted, and a listing with them", () => {
    for (const [description, baseUrl, method, path] of [
      [BUILT_IN_PROVIDERS.deepseek!, "https://proxy.example/user/42/", "POST", "chat/completions"],
      [openai, "https://proxy.example/v1/organization/team-a/", "POST", "v1/chat/completions"],
    ] as const) {
      const route = upstreamRoute(description, { baseUrl, cloudflareGateway: null });
      const matcher = new ProviderMatcher(description);
      expect(matcher.match(method, path, { route })).toMatchObject({ kind: "operation" });
      // A listing behind it could reach the refused path, so it is still refused.
      expect(matcher.refusedCovering(compiled("GET", "models"), route)).not.toBeNull();
    }
  });

  it("reads a base URL on the provider's own host under that host's built-in prefix", () => {
    const openrouter = BUILT_IN_PROVIDERS.openrouter!;
    const route = upstreamRoute(openrouter, { baseUrl: "https://openrouter.ai/", cloudflareGateway: null });
    expect(route.hostPrefix).toEqual(["api"]);
    const matcher = new ProviderMatcher(openrouter);
    expect(matcher.overlappingOperation(compiled("POST", "api/v1/chat/completions"), route)).toBe("openrouter.chat");
    expect(matcher.refusedCovering(compiled("GET", "api/v1/keys"), route)).not.toBeNull();
    // Another host has no built-in prefix to read.
    expect(upstreamRoute(openrouter, { baseUrl: "https://proxy.example/", cloudflareGateway: null }).hostPrefix).toBeUndefined();
  });

  it("refuses some methods on a path and allows the others: deleting a voice, not reading one", () => {
    const elevenlabs = BUILT_IN_PROVIDERS.elevenlabs!;
    const matcher = new ProviderMatcher(elevenlabs);
    const listed = compilePassthrough([
      { method: "GET", path: "v1/voices/{voice_id}" },
      { method: "DELETE", path: "v1/voices/{voice_id}" },
      { method: "PATCH", path: "v1/convai/agents/{agent_id}" },
      { method: "GET", path: "v1/convai/agents/{agent_id}" },
    ]);
    expect(matcher.refusedCovering(listed[0]!)).toBeNull();
    expect(matcher.refusedCovering(listed[1]!)).toMatch(/DELETE/u);
    expect(matcher.refusedCovering(listed[2]!)).toMatch(/PATCH/u);
    expect(matcher.refusedCovering(listed[3]!)).toBeNull();
    expect(matcher.match("GET", "v1/voices/v1", { passthrough: listed })).toMatchObject({ kind: "passthrough" });
    expect(matcher.match("DELETE", "v1/voices/v1", { passthrough: listed })).toMatchObject({ reason: "refused_path" });
    expect(matcher.match("delete".toUpperCase(), "V1/VOICES/v1", { passthrough: listed })).toMatchObject({ reason: "refused_path" });
  });

  it.each([
    ["DELETE", "v1/voices/voice-1"],
    ["POST", "v1/convai/agents/create"],
    ["PATCH", "v1/convai/agents/a1"],
    ["POST", "v1/convai/agents/a1/duplicate"],
    ["PATCH", "v1/convai/environment-variables/e1"],
    ["DELETE", "v1/audio-isolation/history/h1"],
    ["POST", "v1/productions/orders/o1/submit"],
    ["POST", "v1/convai/realtime/client_secrets"],
    ["POST", "v1/workspaces/api-keys/third-party-disabling"],
  ] as const)("refuses ElevenLabs %s %s, even when listed", (method, path) => {
    const matcher = new ProviderMatcher(BUILT_IN_PROVIDERS.elevenlabs!);
    expect(matcher.match(method, path, { passthrough: compilePassthrough([{ method, path }]) })).toMatchObject({ reason: "refused_path" });
  });

  it.each([
    ["GET", "v1/voices"],
    ["GET", "v1/voices/voice-1"],
    ["POST", "v1/text-to-voice/design"],
    ["POST", "v1/text-to-voice/create-voice-from-preview"],
    ["POST", "v1/voices/add"],
    ["POST", "v1/convai/agents/a1/knowledge-base/rag-query"],
    ["POST", "v1/convai/agents/a1/simulate-conversation"],
    ["GET", "v1/studio/projects/p1/snapshots/s1/stream"],
    ["DELETE", "v1/dubbing/d1"],
    ["GET", "v1/convai/environment-variables"],
    ["POST", "v1/voice-generation/generate-voice"],
    ["GET", "v1/voice-generation/generate-voice/parameters"],
    ["GET", "v1/convai/agents/a1"],
    ["GET", "v1/dubbing/d1"],
    ["GET", "v1/pronunciation-dictionaries"],
  ] as const)("still serves ElevenLabs %s %s once listed", (method, path) => {
    const matcher = new ProviderMatcher(BUILT_IN_PROVIDERS.elevenlabs!);
    expect(matcher.match(method, path, { passthrough: compilePassthrough([{ method, path }]) })).toMatchObject({ kind: "passthrough" });
  });

  it("refuses on fal a listing its priced-models path would also take upstream", () => {
    const fal = new ProviderMatcher(BUILT_IN_PROVIDERS.fal!);
    expect(fal.overlappingOperation(compiled("POST", "fal-ai/{a}/{b}"))).toBe("fal.run");
  });

  it("routes Cloudflare's prefix: a path may or may not start with it", () => {
    const route = upstreamRoute(openai, CLOUDFLARE);
    const lit = (value: string) => ({ kind: "literal", value }) as const;
    expect(upstreamTargets(route, "main", [lit("v1"), lit("files")])).toEqual({ host: "main", paths: [[lit("v1"), lit("files")]] });
    expect(upstreamTargets(route, "main", [lit("files")])).toEqual({ host: "main", paths: [[lit("v1"), lit("files")]] });
    expect(upstreamTargets(route, "main", compiled("GET", "{x}/files").template.segments)?.paths).toHaveLength(2);
    expect(upstreamTargets(route, "queue", [lit("x")])).toBeNull();
    expect(upstreamTargets(upstreamRoute(openai, BASE_V1), "main", [lit("files")])?.paths).toEqual([[lit("v1"), lit("files")], [lit("files")]]);
  });

  /** Routes each provider can have: direct, Cloudflare where it is served, and base URLs mounted three ways. */
  const routesOf = (description: (typeof BUILT_IN_PROVIDERS)[string]) => [
    { baseUrl: null, cloudflareGateway: null },
    ...(description.cloudflareGateway !== undefined ? [CLOUDFLARE] : []),
    BASE_V1,
    { baseUrl: "https://example.com/api/", cloudflareGateway: null },
    { baseUrl: "https://example.com/openai/v1/", cloudflareGateway: null },
  ];

  /** The paths the provider may read a sent URL as, worked out from the URL `upstreamRequest` builds, not from `upstreamTargets`. */
  function readAs(description: (typeof BUILT_IN_PROVIDERS)[string], connection: { baseUrl: string | null; cloudflareGateway: object | null }, path: string): string[][] {
    const record = {
      id: "c",
      accountId: "a",
      type: description.type,
      slug: "s",
      status: "active",
      baseUrl: connection.baseUrl,
      secretBlob: null,
      rates: null,
      servingProviders: null,
      cloudflareGateway: connection.cloudflareGateway === null ? null : { accountId: "a", gatewayId: "g", tokenBlob: "", tokenHint: null },
    } as const;
    const { url } = upstreamRequest(record, description, {
      hostKey: "main",
      path: path.replace(/^\//u, ""),
      query: "",
      credentials: { providerKey: "k", cloudflareToken: "t" },
      appId: "app",
      userId: null,
    });
    const segments = new URL(url).pathname.split("/").filter((piece) => piece !== "").map((piece) => decodeURIComponent(piece));
    if (connection.cloudflareGateway !== null) {
      // `/v1/<account>/<gateway>/<slug>/<rest>`: Cloudflare's endpoint for the provider adds its prefix back.
      const prefix = (description.cloudflareEndpoint?.stripPathPrefix ?? "").split("/").filter((piece) => piece !== "");
      return [[...prefix, ...segments.slice(4)]];
    }
    if (connection.baseUrl !== null) {
      const base = new URL(connection.baseUrl).pathname.split("/").filter((piece) => piece !== "").length;
      return Array.from({ length: base + 1 }, (_, drop) => segments.slice(drop));
    }
    const hostPrefix = description.hosts.main.split("/").slice(1).filter((piece) => piece !== "").length;
    return [segments.slice(hostPrefix)];
  }

  it("never lets a listing that saves reach a refused path or a declared operation, on any route (fuzz)", () => {
    let seed = 0x5eed;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let saved = 0;
    // Collected and checked once: an `expect` per check would cost more than the checks.
    const failures: string[] = [];
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      const matcher = new ProviderMatcher(description);
      const refused = description.refused.map((entry) =>
        typeof entry === "string"
          ? { template: parseTemplate(entry, { rest: true }), methods: null, hosts: null }
          : { template: parseTemplate(entry.path, { rest: true }), methods: (entry.methods ?? null) as readonly string[] | null, hosts: entry.hosts ?? null },
      );
      const words = new Set(["v1", "x", "files", "chat"]);
      for (const source of [...description.refused.map((entry) => (typeof entry === "string" ? entry : entry.path)), ...description.operations.flatMap((op) => [op.match.path, op.upstream?.path ?? ""])]) {
        for (const piece of source.split("/")) if (piece !== "" && piece !== "*" && !piece.includes("{")) words.add(piece);
      }
      const vocabulary = [...words];
      const shapes = [...vocabulary, "{a}", "{b}", "comp{c}", "{d}:generateContent"];
      const operations = description.operations
        .filter((op) => (op.upstream?.host ?? "main") === "main")
        .map((op) => ({
          op,
          template: parseTemplate(op.upstream?.path ?? op.match.path, { multi: true }),
          lists: Object.fromEntries(Object.entries(op.multiSegment ?? {}).map(([name, list]) => [name, list === "priced_models" ? ("any" as const) : new Set(list)])),
        }));
      for (const connection of routesOf(description)) {
        const route = upstreamRoute(description, connection);
        const prefix = connection.cloudflareGateway !== null ? (description.cloudflareEndpoint?.stripPathPrefix ?? "").split("/").filter((piece) => piece !== "") : [];
        // Each operation's paths as the provider reads them on this route, worked out once.
        const readings = operations.map(({ op, template, lists }) => ({
          op,
          lists,
          templates:
            prefix.length > 0 && !template.segments.slice(0, prefix.length).every((segment, index) => segment.kind === "literal" && segment.value === prefix[index])
              ? [template, { source: "", segments: [...prefix.map((value) => ({ kind: "literal", value }) as const), ...template.segments] }]
              : [template],
        }));
        // A listing drawn twice on one route is judged once.
        const drawn = new Set<string>();
        for (let round = 0; round < 60; round += 1) {
          const method = (["GET", "POST", "DELETE", "PATCH"] as const)[random(4)]!;
          const path = Array.from({ length: 1 + random(4) }, () => shapes[random(shapes.length)]!).join("/");
          if (drawn.has(`${method} ${path}`)) continue;
          drawn.add(`${method} ${path}`);
          let listing;
          try {
            listing = compilePassthrough([{ method, path }])[0]!;
          } catch {
            continue;
          }
          if (matcher.refusedCovering(listing, route) !== null || matcher.overlappingOperation(listing, route) !== null) continue;
          saved += 1;
          for (let fill = 0; fill < 6; fill += 1) {
            const concrete = listing.template.segments
              .map((segment) => (segment.kind === "literal" ? segment.value : segment.kind === "part" ? segment.prefix + vocabulary[random(vocabulary.length)]! + segment.suffix : "x"))
              .join("/");
            const match = matcher.match(method, concrete, { passthrough: [listing], route });
            if (match.kind !== "passthrough") continue;
            for (const read of readAs(description, connection, match.upstream.path)) {
              const where = () => `${description.type} ${JSON.stringify(connection)} ${method} ${path} as ${concrete}: ${read.join("/")}`;
              const baseHost = connection.baseUrl === null ? null : new URL(connection.baseUrl).hostname;
              for (const { template, methods, hosts } of refused) {
                if (hosts !== null && (baseHost === null || !hosts.includes(baseHost))) continue;
                if ((methods === null || methods.includes(method)) && matchTemplate(template, read, { ignoreCase: true }) !== null) failures.push(`${where()} is refused by ${template.source}`);
              }
              for (const { op, lists, templates } of readings) {
                if (op.match.method !== method) continue;
                if (templates.some((reading) => matchTemplate(reading, read, { closedLists: lists }) !== null)) failures.push(`${where()} reaches ${op.name}`);
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // The fuzz judged a real number of saved listings, not only refused ones.
    expect(saved).toBeGreaterThan(300);
  });
});

describe("passthrough headers", () => {
  it("forward a declared name or prefix, never one that may carry a credential", () => {
    const extra = ["x-goog-upload-", "x-exact"];
    expect(isExtraClientHeader("X-Goog-Upload-Protocol", extra)).toBe(true);
    expect(isExtraClientHeader("x-exact", extra)).toBe(true);
    expect(isExtraClientHeader("x-exactly", extra)).toBe(false);
    for (const name of ["x-goog-upload-api-key", "x-goog-upload-token", "x-goog-upload-authorization", "x-goog-upload-cookie", "x-stainless-session-token", "X-Stainless-Secret"]) {
      expect(mayCarryCredential(name), name).toBe(true);
    }
    for (const name of ["idempotency-key", "x-stainless-lang", "x-goog-upload-protocol", "x-goog-upload-header-content-length", "anthropic-dangerous-direct-browser-access"]) {
      expect(mayCarryCredential(name), name).toBe(false);
    }
  });

  it("drop a credential-like name even from the allowlist, on every call", async () => {
    const { appId, slug, key } = await setup([{ method: "GET", path: "v1/files/{file_id}" }]);
    fetchSpy.mockResolvedValueOnce(Response.json({}));
    await send("GET", `/v2/apps/${appId}/proxy/${slug}/v1/files/f`, key, {
      headers: { "x-stainless-session-token": "leak", "x-stainless-lang": "js", "idempotency-key": "retry-1" },
    });
    const headers = new Headers(fetchSpy.mock.calls[0]![1]!.headers);
    expect(headers.get("x-stainless-session-token")).toBeNull();
    expect(headers.get("x-stainless-lang")).toBe("js");
    expect(headers.get("idempotency-key")).toBe("retry-1");
  });

  it("are declared by no provider with a name that may carry a credential", () => {
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      for (const name of description.passthroughHeaders ?? []) {
        expect(name, description.type).toBe(name.toLowerCase());
        expect(mayCarryCredential(name.endsWith("-") ? `${name}x` : name), `${description.type} ${name}`).toBe(false);
        expect(name.startsWith(description.auth.header), description.type).toBe(false);
      }
    }
  });
});

describe("billing a listed path", () => {
  it("bills a flat price per request as the customer's rate, and no price as `not_priced`", () => {
    const priced = resolvePassthrough({ method: "POST", path: "v1/moderations", priceNano: 2_000_000 });
    expect(priced).toMatchObject({ kind: "admitted", operation: { name: "passthrough" }, model: "", bill: { problem: null, price: { source: "customer_rate" } } });
    expect(callGap(priced)).toBeNull();
    const free = resolvePassthrough({ method: "POST", path: "v1/moderations", priceNano: 0 });
    expect(callGap(free)).toBeNull();
    const unpriced = resolvePassthrough({ method: "GET", path: "v1/files" });
    expect(unpriced.bill).toEqual({ price: null, reportsCost: false, problem: null, notPriced: true });
    expect(callGap(unpriced)).toBeNull();
  });

  const attempt = (listed: { priceNano?: number }): CallAttempt => {
    const call = resolvePassthrough({ method: "POST", path: "v1/things", ...listed });
    return {
      requestId: "req1",
      seq: 1,
      accountId: ACCOUNT_ID,
      appId: "app1",
      identity: { userId: null, installId: null, appleAccountId: null, authMethod: "api_key" } as never,
      providerType: "openai",
      connectionId: "c1",
      providerSlug: "openai",
      operation: "passthrough",
      model: "",
      price: call.bill.price,
      reportsCost: false,
      ...(call.bill.notPriced ? { notPriced: true as const } : {}),
      requestedMode: STANDARD_MODE,
      startedAt: 1_700_000_000_000,
      appVersion: null,
      clientTraceId: null,
      requestUsage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true, units: { requests: 1 } },
    };
  };
  const ok = { status: "ok", httpStatus: 200, errorCode: null, usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true, units: { requests: 1 } }, cut: false, latencyMs: 5 } as const;
  const failed = { status: "provider_error", httpStatus: 500, errorCode: null, usage: null, cut: false, latencyMs: 5 } as const;

  it("charges the flat price for an answer the provider accepted, and nothing for a failed one", () => {
    expect(callCharge(attempt({ priceNano: 2_000_000 }), ok, 1).charge).toMatchObject({
      operation: "passthrough",
      model: null,
      costNano: 2_000_000,
      priceSource: "customer_rate",
      unit: "requests",
      units: 1,
    });
    expect(callCharge(attempt({ priceNano: 2_000_000 }), failed, 1).charge).toMatchObject({ costNano: null, priceSource: "customer_rate" });
  });

  it("charges an unpriced path as `not_priced`, with nothing left to price later and nothing logged as unpriced", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const outcome of [ok, failed]) {
      const { charge, openWork } = callCharge(attempt({}), outcome, 1);
      expect(charge).toMatchObject({ operation: "passthrough", model: null, costNano: null, priceSource: "not_priced", measured: "complete" });
      expect(openWork).toEqual([]);
    }
    expect(errors).not.toHaveBeenCalled();
  });

  it("reads a stored list back, leaving out an entry that does not read", () => {
    const stored = storedPassthrough([{ method: "GET", path: "v1/files/{id}" }, { method: "POST", path: "v1/x", priceNano: 5 }]);
    expect(JSON.parse(stored!)).toEqual({ paths: [{ method: "GET", path: "v1/files/{id}" }, { method: "POST", path: "v1/x", price_nano: 5 }] });
    expect(readPassthrough(stored)).toEqual([{ method: "GET", path: "v1/files/{id}" }, { method: "POST", path: "v1/x", priceNano: 5 }]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(readPassthrough('{"paths":[{"method":"HEAD","path":"x"},{"method":"GET","path":"y"}]}')).toEqual([{ method: "GET", path: "y" }]);
    expect(readPassthrough(storedPassthrough([]))).toEqual([]);
  });
});

/** A connection with `paths` listed, written as a save would, and an app routed to it. */
async function setup(
  paths: readonly { method: string; path: string; priceNano?: number }[],
  operations: readonly string[] = ["passthrough"],
  connection: { type?: string; baseUrl?: string; limits?: Record<string, unknown> } = {},
) {
  await seedAccount();
  const type = connection.type ?? "openai";
  const baseUrl = connection.baseUrl ?? null;
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `${type}-${id.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, type, baseUrl ?? ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, passthrough_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, '4321', ?, ?, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, type, slug, type, blob, baseUrl, storedPassthrough(paths as never), now, now)
    .run();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: { operations } } },
  );
  if (connection.limits !== undefined) {
    const config = { authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, routing: { providers: { [slug]: { operations } } }, limits: connection.limits };
    await env.DB.prepare("UPDATE app SET config_json = ? WHERE id = ?").bind(JSON.stringify(config), appId).run();
  }
  const { key } = await seedAppKey(appId);
  return { appId, slug, key };
}

async function send(method: string, path: string, key: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text };
}

async function chargesOf(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
  return results;
}

describe("serving a listed path", () => {
  it("forwards a listed GET as it is, with the provider's key in its header only, and charges it `not_priced`", async () => {
    const { appId, slug, key } = await setup([{ method: "GET", path: "v1/files/{file_id}" }]);
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "file-abc", object: "file" }, { headers: { "x-request-id": "r1" } }));
    const { response, text } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/v1/files/file-abc?key=leak&limit=2`, key, { headers: { "openai-beta": "assistants=v2", "x-custom": "dropped" } });
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ id: "file-abc", object: "file" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/files/file-abc?limit=2");
    const headers = new Headers(init!.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(headers.get("x-end-user-id")).toBeNull();
    // The same client header allowlist as every call.
    expect(headers.get("openai-beta")).toBe("assistants=v2");
    expect(headers.get("x-custom")).toBeNull();
    expect(init!.body).toBeNull();
    expect(init!.redirect).toBe("manual");
    expect(await chargesOf(appId)).toEqual([
      expect.objectContaining({ operation: "passthrough", model: null, status: "ok", cost_nano: null, price_source: "not_priced", http_status: 200 }),
    ]);
  });

  it("charges a listed path's flat price per accepted answer, and passes a provider error on as it is", async () => {
    const { appId, slug, key } = await setup([{ method: "POST", path: "v1/moderations", priceNano: 3_000_000 }]);
    fetchSpy.mockResolvedValueOnce(Response.json({ results: [] }));
    const body = JSON.stringify({ input: "hello", model: "omni-moderation-latest" });
    expect((await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/moderations`, key, { body, headers: { "content-type": "application/json" } })).response.status).toBe(200);
    // Sent as the client's own bytes.
    expect(new TextDecoder().decode(fetchSpy.mock.calls[0]![1]!.body as Uint8Array)).toBe(body);
    fetchSpy.mockResolvedValueOnce(Response.json({ error: { code: "server_error" } }, { status: 500 }));
    const failed = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/moderations`, key, { body, headers: { "content-type": "application/json" } });
    expect(failed.response.status).toBe(500);
    expect(JSON.parse(failed.text)).toEqual({ error: { code: "server_error" } });
    const charges = await chargesOf(appId);
    expect(charges).toEqual([
      expect.objectContaining({ operation: "passthrough", status: "ok", cost_nano: 3_000_000, price_source: "customer_rate", unit: "requests", units: 1 }),
      expect.objectContaining({ operation: "passthrough", status: "provider_error", cost_nano: null, http_status: 500 }),
    ]);
  });

  it("serves OpenAI translations once listed, with the upload sent unchanged", async () => {
    const { appId, slug, key } = await setup([{ method: "POST", path: "v1/audio/translations" }]);
    fetchSpy.mockResolvedValueOnce(Response.json({ text: "hello" }));
    const form = new FormData();
    form.set("model", "whisper-1");
    form.set("file", new File([new Uint8Array([1, 2, 3])], "a.mp3", { type: "audio/mpeg" }));
    const request = new Request("https://x.test", { method: "POST", body: form });
    const bytes = new Uint8Array(await request.arrayBuffer());
    const contentType = request.headers.get("content-type")!;
    const { response } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/audio/translations`, key, { body: bytes, headers: { "content-type": contentType } });
    expect(response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/audio/translations");
    expect(new Headers(init!.headers).get("content-type")).toBe(contentType);
    expect(new Uint8Array(init!.body as Uint8Array)).toEqual(bytes);
    expect(await chargesOf(appId)).toEqual([expect.objectContaining({ operation: "passthrough", price_source: "not_priced" })]);
  });

  it("refuses a listed path to an app that does not enable passthrough, and sends nothing", async () => {
    const { appId, slug, key } = await setup([{ method: "GET", path: "v1/files/{file_id}" }], ["openai.chat"]);
    const { response, text } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/v1/files/file-abc`, key);
    expect(response.status).toBe(403);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "path_not_allowed" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a refused path refused through the proxy even when the stored list names it", async () => {
    const { appId, slug, key } = await setup([
      { method: "POST", path: "v1/organization/admin_api_keys" },
      { method: "POST", path: "v1/{area}/admin_api_keys" },
    ]);
    for (const path of ["v1/organization/admin_api_keys", "V1/ORGANIZATION/admin_api_keys", "v1/%6frganization/admin_api_keys", "v1/x/../organization/admin_api_keys"]) {
      const { response } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/${path}`, key, { body: "{}", headers: { "content-type": "application/json" } });
      expect(response.status, path).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves declared operations behind a base URL whose own path looks like a refused one, as before", async () => {
    const { appId, slug, key } = await setup([], ["deepseek.chat"], { type: "deepseek", baseUrl: "https://proxy.example/user/42/" });
    fetchSpy.mockResolvedValueOnce(
      Response.json({ id: "c1", object: "chat.completion", model: "deepseek-v4-flash", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    );
    const { response, text } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, {
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status, text).toBe(200);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://proxy.example/user/42/chat/completions");
  });

  it("lets an unpriced path past the spending limits, but not past the request limits", async () => {
    const atBudget = { per_app: { spending: { monthly_nano: 0 } }, per_user: { spending: { monthly_nano: 0 } } };
    const { appId, slug, key } = await setup(
      [{ method: "GET", path: "v1/files/{file_id}" }, { method: "POST", path: "v1/moderations", priceNano: 1_000 }],
      ["passthrough"],
      { limits: atBudget },
    );
    fetchSpy.mockImplementation(async () => Response.json({ ok: true }));
    expect((await send("GET", `/v2/apps/${appId}/proxy/${slug}/v1/files/file-abc`, key)).response.status).toBe(200);
    // A priced one spends, so the budget refuses it.
    const priced = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/moderations`, key, { body: "{}", headers: { "content-type": "application/json" } });
    expect(priced.response.status).toBe(429);
    expect(JSON.parse(priced.text)).toMatchObject({ error: { code: "app_budget_exhausted" } });

    const limited = await setup([{ method: "GET", path: "v1/files/{file_id}" }], ["passthrough"], { limits: { per_app: { requests: { per_minute: 1 } } } });
    expect((await send("GET", `/v2/apps/${limited.appId}/proxy/${limited.slug}/v1/files/a`, limited.key)).response.status).toBe(200);
    const second = await send("GET", `/v2/apps/${limited.appId}/proxy/${limited.slug}/v1/files/b`, limited.key);
    expect(second.response.status).toBe(429);
    expect(JSON.parse(second.text)).toMatchObject({ error: { code: "app_rate_limited" } });
  });

  it("forwards the upload headers Gemini declares for passthrough, never a credential, and only on a listed path", async () => {
    const { appId, slug, key } = await setup([{ method: "POST", path: "upload/v1beta/files" }], ["passthrough"], { type: "gemini" });
    fetchSpy.mockResolvedValueOnce(Response.json({}, { headers: { "x-goog-upload-url": "https://example.com/u" } }));
    const { response } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/upload/v1beta/files`, key, {
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": "2048",
        "x-goog-upload-api-key": "sneaky",
        "x-goog-api-key": "client-key",
      },
    });
    expect(response.status).toBe(200);
    const headers = new Headers(fetchSpy.mock.calls[0]![1]!.headers);
    expect(headers.get("x-goog-upload-protocol")).toBe("resumable");
    expect(headers.get("x-goog-upload-command")).toBe("start");
    expect(headers.get("x-goog-upload-header-content-length")).toBe("2048");
    expect(headers.get("x-goog-upload-api-key")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBe(SECRET);
    // OpenAI declares none: the same header is not forwarded on its passthrough.
    const other = await setup([{ method: "GET", path: "v1/files/{file_id}" }]);
    fetchSpy.mockResolvedValueOnce(Response.json({}));
    await send("GET", `/v2/apps/${other.appId}/proxy/${other.slug}/v1/files/f`, other.key, { headers: { "x-goog-upload-protocol": "resumable" } });
    expect(new Headers(fetchSpy.mock.calls[1]![1]!.headers).get("x-goog-upload-protocol")).toBeNull();
  });

  it("checks who is calling first: a listed path needs a valid app key", async () => {
    const { appId, slug } = await setup([{ method: "GET", path: "v1/files/{file_id}" }]);
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/v1/files/file-abc`, "agw_not_a_key");
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes a redirect on without following it", async () => {
    const { appId, slug, key } = await setup([{ method: "GET", path: "v1/files/{file_id}/content" }]);
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/f" } }));
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/v1/files/file-abc/content`, key);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://elsewhere.example.com/f");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

async function admin(key: string, method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("saving a listed path", () => {
  const create = (key: string, passthrough: unknown, route: Record<string, unknown> = {}) =>
    admin(key, "POST", "/v2/admin/providers", {
      type: "openai",
      name: "OpenAI",
      slug: `openai-${crypto.randomUUID().slice(0, 6)}`,
      secret: "sk-live-secret-abcd",
      passthrough,
      ...route,
    });

  it("stores a list with its prices, and shows it back in dollars", async () => {
    const key = await seedManagementKey();
    const created = await create(key, [
      { method: "GET", path: "v1/files/{file_id}" },
      { method: "POST", path: "v1/moderations", per_request: 0.002 },
    ]);
    expect(created.status).toBe(201);
    expect(created.body.provider.passthrough).toEqual([
      { method: "GET", path: "v1/files/{file_id}" },
      { method: "POST", path: "v1/moderations", per_request: 0.002 },
    ]);
    const row = await env.DB.prepare("SELECT passthrough_json FROM provider_connection WHERE id = ?").bind(created.body.provider.id).first<{ passthrough_json: string }>();
    expect(JSON.parse(row!.passthrough_json)).toEqual({ paths: [{ method: "GET", path: "v1/files/{file_id}" }, { method: "POST", path: "v1/moderations", price_nano: 2_000_000 }] });

    // Left out, it is kept; null lists none.
    const renamed = await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 1, name: "Renamed" });
    expect(renamed.body.provider.passthrough).toHaveLength(2);
    const cleared = await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 2, passthrough: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.provider.passthrough).toBeUndefined();
  });

  it.each([
    [[{ method: "GET", path: "v1/organization/{thing}" }], "always refused"],
    [[{ method: "POST", path: "v1/realtime/client_secrets" }], "set live_token to true"],
    [[{ method: "GET", path: "v1/organization/{thing}", live_token: true }], "key, admin and account paths are always refused"],
    [[{ method: "GET", path: "v1/files", live_token: true }], "not one of OpenAI's live-session token paths"],
    [[{ method: "POST", path: "v1/chat/completions" }], "openai.chat"],
    [[{ method: "POST", path: "v1/{endpoint}" }], "can match a path of the openai."],
    [[{ method: "GET", path: "v1/{rest...}" }], "path"],
    [[{ method: "GET", path: "v1/files/%2e%2e" }], "path"],
    [[{ method: "GET", path: "v1/files" }, { method: "GET", path: "v1/files" }], "matches the same requests"],
    [[{ method: "GET", path: "v1/files/{id}" }, { method: "GET", path: "/v1/files/{file_id}" }], "matches the same requests"],
    [[{ method: "GET", path: "v1/files", per_request: -1 }], "per_request"],
    [[{ method: "HEAD", path: "v1/files" }], "method"],
  ])("refuses %j", async (passthrough, message) => {
    const key = await seedManagementKey();
    const refused = await create(key, passthrough);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(message);
  });

  it("does not judge again a path listed before, so a later refused path or operation never stops a save", async () => {
    const key = await seedManagementKey();
    const created = await create(key, [{ method: "GET", path: "v1/files" }]);
    // As if a release had since declared or refused it: the stored list names it already.
    await env.DB.prepare("UPDATE provider_connection SET passthrough_json = ? WHERE id = ?")
      .bind(storedPassthrough([{ method: "GET", path: "v1/files" }, { method: "POST", path: "v1/chat/completions" }]), created.body.provider.id)
      .run();
    const kept = await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, {
      revision: 1,
      passthrough: [
        { method: "GET", path: "v1/files" },
        { method: "POST", path: "v1/chat/completions" },
        { method: "GET", path: "v1/batches/{batch_id}" },
      ],
    });
    expect(kept.status).toBe(200);
    expect(kept.body.provider.passthrough).toHaveLength(3);
  });

  it("refuses a broad listing that overlaps a declared operation, and saves a narrow one", async () => {
    const key = await seedManagementKey();
    for (const path of ["v1/{endpoint}", "v1/{a}/{b}", "{version}/embeddings"]) {
      const refused = await create(key, [{ method: "POST", path }]);
      expect(refused.status, path).toBe(400);
      expect(JSON.stringify(refused.body)).toContain("can match a path of the openai.");
    }
    const narrow = await create(key, [{ method: "POST", path: "v1/moderations" }, { method: "GET", path: "v1/files/{file_id}" }]);
    expect(narrow.status).toBe(201);
  });

  it("never lets an app with only passthrough reach a declared operation through a listing", async () => {
    const key = await seedManagementKey();
    expect((await create(key, [{ method: "POST", path: "v1/{endpoint}" }])).status).toBe(400);
    const created = await create(key, [{ method: "POST", path: "v1/moderations" }]);
    const slug = created.body.provider.slug as string;
    const app = await admin(key, "POST", "/v2/admin/apps", {
      name: "Only passthrough",
      config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: { [slug]: { operations: ["passthrough"] } } } },
    });
    expect(app.status).toBe(201);
    for (const path of ["v1/embeddings", "v1/responses", "v1/chat/completions"]) {
      const { response, text } = await send("POST", `/v2/apps/${app.body.app.id}/proxy/${slug}/${path}`, app.body.api_key.key, {
        body: JSON.stringify({ model: "text-embedding-3-small", input: "x" }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status, path).toBe(403);
      expect(JSON.parse(text)).toMatchObject({ error: { code: "path_not_allowed" } });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("judges a listing on the connection's route: through Cloudflare or a base URL ending in /v1/", async () => {
    const key = await seedManagementKey();
    const routes = [
      { cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: "cf-token-for-tests-1234" } },
      { baseUrl: "https://example.com/v1/" },
    ];
    for (const route of routes) {
      for (const passthrough of [
        [{ method: "POST", path: "realtime/client_secrets" }],
        [{ method: "GET", path: "organization/{x}" }],
        [{ method: "POST", path: "responses" }],
      ]) {
        const refused = await create(key, passthrough, route);
        expect(refused.status, JSON.stringify([route, passthrough])).toBe(400);
      }
      expect((await create(key, [{ method: "POST", path: "moderations" }], route)).status).toBe(201);
    }
  });

  it("judges kept listings again when the connection moves to a new route", async () => {
    const key = await seedManagementKey();
    const created = await create(key, [{ method: "GET", path: "organization/{x}" }]);
    expect(created.status).toBe(201);
    const moved = await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 1, baseUrl: "https://example.com/v1/", secret: "sk-live-secret-abcd" });
    expect(moved.status).toBe(400);
    expect(JSON.stringify(moved.body)).toContain("never allows");
  });

  it("keeps listings saved before when the route reads paths the same way, such as another Cloudflare gateway", async () => {
    const key = await seedManagementKey();
    const gateway = (gatewayId: string) => ({ cloudflareGateway: { accountId: "acct", gatewayId, token: "cf-token-for-tests-1234" } });
    const created = await create(key, [{ method: "POST", path: "moderations" }], gateway("gw-a"));
    expect(created.status).toBe(201);
    // As if a release had since declared or refused it.
    await env.DB.prepare("UPDATE provider_connection SET passthrough_json = ? WHERE id = ?")
      .bind(storedPassthrough([{ method: "POST", path: "responses" }]), created.body.provider.id)
      .run();
    const moved = await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 1, ...gateway("gw-b"), secret: "sk-live-secret-abcd" });
    expect(moved.status).toBe(200);
    expect(moved.body.provider.passthrough).toEqual([{ method: "POST", path: "responses" }]);
  });

  it("says when an overlap comes from the base URL, not from the listing itself", async () => {
    const key = await seedManagementKey();
    const behind = await create(key, [{ method: "POST", path: "embeddings" }], { baseUrl: "https://example.com/v1/" });
    expect(behind.status).toBe(400);
    expect(JSON.stringify(behind.body)).toContain("behind this connection's base URL");
    const direct = await create(key, [{ method: "POST", path: "v1/embeddings" }], { baseUrl: "https://example.com/v1/" });
    expect(direct.status).toBe(400);
    expect(JSON.stringify(direct.body)).toContain("enable openai.embeddings on the app");
  });

  it("refuses a listing that reaches OpenRouter's own chat or keys behind a base URL on its host", async () => {
    const key = await seedManagementKey();
    for (const listing of [{ method: "POST", path: "api/v1/chat/completions" }, { method: "GET", path: "api/v1/keys" }]) {
      const refused = await admin(key, "POST", "/v2/admin/providers", {
        type: "openrouter",
        name: "OpenRouter",
        slug: `or-${crypto.randomUUID().slice(0, 6)}`,
        secret: "sk-or-live-secret-abcd",
        baseUrl: "https://openrouter.ai/",
        passthrough: [listing],
      });
      expect(refused.status, listing.path).toBe(400);
    }
  });

  it("refuses deleting an ElevenLabs voice when listed, and saves reading one", async () => {
    const key = await seedManagementKey();
    const make = (passthrough: unknown) =>
      admin(key, "POST", "/v2/admin/providers", { type: "elevenlabs", name: "ElevenLabs", slug: `el-${crypto.randomUUID().slice(0, 6)}`, secret: "el-live-secret-abcd", passthrough });
    expect((await make([{ method: "DELETE", path: "v1/voices/{voice_id}" }])).status).toBe(400);
    expect((await make([{ method: "GET", path: "v1/voices/{voice_id}" }])).status).toBe(201);
  });

  it("refuses on fal a listing its model runs would also take", async () => {
    const key = await seedManagementKey();
    const refused = await admin(key, "POST", "/v2/admin/providers", {
      type: "fal",
      name: "fal",
      slug: `fal-${crypto.randomUUID().slice(0, 6)}`,
      secret: "fal-live-secret-abcd",
      passthrough: [{ method: "POST", path: "fal-ai/{a}/{b}" }],
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("fal.run");
  });

  it("lets an app enable passthrough on the connection", async () => {
    const key = await seedManagementKey();
    const created = await create(key, [{ method: "GET", path: "v1/files" }]);
    const app = await admin(key, "POST", "/v2/admin/apps", {
      name: "Files",
      config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: { [created.body.provider.slug]: { operations: ["passthrough"] } } } },
    });
    expect(app.status).toBe(201);
  });

  it("is never taken from a handoff: listing paths is a person's choice", async () => {
    const key = await seedManagementKey();
    const handoff = await admin(key, "POST", "/v2/admin/provider-handoffs", { type: "openai", name: "OpenAI", passthrough: [{ method: "GET", path: "v1/files" }] });
    expect(handoff).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
  });
});
