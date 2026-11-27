/**
 * The minimal management API: sign-in with management keys, apps, provider
 * connections and app keys, and a call made with what it created.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { clearCaches, seedManagementKey, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, ledger } from "./helpers.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { localVault, TEST_VAULT_ENV } from "./local-vault.ts";
import { setVaultForTests, type VaultCall } from "../src/vault/client.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const ORIGIN = "https://gateway.test";

async function request(key: string | null, method: string, path: string, body?: unknown) {
  const headers = new Headers({ "content-type": "application/json" });
  if (key !== null) headers.set("authorization", `Bearer ${key}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function createProvider(key: string, overrides: Record<string, unknown> = {}) {
  return request(key, "POST", "/v2/admin/providers", {
    type: "openai",
    name: "OpenAI",
    slug: `openai-${crypto.randomUUID().slice(0, 6)}`,
    secret: "sk-live-secret-abcd",
    ...overrides,
  });
}

const apiKeyConfig = (routing: Record<string, unknown> = {}) => ({
  authentication: { type: "api_key", end_user: { source: "none" } },
  routing: { providers: routing },
});

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("management sign-in", () => {
  it("needs a valid management key", async () => {
    expect((await request(null, "GET", "/v2/admin/apps")).status).toBe(401);
    expect((await request("agw_mgmt_unknown", "GET", "/v2/admin/apps")).status).toBe(401);
    expect((await request("agw_not_a_management_key", "GET", "/v2/admin/apps")).status).toBe(401);
    const key = await seedManagementKey();
    expect((await request(key, "GET", "/v2/admin/apps")).status).toBe(200);
    await env.DB.prepare("UPDATE mgmt_api_key SET revoked_at = ? WHERE token_hint = ?").bind(Date.now(), key.slice(-4)).run();
    expect((await request(key, "GET", "/v2/admin/apps")).status).toBe(401);
  });

  it("lets a read key read but not write, and a member not write", async () => {
    const reader = await seedManagementKey({ grant: "read" });
    expect((await request(reader, "GET", "/v2/admin/providers")).status).toBe(200);
    const refused = await createProvider(reader);
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "grant_insufficient" } } });
    const member = await seedManagementKey({ role: "member" });
    expect(await createProvider(member)).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  });
});

describe("provider connections", () => {
  it("gives a key too short to hint at no hint, so no response contains it", async () => {
    const key = await seedManagementKey();
    const created = await createProvider(key, { secret: "abcd1234" });
    expect(created.status).toBe(201);
    expect(created.body.provider.secretHint).toBe("");
    const listed = await request(key, "GET", "/v2/admin/providers");
    expect(JSON.stringify(listed.body)).not.toContain("abcd1234");
  });

  describe("a provider key conversation history can recognise", () => {
    const refusedKeys: Array<[string, string]> = [
      ["shorter than 8 characters", "sk-1234"],
      ["a quote", 'sk-live"secret'],
      ["a backslash", "sk-live\\secret"],
      ["a control character", "sk-live\u0001secret"],
    ];

    it.each(refusedKeys)("refuses a new key with %s, wherever a key is sent", async (_, secret) => {
      const key = await seedManagementKey();
      const created = await createProvider(key, { secret });
      expect(created.status).toBe(400);
      expect(JSON.stringify(created.body)).toContain("at least 8 characters");
      const saved = await createProvider(key);
      const id = saved.body.provider.id as string;
      const updated = await request(key, "PUT", `/v2/admin/providers/${id}`, { revision: 1, secret });
      expect(updated.status).toBe(400);
      const tested = await request(key, "POST", "/v2/admin/providers/test", { type: "openai", secret });
      expect(tested.status).toBe(400);
      const cloudflare = await createProvider(key, { cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: secret } });
      expect(cloudflare.status).toBe(400);
    });

    it("saves a key of 8 characters", async () => {
      const key = await seedManagementKey();
      expect((await createProvider(key, { secret: "sk-12345" })).status).toBe(201);
    });

    it("never judges a stored key again", async () => {
      const key = await seedManagementKey();
      const saved = await createProvider(key);
      const id = saved.body.provider.id as string;
      // A key stored before the rule: three characters.
      const row = await env.DB.prepare("SELECT account_id FROM provider_connection WHERE id = ?").bind(id).first<{ account_id: string }>();
      const blob = await sealSecret(TEST_VAULT_ENV, "providerKey", [row!.account_id, id, "openai", "", "", ""], "abc");
      await env.DB.prepare("UPDATE provider_connection SET secret_blob = ? WHERE id = ?").bind(blob, id).run();
      const renamed = await request(key, "PUT", `/v2/admin/providers/${id}`, { revision: 1, name: "Renamed" });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      expect(renamed.body.provider.name).toBe("Renamed");
    });
  });

  it("tests a key through the vault: sealed first, and never added to a request by this Worker (plan step 8i)", async () => {
    const key = await seedManagementKey();
    const secret = "sk-live-key-under-test";
    const sealed: string[] = [];
    const calls: VaultCall[] = [];
    setVaultForTests((vaultEnv) => {
      const inner = localVault(vaultEnv);
      return {
        ...inner,
        seal: (kind, identity, plaintext) => (sealed.push(kind), inner.seal(kind, identity, plaintext)),
        call: (input) => (calls.push(input), inner.call(input)),
      };
    });
    const seen: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return Response.json({ data: [] });
    });
    try {
      const tested = await request(key, "POST", "/v2/admin/providers/test", { type: "openai", secret });
      expect(tested.status).toBe(200);
      expect(tested.body).toEqual({ validated: true });
    } finally {
      setVaultForTests(localVault);
    }
    expect(sealed).toEqual(["providerKey"]);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]!.credentials)).not.toContain(secret);
    expect([...calls[0]!.headers.values()].join(" ")).not.toContain(secret);
    expect(seen[0]?.get("authorization")).toBe(`Bearer ${secret}`);
  });

  it("answers `unreachable` when sealing the key stalls, within the probe's one time limit (8i review)", async () => {
    const key = await seedManagementKey();
    setVaultForTests((vaultEnv) => ({ ...localVault(vaultEnv), seal: () => new Promise<string>(() => undefined) }));
    const fetched = vi.spyOn(globalThis, "fetch");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = request(key, "POST", "/v2/admin/providers/test", { type: "openai", secret: "sk-live-key-under-test" });
      await vi.advanceTimersByTimeAsync(4_001);
      const tested = await pending;
      expect(tested.status).toBe(200);
      expect(tested.body).toEqual({ validated: false, reason: "unreachable" });
    } finally {
      vi.useRealTimers();
      setVaultForTests(localVault);
    }
    expect(fetched).not.toHaveBeenCalled();
  });

  it("answers `unreachable` when sealing the key fails", async () => {
    const key = await seedManagementKey();
    setVaultForTests((vaultEnv) => ({ ...localVault(vaultEnv), seal: () => Promise.reject(new Error("vault refused")) }));
    try {
      const tested = await request(key, "POST", "/v2/admin/providers/test", { type: "openai", secret: "sk-live-key-under-test" });
      expect(tested.body).toEqual({ validated: false, reason: "unreachable" });
    } finally {
      setVaultForTests(localVault);
    }
  });

  it("seals the key and returns only its hint", async () => {
    const key = await seedManagementKey();
    const created = await createProvider(key, { pricing: { "my-model": { input: 1, output: 2 } } });
    expect(created.status).toBe(201);
    expect(created.body.provider).toMatchObject({ type: "openai", status: "active", secretHint: "abcd", baseUrl: null, revision: 1 });
    expect(created.body.provider.pricing).toEqual({ "my-model": { input: 1, output: 2 } });
    expect(JSON.stringify(created.body)).not.toContain("sk-live-secret");
    const row = await env.DB.prepare("SELECT secret_blob, rates_json FROM provider_connection WHERE id = ?")
      .bind(created.body.provider.id)
      .first<{ secret_blob: string; rates_json: string }>();
    expect(row!.secret_blob).not.toContain("sk-live-secret");
    expect(JSON.parse(row!.rates_json)).toEqual({ "my-model": { input: 1_000_000_000, output: 2_000_000_000 } });
    const listed = await request(key, "GET", "/v2/admin/providers");
    expect(JSON.stringify(listed.body)).not.toContain("sk-live-secret");
  });

  it("checks a base URL with the origin guard, and needs the key to move it", async () => {
    const key = await seedManagementKey();
    expect(await createProvider(key, { baseUrl: "http://example.com/" })).toMatchObject({ status: 400 });
    expect(await createProvider(key, { baseUrl: "https://10.0.0.1/" })).toMatchObject({ status: 400 });
    const created = await createProvider(key, { baseUrl: "https://llm.example.com/v1" });
    expect(created.body.provider.baseUrl).toBe("https://llm.example.com/v1/");
    const { id, revision } = created.body.provider;
    const moved = await request(key, "PUT", `/v2/admin/providers/${id}`, { revision, baseUrl: "https://other.example.com/" });
    expect(moved).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    const back = await request(key, "PUT", `/v2/admin/providers/${id}`, { revision, baseUrl: null });
    expect(back).toMatchObject({ status: 200, body: { provider: { baseUrl: null, secretHint: "abcd", revision: 2 } } });
    const stale = await request(key, "PUT", `/v2/admin/providers/${id}`, { revision, name: "Again" });
    expect(stale).toMatchObject({ status: 409 });
  });

  it("refuses a slug already in use and an unknown type", async () => {
    const key = await seedManagementKey();
    await createProvider(key, { slug: "dup-slug" });
    expect(await createProvider(key, { slug: "dup-slug" })).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
    expect(await createProvider(key, { type: "nobody" })).toMatchObject({ status: 400 });
  });
});

describe("apps", () => {
  it("refuses an update that prices xAI's voice model by key value, which its sessions can't bill; both base rates save (Sol, #266 round 2)", async () => {
    const key = await seedManagementKey();
    const xai = await createProvider(key, { type: "xai", name: "xAI", slug: `xai-${crypto.randomUUID().slice(0, 6)}` });
    const id = xai.body.provider.id as string;
    const slug = xai.body.provider.slug as string;
    const app = await request(key, "POST", "/v2/admin/apps", { name: "Voice", config: apiKeyConfig({ [slug]: { operations: ["xai.realtime"], models: ["grok-voice-3.0"] } }) });
    expect(app.status).toBe(201);
    const keyed = await request(key, "PUT", `/v2/admin/providers/${id}`, {
      revision: 1,
      pricing: { "grok-voice-3.0": { per_minute: 0.08, per_text_message: 0.004, by: { voice: { eve: { per_minute: 0.1, per_text_message: 0.004 } } } } },
    });
    expect(keyed).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(String(keyed.body.error.message)).toContain("xai.realtime sessions are billed by the rates the model states itself");
    expect(await request(key, "PUT", `/v2/admin/providers/${id}`, { revision: 1, pricing: { "grok-voice-3.0": { per_minute: 0.1, per_text_message: 0.005 } } })).toMatchObject({ status: 200 });
  });

  it("checks each model's unit against the enabled operations, with the provider-cost exception per operation", async () => {
    const key = await seedManagementKey();
    const xai = await createProvider(key, { type: "xai", name: "xAI", slug: `xai-${crypto.randomUUID().slice(0, 6)}` });
    const xaiSlug = xai.body.provider.slug as string;
    const create = (routing: Record<string, unknown>) =>
      request(key, "POST", "/v2/admin/apps", { name: "Units", config: apiKeyConfig(routing) });
    // xAI's chat reports its own cost, so it needs no price of ours; its Messages API does.
    expect((await create({ [xaiSlug]: { operations: ["xai.chat"], models: ["grok-unpriced-zz"] } })).status).toBe(201);
    expect(await create({ [xaiSlug]: { operations: ["xai.chat", "xai.messages"], models: ["grok-unpriced-zz"] } })).toMatchObject({
      status: 400,
      body: { error: { code: "pricing_not_configured", data: { operation: "xai.messages" } } },
    });
    // A price per minute cannot bill a token operation, so whisper-1 needs an operation that can.
    const openai = await createProvider(key);
    const openaiSlug = openai.body.provider.slug as string;
    expect(await create({ [openaiSlug]: { operations: ["openai.chat"], models: ["whisper-1"] } })).toMatchObject({
      status: 400,
      body: { error: { code: "pricing_not_configured" } },
    });
    // Beside chat models, for transcriptions, it is saved: one enabled operation can bill it.
    expect((await create({ [openaiSlug]: { operations: ["openai.chat", "openai.transcription"], models: ["gpt-4o-mini", "whisper-1"] } })).status).toBe(201);
  });

  it("refuses a provider's key header as the end user header when saved", async () => {
    const key = await seedManagementKey();
    const config = { authentication: { type: "api_key", end_user: { source: "header", header: "x-goog-api-key" } }, routing: { providers: {} } };
    expect(await request(key, "POST", "/v2/admin/apps", { name: "Header", config })).toMatchObject({ status: 400 });
  });

  it("checks every connection, operation and model the config names when saved", async () => {
    const key = await seedManagementKey();
    const { body } = await createProvider(key);
    const slug = body.provider.slug as string;
    const create = (routing: Record<string, unknown>) =>
      request(key, "POST", "/v2/admin/apps", { name: "My App", config: apiKeyConfig(routing) });
    expect(await create({ "no-such-slug": { operations: ["openai.chat"] } })).toMatchObject({ status: 400 });
    expect(await create({ [slug]: { operations: ["openai.nothing"] } })).toMatchObject({ status: 400 });
    expect(await create({ [slug]: { operations: [] } })).toMatchObject({ status: 400 });
    expect(await create({ [slug]: { operations: ["openai.chat"], models: ["gpt-unpriced-zz"] } })).toMatchObject({
      status: 400,
      body: { error: { code: "pricing_not_configured" } },
    });
    const created = await create({ [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } });
    expect(created.status).toBe(201);
    expect(created.body.app.id).toMatch(/^my-app-[a-z0-9]{6}$/u);
    expect(created.body.api_key).toMatchObject({ key: expect.stringMatching(/^agw_/u), name: "Initial key" });
  });

  it("needs the revision the app was read at", async () => {
    const key = await seedManagementKey();
    const created = await request(key, "POST", "/v2/admin/apps", { name: "Rev", config: apiKeyConfig() });
    const appId = created.body.app.id as string;
    const update = { name: "Rev 2", config: apiKeyConfig() };
    expect(await request(key, "PUT", `/v2/admin/apps/${appId}`, update)).toMatchObject({
      status: 400,
      body: { error: { code: "app_revision_required" } },
    });
    expect(await request(key, "PUT", `/v2/admin/apps/${appId}`, { ...update, revision: 1 })).toMatchObject({
      status: 200,
      body: { app: { name: "Rev 2", revision: 2 } },
    });
    expect(await request(key, "PUT", `/v2/admin/apps/${appId}`, { ...update, revision: 1 })).toMatchObject({
      status: 409,
      body: { error: { code: "app_revision_conflict" } },
    });
    expect((await request(key, "DELETE", `/v2/admin/apps/${appId}`)).status).toBe(400);
    expect(await request(key, "DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`)).toMatchObject({ status: 200 });
    expect((await request(key, "GET", `/v2/admin/apps/${appId}`)).status).toBe(404);
  });

  it("creates, lists and revokes app keys, shown once", async () => {
    const key = await seedManagementKey();
    const created = await request(key, "POST", "/v2/admin/apps", { name: "Keys", config: apiKeyConfig() });
    const appId = created.body.app.id as string;
    const added = await request(key, "POST", `/v2/admin/apps/${appId}/keys`, { name: "Second" });
    expect(added).toMatchObject({ status: 201, body: { name: "Second", key: expect.stringMatching(/^agw_/u) } });
    const listed = await request(key, "GET", `/v2/admin/apps/${appId}/keys`);
    expect(listed.body.keys).toHaveLength(2);
    expect(JSON.stringify(listed.body)).not.toContain(added.body.key);
    const revoked = await request(key, "POST", `/v2/admin/apps/${appId}/keys/${added.body.id}/revoke`);
    expect(revoked).toMatchObject({ status: 200, body: { key: { status: "revoked" } } });
  });
});

describe("a call made with what the management API created", () => {
  it("serves chat with the app key it returned", async () => {
    const key = await seedManagementKey();
    const { body } = await createProvider(key);
    const slug = body.provider.slug as string;
    const app = await request(key, "POST", "/v2/admin/apps", {
      name: "End to end",
      config: apiKeyConfig({ [slug]: { operations: ["openai.chat"] } }),
    });
    const appKey = app.body.api_key.key as string;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${app.body.app.id}/proxy/${slug}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer sk-live-secret-abcd");
    const charge = await ledger().prepare("SELECT status, price_source FROM charge WHERE app_id = ?").bind(app.body.app.id).first();
    expect(charge).toEqual({ status: "ok", price_source: "list_rate" });
  });
});

describe("review fixes", () => {
  it("refuses a provider type that is only an inherited name (S9)", async () => {
    const key = await seedManagementKey();
    for (const type of ["constructor", "toString", "__proto__"]) {
      expect(await createProvider(key, { type })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    }
  });

  it("manages app keys only for app-key apps (S10)", async () => {
    const key = await seedManagementKey();
    const created = await request(key, "POST", "/v2/admin/apps", {
      name: "Attest",
      config: {
        authentication: {
          type: "apple_app_attest",
          end_user: { source: "app_install" },
          app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.app" },
        },
      },
    });
    expect(created).toMatchObject({ status: 201, body: { api_key: null } });
    const appId = created.body.app.id as string;
    for (const [method, path, body] of [
      ["POST", `/v2/admin/apps/${appId}/keys`, { name: "Nope" }],
      ["GET", `/v2/admin/apps/${appId}/keys`, undefined],
      ["POST", `/v2/admin/apps/${appId}/keys/key_x/revoke`, undefined],
    ] as const) {
      expect(await request(key, method, path, body)).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    }
  });
});

describe("second review fixes", () => {
  it("refuses a customer price too large to store, with 400 (F9)", async () => {
    const key = await seedManagementKey();
    expect(await createProvider(key, { pricing: { "my-model": { input: 1e300, output: 1 } } })).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_request" } },
    });
  });
});
