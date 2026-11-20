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
import { compilePassthrough, ProviderMatcher } from "../src/providers/matcher.ts";
import { openai } from "../src/providers/openai.ts";
import { readPassthrough, storedPassthrough } from "../src/providers/passthrough.ts";
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

  it("never refuses a declared operation of any built-in provider by its own refused paths", () => {
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      const matcher = new ProviderMatcher(description);
      for (const operation of description.operations) {
        const path = operation.match.path
          .split("/")
          .map((segment) => segment.replace(/\{[A-Za-z_][A-Za-z0-9_]*\.\.\.\}/u, (part) => {
            const list = operation.multiSegment?.[part.slice(1, -4)];
            return Array.isArray(list) ? list[0]! : "some/model";
          }).replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/u, "x1"))
          .join("/");
        expect(matcher.match(operation.match.method, path), `${operation.name}: ${path}`).not.toMatchObject({ reason: "refused_path" });
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
async function setup(paths: readonly { method: string; path: string; priceNano?: number }[], operations: readonly string[] = ["passthrough"]) {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `openai-${id.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, "openai", ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, passthrough_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'openai', ?, 'OpenAI', 'active', ?, '4321', NULL, ?, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, slug, blob, storedPassthrough(paths as never), now, now)
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
  const create = (key: string, passthrough: unknown) =>
    admin(key, "POST", "/v2/admin/providers", {
      type: "openai",
      name: "OpenAI",
      slug: `openai-${crypto.randomUUID().slice(0, 6)}`,
      secret: "sk-live-secret-abcd",
      passthrough,
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
    [[{ method: "POST", path: "v1/realtime/client_secrets" }], "always refused"],
    [[{ method: "POST", path: "v1/chat/completions" }], "openai.chat"],
    [[{ method: "POST", path: "v1/{endpoint}" }], "can match a path of the openai."],
    [[{ method: "GET", path: "v1/{rest...}" }], "path"],
    [[{ method: "GET", path: "v1/files/%2e%2e" }], "path"],
    [[{ method: "GET", path: "v1/files" }, { method: "GET", path: "v1/files" }], "listed twice"],
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
