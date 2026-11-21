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
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { baseUrlOwnerProblem } from "../src/providers/destination.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { compilePassthrough, ProviderMatcher, upstreamRoute, type PassthroughPath } from "../src/providers/matcher.ts";
import type { HttpMethod } from "../src/providers/operation.ts";
import { loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS, seedManagementKey } from "./helpers.ts";

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
