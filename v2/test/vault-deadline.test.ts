/**
 * The gateway's deadline reaches the vault (`x-agw-vault-deadline`), and the
 * vault stops waiting on cf-kms before it: a stall comes back as the vault's
 * own refusal (nothing sent, nothing charged), never as the gateway giving up
 * on a call it cannot tell apart. Run over the real service binding to a vault
 * in kms mode (`vitest.config.ts`), whose cf-kms stand-in never answers a
 * decrypt for the wrapped key "stall". The gateway's first-byte limit is 3 s
 * here, under the vault's own 5 s cf-kms limit; each test waits about 2.5 s.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKmsClient } from "@maxceem/cf-kms/client";
import worker from "../src/index.ts";
import { setVaultForTests } from "../src/vault/client.ts";
import { secretContext } from "../vault/src/seal.js";
import { ACCOUNT_ID, clearCaches, ledger, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";
import { localVault } from "./local-vault.ts";

const ORIGIN = "https://gateway.test";
const SECRET = "sk-test-deadline-key-2468";
/** The gateway with the kms vault bound as its vault, and a 3 s first-byte limit. */
const kmsEnv = () => ({ ...env, VAULT: (env as unknown as { VAULT_KMS: unknown }).VAULT_KMS, PROVIDER_TTFB_TIMEOUT_SECONDS: "3" }) as unknown as Env;

/** A blob whose decrypt stalls at the stand-in: well formed, never opened. */
const STALLED = "cfkms-env1.stall.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA";

/** A blob the stand-in opens: sealed with its one fixed data key, under the connection's real context. */
async function openable(identity: string[]): Promise<string> {
  const client = createKmsClient({
    url: "https://kms.example.test",
    token: "kms-token",
    fetch: async () => Response.json({ plaintextKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", wrappedKey: "fixed", kekVersion: 1 }),
  });
  return client.encryptSecret(SECRET, secretContext("providerKey", identity));
}

async function connection(type: string, blob: (id: string) => Promise<string> | string): Promise<{ id: string; slug: string }> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `${type}-${id.slice(0, 6)}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, revision, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, '2468', NULL, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, type, slug, type, await blob(id), now, now)
    .run();
  return { id, slug };
}

async function send(path: string, key: string, body: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    kmsEnv(),
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, text };
}

async function charges(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await ledger().prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY seq").bind(appId).all();
  return results;
}

beforeEach(() => {
  clearCaches();
  setVaultForTests(null);
});
afterEach(() => setVaultForTests(localVault));

describe("the gateway's deadline, through the real binding to a kms vault", () => {
  it("charges nothing for a job submission whose key cf-kms never opens before the deadline", async () => {
    const { slug } = await connection("fal", () => STALLED);
    const appId = await seedRoutedApp(
      { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      { providers: { [slug]: { operations: ["fal.queue"] } } },
    );
    const { key } = await seedAppKey(appId);
    const submitted = await send(`/v2/apps/${appId}/proxy/${slug}/queue/fal-ai/flux/dev`, key, { prompt: "a cat", num_images: 2 });
    expect(submitted.status).toBe(502);
    expect(JSON.parse(submitted.text)).toMatchObject({ error: { code: "provider_unavailable" } });
    expect(await charges(appId)).toEqual([]);
  }, 15_000);

  it("keeps a held 503 and writes no timeout charge when a fallback's key never opens before the deadline", async () => {
    const primary = await connection("openai", (id) => openable([ACCOUNT_ID, id, "openai", "", "", ""]));
    const fallback = await connection("openai", () => STALLED);
    await seedAccount();
    const appId = `app_deadline_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const config = {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      presets: { chat: { provider: primary.slug, operation: "openai.chat", model: "gpt-4o-mini", fallback: [{ provider: fallback.slug, model: "gpt-4o-mini" }] } },
    };
    await env.DB.prepare("INSERT INTO app(id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)")
      .bind(appId, ACCOUNT_ID, appId, JSON.stringify(config), now, now)
      .run();
    const { key } = await seedAppKey(appId);
    const served = await send(`/v2/apps/${appId}/presets/chat`, key, { messages: [] });
    expect(served.status).toBe(503);
    expect(JSON.parse(served.text)).toEqual({ error: { code: "busy" } });
    expect((await charges(appId)).map((row) => [row.seq, row.http_status, row.status])).toEqual([[1, 503, "provider_error"]]);
  }, 15_000);
});
