import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeyCache, generateApiKey, hashApiKey, markApiKeyUsed, verifyApiKey } from "../src/client-auth/api-keys.ts";
import { clearAllCaches } from "../src/core/ttl-cache.ts";
import { clearCaches, seedApp, seedAppKey } from "./helpers.ts";

beforeEach(() => clearCaches());
afterEach(() => vi.useRealTimers());

const lastUsedAt = (id: string) =>
  env.DB.prepare("SELECT last_used_at FROM app_key WHERE id = ?").bind(id).first<{ last_used_at: number | null }>();

describe("app keys", () => {
  it("are generated in the documented format and stored only as a hash of the full key", async () => {
    const generated = await generateApiKey();
    expect(generated.key).toMatch(/^agw_[0-9A-Za-z]{48}$/);
    expect(generated.id).toMatch(/^key_[0-9a-z]{20}$/);
    expect(generated.keyHash).toBe(await hashApiKey(generated.key));
    expect(generated.keyPrefix).toBe(generated.key.slice(0, 12));
  });

  it("verify for their own app only, and carry the end user given", async () => {
    const appId = await seedApp({ type: "api_key", end_user: { source: "none" } });
    const otherApp = await seedApp({ type: "api_key", end_user: { source: "none" } });
    const key = await seedAppKey(appId);
    await expect(verifyApiKey(key.key, env, appId, "user-1")).resolves.toEqual({
      appId,
      userId: "user-1",
      authMethod: "api_key",
      credentialType: "api_key",
      apiKeyId: key.id,
      installId: null,
      appleAccountId: null,
    });
    await expect(verifyApiKey(key.key, env, otherApp, null)).rejects.toMatchObject({ status: 401, code: "auth_required" });
  });

  it("keep a revoked key working for at most the cache minute, and check a miss again after ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const appId = await seedApp({ type: "api_key", end_user: { source: "none" } });
    const key = await seedAppKey(appId);
    await verifyApiKey(key.key, env, appId, null);
    await env.DB.prepare("UPDATE app_key SET status = 'revoked' WHERE id = ?").bind(key.id).run();
    await expect(verifyApiKey(key.key, env, appId, null)).resolves.toMatchObject({ apiKeyId: key.id });
    vi.setSystemTime(Date.now() + 60_001);
    await expect(verifyApiKey(key.key, env, appId, null)).rejects.toMatchObject({ code: "auth_required" });

    await env.DB.prepare("UPDATE app_key SET status = 'active' WHERE id = ?").bind(key.id).run();
    await expect(verifyApiKey(key.key, env, appId, null)).rejects.toMatchObject({ code: "auth_required" });
    vi.setSystemTime(Date.now() + 10_001);
    await expect(verifyApiKey(key.key, env, appId, null)).resolves.toMatchObject({ apiKeyId: key.id });
    expect(apiKeyCache.size).toBeGreaterThan(0);
  });

  it("record their last use at most once an hour per isolate", async () => {
    const appId = await seedApp({ type: "api_key", end_user: { source: "none" } });
    const key = await seedAppKey(appId);
    await markApiKeyUsed(env, key.id);
    const first = (await lastUsedAt(key.id))?.last_used_at;
    expect(first).toEqual(expect.any(Number));
    await env.DB.prepare("UPDATE app_key SET last_used_at = 1 WHERE id = ?").bind(key.id).run();
    await markApiKeyUsed(env, key.id);
    expect((await lastUsedAt(key.id))?.last_used_at).toBe(1);
    // A fresh isolate writes again; the statement's own condition decides.
    clearAllCaches();
    await markApiKeyUsed(env, key.id);
    expect((await lastUsedAt(key.id))?.last_used_at).toBeGreaterThan(1);
  });
});
