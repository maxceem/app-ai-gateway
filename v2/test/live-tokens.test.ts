/**
 * Live-session token endpoints (plan D4, step 5c): paths that mint a
 * short-lived secret for one live call. They are refused like refused paths
 * until a listed path opts in to them (`live_token`). Once opted in, a mint
 * goes through auth and limits as any passthrough call, is charged as a
 * `live_token` call, and its window for starting a call is locked to 60
 * seconds where the request sets it. The provider is mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { compilePassthrough, ProviderMatcher, upstreamRoute } from "../src/providers/matcher.ts";
import { LIVE_TOKEN_WINDOW_SECONDS, type HttpMethod, type LiveTokenForced, type LiveTokenValue } from "../src/providers/operation.ts";
import { lockedLiveTokenBody, lockedLiveTokenQuery, readPassthrough, storedPassthrough } from "../src/providers/passthrough.ts";
import { clearCaches, loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS, seedAppKey, seedManagementKey, seedRoutedApp } from "./helpers.ts";

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Each provider's live-session token endpoints, as a client calls them. */
const TOKEN_ENDPOINTS: readonly (readonly [type: string, method: HttpMethod, path: string])[] = [
  ["openai", "POST", "v1/realtime/client_secrets"],
  ["openai", "POST", "v1/realtime/sessions"],
  ["openai", "POST", "v1/realtime/transcription_sessions"],
  ["openai", "POST", "v1/chatkit/sessions"],
  ["xai", "POST", "v1/realtime/client_secrets"],
  ["gemini", "POST", "v1alpha/auth_tokens"],
  ["elevenlabs", "POST", "v1/single-use-token/tts_websocket"],
  ["elevenlabs", "GET", "v1/convai/conversation/token"],
  ["elevenlabs", "GET", "v1/convai/conversation/get-signed-url"],
  ["elevenlabs", "POST", "v1/single-use-token/realtime_scribe"],
  ["elevenlabs", "POST", "v1/convai/realtime/client_secrets"],
];

const describedAs = (type: string) => BUILT_IN_PROVIDERS[type]!;

describe("matching a live-session token path", () => {
  it.each(TOKEN_ENDPOINTS)("%s %s %s is refused when listed, and reached once the listing opts in", (type, method, path) => {
    const matcher = new ProviderMatcher(describedAs(type));
    expect(matcher.match(method, path)).toMatchObject({ kind: "refused", reason: "refused_path" });
    expect(matcher.match(method, path, { passthrough: compilePassthrough([{ method, path }]) })).toMatchObject({ kind: "refused", reason: "refused_path" });
    const optedIn = matcher.match(method, path, { passthrough: compilePassthrough([{ method, path, liveToken: true }]) });
    expect(optedIn).toMatchObject({ kind: "passthrough" });
    expect(optedIn.kind === "passthrough" && optedIn.liveToken).not.toBeNull();
  });

  it.each([
    ["openai", "POST", "v1/organization/admin_api_keys"],
    ["xai", "GET", "v1/api-key"],
    ["deepgram", "POST", "v1/projects/p1/keys"],
    // Its token also allows ordinary transcription and speech, not just one live session.
    ["deepgram", "POST", "v1/auth/grant"],
    // Only the mint itself: managing what it made, or another method, stays refused.
    ["openai", "POST", "v1/chatkit/sessions/cksess_1/cancel"],
    ["openai", "GET", "v1/chatkit/sessions"],
    ["openai", "DELETE", "v1/realtime/client_secrets"],
    ["elevenlabs", "POST", "v1/convai/agents/agent_1/link"],
    // An agent's link answers with a shareable token that may never expire.
    ["elevenlabs", "GET", "v1/convai/agents/agent_1/link"],
    // The single-use token namespace stays refused around its two mints.
    ["elevenlabs", "GET", "v1/single-use-token/batch_scribe"],
    ["elevenlabs", "POST", "v1/single-use-token/batch_scribe"],
    ["elevenlabs", "GET", "v1/single-use-token/realtime_scribe"],
    // Anything under another token path that is not its mint.
    ["openai", "POST", "v1/realtime/client_secrets/cs_1"],
    ["xai", "GET", "v1/realtime/client_secrets"],
    ["gemini", "GET", "v1alpha/auth_tokens"],
    ["elevenlabs", "POST", "v1/convai/conversation/token"],
    ["elevenlabs", "GET", "v1/user"],
    ["elevenlabs", "DELETE", "v1/voices/v1"],
  ] as const)("keeps %s %s %s refused, opt-in or not", (type, method, path) => {
    const matcher = new ProviderMatcher(describedAs(type));
    for (const passthrough of [compilePassthrough([{ method, path }]), compilePassthrough([{ method, path, liveToken: true }])]) {
      expect(matcher.match(method, path, { passthrough })).toMatchObject({ kind: "refused", reason: "refused_path" });
    }
  });

  it("lets an opted-in mint through behind a broader listing that does not opt in, in either order", () => {
    const matcher = new ProviderMatcher(describedAs("openai"));
    const broad = { method: "POST" as const, path: "v1/realtime/{endpoint}" };
    const mint = { method: "POST" as const, path: "v1/realtime/client_secrets", liveToken: true as const };
    for (const order of [[broad, mint], [mint, broad]]) {
      const passthrough = compilePassthrough(order);
      expect(matcher.match("POST", "v1/realtime/client_secrets", { passthrough })).toMatchObject({ kind: "passthrough", listed: { liveToken: true } });
      // The broad listing still serves its other paths, and reaches no token path itself.
      expect(matcher.match("POST", "v1/realtime/calls", { passthrough })).toMatchObject({ kind: "passthrough", liveToken: null });
    }
    // Without an opted-in listing, the broad one alone does not reach the mint.
    expect(matcher.match("POST", "v1/realtime/client_secrets", { passthrough: compilePassthrough([broad]) })).toMatchObject({ kind: "refused", reason: "refused_path" });
  });

  it("keeps the opt-in to the paths it was made for: case and encoding tricks reach only the token path itself", () => {
    const matcher = new ProviderMatcher(describedAs("openai"));
    const passthrough = compilePassthrough([{ method: "POST", path: "v1/realtime/client_secrets", liveToken: true }]);
    // Token paths ignore case; a listing compares exactly, so it does not take this one.
    expect(matcher.match("POST", "V1/REALTIME/client_secrets", { passthrough })).toMatchObject({ kind: "refused", reason: "refused_path" });
    // Decoded, it is the same path: the opted-in listing takes it, as the token path it is.
    expect(matcher.match("POST", "v1/realtime/%63lient_secrets", { passthrough })).toMatchObject({ kind: "passthrough", liveToken: { path: "v1/realtime/client_secrets/*" } });
    expect(matcher.match("POST", "v1/realtime/client_secrets/../../organization/users", { passthrough })).toMatchObject({ kind: "refused", reason: "bad_path" });
  });

  it("judges the mint where the provider reads it: a base URL that puts the listing under the namespace stays refused", () => {
    const description = describedAs("elevenlabs");
    const matcher = new ProviderMatcher(description);
    const route = upstreamRoute(description, { baseUrl: "https://api.elevenlabs.io/v1/single-use-token/", cloudflareGateway: null });
    // Sent as `v1/single-use-token/v1/single-use-token/tts_websocket`: under the namespace, not its mint.
    const doubled = compilePassthrough([{ method: "POST", path: "v1/single-use-token/tts_websocket", liveToken: true }]);
    expect(matcher.liveTokenCovering(doubled[0]!, route)).toBeNull();
    expect(matcher.match("POST", "v1/single-use-token/tts_websocket", { passthrough: doubled, route })).toMatchObject({ kind: "refused", reason: "refused_path" });
    // The relative listing resolves to the mint itself, and is reached.
    const relative = compilePassthrough([{ method: "POST", path: "tts_websocket", liveToken: true }]);
    expect(matcher.liveTokenCovering(relative[0]!, route)).toMatchObject({ method: "POST" });
    expect(matcher.match("POST", "tts_websocket", { passthrough: relative, route })).toMatchObject({ kind: "passthrough", liveToken: { method: "POST" } });
  });

  it("reads a base URL on Cloudflare AI Gateway as the Cloudflare setting reads its paths", () => {
    const description = describedAs("openai");
    const matcher = new ProviderMatcher(description);
    // Cloudflare's OpenAI endpoint adds back `v1`, so `realtime/client_secrets` reaches the token path.
    const route = upstreamRoute(description, { baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/", cloudflareGateway: null });
    const plain = compilePassthrough([{ method: "POST", path: "realtime/client_secrets" }]);
    expect(matcher.match("POST", "realtime/client_secrets", { passthrough: plain, route })).toMatchObject({ kind: "refused", reason: "refused_path" });
    expect(matcher.refusedCovering(plain[0]!, route)).toBe("v1/realtime/client_secrets/*");
    // Admin paths too, written as the endpoint reads them.
    const admin = compilePassthrough([{ method: "GET", path: "organization/users" }]);
    expect(matcher.refusedCovering(admin[0]!, route)).toBe("v1/organization/*");
    expect(matcher.match("GET", "organization/users", { passthrough: admin, route })).toMatchObject({ kind: "refused", reason: "refused_path" });
    // Opted in, it is the mint.
    const optedIn = compilePassthrough([{ method: "POST", path: "realtime/client_secrets", liveToken: true }]);
    expect(matcher.liveTokenCovering(optedIn[0]!, route)).toMatchObject({ method: "POST" });
    expect(matcher.match("POST", "realtime/client_secrets", { passthrough: optedIn, route })).toMatchObject({ kind: "passthrough", liveToken: { method: "POST" } });
  });

  it("refuses every built-in provider's refused paths through a base URL on its Cloudflare AI Gateway endpoint", () => {
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      const slug = description.cloudflareGateway?.slug;
      if (slug === undefined) continue;
      const matcher = new ProviderMatcher(description);
      const route = upstreamRoute(description, { baseUrl: `https://gateway.ai.cloudflare.com/v1/acct/gw/${slug}/`, cloudflareGateway: null });
      const strip = description.cloudflareGateway?.stripPathPrefix ?? "";
      for (const entry of description.refused) {
        const rule = typeof entry === "string" ? { path: entry, methods: undefined, hosts: undefined } : entry;
        if (rule.hosts !== undefined) continue;
        const method = rule.methods?.[0] ?? "GET";
        // A concrete path under the rule, written as the client sends it to the endpoint.
        const concrete = rule.path.replace(/\/\*$/, "/x").replace(/\{[^}]+\}/g, "x");
        const sent = concrete.startsWith(strip) ? concrete.slice(strip.length) : concrete;
        const listed = compilePassthrough([{ method, path: sent }]);
        expect(matcher.match(method, sent, { passthrough: listed, route }), `${description.type} ${method} ${sent}`).toMatchObject({ kind: "refused" });
      }
    }
  });

  it("refuses xAI's management paths only on its management host", () => {
    const description = describedAs("xai");
    const matcher = new ProviderMatcher(description);
    const health = compilePassthrough([{ method: "GET", path: "auth/health" }]);
    // An xAI-compatible server: `auth/health` is an ordinary path there, as it was before.
    const compatible = upstreamRoute(description, { baseUrl: "https://grok-compatible.example.com/", cloudflareGateway: null });
    expect(matcher.match("GET", "auth/health", { passthrough: health, route: compatible })).toMatchObject({ kind: "passthrough" });
    expect(matcher.refusedCovering(health[0]!, compatible)).toBeNull();
    // The management host: key creation stays refused.
    const management = upstreamRoute(description, { baseUrl: "https://management-api.x.ai/", cloudflareGateway: null });
    const create = compilePassthrough([{ method: "POST", path: "auth/teams/{teamId}/api-keys" }]);
    expect(matcher.refusedCovering(create[0]!, management)).toBe("auth/*");
    expect(matcher.match("POST", "auth/teams/t1/api-keys", { passthrough: create, route: management })).toMatchObject({ kind: "refused", reason: "refused_path" });
    expect(matcher.match("GET", "auth/health", { passthrough: health, route: management })).toMatchObject({ kind: "refused", reason: "refused_path" });
  });

  it("refuses an opt-in that some value of its parts would send under a token path but not to its mint", () => {
    const description = describedAs("gemini");
    const matcher = new ProviderMatcher(description);
    const route = upstreamRoute(description, { baseUrl: "https://generativelanguage.googleapis.com/v1alpha/", cloudflareGateway: null });
    // `{version}` as `auth_tokens` sends `v1alpha/auth_tokens/auth_tokens`, under the namespace and not its mint.
    const wide = compilePassthrough([{ method: "POST", path: "{version}/auth_tokens", liveToken: true }]);
    expect(matcher.liveTokenCovering(wide[0]!, route)).toBeNull();
    expect(matcher.match("POST", "auth_tokens/auth_tokens", { passthrough: wide, route })).toMatchObject({ kind: "refused", reason: "refused_path" });
    // The relative listing is the mint itself, wherever it is read.
    const relative = compilePassthrough([{ method: "POST", path: "auth_tokens", liveToken: true }]);
    expect(matcher.liveTokenCovering(relative[0]!, route)).toMatchObject({ method: "POST" });
    expect(matcher.match("POST", "auth_tokens", { passthrough: relative, route })).toMatchObject({ kind: "passthrough", liveToken: { method: "POST" } });
    // Without a base path, the template is the mint for every version.
    expect(matcher.liveTokenCovering(wide[0]!)).toMatchObject({ method: "POST" });
    // Two token paths that share a namespace each keep their own mint.
    const elevenlabs = new ProviderMatcher(describedAs("elevenlabs"));
    for (const type of ["realtime_scribe", "tts_websocket"]) {
      const listed = compilePassthrough([{ method: "POST", path: `v1/single-use-token/${type}`, liveToken: true }]);
      expect(elevenlabs.liveTokenCovering(listed[0]!)).toMatchObject({ method: "POST" });
    }
  });

  it("refuses on save a Gemini opt-in whose parts could land under the token path beside the mint", async () => {
    const management = await seedManagementKey();
    const save = (path: string) =>
      admin(management, "POST", "/v2/admin/providers", {
        name: "gemini",
        slug: `gemini-${crypto.randomUUID().slice(0, 6)}`,
        secret: SECRET,
        type: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1alpha/",
        passthrough: [{ method: "POST", path, live_token: true }],
      });
    const wide = await save("{version}/auth_tokens");
    expect(wide.status, JSON.stringify(wide.body)).toBe(400);
    const relative = await save("auth_tokens");
    expect(relative.status, JSON.stringify(relative.body)).toBe(201);
  });

  it("gives a custom provider on a known host that provider's token paths, and none elsewhere", async () => {
    const { customDescription } = await import("../src/providers/custom.ts");
    const auth = { header: "authorization", format: "Bearer {key}" };
    const onOpenAi = new ProviderMatcher(customDescription({ baseUrl: "https://api.openai.com/", auth, paths: [] }));
    const listed = (liveToken: boolean) => compilePassthrough([{ method: "POST", path: "v1/realtime/client_secrets", ...(liveToken ? { liveToken: true as const } : {}) }]);
    expect(onOpenAi.match("POST", "v1/realtime/client_secrets", { passthrough: listed(false) })).toMatchObject({ kind: "refused" });
    expect(onOpenAi.match("POST", "v1/realtime/client_secrets", { passthrough: listed(true) })).toMatchObject({ kind: "passthrough" });
    const elsewhere = new ProviderMatcher(customDescription({ baseUrl: "https://llm.example.com/", auth, paths: [] }));
    expect(elsewhere.match("POST", "v1/realtime/client_secrets", { passthrough: listed(false) })).toMatchObject({ kind: "passthrough", liveToken: null });
  });
});

describe("locking a mint's window", () => {
  it("replaces the nested expiry of OpenAI's older Realtime mints, under both spellings", () => {
    const now = Date.parse("2026-11-21T10:00:00.000Z");
    const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    for (const path of ["v1/realtime/sessions/*", "v1/realtime/transcription_sessions/*"]) {
      const forced = describedAs("openai").liveTokens!.find((token) => token.path === path)!.forced!;
      const sent = { model: "m", client_secret: { expires_after: { anchor: "created_at", seconds: 600 }, expires_at: { seconds: 600 }, other: 1 } };
      const locked = lockedLiveTokenBody(forced, encoded(sent), now);
      if (locked.kind !== "locked") throw new Error(`${path}: not locked`);
      const body = JSON.parse(new TextDecoder().decode(locked.bytes)) as { client_secret: Record<string, unknown> };
      const written = forced.fields![0].names[0].split(".")[1]!;
      expect(body.client_secret, path).toEqual({ other: 1, [written]: { anchor: "created_at", seconds: 60 } });
      // No `client_secret` sent: it is created.
      const bare = lockedLiveTokenBody(forced, encoded({ model: "m" }), now);
      expect(bare.kind === "locked" && JSON.parse(new TextDecoder().decode(bare.bytes)), path).toEqual({ model: "m", client_secret: { [written]: { anchor: "created_at", seconds: 60 } } });
      // A `client_secret` that is not an object is replaced by one.
      const odd = lockedLiveTokenBody(forced, encoded({ client_secret: "x" }), now);
      expect(odd.kind === "locked" && JSON.parse(new TextDecoder().decode(odd.bytes)), path).toEqual({ client_secret: { [written]: { anchor: "created_at", seconds: 60 } } });
    }
  });

  it("sets an ElevenLabs signed URL to single use, replacing every value the client sent", () => {
    for (const path of ["v1/convai/conversation/get-signed-url/*", "v1/convai/conversation/get_signed_url/*"]) {
      const forced = describedAs("elevenlabs").liveTokens!.find((token) => token.path === path)!.forced!;
      expect(lockedLiveTokenQuery(forced, "?agent_id=a1&include_conversation_id=false&include_conversation_id=0")).toBe("?agent_id=a1&include_conversation_id=true");
      expect(lockedLiveTokenQuery(forced, "")).toBe("?include_conversation_id=true");
    }
  });

  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const decode = (result: ReturnType<typeof lockedLiveTokenBody>) => (result.kind === "locked" ? JSON.parse(new TextDecoder().decode(result.bytes)) : result);
  const NOW = Date.parse("2026-11-21T10:00:00.000Z");
  const one = (name: string, value: LiveTokenValue): LiveTokenForced => ({ fields: [{ names: [name], value }] });

  it.each([
    [one("expires_after", { window: "expires_after", anchor: true }), "expires_after", { anchor: "created_at", seconds: 60 }],
    [one("expires_after", { window: "expires_after" }), "expires_after", { seconds: 60 }],
    [one("ttl_seconds", { window: "seconds" }), "ttl_seconds", 60],
    [one("newSessionExpireTime", { window: "time" }), "newSessionExpireTime", "2026-11-21T10:01:00.000Z"],
    [one("uses", { fixed: 1 }), "uses", 1],
  ] as const)("writes %j over whatever the client sent", (forced, field, value) => {
    expect(LIVE_TOKEN_WINDOW_SECONDS).toBe(60);
    const sent = { session: { model: "m" }, [field]: 7200 };
    expect(decode(lockedLiveTokenBody(forced, encode(sent), NOW))).toEqual({ session: { model: "m" }, [field]: value });
    // Set when the client sent nothing.
    expect(decode(lockedLiveTokenBody(forced, new Uint8Array(), NOW))).toEqual({ [field]: value });
  });

  it("removes every spelling of a forced field and writes only the first, so the provider reads one value", () => {
    const forced: LiveTokenForced = {
      fields: [
        { names: ["newSessionExpireTime", "new_session_expire_time"], value: { window: "time" } },
        { names: ["uses"], value: { fixed: 1 } },
      ],
    };
    const sent = { new_session_expire_time: "2026-11-22T10:00:00Z", newSessionExpireTime: "2026-11-22T10:00:00Z", uses: 0, expireTime: "2026-11-21T10:30:00Z" };
    expect(decode(lockedLiveTokenBody(forced, encode(sent), NOW))).toEqual({
      newSessionExpireTime: "2026-11-21T10:01:00.000Z",
      uses: 1,
      expireTime: "2026-11-21T10:30:00Z",
    });
    // Only the snake_case spelling sent: it is gone too.
    expect(decode(lockedLiveTokenBody(forced, encode({ new_session_expire_time: "2027-01-01T00:00:00Z" }), NOW))).toEqual({
      newSessionExpireTime: "2026-11-21T10:01:00.000Z",
      uses: 1,
    });
    // A key sent twice in the text is one key once read.
    expect(decode(lockedLiveTokenBody(forced, new TextEncoder().encode('{"uses":0,"uses":0}'), NOW))).toEqual({ newSessionExpireTime: "2026-11-21T10:01:00.000Z", uses: 1 });
  });

  it("leaves a mint that forces no body field as it is, and calls a body that is not a JSON object unreadable", () => {
    const forced = one("ttl_seconds", { window: "seconds" });
    expect(lockedLiveTokenBody({ query: [{ name: "include_conversation_id", value: "true" }] }, new TextEncoder().encode("anything"), 0)).toEqual({ kind: "same" });
    for (const body of ["[1]", "7", "not json", "\"text\""]) {
      expect(lockedLiveTokenBody(forced, new TextEncoder().encode(body), 0), body).toEqual({ kind: "unreadable" });
    }
    expect(lockedLiveTokenBody(forced, new Uint8Array([0xff, 0xfe]), 0)).toEqual({ kind: "unreadable" });
  });

  it("reads a JSON null body as an empty one, and adds the forced fields", () => {
    // ElevenLabs' realtime client-secret mint accepts a null body.
    const forced = one("ttl_seconds", { window: "seconds" });
    expect(decode(lockedLiveTokenBody(forced, encode(null), 0))).toEqual({ ttl_seconds: 60 });
    expect(decode(lockedLiveTokenBody(forced, new TextEncoder().encode(" null "), 0))).toEqual({ ttl_seconds: 60 });
  });
});

describe("storing the opt-in", () => {
  it("writes `live_token` only when true, and reads it back", () => {
    expect(storedPassthrough([{ method: "POST", path: "v1/realtime/client_secrets" }])).not.toContain("live_token");
    const stored = storedPassthrough([{ method: "POST", path: "v1/realtime/client_secrets", liveToken: true }]);
    expect(JSON.parse(stored!)).toEqual({ paths: [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }] });
    expect(readPassthrough(stored)).toEqual([{ method: "POST", path: "v1/realtime/client_secrets", liveToken: true }]);
    expect(readPassthrough(JSON.stringify({ paths: [{ method: "POST", path: "x", live_token: "yes" }] }))).toEqual([{ method: "POST", path: "x" }]);
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

/** A connection made through the API, so its listing is saved as a customer would save it, and an app that enables passthrough on it. */
async function connected(
  fields: Record<string, unknown>,
  limits?: Record<string, unknown>,
): Promise<{ appId: string; slug: string; key: string }> {
  const management = await seedManagementKey();
  const type = String(fields.type);
  const slug = `${type}-${crypto.randomUUID().slice(0, 6)}`;
  const created = await admin(management, "POST", "/v2/admin/providers", { name: type, slug, secret: SECRET, ...fields });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const authentication = { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } };
  const routing = { providers: { [slug]: { operations: ["passthrough"] } } };
  const appId = await seedRoutedApp(authentication, routing);
  if (limits !== undefined) {
    await env.DB.prepare("UPDATE app SET config_json = ? WHERE id = ?").bind(JSON.stringify({ authentication, routing, limits }), appId).run();
  }
  const { key } = await seedAppKey(appId);
  return { appId, slug, key };
}

async function send(method: string, path: string, key: string, body?: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, text };
}

const sentBody = (call: number) => JSON.parse(new TextDecoder().decode(fetchSpy.mock.calls[call]![1]!.body as Uint8Array)) as Record<string, unknown>;

async function chargesOf(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
  return results;
}

/** Pins `Date` to the middle of a minute, so two requests counted per minute land in the same one. */
function pinClockMidMinute(): number {
  const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  return now;
}

describe("saving a live-session token path", () => {
  const create = (passthrough: unknown, type = "openai") =>
    seedManagementKey().then((key) =>
      admin(key, "POST", "/v2/admin/providers", { type, name: type, slug: `${type}-${crypto.randomUUID().slice(0, 6)}`, secret: SECRET, passthrough }),
    );

  it("refuses the path without the opt-in, saying how to opt in", async () => {
    const refused = await create([{ method: "POST", path: "v1/realtime/client_secrets" }]);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain("set live_token to true");
  });

  it("refuses a path under a token path that is not its mint, without suggesting the opt-in", async () => {
    const refused = await create([{ method: "POST", path: "v1/chatkit/sessions/{session_id}/cancel" }]);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain("always refused");
  });

  it("saves it with the opt-in, and shows the opt-in back", async () => {
    const saved = await create([{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.provider.passthrough).toEqual([{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }]);
    // `false` is the same as leaving it out, and is not shown.
    const plain = await create([{ method: "GET", path: "v1/files/{id}", live_token: false }]);
    expect(plain.body.provider.passthrough).toEqual([{ method: "GET", path: "v1/files/{id}" }]);
  });

  it.each([
    [[{ method: "POST", path: "v1/organization/admin_api_keys", live_token: true }], "always refused"],
    [[{ method: "GET", path: "v1/files", live_token: true }], "not one of OpenAI's live-session token paths"],
    // Only some of its requests are token paths: it cannot opt in, nor be listed without.
    [[{ method: "POST", path: "v1/realtime/{thing}", live_token: true }], "not one of OpenAI's live-session token paths"],
    // Only the mint itself opts in: cancelling a ChatKit session, or another method on a mint's path, does not.
    // Under a token path but not its mint: always refused, the same answer as without the opt-in.
    [[{ method: "POST", path: "v1/chatkit/sessions/{session_id}/cancel", live_token: true }], "always refused"],
    [[{ method: "GET", path: "v1/chatkit/sessions", live_token: true }], "always refused"],
    // Deepgram's grant also allows ordinary transcription and speech.
    [[{ method: "POST", path: "v1/auth/grant", live_token: true }], "always refused", "deepgram"],
  ])("refuses %j", async (passthrough, message, type = "openai") => {
    const refused = await create(passthrough, type);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain(message);
  });

  it("refuses the opt-in on a custom provider's API-style path, and on a host with no token paths", async () => {
    const key = await seedManagementKey();
    const custom = (baseUrl: string, passthrough: unknown) =>
      admin(key, "POST", "/v2/admin/providers", {
        type: "custom",
        name: "Mine",
        slug: `mine-${crypto.randomUUID().slice(0, 6)}`,
        secret: SECRET,
        baseUrl,
        auth: { header: "authorization", format: "Bearer {key}" },
        passthrough,
      });
    const styled = await custom("https://llm.example.com/", [{ method: "POST", path: "chat/completions", style: "openai-chat", live_token: true }]);
    expect(styled.body.error.message).toContain("not a live-session token path");
    const unknown = await custom("https://llm.example.com/", [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }]);
    expect(unknown.body.error.message).toContain("live-session token paths");
    const onOpenAi = await custom("https://api.openai.com/", [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }]);
    expect(onOpenAi.status, JSON.stringify(onOpenAi.body)).toBe(201);
  });
});

describe("serving a live-session mint", () => {
  it("refuses the mint when the stored listing does not opt in, and sends nothing", async () => {
    const { appId, slug, key } = await connected({ type: "openai", passthrough: [{ method: "GET", path: "v1/files/{id}" }] });
    // As if stored by an older release, without the opt-in.
    await env.DB.prepare("UPDATE provider_connection SET passthrough_json = ? WHERE slug = ?")
      .bind(storedPassthrough([{ method: "POST", path: "v1/realtime/client_secrets" }]), slug)
      .run();
    clearCaches();
    const { status } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, "{}");
    expect(status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("locks OpenAI's client secret to 60 seconds whatever the client asks, keeps the rest, and charges a `live_token` call", async () => {
    const { appId, slug, key } = await connected({ type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }] });
    fetchSpy.mockImplementation(async () => Response.json({ value: "ek_minted", expires_at: 1 }));
    const asked = JSON.stringify({ session: { type: "realtime", model: "gpt-realtime" }, expires_after: { anchor: "created_at", seconds: 7200 } });
    const minted = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, asked);
    expect(minted.status, minted.text).toBe(200);
    expect(JSON.parse(minted.text)).toEqual({ value: "ek_minted", expires_at: 1 });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(new Headers(init!.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(new Headers(init!.headers).get("content-type")).toBe("application/json");
    expect(sentBody(0)).toEqual({ session: { type: "realtime", model: "gpt-realtime" }, expires_after: { anchor: "created_at", seconds: 60 } });
    // Set when left out, and with no body at all.
    await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, JSON.stringify({ session: { type: "realtime" } }));
    expect(sentBody(1).expires_after).toEqual({ anchor: "created_at", seconds: 60 });
    expect((await chargesOf(appId)).map((charge) => [charge.operation, charge.price_source, charge.cost_nano, charge.model])).toEqual([
      ["live_token", "not_priced", null, null],
      ["live_token", "not_priced", null, null],
    ]);
  });

  it.each([
    ["xai", "v1/realtime/client_secrets", { expires_after: { seconds: 3600 } }, (body: Record<string, unknown>) => expect(body.expires_after).toEqual({ seconds: 60 })],
    [
      "openai",
      "v1/realtime/sessions",
      { model: "m", client_secret: { expires_after: { anchor: "created_at", seconds: 600 } } },
      (body: Record<string, unknown>) => expect(body.client_secret).toEqual({ expires_after: { anchor: "created_at", seconds: 60 } }),
    ],
    [
      "openai",
      "v1/realtime/transcription_sessions",
      { client_secret: { expires_at: { seconds: 600 } } },
      (body: Record<string, unknown>) => expect(body.client_secret).toEqual({ expires_at: { anchor: "created_at", seconds: 60 } }),
    ],
    [
      "gemini",
      "v1alpha/auth_tokens",
      // `uses: 0` would start any number of sessions; both spellings of the window are sent.
      { uses: 0, expireTime: "2026-11-21T12:00:00Z", newSessionExpireTime: "2026-11-21T12:00:00Z", new_session_expire_time: "2026-11-21T12:00:00Z" },
      (body: Record<string, unknown>, now: number) => {
        expect(body.newSessionExpireTime).toBe(new Date(now + 60_000).toISOString());
        expect(body).not.toHaveProperty("new_session_expire_time");
        // The session's own cap is the customer's to set.
        expect(body.expireTime).toBe("2026-11-21T12:00:00Z");
        expect(body.uses).toBe(1);
      },
    ],
    [
      "openai",
      "v1/chatkit/sessions",
      { user: "u1", workflow: { id: "wf_1" }, expires_after: { anchor: "created_at", seconds: 600 } },
      (body: Record<string, unknown>) => {
        expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 60 });
        expect(body.workflow).toEqual({ id: "wf_1" });
      },
    ],
    ["elevenlabs", "v1/convai/realtime/client_secrets", { expires_after: { seconds: 900 } }, (body: Record<string, unknown>) => expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 60 })],
  ] as const)("locks %s's window at %s", async (type, path, asked, check) => {
    const now = pinClockMidMinute();
    const { appId, slug, key } = await connected({ type, passthrough: [{ method: "POST", path, live_token: true }] });
    fetchSpy.mockImplementation(async () => Response.json({ token: "minted" }));
    const { status, text } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/${path}`, key, JSON.stringify(asked));
    expect(status, text).toBe(200);
    check(sentBody(0), now);
  });

  describe("is never served from a cache, wherever it goes", () => {
    const cacheHeaders = { "CF-AIG-Cache-TTL": "300", "cf-aig-skip-cache": "false" };

    async function mintVia(fields: Record<string, unknown>, path: string, extra: Record<string, string>) {
      const { appId, slug, key } = await connected(fields);
      fetchSpy.mockImplementation(async () => Response.json({ value: "ek_minted", expires_at: 1 }));
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json", ...extra },
          body: JSON.stringify({ session: { type: "realtime" } }),
        }),
        env,
        ctx,
      );
      await response.text();
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
      const [url, init] = fetchSpy.mock.calls[0]!;
      return { url: String(url), headers: new Headers(init!.headers) };
    }

    it("through the Cloudflare AI Gateway setting", async () => {
      const sent = await mintVia(
        {
          type: "openai",
          cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: "cf-token-test" },
          passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }],
        },
        "v1/realtime/client_secrets",
        cacheHeaders,
      );
      expect(sent.url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/openai/realtime/client_secrets");
      expect(sent.headers.get("cf-aig-skip-cache")).toBe("true");
      expect(sent.headers.get("cf-aig-cache-ttl")).toBeNull();
    });

    it("through a base URL on Cloudflare AI Gateway", async () => {
      const sent = await mintVia(
        {
          type: "xai",
          baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/grok/",
          passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }],
        },
        "v1/realtime/client_secrets",
        cacheHeaders,
      );
      expect(sent.url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/grok/v1/realtime/client_secrets");
      expect(sent.headers.get("cf-aig-skip-cache")).toBe("true");
      expect(sent.headers.get("cf-aig-cache-ttl")).toBeNull();
    });

    it("straight to the provider", async () => {
      const sent = await mintVia(
        { type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }] },
        "v1/realtime/client_secrets",
        cacheHeaders,
      );
      expect(sent.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
      expect(sent.headers.get("cf-aig-skip-cache")).toBe("true");
      expect(sent.headers.get("cf-aig-cache-ttl")).toBeNull();
    });

    it("through a base URL on Cloudflare AI Gateway's OpenAI endpoint, with the expiry locked", async () => {
      const { appId, slug, key } = await connected({
        type: "openai",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/",
        passthrough: [{ method: "POST", path: "realtime/client_secrets", live_token: true }],
      });
      fetchSpy.mockImplementation(async () => Response.json({ value: "ek_minted", expires_at: 1 }));
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/realtime/client_secrets`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json", ...cacheHeaders },
          body: JSON.stringify({ session: { type: "realtime" }, expires_after: { anchor: "created_at", seconds: 600 } }),
        }),
        env,
        ctx,
      );
      await response.text();
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/openai/realtime/client_secrets");
      const headers = new Headers(init!.headers);
      expect(headers.get("cf-aig-skip-cache")).toBe("true");
      expect(headers.get("cf-aig-cache-ttl")).toBeNull();
      expect(sentBody(0).expires_after).toEqual({ anchor: "created_at", seconds: 60 });
    });

    it("leaves a request that is not a mint as it was", async () => {
      const { appId, slug, key } = await connected({
        type: "openai",
        cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: "cf-token-test" },
        passthrough: [{ method: "POST", path: "v1/echo" }],
      });
      fetchSpy.mockImplementation(async () => Response.json({ ok: true }));
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/echo`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json", ...cacheHeaders },
          body: "{}",
        }),
        env,
        ctx,
      );
      await response.text();
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
      const headers = new Headers(fetchSpy.mock.calls[0]![1]!.headers);
      expect(headers.get("cf-aig-cache-ttl")).toBe("300");
      expect(headers.get("cf-aig-skip-cache")).toBe("false");
    });
  });

  it("serves a mint only where the provider reads it as the mint, on save and when sent", async () => {
    const baseUrl = "https://api.elevenlabs.io/v1/single-use-token/";
    const management = await seedManagementKey();
    const doubled = await admin(management, "POST", "/v2/admin/providers", {
      name: "elevenlabs",
      slug: `elevenlabs-${crypto.randomUUID().slice(0, 6)}`,
      secret: SECRET,
      type: "elevenlabs",
      baseUrl,
      passthrough: [{ method: "POST", path: "v1/single-use-token/tts_websocket", live_token: true }],
    });
    expect(doubled.status, JSON.stringify(doubled.body)).toBe(400);
    const { appId, slug, key } = await connected({ type: "elevenlabs", baseUrl, passthrough: [{ method: "POST", path: "tts_websocket", live_token: true }] });
    fetchSpy.mockImplementation(async () => Response.json({ token: "minted" }));
    expect((await send("POST", `/v2/apps/${appId}/proxy/${slug}/tts_websocket`, key, "{}")).status).toBe(200);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.elevenlabs.io/v1/single-use-token/tts_websocket");
    // As if stored before this check: the doubled listing is refused when sent, and nothing reaches the provider.
    await env.DB.prepare("UPDATE provider_connection SET passthrough_json = ? WHERE slug = ?")
      .bind(storedPassthrough([{ method: "POST", path: "v1/single-use-token/tts_websocket", liveToken: true }]), slug)
      .run();
    clearCaches();
    expect((await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/single-use-token/tts_websocket`, key, "{}")).status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses to save an opt-in on a template that also covers the batch transcription token", async () => {
    const management = await seedManagementKey();
    const created = await admin(management, "POST", "/v2/admin/providers", {
      name: "elevenlabs",
      slug: `elevenlabs-${crypto.randomUUID().slice(0, 6)}`,
      secret: SECRET,
      type: "elevenlabs",
      passthrough: [{ method: "POST", path: "v1/single-use-token/{token_type}", live_token: true }],
    });
    expect(created.status).toBe(400);
  });

  it("sends an ElevenLabs mint with no expiry field as it is, and makes its signed URL single use", async () => {
    const { appId, slug, key } = await connected({
      type: "elevenlabs",
      passthrough: [
        { method: "POST", path: "v1/single-use-token/realtime_scribe", live_token: true },
        { method: "GET", path: "v1/convai/conversation/get-signed-url", live_token: true },
      ],
    });
    fetchSpy.mockImplementation(async () => Response.json({ token: "minted" }));
    expect((await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/single-use-token/realtime_scribe`, key, "{\"a\":1}")).status).toBe(200);
    expect(new TextDecoder().decode(fetchSpy.mock.calls[0]![1]!.body as Uint8Array)).toBe("{\"a\":1}");
    // `include_conversation_id=true` makes the URL start one call only (T13), whatever the client asked.
    expect((await send("GET", `/v2/apps/${appId}/proxy/${slug}/v1/convai/conversation/get-signed-url?agent_id=a1&include_conversation_id=false`, key)).status).toBe(200);
    expect(String(fetchSpy.mock.calls[1]![0])).toBe("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=a1&include_conversation_id=true");
    expect((await chargesOf(appId)).map((charge) => charge.operation)).toEqual(["live_token", "live_token"]);
  });

  it("refuses a mint whose body cannot carry the window, before it spends anything or calls the provider", async () => {
    const { appId, slug, key } = await connected({ type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }] });
    const { status, text } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, "[]");
    expect(status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "invalid_request" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await chargesOf(appId)).toEqual([]);
  });

  it("charges a flat price when the listing has one, and keeps request limits", async () => {
    pinClockMidMinute();
    const { appId, slug, key } = await connected(
      { type: "xai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true, per_request: 0.001 }] },
      { per_app: { requests: { per_minute: 1 } } },
    );
    fetchSpy.mockImplementation(async () => Response.json({ value: "secret", expires_at: 60 }));
    expect((await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, "{}")).status).toBe(200);
    const limited = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, "{}");
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.text)).toMatchObject({ error: { code: "app_rate_limited" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await chargesOf(appId)).toEqual([
      expect.objectContaining({ operation: "live_token", price_source: "customer_rate", cost_nano: 1_000_000, unit: "requests", units: 1 }),
    ]);
  });

  it("checks who is calling first: a mint needs a valid app key", async () => {
    const { appId, slug } = await connected({ type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }] });
    const { status } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, "agw_wrong", "{}");
    expect(status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves a custom provider on OpenAI's host the same way", async () => {
    const { appId, slug, key } = await connected({
      type: "custom",
      baseUrl: "https://api.openai.com/",
      auth: { header: "authorization", format: "Bearer {key}" },
      passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }],
    });
    fetchSpy.mockImplementation(async () => Response.json({ value: "ek_minted" }));
    const { status, text } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, JSON.stringify({ expires_after: { seconds: 7200 } }));
    expect(status, text).toBe(200);
    expect(sentBody(0).expires_after).toEqual({ anchor: "created_at", seconds: 60 });
    expect((await chargesOf(appId)).map((charge) => charge.operation)).toEqual(["live_token"]);
  });
});
