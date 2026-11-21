/**
 * Refused and live-session token paths follow where a request really goes
 * (`src/providers/destination.ts`), not the connection's type: a base URL on
 * another provider's host, or a Cloudflare AI Gateway base URL however much
 * of Cloudflare's path it holds, is judged by the rules of the provider the
 * request reaches. Saving refuses a built-in connection whose new base URL
 * reaches another provider; one stored before is still judged by that
 * provider's rules when serving.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { baseUrlOwnerProblem } from "../src/providers/destination.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { compilePassthrough, ProviderMatcher, upstreamRoute, type PassthroughPath } from "../src/providers/matcher.ts";
import type { HttpMethod } from "../src/providers/operation.ts";
import { storedPassthrough } from "../src/providers/passthrough.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS, seedAccount, seedAppKey, seedManagementKey, seedRoutedApp } from "./helpers.ts";

const provider = (type: string) => BUILT_IN_PROVIDERS[type]!;
const routed = (type: string, baseUrl: string) => {
  const description = provider(type);
  return { matcher: new ProviderMatcher(description), route: upstreamRoute(description, { baseUrl, cloudflareGateway: null }) };
};
const listing = (method: HttpMethod, path: string, liveToken = false): PassthroughPath => ({ method, path, ...(liveToken ? { liveToken: true as const } : {}) });

describe("a Cloudflare base URL, wherever it ends", () => {
  // The same OpenAI paths, with the base URL holding 0, 3 or 4 of Cloudflare's segments.
  const SHAPES = [
    ["0 segments", "https://gateway.ai.cloudflare.com/", "v1/acct/gw/openai/"],
    ["3 segments", "https://gateway.ai.cloudflare.com/v1/acct/gw/", "openai/"],
    ["4 segments", "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/", ""],
  ] as const;

  it.each(SHAPES)("with %s, a token path needs the opt-in and an admin path is refused even with it", (_shape, baseUrl, lead) => {
    const { matcher, route } = routed("openai", baseUrl);
    const token = `${lead}realtime/client_secrets`;
    const plain = compilePassthrough([listing("POST", token)]);
    const optedIn = compilePassthrough([listing("POST", token, true)]);
    expect(matcher.match("POST", token, { passthrough: plain, route })).toMatchObject({ kind: "refused", reason: "refused_path" });
    expect(matcher.match("POST", token, { passthrough: optedIn, route })).toMatchObject({ kind: "passthrough", liveToken: { method: "POST" } });
    expect(matcher.listingVerdict(plain[0]!, route)).toMatchObject({ kind: "token_mint" });
    const admin = `${lead}organization/admin_api_keys`;
    for (const listed of [compilePassthrough([listing("POST", admin)]), compilePassthrough([listing("POST", admin, true)])]) {
      expect(matcher.match("POST", admin, { passthrough: listed, route })).toMatchObject({ kind: "refused", reason: "refused_path" });
      expect(matcher.listingVerdict(listed[0]!, route)).toMatchObject({ kind: "refused" });
    }
  });

  it("judges a path under another provider's endpoint by that provider's rules", () => {
    // An OpenAI connection whose base URL names Anthropic's endpoint, as stored before saving refused it.
    const { matcher, route } = routed("openai", "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/");
    const path = "v1/organizations/invites";
    expect(matcher.match("GET", path, { passthrough: compilePassthrough([listing("GET", path)]), route })).toMatchObject({ kind: "refused" });
    // Without a provider segment in the base URL, each request names its endpoint.
    const open = routed("openai", "https://gateway.ai.cloudflare.com/v1/acct/gw/");
    const named = `anthropic/${path}`;
    expect(open.matcher.match("GET", named, { passthrough: compilePassthrough([listing("GET", named)]), route: open.route })).toMatchObject({ kind: "refused" });
    // A part there could name any endpoint: each mapped provider's reading is judged by its rules, on save too.
    const any = compilePassthrough([listing("GET", `{endpoint}/${path}`)]);
    expect(open.matcher.listingVerdict(any[0]!, open.route)).toMatchObject({ kind: "refused", pattern: "v1/organizations/*" });
    expect(open.matcher.match("GET", named, { passthrough: any, route: open.route })).toMatchObject({ kind: "refused" });
  });
});

describe("every provider Cloudflare AI Gateway reaches, through a short base URL", () => {
  const SHORT = "https://gateway.ai.cloudflare.com/v1/acct/gw/";
  const reached = Object.values(BUILT_IN_PROVIDERS).filter((description) => description.cloudflareEndpoint !== undefined);
  const strip = (description: (typeof reached)[number], path: string) => {
    const prefix = description.cloudflareEndpoint!.stripPathPrefix ?? "";
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  };
  const concrete = (template: string) => template.replace(/\/\*$/, "/x").replace(/\{[^}]+\}/g, "x");

  it("knows an endpoint for every provider a connection may send through the Cloudflare setting", () => {
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      if (description.cloudflareGateway !== undefined) expect(description.cloudflareEndpoint, description.type).toBeDefined();
    }
  });

  it("keeps each one's refused paths refused, and its token paths behind the opt-in, whatever the connection's type", () => {
    for (const target of reached) {
      const slug = target.cloudflareEndpoint!.slug;
      // The provider's own type, and a type whose rules differ.
      for (const type of [target.type, target.type === "openai" ? "anthropic" : "openai"]) {
        const { matcher, route } = routed(type, SHORT);
        for (const entry of target.refused) {
          const rule = typeof entry === "string" ? { path: entry, methods: undefined, hosts: undefined } : entry;
          if (rule.hosts !== undefined) continue;
          const method = rule.methods?.[0] ?? "GET";
          const sent = `${slug}/${strip(target, concrete(rule.path))}`;
          for (const liveToken of [false, true]) {
            const listed = compilePassthrough([listing(method, sent, liveToken)]);
            expect(matcher.match(method, sent, { passthrough: listed, route }), `${type} ${method} ${sent}`).toMatchObject({ kind: "refused" });
          }
        }
        for (const token of target.liveTokens ?? []) {
          const sent = `${slug}/${strip(target, token.mint ?? token.path.replace(/\/\*$/, ""))}`;
          const plain = compilePassthrough([listing(token.method, sent)]);
          expect(matcher.match(token.method, sent, { passthrough: plain, route }), `${type} ${token.method} ${sent}`).toMatchObject({ kind: "refused" });
          const optedIn = compilePassthrough([listing(token.method, sent, true)]);
          expect(matcher.match(token.method, sent, { passthrough: optedIn, route }), `${type} opted-in ${sent}`).toMatchObject({
            kind: "passthrough",
            liveToken: { method: token.method },
          });
        }
      }
    }
  });

  it("refuses the cases Fable named: ElevenLabs tokens and key creation, and Deepgram's grant", () => {
    const cases = [
      ["elevenlabs", "GET", "elevenlabs/v1/convai/conversation/token"],
      ["elevenlabs", "POST", "elevenlabs/v1/service-accounts/a1/api-keys"],
      ["openai", "POST", "deepgram/v1/auth/grant"],
      ["openai", "GET", "elevenlabs/v1/convai/conversation/token"],
    ] as const;
    for (const [type, method, path] of cases) {
      const { matcher, route } = routed(type, SHORT);
      const listed = compilePassthrough([listing(method, path)]);
      expect(matcher.match(method, path, { passthrough: listed, route }), `${type} ${path}`).toMatchObject({ kind: "refused" });
      expect(matcher.listingVerdict(listed[0]!, route).kind, `${type} ${path}`).not.toBe("free");
    }
  });

  it("serves ElevenLabs and Deepgram connections on their own Cloudflare endpoint, under their refusals", () => {
    const eleven = routed("elevenlabs", `${SHORT}elevenlabs/`);
    const keys = "v1/service-accounts/a1/api-keys";
    expect(eleven.matcher.match("POST", keys, { passthrough: compilePassthrough([listing("POST", keys)]), route: eleven.route })).toMatchObject({ kind: "refused" });
    const token = "v1/convai/conversation/token";
    expect(eleven.matcher.match("GET", token, { passthrough: compilePassthrough([listing("GET", token)]), route: eleven.route })).toMatchObject({ kind: "refused" });
    expect(eleven.matcher.match("GET", token, { passthrough: compilePassthrough([listing("GET", token, true)]), route: eleven.route })).toMatchObject({
      kind: "passthrough",
      liveToken: { method: "GET" },
    });
    const deepgram = routed("deepgram", `${SHORT}deepgram/`);
    const grant = "v1/auth/grant";
    expect(deepgram.matcher.match("POST", grant, { passthrough: compilePassthrough([listing("POST", grant, true)]), route: deepgram.route })).toMatchObject({ kind: "refused" });
  });
});

describe("a base URL on another provider's host, stored before saving refused it", () => {
  it("is judged by the host owner's refused and token paths when serving", () => {
    const { matcher, route } = routed("mistral", "https://api.openai.com/");
    expect(route.owner?.type).toBe("openai");
    for (const path of ["v1/realtime/client_secrets", "v1/organization/admin_api_keys"]) {
      expect(matcher.match("POST", path, { passthrough: compilePassthrough([listing("POST", path)]), route }), path).toMatchObject({ kind: "refused" });
    }
    const onXai = routed("openai", "https://management-api.x.ai/");
    const create = "auth/teams/t1/api-keys";
    expect(onXai.matcher.match("POST", create, { passthrough: compilePassthrough([listing("POST", create)]), route: onXai.route })).toMatchObject({ kind: "refused" });
  });

  it("reads the path under the host owner's built-in prefix, whatever the connection's type", () => {
    // OpenRouter reads `https://openrouter.ai/` paths under `api`: `api/v1/credits` is its `v1/credits`.
    const { matcher, route } = routed("mistral", "https://openrouter.ai/");
    expect(route.hostPrefix).toEqual(["api"]);
    const path = "api/v1/credits";
    const listed = compilePassthrough([listing("GET", path)]);
    expect(matcher.match("GET", path, { passthrough: listed, route })).toMatchObject({ kind: "refused" });
    expect(matcher.listingVerdict(listed[0]!, route)).toMatchObject({ kind: "refused" });
    // The connection's own host keeps its own prefix, as before.
    const own = routed("openrouter", "https://openrouter.ai/api/");
    expect(own.matcher.match("GET", "v1/credits", { passthrough: compilePassthrough([listing("GET", "v1/credits")]), route: own.route })).toMatchObject({ kind: "refused" });
  });

  it("refuses OpenRouter's credits on a stored Mistral connection at openrouter.ai, and sends nothing", async () => {
    await loadManagement();
    clearCaches();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: { total_credits: 1 } }));
    await seedAccount();
    const id = crypto.randomUUID().replaceAll("-", "");
    const slug = `mistral-${id.slice(0, 6)}`;
    const baseUrl = "https://openrouter.ai/";
    const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, "mistral", baseUrl], "sk-test-1234");
    const now = Date.now();
    // Written directly, as a row stored before saving refused another provider's host.
    await env.DB.prepare(
      `INSERT INTO provider_connection
        (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, passthrough_json, revision, created_by, created_at, updated_at)
       VALUES (?, ?, 'mistral', ?, 'Mistral', 'active', ?, '1234', ?, ?, 1, 'usr_test', ?, ?)`,
    )
      .bind(id, ACCOUNT_ID, slug, blob, baseUrl, storedPassthrough([{ method: "GET", path: "api/v1/credits" }]), now, now)
      .run();
    const appId = await seedRoutedApp({ type: "api_key", end_user: { source: "none" } }, { providers: { [slug]: { operations: ["passthrough"] } } });
    const { key } = await seedAppKey(appId);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://gateway.test/v2/apps/${appId}/proxy/${slug}/api/v1/credits`, { headers: { authorization: `Bearer ${key}` } }),
      env,
      ctx,
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("openrouter.ai"))).toBe(false);
  });

  it("refuses every path on xAI's management host, a declared operation's included", () => {
    const { matcher, route } = routed("xai", "https://management-api.x.ai/");
    for (const [method, path] of [["GET", "v1/models"], ["POST", "v1/chat/completions"], ["GET", "anything/at/all"]] as const) {
      expect(matcher.match(method, path, { passthrough: compilePassthrough([listing(method, path)]), route }), path).toMatchObject({ kind: "refused" });
    }
    // On xAI's own API host, its declared operations are served as always.
    const direct = routed("xai", "https://api.x.ai/");
    expect(direct.matcher.match("POST", "v1/chat/completions", { route: direct.route })).toMatchObject({ kind: "operation" });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("saving a built-in connection's base URL", () => {
  it.each([
    ["openai", "https://gateway.ai.cloudflare.com/v1/acct/gw/elevenlabs/", true],
    ["openai", "https://gateway.ai.cloudflare.com/v1/acct/gw/workers-ai/", true],
    ["openai", "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/", false],
    ["openai", "https://gateway.ai.cloudflare.com/v1/acct/gw/", false],
    ["openai", "https://gateway.ai.cloudflare.com/", false],
    ["xai", "https://gateway.ai.cloudflare.com/v1/acct/gw/grok/", false],
    ["mistral", "https://api.openai.com/", true],
    ["openai", "https://management-api.x.ai/", true],
    ["openai", "https://eu.api.openai.com/", false],
    ["openai", "https://llm.example.com/v1/", false],
    // A provider with no Cloudflare setting still has its own endpoint there.
    ["elevenlabs", "https://gateway.ai.cloudflare.com/v1/acct/gw/elevenlabs/", false],
    ["deepgram", "https://gateway.ai.cloudflare.com/v1/acct/gw/deepgram/", false],
    ["elevenlabs", "https://gateway.ai.cloudflare.com/v1/acct/gw/deepgram/", true],
  ] as const)("%s at %s is refused: %s", (type, baseUrl, refused) => {
    expect(baseUrlOwnerProblem(provider(type), baseUrl) !== null).toBe(refused);
  });
});

describe("saving through the API", () => {
  beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

  async function admin(key: string, method: string, path: string, body: unknown) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://gateway.test${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  it("refuses a new or changed base URL that reaches another provider, and keeps the connection's own working", async () => {
    const key = await seedManagementKey();
    const create = (type: string, baseUrl: string) =>
      admin(key, "POST", "/v2/admin/providers", { type, name: type, slug: `${type}-${crypto.randomUUID().slice(0, 6)}`, secret: "sk-test-1234", baseUrl });
    const foreign = await create("mistral", "https://api.openai.com/");
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.message).toContain("OpenAI");
    const elsewhere = await create("openai", "https://gateway.ai.cloudflare.com/v1/acct/gw/elevenlabs/");
    expect(elsewhere.status).toBe(400);
    const own = await create("openai", "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/");
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    // A change to another provider's host is refused too.
    const moved = await admin(key, "PUT", `/v2/admin/providers/${own.body.provider.id}`, { baseUrl: "https://api.anthropic.com/", secret: "sk-test-1234" });
    expect(moved.status).toBe(400);
  });
});

describe("one place decides whose rules judge a request", () => {
  const sources = (import.meta as ImportMeta & {
    glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>;
  }).glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");

  it("reads refused and token paths only in the matcher, and a host's owner only through destination.ts", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      const body = code(text);
      // The rules are compiled from a description in one place, for every provider a request reaches.
      if (file !== "../src/providers/matcher.ts" && /\.(refused|liveTokens)\b(?!\s*:)/u.test(body)) offenders.push(`${file}: reads a provider's rules`);
      // Who owns a host is decided once; nothing else compares host names to provider types.
      if (!file.endsWith("/providers/destination.ts") && /\bfunction (hostOwner|knownHostOwner|declaredHostNames)\b/u.test(body)) offenders.push(`${file}: decides a host's owner`);
    }
    expect(offenders).toEqual([]);
  });
});
