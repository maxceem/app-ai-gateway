import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyCacheHashes,
  clearApiKeyCache,
  generateApiKey,
  hashApiKey,
  markApiKeyUsed,
  setApiKeyCacheLimit,
  verifyApiKey,
} from "../src/core/apikeys";
import { issueGatewayToken } from "../src/core/jwt";
import { database } from "../src/db";
import { appApiKey } from "../src/db/schema";
import { gatewayToken, seedApp, seedServerApp } from "./helpers";

beforeEach(() => clearApiKeyCache());
afterEach(() => vi.restoreAllMocks());

describe("server tenant API keys", () => {
  it("generates the documented format and hashes the full plaintext key", async () => {
    const first = await generateApiKey();
    const second = await generateApiKey();

    expect(first.key).toMatch(/^agw_[0-9A-Za-z]{40,}$/u);
    expect(first.keyPrefix).toBe(first.key.slice(0, 12));
    expect(first.id).toMatch(/^key_[a-z0-9]+$/u);
    expect(first.keyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.keyHash).toBe(await hashApiKey(first.key));
    expect(second.key).not.toBe(first.key);
  });

  it("uses the config cache TTL for revocation and carries the end-user identity as given", async () => {
    const key = await seedServerApp("key-cache");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    await expect(verifyApiKey(key, env, "key-cache", "customer-42")).resolves.toMatchObject({
      appId: "key-cache",
      userId: "customer-42",
      authMethod: "api_key",
      apiKeyId: "key_key-cache",
    });

    await database(env.DB)
      .update(appApiKey)
      .set({ status: "revoked" })
      .where(eq(appApiKey.id, "key_key-cache"));
    // `null` stays `null`: an application with no end users has nobody here,
    // and the key's own id is reported as `apiKeyId` rather than standing in
    // for a person.
    await expect(verifyApiKey(key, env, "key-cache", null)).resolves.toMatchObject({
      userId: null,
      apiKeyId: "key_key-cache",
    });

    vi.mocked(Date.now).mockReturnValue(now + 61_000);
    await expect(verifyApiKey(key, env, "key-cache", null)).rejects.toMatchObject({
      status: 401,
      code: "auth_required",
    });
  });

  it("re-checks a cached miss against D1 after ten seconds", async () => {
    await seedServerApp("miss-ttl");
    const late = `agw_${"L".repeat(48)}`;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    await expect(verifyApiKey(late, env, "miss-ttl", null)).rejects.toMatchObject({
      status: 401,
      code: "auth_required",
    });

    await database(env.DB).insert(appApiKey).values({
      id: "key_miss-ttl-late",
      appId: "miss-ttl",
      name: "Late key",
      keyHash: await hashApiKey(late),
      keyPrefix: late.slice(0, 12),
    });

    vi.mocked(Date.now).mockReturnValue(now + 9_000);
    await expect(verifyApiKey(late, env, "miss-ttl", null)).rejects.toMatchObject({
      status: 401,
    });

    vi.mocked(Date.now).mockReturnValue(now + 11_000);
    await expect(verifyApiKey(late, env, "miss-ttl", null)).resolves.toMatchObject({
      apiKeyId: "key_miss-ttl-late",
    });
  });

  it("re-checks the key behind a gateway token after a fixed minute", async () => {
    await seedServerApp("jwt-key-cache", { issuer: {} });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { token } = await issueGatewayToken(
      env.JWT_SECRET,
      "jwt-key-cache",
      "customer-42",
      "api_key",
      3600,
      { apiKeyId: "key_jwt-key-cache" },
    );
    const request = () => exports.default.fetch(
      "https://example.test/v1/apps/jwt-key-cache/me",
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect((await request()).status).toBe(200);
    await database(env.DB)
      .update(appApiKey)
      .set({ status: "revoked" })
      .where(eq(appApiKey.id, "key_jwt-key-cache"));

    vi.mocked(Date.now).mockReturnValue(now + 30_000);
    expect((await request()).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(now + 59_000);
    expect((await request()).status).toBe(200);

    vi.mocked(Date.now).mockReturnValue(now + 60_000);
    const revoked = await request();
    expect(revoked.status).toBe(401);
    await expect(revoked.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
  });

  it("rejects gateway tokens tied to missing or different-app keys", async () => {
    await seedServerApp("jwt-key-owner", { issuer: {} });
    await seedServerApp("jwt-key-target", { issuer: {} });
    const token = async (apiKeyId: string) => (await issueGatewayToken(
      env.JWT_SECRET,
      "jwt-key-target",
      "customer-42",
      "api_key",
      3600,
      { apiKeyId },
    )).token;
    const request = (credential: string) => exports.default.fetch(
      "https://example.test/v1/apps/jwt-key-target/me",
      { headers: { authorization: `Bearer ${credential}` } },
    );

    expect((await request(await token("key_jwt-key-owner"))).status).toBe(401);
    await database(env.DB)
      .delete(appApiKey)
      .where(eq(appApiKey.id, "key_jwt-key-target"));
    expect((await request(await token("key_jwt-key-target"))).status).toBe(401);
  });

  it("leaves gateway tokens without an API-key ID unchanged", async () => {
    await seedApp("jwt-no-key-id");
    const token = await gatewayToken("jwt-no-key-id", "customer-42");
    const response = await exports.default.fetch(
      "https://example.test/v1/apps/jwt-no-key-id/me",
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user_id: "customer-42" });
  });

  // Each rejected credential is a real D1 lookup, so the bound is narrowed to
  // keep this to a hundred of them rather than the production ten thousand. The
  // policy under test is that the bound holds and that the oldest entry goes
  // first, and neither depends on where the bound sits.
  it("bounds the verification cache and evicts the oldest credential first", async () => {
    const limit = 100;
    setApiKeyCacheLimit(limit);
    await seedServerApp("cache-bound");
    const credentials = Array.from({ length: limit + 1 }, (_, index) => `agw_rejected_${index}`);

    for (const credential of credentials) {
      await expect(verifyApiKey(credential, env, "cache-bound", null)).rejects.toMatchObject({
        status: 401,
      });
    }

    const hashes = apiKeyCacheHashes();
    expect(hashes).toHaveLength(limit);
    expect(hashes[0]).toBe(await hashApiKey(credentials[1]!));
    expect(hashes.at(-1)).toBe(await hashApiKey(credentials.at(-1)!));
    expect(hashes).not.toContain(await hashApiKey(credentials[0]!));
  });

  it("keeps issuer JWTs and API keys exclusive to their configured mode", async () => {
    // No end users, so the request carries nothing but the credential and the
    // rejection is about the credential rather than a missing user id.
    const key = await seedServerApp("mode-server", { endUser: "none" });
    const jwt = await gatewayToken("mode-server");
    const serverWithJwt = await exports.default.fetch(
      "https://example.test/v1/apps/mode-server/proxy/openai/v1/responses",
      {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol" }),
      },
    );
    expect(serverWithJwt.status).toBe(401);

    await seedApp("mode-issuer");
    const issuerWithKey = await exports.default.fetch(
      "https://example.test/v1/apps/mode-issuer/proxy/openai/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-app-version": "1",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol" }),
      },
    );
    expect(issuerWithKey.status).toBe(401);
  });

  it("validates end-user ids and disables issuer exchange routes", async () => {
    const key = await seedServerApp("server-headers");
    for (const endUserId of ["contains space", "", "a".repeat(129), "\x7f"]) {
      const response = await exports.default.fetch(
        "https://example.test/v1/apps/server-headers/proxy/openai/v1/responses",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "x-end-user-id": endUserId,
          },
          body: JSON.stringify({ model: "gpt-5.6-sol" }),
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
    }

    const exchange = await exports.default.fetch(
      "https://example.test/v1/apps/server-headers/auth/challenge",
      { method: "POST" },
    );
    expect(exchange.status).toBe(403);
    await expect(exchange.json()).resolves.toMatchObject({
      error: { code: "auth_method_not_supported" },
    });
  });
});

/**
 * `last_used_at` is reporting: the console shows it, nothing decides anything
 * by it, and the statement that maintains it only writes once an hour. Issuing
 * it on every recorded request therefore buys a D1 round trip to be told the
 * row is already current, which is what the per-isolate interval below skips.
 */
describe("marking a server key used", () => {
  /**
   * Counts the statements that reach D1, and can make one of them fail. Local
   * to this file on purpose: a barrel imports test files, not the other way
   * round, so a helper shared between two of them would have to live in
   * `helpers.ts` first.
   */
  function countingDatabase(): { env: Env; statements: () => number; failNext: () => void } {
    let statements = 0;
    let failing = false;
    const rejected = {
      bind: () => rejected,
      run: async () => { throw new Error("d1 unavailable"); },
      all: async () => { throw new Error("d1 unavailable"); },
      first: async () => { throw new Error("d1 unavailable"); },
      raw: async () => { throw new Error("d1 unavailable"); },
    } as unknown as D1PreparedStatement;
    const db = {
      prepare: (query: string) => {
        statements += 1;
        if (!failing) return env.DB.prepare(query);
        failing = false;
        return rejected;
      },
      batch: (input: D1PreparedStatement[]) => env.DB.batch(input),
      exec: (query: string) => env.DB.exec(query),
      withSession: (constraint?: string) => env.DB.withSession(constraint),
    } as unknown as D1Database;
    return {
      env: new Proxy(env, {
        get: (target, property, receiver) =>
          property === "DB" ? db : Reflect.get(target, property, receiver),
      }) as Env,
      statements: () => statements,
      failNext: () => { failing = true; },
    };
  }

  function lastUsedAt(id: string): Promise<string | null | undefined> {
    return env.DB.prepare("SELECT last_used_at FROM app_api_key WHERE id = ?")
      .bind(id)
      .first<{ last_used_at: string | null }>()
      .then((row) => row?.last_used_at);
  }

  it("writes once for repeated requests inside the hour it would write in anyway", async () => {
    await seedServerApp("mark-used-window");
    const counted = countingDatabase();

    await markApiKeyUsed(counted.env, "key_mark-used-window");
    await markApiKeyUsed(counted.env, "key_mark-used-window");

    expect(counted.statements()).toBe(1);
    await expect(lastUsedAt("key_mark-used-window")).resolves.not.toBeNull();
  });

  it("writes again in a fresh isolate, which is what keeps the column accurate", async () => {
    await seedServerApp("mark-used-fresh");
    const counted = countingDatabase();

    await markApiKeyUsed(counted.env, "key_mark-used-fresh");
    // Standing in for an isolate that never saw this key: it has to reach D1,
    // where the statement's own predicate decides whether anything changes.
    clearApiKeyCache();
    await markApiKeyUsed(counted.env, "key_mark-used-fresh");

    expect(counted.statements()).toBe(2);
  });

  it("gives the interval back when the statement fails, so the retry reaches D1", async () => {
    await seedServerApp("mark-used-failed");
    const counted = countingDatabase();
    counted.failNext();

    await expect(markApiKeyUsed(counted.env, "key_mark-used-failed")).rejects.toThrow();
    expect(counted.statements()).toBe(1);
    expect(await lastUsedAt("key_mark-used-failed")).toBeNull();

    // The caller retries this step, and a retry held off by an interval the
    // failed attempt had already claimed would report a write that never
    // happened.
    await markApiKeyUsed(counted.env, "key_mark-used-failed");
    expect(counted.statements()).toBe(2);
    await expect(lastUsedAt("key_mark-used-failed")).resolves.not.toBeNull();
  });
});
