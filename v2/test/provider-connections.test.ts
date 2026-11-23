/**
 * Provider connections as the request path opens them: the opened key is
 * cached, but never for a blob, a destination or an account other than the
 * one it was sealed for.
 *
 * Ported from v1's `provider-store.test.ts`. The stale-key fallback through a
 * vault outage was dropped in v2 (owner, 2026-11-23), so its cases are not
 * here. The cache's own bounds and eviction order are in `ttl-cache.test.ts`.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionCredentials,
  invalidateConnection,
  loadConnection,
  type ConnectionRecord,
} from "../src/providers/connections.ts";
import { secretVault } from "../src/vault/index.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, seedAccount } from "./helpers.ts";

const SECRET = "sk-provider-connection-secret";

async function seedConnection(baseUrl: string | null = null): Promise<{ id: string; slug: string }> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `openai-${id.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, "openai", baseUrl ?? ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'openai', ?, 'OpenAI', 'active', ?, 'cret', ?, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, slug, blob, baseUrl, now, now)
    .run();
  return { id, slug };
}

async function load(slug: string): Promise<ConnectionRecord> {
  const connection = await loadConnection(env, ACCOUNT_ID, slug);
  if (connection === null) throw new Error("connection missing");
  return connection;
}

beforeEach(() => clearCaches());
afterEach(() => vi.restoreAllMocks());

describe("opening a connection's key", () => {
  it("opens the sealed key", async () => {
    const { slug } = await seedConnection();
    await expect(connectionCredentials(env, await load(slug))).resolves.toEqual({ providerKey: SECRET, cloudflareToken: null });
  });

  it("never serves a warm key for a destination rewritten behind the management API", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { id, slug } = await seedConnection();
    await connectionCredentials(env, await load(slug));

    // The base URL changed in D1 without the key being sealed again, which
    // the management API never allows: the key is bound to the origin it was
    // given for, so the warm copy must not follow the row somewhere else.
    await env.DB.prepare("UPDATE provider_connection SET base_url = ? WHERE id = ?").bind("https://elsewhere.example.test/", id).run();
    invalidateConnection(ACCOUNT_ID, slug);

    await expect(connectionCredentials(env, await load(slug))).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
    expect(errors.mock.calls.flat().join(" ")).not.toContain(SECRET);
  });

  it("never serves a warm key for a connection whose type changed behind the management API", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { id, slug } = await seedConnection();
    await connectionCredentials(env, await load(slug));

    await env.DB.prepare("UPDATE provider_connection SET type = 'anthropic' WHERE id = ?").bind(id).run();
    invalidateConnection(ACCOUNT_ID, slug);

    await expect(connectionCredentials(env, await load(slug))).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
  });

  it("opens a replaced key afresh, never the cached old one", async () => {
    const { id, slug } = await seedConnection();
    await connectionCredentials(env, await load(slug));

    const replaced = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, "openai", ""], "sk-replaced-key");
    await env.DB.prepare("UPDATE provider_connection SET secret_blob = ? WHERE id = ?").bind(replaced, id).run();
    invalidateConnection(ACCOUNT_ID, slug);

    await expect(connectionCredentials(env, await load(slug))).resolves.toMatchObject({ providerKey: "sk-replaced-key" });
  });

  it("refuses a key sealed before its type and destination were bound, without logging it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { id, slug } = await seedConnection();
    const legacy = await secretVault(env).encryptSecret(SECRET, { service: "app-ai-gateway", accountId: ACCOUNT_ID, connectionId: id });
    await env.DB.prepare("UPDATE provider_connection SET secret_blob = ? WHERE id = ?").bind(legacy, id).run();

    await expect(connectionCredentials(env, await load(slug))).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
    const lines = errors.mock.calls.flat().map((line) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({
      message: "provider_secret_unavailable",
      connection: id,
      credential: "providerKey",
      error: expect.objectContaining({ class: "SecretVaultBlobError" }),
    }));
    expect(errors.mock.calls.flat().join(" ")).not.toContain(SECRET);
  });

  it("refuses a connection with neither a key nor a Cloudflare token", async () => {
    const { id, slug } = await seedConnection();
    await env.DB.prepare("UPDATE provider_connection SET secret_blob = NULL WHERE id = ?").bind(id).run();

    await expect(connectionCredentials(env, await load(slug))).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
  });

  async function addCloudflareGateway(id: string): Promise<void> {
    const token = await sealSecret(env, "cloudflareGatewayToken", [ACCOUNT_ID, id], "cf-token");
    await env.DB.prepare("UPDATE provider_connection SET cloudflare_gateway_json = ? WHERE id = ?")
      .bind(JSON.stringify({ account_id: "cf-account", gateway_id: "cf-gateway", token_blob: token }), id)
      .run();
  }

  it.each(["cold", "warm"])("refuses a row with both a base URL and a Cloudflare gateway and a stored key, %s cache, before opening it", async (cache) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { id, slug } = await seedConnection("https://elsewhere.example.test/");
    if (cache === "warm") await connectionCredentials(env, await load(slug));
    await addCloudflareGateway(id);
    invalidateConnection(ACCOUNT_ID, slug);
    const connection = await load(slug);
    // With a cold cache, opening the key would decrypt. The tests' local vault
    // decrypts with `crypto.subtle`, so no call proves the refusal comes first.
    const decrypt = cache === "cold" ? vi.spyOn(crypto.subtle, "decrypt") : null;

    await expect(connectionCredentials(env, connection)).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
    if (decrypt !== null) expect(decrypt).not.toHaveBeenCalled();
    const lines = errors.mock.calls.flat().map((line) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ message: "provider_connection_unusable", connection: id, reason: "base_url_and_cloudflare_gateway" }));
    expect(errors.mock.calls.flat().join(" ")).not.toContain(SECRET);
  });

  it("keeps serving a Cloudflare connection whose provider keys stay in Cloudflare, whatever stray base URL it has", async () => {
    const { id, slug } = await seedConnection("https://elsewhere.example.test/");
    await addCloudflareGateway(id);
    await env.DB.prepare("UPDATE provider_connection SET secret_blob = NULL WHERE id = ?").bind(id).run();
    invalidateConnection(ACCOUNT_ID, slug);

    await expect(connectionCredentials(env, await load(slug))).resolves.toEqual({ providerKey: null, cloudflareToken: "cf-token" });
  });
});
