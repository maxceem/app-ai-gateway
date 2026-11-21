/**
 * No refused paths, and safe defaults for request fields (plan section 4.5,
 * D4; step 5d). A customer may list any path of a built-in provider, admin
 * paths included. A path the provider knows, such as a live-session token
 * mint, gets suggested field settings written in when it is first listed,
 * which the customer may change or remove. The gateway applies whatever the
 * listing sets, over what the app sent. The provider is mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { compilePassthrough, namedPartProblem, ProviderMatcher } from "../src/providers/matcher.ts";
import { LIVE_TOKEN_WINDOW_SECONDS, type FieldSetting } from "../src/providers/operation.ts";
import { applyFieldSettings, readPassthrough, storedPassthrough } from "../src/providers/passthrough.ts";
import { parseTemplate } from "../src/providers/path.ts";
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

const describedAs = (type: string) => BUILT_IN_PROVIDERS[type]!;

describe("matching", () => {
  it("serves every suggested path once listed, with no opt-in, and says which suggestion it is", () => {
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      const matcher = new ProviderMatcher(description);
      for (const suggested of description.suggestedPaths ?? []) {
        expect(matcher.match(suggested.method, suggested.path)).toMatchObject({ kind: "refused", reason: "not_declared" });
        const listed = matcher.match(suggested.method, suggested.path, { passthrough: compilePassthrough([{ method: suggested.method, path: suggested.path }]) });
        expect(listed, `${description.type} ${suggested.path}`).toMatchObject({ kind: "passthrough", suggested });
      }
    }
  });

  it.each([
    ["openai", "POST", "v1/organization/admin_api_keys"],
    ["deepgram", "POST", "v1/auth/grant"],
    ["elevenlabs", "GET", "v1/convai/agents/agent_1/link"],
    ["elevenlabs", "POST", "v1/single-use-token/batch_scribe"],
    ["openrouter", "GET", "v1/credits"],
  ] as const)("serves %s %s %s once listed: there are no refused paths", (type, method, path) => {
    const matcher = new ProviderMatcher(describedAs(type));
    expect(matcher.match(method, path)).toMatchObject({ kind: "refused", reason: "not_declared" });
    expect(matcher.match(method, path, { passthrough: compilePassthrough([{ method, path }]) })).toMatchObject({ kind: "passthrough", suggested: null });
  });
});

describe("the named-part rule", () => {
  it.each(["v1/files/{file_id}", "v1/threads/{thread_id}/messages/{message_id}", "v1/convai/conversations/{id}", "v1beta/models/{model}:countTokens", "v1/realtime/client_secrets"])(
    "allows %s",
    (path) => expect(namedPartProblem(parseTemplate(path))).toBeNull(),
  );

  it.each(["{a}/b/c", "v1/{a}", "v1/{a}/{b}", "v1/threads/{id}/{x}"])("refuses %s", (path) => {
    expect(namedPartProblem(parseTemplate(path))).not.toBeNull();
  });
});

describe("storing field settings", () => {
  it("writes them only when there are some, and reads them back", () => {
    const fields: FieldSetting[] = [
      { in: "body", name: "client_secret.expires_after", value: { seconds: 60 }, aliases: ["client_secret.expires_at"] },
      { in: "query", name: "include_conversation_id", value: "true" },
      { in: "body", name: "newSessionExpireTime", value: 60, as: "time_from_now" },
    ];
    expect(storedPassthrough([{ method: "POST", path: "v1/x", setFields: [] }])).not.toContain("set_fields");
    const stored = storedPassthrough([{ method: "POST", path: "v1/x", setFields: fields }]);
    expect(JSON.parse(stored!).paths[0].set_fields).toEqual([
      { in: "body", name: "client_secret.expires_after", value: { seconds: 60 }, aliases: ["client_secret.expires_at"] },
      { in: "query", name: "include_conversation_id", value: "true" },
      { in: "body", name: "newSessionExpireTime", value: 60, as: "time_from_now" },
    ]);
    expect(readPassthrough(stored)).toEqual([{ method: "POST", path: "v1/x", setFields: fields }]);
    // One that does not read is left out; the rest still work.
    expect(readPassthrough(JSON.stringify({ paths: [{ method: "POST", path: "x", set_fields: [{ in: "header", name: "a", value: 1 }, { in: "body", name: "b", value: 2 }] }] }))).toEqual([
      { method: "POST", path: "x", setFields: [{ in: "body", name: "b", value: 2 }] },
    ]);
  });
});

describe("applying field settings", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const decode = (result: ReturnType<typeof applyFieldSettings>) =>
    result.body.kind === "set" ? (JSON.parse(new TextDecoder().decode(result.body.bytes)) as Record<string, any>) : null;

  it("writes nested fields over the app's, creating parents, and removes every other spelling", () => {
    const settings: FieldSetting[] = [{ in: "body", name: "client_secret.expires_after", value: { seconds: 60 }, aliases: ["client_secret.expires_at"] }];
    const sent = { model: "m", client_secret: { expires_at: { seconds: 600 }, other: 1 } };
    const result = applyFieldSettings(settings, encode(sent), "", 0);
    expect(decode(result)).toEqual({ model: "m", client_secret: { expires_after: { seconds: 60 }, other: 1 } });
    // The app's own object is never changed.
    expect(sent.client_secret.expires_at).toEqual({ seconds: 600 });
    expect(decode(applyFieldSettings(settings, encode({ client_secret: "x" }), "", 0))).toEqual({ client_secret: { expires_after: { seconds: 60 } } });
    expect(decode(applyFieldSettings(settings, new Uint8Array(), "", 0))).toEqual({ client_secret: { expires_after: { seconds: 60 } } });
    expect(decode(applyFieldSettings(settings, encode(null), "", 0))).toEqual({ client_secret: { expires_after: { seconds: 60 } } });
  });

  it("writes a time from now, in RFC 3339", () => {
    const now = Date.UTC(2026, 10, 21, 12, 0, 0);
    const result = applyFieldSettings([{ in: "body", name: "newSessionExpireTime", value: 60, as: "time_from_now", aliases: ["new_session_expire_time"] }], encode({ new_session_expire_time: "x", newSessionExpireTime: "y" }), "", now);
    expect(decode(result)).toEqual({ newSessionExpireTime: "2026-11-21T12:01:00.000Z" });
  });

  it("replaces every value of a query parameter and its aliases with the setting's", () => {
    const result = applyFieldSettings([{ in: "query", name: "include_conversation_id", value: "true", aliases: ["Include_Conversation_ID"] }], new Uint8Array(), "?agent_id=a&include_conversation_id=false&include_conversation_id=no&Include_Conversation_ID=false", 0);
    expect(result.search).toBe("?agent_id=a&include_conversation_id=true");
    expect(result.body).toEqual({ kind: "same" });
  });

  it("leaves a request with no body settings as it is, and calls a body that is not a JSON object unreadable", () => {
    expect(applyFieldSettings([], encode([1]), "?a=1", 0)).toEqual({ body: { kind: "same" }, search: "?a=1" });
    const settings: FieldSetting[] = [{ in: "body", name: "a", value: 1 }];
    expect(applyFieldSettings(settings, encode([1]), "", 0).body).toEqual({ kind: "unreadable" });
    expect(applyFieldSettings(settings, new TextEncoder().encode("not json"), "", 0).body).toEqual({ kind: "unreadable" });
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

const create = (fields: Record<string, unknown>) =>
  seedManagementKey().then((key) =>
    admin(key, "POST", "/v2/admin/providers", { name: String(fields.type), slug: `${String(fields.type)}-${crypto.randomUUID().slice(0, 6)}`, secret: SECRET, ...fields }),
  );

/** A connection made through the API, so its listing is saved as a customer would save it, and an app that enables passthrough on it. */
async function connected(fields: Record<string, unknown>): Promise<{ appId: string; slug: string; key: string; management: string; providerId: string }> {
  const management = await seedManagementKey();
  const type = String(fields.type);
  const slug = `${type}-${crypto.randomUUID().slice(0, 6)}`;
  const created = await admin(management, "POST", "/v2/admin/providers", { name: type, slug, secret: SECRET, ...fields });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const authentication = { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } };
  const appId = await seedRoutedApp(authentication, { providers: { [slug]: { operations: ["passthrough"] } } });
  const { key } = await seedAppKey(appId);
  return { appId, slug, key, management, providerId: created.body.provider.id };
}

async function send(method: string, path: string, key: string, body?: string, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, text, headers: response.headers };
}

const sentBody = (call: number) => JSON.parse(new TextDecoder().decode(fetchSpy.mock.calls[call]![1]!.body as Uint8Array)) as Record<string, unknown>;

async function chargesOf(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
  return results;
}

const CLIENT_SECRET_EXPIRY = { in: "body", name: "expires_after", value: { anchor: "created_at", seconds: LIVE_TOKEN_WINDOW_SECONDS } };

describe("saving a listing", () => {
  it("writes the provider's safe defaults into a newly listed path, and answers with their label, reason and suggested value", async () => {
    const { status, body } = await create({ type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets" }] });
    expect(status, JSON.stringify(body)).toBe(201);
    expect(body.provider.passthrough).toEqual([
      {
        method: "POST",
        path: "v1/realtime/client_secrets",
        set_fields: [{ ...CLIENT_SECRET_EXPIRY, label: "Token expiry", reason: expect.stringContaining("60-second"), suggested_value: CLIENT_SECRET_EXPIRY.value }],
      },
    ]);
  });

  it("keeps the customer's own values, shows the suggestion beside them, and sets none for an empty list", async () => {
    const own = { ...CLIENT_SECRET_EXPIRY, value: { anchor: "created_at", seconds: 120 } };
    const changed = await create({ type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", set_fields: [own] }] });
    expect(changed.body.provider.passthrough[0].set_fields).toEqual([{ ...own, label: "Token expiry", reason: expect.any(String), suggested_value: CLIENT_SECRET_EXPIRY.value }]);
    const none = await create({ type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", set_fields: [] }] });
    expect(none.body.provider.passthrough).toEqual([{ method: "POST", path: "v1/realtime/client_secrets" }]);
  });

  it("keeps removed defaults removed: they are written only when a path is first listed", async () => {
    const management = await seedManagementKey();
    const created = await admin(management, "POST", "/v2/admin/providers", {
      type: "openai",
      name: "o",
      slug: `openai-${crypto.randomUUID().slice(0, 6)}`,
      secret: SECRET,
      passthrough: [{ method: "POST", path: "v1/realtime/client_secrets" }],
    });
    const { id, revision } = created.body.provider;
    const updated = await admin(management, "PUT", `/v2/admin/providers/${id}`, {
      revision,
      passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", set_fields: [] }, { method: "GET", path: "v1/files/{file_id}" }],
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    // Saved again with the field left out, as an older client might: not written back in.
    const again = await admin(management, "PUT", `/v2/admin/providers/${id}`, {
      revision: updated.body.provider.revision,
      passthrough: [{ method: "POST", path: "v1/realtime/client_secrets" }, { method: "GET", path: "v1/files/{file_id}" }],
    });
    expect(again.body.provider.passthrough).toEqual([
      { method: "POST", path: "v1/realtime/client_secrets" },
      { method: "GET", path: "v1/files/{file_id}" },
    ]);
  });

  it("saves an admin path: the customer decides", async () => {
    const { status } = await create({ type: "openai", passthrough: [{ method: "POST", path: "v1/organization/admin_api_keys" }] });
    expect(status).toBe(201);
  });

  it.each([
    ["v1/{a}/{b}", "two fixed segments"],
    ["v1/threads/{id}/{x}", "next to each other"],
  ])("refuses %s by the named-part rule", async (path, says) => {
    const { status, body } = await create({ type: "openai", passthrough: [{ method: "GET", path }] });
    expect(status).toBe(400);
    expect(body.error.message).toContain(says);
  });

  it("allows two named parts where ids are", async () => {
    const { status } = await create({ type: "openai", passthrough: [{ method: "GET", path: "v1/threads/{thread_id}/messages/{message_id}" }] });
    expect(status).toBe(201);
  });

  it("refuses a built-in endpoint as a listing: it is turned on for the app instead", async () => {
    const { status, body } = await create({ type: "openai", passthrough: [{ method: "POST", path: "v1/chat/completions" }] });
    expect(status).toBe(400);
    expect(body.error.message).toBe("passthrough.0.path: POST v1/chat/completions is built in as the openai.chat operation; turn it on for the app instead");
  });

  it.each([
    [{ in: "query", name: "a", value: 1 }, "a string"],
    [{ in: "body", name: "a", value: 1.5, as: "time_from_now" }, "whole number of seconds"],
    [{ in: "body", name: "a" }, "value"],
    [{ in: "body", name: "a..b", value: 1 }, "not a field name"],
  ])("refuses a field setting %j", async (field, says) => {
    const { status, body } = await create({ type: "openai", passthrough: [{ method: "POST", path: "v1/echo", set_fields: [field] }] });
    expect(status).toBe(400);
    expect(body.error.message).toContain(says);
  });

  it("refuses a field set twice, under its name or an alias", async () => {
    const { status } = await create({
      type: "openai",
      passthrough: [{ method: "POST", path: "v1/echo", set_fields: [{ in: "body", name: "a", value: 1 }, { in: "body", name: "b", value: 2, aliases: ["a"] }] }],
    });
    expect(status).toBe(400);
  });

  it("reaches Cloudflare AI Gateway only through its setting, not a base URL", async () => {
    const { status, body } = await create({ type: "openai", baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/" });
    expect(status).toBe(400);
    expect(body.error.message).toContain("cloudflareGateway setting");
  });

  it.each([
    ["openai", "https://api.openai.com/v1/", "https://api.openai.com/"],
    ["openai", "https://eu.api.openai.com/v1/", "https://eu.api.openai.com/"],
    ["openrouter", "https://openrouter.ai/", "https://openrouter.ai/api/"],
  ])("takes only the plain address on %s's own host", async (type, wrong, plain) => {
    const refused = await create({ type, baseUrl: wrong });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain(plain);
    expect((await create({ type, baseUrl: plain })).status).toBe(201);
  });

  it("keeps any path on a host that is not the provider's own", async () => {
    expect((await create({ type: "openai", baseUrl: "https://llm.example.net/openai/v1/" })).status).toBe(201);
  });
});

describe("serving a listing with field settings", () => {
  it("sets OpenAI's client secret to the suggested 60 seconds whatever the app asks, and charges a `live_token` call", async () => {
    const { appId, slug, key } = await connected({ type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets" }] });
    fetchSpy.mockImplementation(async () => Response.json({ value: "ek_minted", expires_at: 1 }));
    const asked = JSON.stringify({ session: { type: "realtime" }, expires_after: { anchor: "created_at", seconds: 7200 } });
    const minted = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, asked);
    expect(minted.status, minted.text).toBe(200);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(sentBody(0)).toEqual({ session: { type: "realtime" }, expires_after: { anchor: "created_at", seconds: 60 } });
    expect((await chargesOf(appId)).map((charge) => [charge.operation, charge.price_source])).toEqual([["live_token", "not_priced"]]);
  });

  it("sends the customer's own value, or the app's when the customer removed the setting", async () => {
    const changed = await connected({
      type: "openai",
      passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", set_fields: [{ ...CLIENT_SECRET_EXPIRY, value: { anchor: "created_at", seconds: 120 } }] }],
    });
    fetchSpy.mockImplementation(async () => Response.json({ value: "ek" }));
    await send("POST", `/v2/apps/${changed.appId}/proxy/${changed.slug}/v1/realtime/client_secrets`, changed.key, JSON.stringify({ expires_after: { seconds: 7200 } }));
    expect(sentBody(0).expires_after).toEqual({ anchor: "created_at", seconds: 120 });
    const removed = await connected({ type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", set_fields: [] }] });
    const asked = JSON.stringify({ expires_after: { seconds: 7200 } });
    await send("POST", `/v2/apps/${removed.appId}/proxy/${removed.slug}/v1/realtime/client_secrets`, removed.key, asked);
    expect(new TextDecoder().decode(fetchSpy.mock.calls[1]![1]!.body as Uint8Array)).toBe(asked);
  });

  it("writes Gemini's window as a time from now, one use, and removes the other spelling", async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const { appId, slug, key } = await connected({ type: "gemini", passthrough: [{ method: "POST", path: "v1alpha/auth_tokens" }] });
    fetchSpy.mockImplementation(async () => Response.json({ name: "auth_tokens/x" }));
    const asked = { uses: 0, expireTime: "2026-11-21T12:00:00Z", new_session_expire_time: "2026-11-21T12:00:00Z" };
    const { status, text } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1alpha/auth_tokens`, key, JSON.stringify(asked));
    expect(status, text).toBe(200);
    expect(sentBody(0)).toEqual({ uses: 1, expireTime: "2026-11-21T12:00:00Z", newSessionExpireTime: new Date(now + 60_000).toISOString() });
  });

  it("makes an ElevenLabs signed URL single use, replacing every value the app sent", async () => {
    const { appId, slug, key } = await connected({ type: "elevenlabs", passthrough: [{ method: "GET", path: "v1/convai/conversation/get-signed-url" }] });
    fetchSpy.mockImplementation(async () => Response.json({ signed_url: "wss://x" }));
    const { status } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/v1/convai/conversation/get-signed-url?agent_id=a1&include_conversation_id=false&include_conversation_id=no`, key);
    expect(status).toBe(200);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=a1&include_conversation_id=true");
  });

  it("refuses a request whose body cannot carry the settings, before it spends anything or calls the provider", async () => {
    const { appId, slug, key } = await connected({ type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets" }] });
    const { status, text } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, "[1]");
    expect(status).toBe(400);
    expect(text).toContain("expires_after");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await chargesOf(appId)).toEqual([]);
  });

  it("serves an admin path the customer listed", async () => {
    const { appId, slug, key } = await connected({ type: "openai", passthrough: [{ method: "GET", path: "v1/organization/users" }] });
    fetchSpy.mockImplementation(async () => Response.json({ data: [] }));
    const { status } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/v1/organization/users`, key);
    expect(status).toBe(200);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.openai.com/v1/organization/users");
  });

  describe("never caches a live-session mint", () => {
    const cacheHeaders = { "CF-AIG-Cache-TTL": "300", "cf-aig-skip-cache": "false" };

    it.each([
      ["through the Cloudflare AI Gateway setting", { cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: "cf-token-test" } }, "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/realtime/client_secrets"],
      ["straight to the provider", {}, "https://api.openai.com/v1/realtime/client_secrets"],
    ])("asks Cloudflare to skip its cache %s", async (_how, extra, url) => {
      const { appId, slug, key } = await connected({ type: "openai", ...extra, passthrough: [{ method: "POST", path: "v1/realtime/client_secrets" }] });
      fetchSpy.mockImplementation(async () => Response.json({ value: "ek" }));
      const { status } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, "{}", cacheHeaders);
      expect(status).toBe(200);
      const [sentUrl, init] = fetchSpy.mock.calls[0]!;
      expect(String(sentUrl)).toBe(url);
      expect(new Headers(init!.headers).get("cf-aig-skip-cache")).toBe("true");
      expect(new Headers(init!.headers).get("cf-aig-cache-ttl")).toBeNull();
    });

    it("tells every cache after the gateway not to keep the answer", async () => {
      const { appId, slug, key } = await connected({ type: "openai", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets" }] });
      fetchSpy.mockImplementation(async () =>
        Response.json({ value: "ek" }, { headers: { "cache-control": "public, max-age=300", "cdn-cache-control": "max-age=300", "surrogate-control": "max-age=300" } }),
      );
      const { headers } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/realtime/client_secrets`, key, "{}");
      expect(headers.get("cache-control")).toBe("no-store");
      expect(headers.get("cdn-cache-control")).toBeNull();
      expect(headers.get("surrogate-control")).toBeNull();
    });

    it("leaves a path that is not a mint as it was", async () => {
      const { appId, slug, key } = await connected({
        type: "openai",
        cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: "cf-token-test" },
        passthrough: [{ method: "POST", path: "v1/echo" }],
      });
      fetchSpy.mockImplementation(async () => Response.json({ ok: true }, { headers: { "cache-control": "public, max-age=300" } }));
      const { headers } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/echo`, key, "{}", cacheHeaders);
      expect(headers.get("cache-control")).toBe("public, max-age=300");
      expect(new Headers(fetchSpy.mock.calls[0]![1]!.headers).get("cf-aig-cache-ttl")).toBe("300");
      expect((await chargesOf(appId))[0]).toMatchObject({ operation: "passthrough" });
    });
  });
});
