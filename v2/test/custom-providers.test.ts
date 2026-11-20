/**
 * Custom providers (plan section 4.5, step 5b): a provider the gateway does
 * not know, at the base URL a customer names, with the key in the header they
 * name. Its listed paths are passed through, unless one names an API style:
 * then it is metered by that style at the connection's rates. The provider is
 * mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { CUSTOM_PATH_STYLES } from "../src/contracts/admin.ts";
import { describeConnection } from "../src/providers/connections.ts";
import { CUSTOM_STYLES, customAuthProblem, customDescription, customOperationName, knownHostOwner } from "../src/providers/custom.ts";
import { ProviderMatcher, upstreamRoute } from "../src/providers/matcher.ts";
import { openai } from "../src/providers/openai.ts";
import { storedPassthrough } from "../src/providers/passthrough.ts";
import { declaredOperation } from "../src/providers/presets.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedAccount, seedAppKey, seedManagementKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const SECRET = "sk-custom-provider-key-9876";
const BASE = "https://llm.example.com/v1/";
const AUTH = { header: "x-api-key", format: "Key {key}" };

let fetchSpy: MockInstance<typeof fetch>;

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("a custom provider's description", () => {
  it("offers exactly the styles the contract lists, each a POST operation named after it", () => {
    expect([...CUSTOM_STYLES].sort()).toEqual([...CUSTOM_PATH_STYLES].sort());
    for (const style of CUSTOM_STYLES) {
      const operation = declaredOperation(customOperationName(style));
      expect(operation, style).toMatchObject({ name: `custom.${style}`, style, match: { method: "POST" } });
    }
  });

  it("has its base URL's host and no refused paths on a host the gateway does not know", () => {
    const description = customDescription({ baseUrl: BASE, auth: AUTH, paths: [] });
    expect(description).toMatchObject({ type: "custom", hosts: { main: "llm.example.com" }, auth: AUTH, refused: [], operations: [] });
  });

  it("gets a known provider's hosts and refused paths on its host, a regional one included", () => {
    expect(knownHostOwner("https://api.openai.com/v1/")?.type).toBe("openai");
    expect(knownHostOwner("https://API.OPENAI.COM/")?.type).toBe("openai");
    expect(knownHostOwner("https://openrouter.ai/api/")?.type).toBe("openrouter");
    expect(knownHostOwner("https://api.eu.mistral.ai/")?.type).toBe("mistral");
    expect(knownHostOwner("https://openai.example.com/")).toBeNull();
    const description = customDescription({ baseUrl: "https://api.openai.com/v1/", auth: AUTH, paths: [] });
    expect(description.refused).toBe(openai.refused);
    expect(description.hosts).toBe(openai.hosts);
  });

  it("turns each API-style path into its operation, and leaves plain paths to passthrough", () => {
    const description = customDescription({
      baseUrl: BASE,
      auth: AUTH,
      paths: [
        { method: "POST", path: "chat/completions", style: "openai-chat" },
        { method: "GET", path: "models" },
      ],
    });
    expect(description.operations.map((operation) => [operation.name, operation.match.path])).toEqual([["custom.openai-chat", "chat/completions"]]);
  });

  it("is null for a custom row without its base URL or key header, which no save stores", () => {
    expect(describeConnection({ type: "custom", baseUrl: null, customAuth: AUTH })).toBeNull();
    expect(describeConnection({ type: "custom", baseUrl: BASE, customAuth: null })).toBeNull();
  });

  it("judges a listed operation's refused paths on every way its base URL may be read, as listings are", () => {
    const description = customDescription({
      baseUrl: "https://api.openai.com/v1/",
      auth: AUTH,
      paths: [{ method: "POST", path: "{area}/chat", style: "openai-chat" }],
    });
    const matcher = new ProviderMatcher(description);
    const route = upstreamRoute(description, { baseUrl: "https://api.openai.com/v1/", cloudflareGateway: null });
    // Sent as `v1/organization/chat`, which OpenAI's refused paths take.
    expect(matcher.match("POST", "organization/chat", { route })).toMatchObject({ kind: "refused", reason: "refused_path" });
    expect(matcher.match("POST", "team/chat", { route })).toMatchObject({ kind: "operation", operation: { name: "custom.openai-chat" } });
  });

  it.each([
    [{ header: "authorization", format: "Bearer {key}" }, null],
    [{ header: "x-api-key", format: "{key}" }, null],
    [{ header: "host", format: "{key}" }, "cannot carry the key"],
    [{ header: "content-type", format: "{key}" }, "cannot carry the key"],
    [{ header: "cf-aig-authorization", format: "{key}" }, "cannot carry the key"],
    [{ header: "x api key", format: "{key}" }, "header name"],
    [{ header: "x-api-key", format: "Bearer key" }, "{key} exactly once"],
    [{ header: "x-api-key", format: "{key}{key}" }, "{key} exactly once"],
    [{ header: "x-api-key", format: "Bearer\n{key}" }, "printable ASCII"],
  ])("judges the key header %j", (auth, problem) => {
    const found = customAuthProblem(auth);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toContain(problem);
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

const PRICING = { "local-llm": { input: 1, output: 2 } };

const createCustom = (key: string, fields: Record<string, unknown> = {}) =>
  admin(key, "POST", "/v2/admin/providers", {
    type: "custom",
    name: "My LLM",
    slug: `my-llm-${crypto.randomUUID().slice(0, 6)}`,
    secret: SECRET,
    baseUrl: BASE,
    auth: AUTH,
    ...fields,
  });

describe("saving a custom provider", () => {
  it("stores its base URL, key header and paths, and shows them back without the key", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, {
      passthrough: [
        { method: "POST", path: "chat/completions", style: "openai-chat" },
        { method: "GET", path: "models", per_request: 0.001 },
      ],
      pricing: PRICING,
    });
    expect(created.status).toBe(201);
    expect(created.body.provider).toMatchObject({
      type: "custom",
      baseUrl: BASE,
      auth: AUTH,
      secretHint: "9876",
      passthrough: [
        { method: "POST", path: "chat/completions", style: "openai-chat" },
        { method: "GET", path: "models", per_request: 0.001 },
      ],
    });
    expect(JSON.stringify(created.body)).not.toContain(SECRET);
    const row = await env.DB.prepare("SELECT passthrough_json FROM provider_connection WHERE id = ?").bind(created.body.provider.id).first<{ passthrough_json: string }>();
    expect(JSON.parse(row!.passthrough_json)).toEqual({
      paths: [
        { method: "POST", path: "chat/completions", style: "openai-chat" },
        { method: "GET", path: "models", price_nano: 1_000_000 },
      ],
      auth: AUTH,
    });
    // A built-in provider shows no key header.
    const builtIn = await admin(key, "POST", "/v2/admin/providers", { type: "openai", name: "OpenAI", slug: `oa-${crypto.randomUUID().slice(0, 6)}`, secret: "sk-live-secret-abcd" });
    expect(builtIn.body.provider.auth).toBeUndefined();
  });

  it("keeps its key header when its paths are cleared, and takes a new one", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { passthrough: [{ method: "GET", path: "models" }] });
    const id = created.body.provider.id as string;
    const cleared = await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 1, passthrough: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.provider.auth).toEqual(AUTH);
    expect(cleared.body.provider.passthrough).toBeUndefined();
    const moved = await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 2, auth: { header: "authorization", format: "Bearer {key}" } });
    expect(moved.status).toBe(200);
    expect(moved.body.provider.auth).toEqual({ header: "authorization", format: "Bearer {key}" });
  });

  it.each([
    [{ baseUrl: undefined }, "base URL"],
    [{ auth: undefined }, "header its key is sent in"],
    [{ auth: { header: "host", format: "{key}" } }, "cannot carry the key"],
    [{ auth: { header: "x-api-key", format: "Bearer token" } }, "{key} exactly once"],
    [{ baseUrl: "http://llm.example.com/" }, "https"],
    [{ baseUrl: "https://10.0.0.8/" }, "IP address"],
    [{ baseUrl: "https://[::1]/" }, "IPv6"],
    [{ baseUrl: "https://localhost/" }, "public domain name"],
    [{ baseUrl: "https://llm.internal/" }, "reserved local name"],
    [{ baseUrl: "https://llm.example.com:8443/" }, "port"],
    [{ baseUrl: "https://user:pass@llm.example.com/" }, "credentials"],
    [{ baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/" }, "Cloudflare AI Gateway is not a custom provider"],
    [{ cloudflareGateway: { accountId: "a", gatewayId: "g", token: "cf-token-for-tests-1234" } }, "base URL only"],
    [{ servingProviders: ["openai"] }, "no serving providers"],
    [{ passthrough: [{ method: "GET", path: "chat/completions", style: "openai-chat" }] }, "is a POST"],
    [{ passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat", per_request: 0.01 }] }, "priced by its models"],
    [
      { passthrough: [{ method: "POST", path: "a/chat", style: "openai-chat" }, { method: "POST", path: "b/chat", style: "openai-chat" }], pricing: PRICING },
      "one path per API style",
    ],
    [{ passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }] }, "give at least one model a rate"],
    [
      {
        passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }, { method: "POST", path: "images/generations", style: "openai-images" }],
        pricing: { "img-model": { per_image: 0.04 } },
      },
      "custom.openai-chat (chat/completions) bills its models at your rates",
    ],
    [
      { passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }, { method: "POST", path: "chat/{what}" }], pricing: PRICING },
      "custom.openai-chat",
    ],
    [
      { passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }, { method: "POST", path: "chat/{x}", style: "openai-responses" }], pricing: PRICING },
      "can match the requests of the custom.",
    ],
    [{ baseUrl: "https://api.openai.com/v1/", passthrough: [{ method: "GET", path: "organization/{thing}" }] }, "never allows"],
    [{ baseUrl: "https://api.openai.com/", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets" }] }, "never allows"],
  ])("refuses %j", async (fields, message) => {
    const key = await seedManagementKey();
    const refused = await createCustom(key, fields);
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(message);
  });

  it("refuses an API style or a key header on a built-in provider", async () => {
    const key = await seedManagementKey();
    const base = { type: "openai", name: "OpenAI", secret: "sk-live-secret-abcd" };
    const styled = await admin(key, "POST", "/v2/admin/providers", { ...base, slug: "oa-styled", passthrough: [{ method: "POST", path: "v1/moderations", style: "openai-chat" }] });
    expect(styled.status).toBe(400);
    expect(JSON.stringify(styled.body)).toContain("only a custom provider's path names an API style");
    const auth = await admin(key, "POST", "/v2/admin/providers", { ...base, slug: "oa-auth", auth: AUTH });
    expect(auth.status).toBe(400);
  });

  it("is saved only with the manage grant, by an owner or admin", async () => {
    for (const options of [{ grant: "read" as const }, { role: "member" as const }]) {
      const key = await seedManagementKey(options);
      expect((await createCustom(key)).status, JSON.stringify(options)).toBe(403);
    }
  });

  it("judges its paths again when its base URL moves onto a known provider's host", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { passthrough: [{ method: "GET", path: "organization/{thing}" }] });
    expect(created.status).toBe(201);
    const moved = await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 1, baseUrl: "https://api.openai.com/v1/", secret: SECRET });
    expect(moved.status).toBe(400);
    expect(JSON.stringify(moved.body)).toContain("never allows");
  });

  it("needs the key again to move to another base URL: a key is never sent to a new origin", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key);
    const moved = await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 1, baseUrl: "https://other.example.com/" });
    expect(moved.status).toBe(400);
    expect(JSON.stringify(moved.body)).toContain("needs the key");
  });

  it("answers a key test without sending anything: it has no call known to be free", async () => {
    const key = await seedManagementKey();
    const tested = await admin(key, "POST", "/v2/admin/providers/test", { type: "custom", secret: SECRET, baseUrl: BASE, auth: AUTH });
    expect(tested).toEqual({ status: 200, body: { validated: false, reason: "no_probe" } });
    expect((await admin(key, "POST", "/v2/admin/providers/test", { type: "custom", secret: SECRET, baseUrl: "https://localhost/" })).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets an app enable its style operations and passthrough, and judges the app's models on the connection's rates", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, {
      passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }, { method: "GET", path: "models" }],
      pricing: PRICING,
    });
    const slug = created.body.provider.slug as string;
    const make = (models?: string[], operations = ["custom.openai-chat", "passthrough"]) =>
      admin(key, "POST", "/v2/admin/apps", {
        name: `Custom ${crypto.randomUUID().slice(0, 6)}`,
        config: {
          authentication: { type: "api_key", end_user: { source: "none" } },
          routing: { providers: { [slug]: { operations, ...(models === undefined ? {} : { models }) } } },
        },
      });
    expect((await make()).status).toBe(201);
    expect((await make(["local-llm"])).status).toBe(201);
    expect((await make(["not-priced"])).status).toBe(400);
    expect((await make(undefined, ["custom.openai-responses"])).status).toBe(400);
    expect((await make(undefined, ["openai.chat"])).status).toBe(400);
  });

  it("keeps saving an app whose unchanged route names a path's operation the provider no longer lists", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }], pricing: PRICING });
    const slug = created.body.provider.slug as string;
    const config = { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: { [slug]: { operations: ["custom.openai-chat"] } } } };
    const app = await admin(key, "POST", "/v2/admin/apps", { name: "Chat", config });
    expect(app.status).toBe(201);
    expect((await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 1, passthrough: [{ method: "GET", path: "models" }] })).status).toBe(200);
    const renamed = await admin(key, "PUT", `/v2/admin/apps/${app.body.app.id}`, { revision: app.body.app.revision, name: "Renamed", config });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
  });

  it("is never taken from a handoff: a custom provider is a person's choice", async () => {
    const key = await seedManagementKey();
    const handoff = await admin(key, "POST", "/v2/admin/provider-handoffs", { type: "custom", name: "Mine", baseUrl: BASE });
    expect(handoff.status).toBe(400);
  });
});

/** A custom connection stored as a save would store it, and an app routed to it. */
async function setup(
  paths: readonly { method: string; path: string; priceNano?: number; style?: string }[],
  operations: readonly string[],
  baseUrl = BASE,
) {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `custom-${id.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, "custom", baseUrl], SECRET);
  const rates = JSON.stringify({ "local-llm": { input: 1_000_000_000, output: 2_000_000_000 } });
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, passthrough_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'custom', ?, 'Mine', 'active', ?, '9876', ?, ?, ?, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, slug, blob, baseUrl, rates, storedPassthrough(paths as never, AUTH), now, now)
    .run();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: { operations } } },
  );
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

describe("serving a custom provider", () => {
  const paths = [
    { method: "POST", path: "chat/completions", style: "openai-chat" },
    { method: "GET", path: "models/{model}" },
  ];

  it("meters an API-style path by its usage reader at the connection's rates, with the key in the named header", async () => {
    const { appId, slug, key } = await setup(paths, ["custom.openai-chat"]);
    fetchSpy.mockResolvedValueOnce(
      Response.json({ id: "c1", choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } }),
    );
    const { response } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, {
      body: JSON.stringify({ model: "local-llm", messages: [{ role: "user", content: "hi" }] }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://llm.example.com/v1/chat/completions");
    const headers = new Headers(init!.headers);
    expect(headers.get("x-api-key")).toBe(`Key ${SECRET}`);
    // The app's own key never reaches the provider.
    expect(headers.get("authorization")).toBeNull();
    expect(init!.redirect).toBe("manual");
    expect(await chargesOf(appId)).toEqual([
      expect.objectContaining({ operation: "custom.openai-chat", provider_type: "custom", model: "local-llm", price_source: "customer_rate", cost_nano: 2_000_000 }),
    ]);
  });

  it("refuses a model the connection has no rate for, and sends nothing", async () => {
    const { appId, slug, key } = await setup(paths, ["custom.openai-chat"]);
    const { response } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, {
      body: JSON.stringify({ model: "other-model", messages: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes a plain listed path through, `not_priced`, only to an app that enables passthrough", async () => {
    const { appId, slug, key } = await setup(paths, ["passthrough"]);
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "local-llm" }));
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/models/local-llm`, key);
    expect(response.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://llm.example.com/v1/models/local-llm");
    expect(await chargesOf(appId)).toEqual([expect.objectContaining({ operation: "passthrough", price_source: "not_priced" })]);
    // Passthrough alone does not reach the API-style path.
    const styled = await send("POST", `/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, { body: "{}", headers: { "content-type": "application/json" } });
    expect(styled.response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a path it does not list", async () => {
    const { appId, slug, key } = await setup(paths, ["passthrough", "custom.openai-chat"]);
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/files`, key);
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never follows a redirect: the key stays with the base URL's host", async () => {
    const { appId, slug, key } = await setup(paths, ["passthrough"]);
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://collector.example.net/steal" } }));
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/models/x`, key);
    expect(response.status).toBe(307);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![1]!.redirect).toBe("manual");
  });

  it("keeps a known host's refused paths refused, even when the stored list names them", async () => {
    const { appId, slug, key } = await setup(
      [{ method: "GET", path: "{area}/{what}" }, { method: "POST", path: "{area}/chat", style: "openai-chat" }],
      ["passthrough", "custom.openai-chat"],
      "https://api.openai.com/v1/",
    );
    for (const [method, path] of [["GET", "organization/users"], ["POST", "organization/chat"]] as const) {
      const { response } = await send(method, `/v2/apps/${appId}/proxy/${slug}/${path}`, key, method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {});
      expect(response.status, path).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("checks who is calling first: a custom path needs a valid app key", async () => {
    const { appId, slug } = await setup(paths, ["passthrough"]);
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/models/x`, "agw_not_a_real_key");
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
