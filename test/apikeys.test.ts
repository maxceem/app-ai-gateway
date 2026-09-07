import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyCacheHashes,
  clearApiKeyCache,
  generateApiKey,
  hashApiKey,
  verifyApiKey,
} from "../src/core/apikeys";
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

  it("uses the config cache TTL for revocation and maps optional end-user identity", async () => {
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
    await expect(verifyApiKey(key, env, "key-cache", null)).resolves.toMatchObject({
      userId: "key_key-cache",
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

  // Each rejected credential is a real D1 lookup, so this one test is slower
  // than the default 5 s timeout allows.
  it("bounds the verification cache and evicts the oldest credential first", async () => {
    await seedServerApp("cache-bound");
    const credentials = Array.from({ length: 10_001 }, (_, index) => `agw_rejected_${index}`);

    for (const credential of credentials) {
      await expect(verifyApiKey(credential, env, "cache-bound", null)).rejects.toMatchObject({
        status: 401,
      });
    }

    const hashes = apiKeyCacheHashes();
    expect(hashes).toHaveLength(10_000);
    expect(hashes[0]).toBe(await hashApiKey(credentials[1]!));
    expect(hashes.at(-1)).toBe(await hashApiKey(credentials.at(-1)!));
    expect(hashes).not.toContain(await hashApiKey(credentials[0]!));
  }, 60_000);

  it("keeps issuer JWTs and API keys exclusive to their configured mode", async () => {
    const key = await seedServerApp("mode-server");
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
