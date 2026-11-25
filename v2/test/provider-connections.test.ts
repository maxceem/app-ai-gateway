/**
 * Provider connections as the request path sends them: the key stays sealed
 * in this Worker and only the vault opens it (plan step 8i), under the exact
 * binding it was sealed for: never for a blob, a destination, a type or an
 * account other than its own.
 *
 * Ported from v1's `provider-store.test.ts`. The stale-key fallback through a
 * vault outage was dropped in v2 (owner, 2026-11-23), so its cases are not
 * here. The vault's own cache is covered in `vault-worker.test.ts`.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import {
  invalidateConnection,
  loadConnection,
  sealedCredentials,
  type ConnectionRecord,
} from "../src/providers/connections.ts";
import { sealedUpstreamRequest } from "../src/providers/route.ts";
import { vault } from "../src/vault/client.ts";
import { secretVault } from "../src/vault/index.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, seedAccount } from "./helpers.ts";
import { TEST_VAULT_ENV } from "./local-vault.ts";

const SECRET = "sk-provider-connection-secret";

async function seedConnection(baseUrl: string | null = null): Promise<{ id: string; slug: string }> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `openai-${id.slice(0, 6)}`;
  const blob = await sealSecret(TEST_VAULT_ENV, "providerKey", [ACCOUNT_ID, id, "openai", baseUrl ?? "", "", ""], SECRET);
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

/** What reached the provider when a call went through the vault: its credential headers. */
async function connectionCredentials(_env: Env, connection: ConnectionRecord): Promise<{ providerKey: string | null; cloudflareToken: string | null }> {
  const sent: Headers[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    sent.push(new Headers(init?.headers));
    return new Response("{}");
  });
  const target = sealedUpstreamRequest(connection, BUILT_IN_PROVIDERS.openai!, {
    hostKey: "main",
    path: "v1/models",
    query: "",
    credentials: sealedCredentials(connection),
    appId: "app_test",
    userId: null,
  });
  try {
    await vault(env).call({ url: target.url, method: "GET", headers: new Headers(target.headers), body: null, credentials: target.credentials });
  } finally {
    vi.mocked(globalThis.fetch).mockRestore();
  }
  const headers = sent[0]!;
  const authorization = headers.get("authorization");
  const cloudflare = headers.get("cf-aig-authorization");
  return {
    providerKey: authorization === null ? null : authorization.replace(/^Bearer /u, ""),
    cloudflareToken: cloudflare === null ? null : cloudflare.replace(/^Bearer /u, ""),
  };
}

describe("sending with a connection's key, through the vault", () => {
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

    const replaced = await sealSecret(TEST_VAULT_ENV, "providerKey", [ACCOUNT_ID, id, "openai", "", "", ""], "sk-replaced-key");
    await env.DB.prepare("UPDATE provider_connection SET secret_blob = ? WHERE id = ?").bind(replaced, id).run();
    invalidateConnection(ACCOUNT_ID, slug);

    await expect(connectionCredentials(env, await load(slug))).resolves.toMatchObject({ providerKey: "sk-replaced-key" });
  });

  it("refuses a key sealed before its type and destination were bound, without logging it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { id, slug } = await seedConnection();
    const legacy = await secretVault(TEST_VAULT_ENV).encryptSecret(SECRET, { service: "app-ai-gateway", accountId: ACCOUNT_ID, connectionId: id });
    await env.DB.prepare("UPDATE provider_connection SET secret_blob = ? WHERE id = ?").bind(legacy, id).run();

    await expect(connectionCredentials(env, await load(slug))).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
    const lines = errors.mock.calls.flat().map((line) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ message: "provider_secret_unavailable", vault: "credential_unavailable" }));
    expect(errors.mock.calls.flat().join(" ")).not.toContain(SECRET);
  });

  it("refuses a connection with neither a key nor a Cloudflare token", async () => {
    const { id, slug } = await seedConnection();
    await env.DB.prepare("UPDATE provider_connection SET secret_blob = NULL WHERE id = ?").bind(id).run();

    await expect(connectionCredentials(env, await load(slug))).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
  });

  async function addCloudflareGateway(id: string): Promise<void> {
    const token = await sealSecret(TEST_VAULT_ENV, "cloudflareGatewayToken", [ACCOUNT_ID, id, "cf-account", "cf-gateway"], "cf-token");
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
    // The refusal comes before anything reaches the vault: nothing is decrypted.
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");

    await expect(connectionCredentials(env, connection)).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
    expect(decrypt).not.toHaveBeenCalled();
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
