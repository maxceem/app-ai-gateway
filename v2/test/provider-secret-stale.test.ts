/**
 * A provider key while the vault cannot be reached: the last copy opened from
 * the same sealed blob serves for up to an hour past its expiry, logged as
 * `provider_secret_stale`, as v1 (`provider-store.test.ts` at the repository
 * root), and only once D1 confirms it is still the connection's own. A fault
 * in the deployment's own vault setup, or a refusal the vault meant, never
 * serves one, and drops the copy.
 *
 * The local vault reports every decrypt failure as a blob fault, so only a
 * KMS vault meets a transport failure. The open step is given to `opened`
 * here, so each kind of failure can be made.
 */
import { env } from "cloudflare:workers";
import { KmsClientError } from "@maxceem/cf-kms/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialStillCurrent, loadConnection, opened, type ConnectionRecord } from "../src/providers/connections.ts";
import { isVaultTransportFailure } from "../src/vault/index.ts";
import { SecretVaultBlobError, SecretVaultConfigurationError } from "../src/vault/types.ts";
import { ACCOUNT_ID, clearCaches, seedAccount } from "./helpers.ts";

const SECRET = "sk-test-stale-provider-key-5678";
const TEN_MINUTES = 10 * 60_000;
const HOUR = 60 * 60_000;

function connection(): ConnectionRecord {
  return {
    id: `conn_${crypto.randomUUID().slice(0, 8)}`,
    accountId: "acc_stale",
    type: "openai",
    slug: "openai",
    status: "active",
    baseUrl: null,
    secretBlob: `cfkms-env1.${crypto.randomUUID()}`,
    rates: null,
    cloudflareGateway: null,
    servingProviders: null,
  };
}

const unreachable = () => Promise.reject(new KmsClientError("request_failed", 503));
const current = () => Promise.resolve(true);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearCaches();
  vi.useFakeTimers({ toFake: ["Date"] });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("what counts as the vault being unreachable", () => {
  it("is no answer at all: a network error, a timeout, a 5xx or a 429", () => {
    expect(isVaultTransportFailure(new TypeError("Network connection lost."))).toBe(true);
    expect(isVaultTransportFailure(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true);
    expect(isVaultTransportFailure(new KmsClientError("request_failed", 503))).toBe(true);
    expect(isVaultTransportFailure(new KmsClientError("invalid_response", 502))).toBe(true);
    expect(isVaultTransportFailure(new KmsClientError("rate_limited", 429))).toBe(true);
  });

  it("is never a refusal cf-kms meant, whatever its body, nor a fault in the setup or the blob", () => {
    expect(isVaultTransportFailure(new KmsClientError("forbidden", 403))).toBe(false);
    expect(isVaultTransportFailure(new KmsClientError("request_failed", 403))).toBe(false);
    expect(isVaultTransportFailure(new KmsClientError("invalid_response", 404))).toBe(false);
    expect(isVaultTransportFailure(new KmsClientError("not_found", 404))).toBe(false);
    expect(isVaultTransportFailure(new KmsClientError("unauthorized", 401))).toBe(false);
    expect(isVaultTransportFailure(new KmsClientError("decrypt_failed", 0))).toBe(false);
    expect(isVaultTransportFailure(new KmsClientError("invalid_response", 200))).toBe(false);
    expect(isVaultTransportFailure(new SecretVaultBlobError("decrypt failed"))).toBe(false);
    expect(isVaultTransportFailure(new SecretVaultConfigurationError("missing", { setting: "SECRET_VAULT_MODE", problem: "missing" } as never))).toBe(false);
  });
});

describe("a provider key while the vault cannot be reached", () => {
  it("serves the last opened copy for up to an hour past its expiry, logged without the key, never refreshed", async () => {
    const record = connection();
    const blob = record.secretBlob!;
    expect(await opened(record, "providerKey", () => Promise.resolve(SECRET), blob, current)).toBe(SECRET);

    vi.setSystemTime(Date.now() + TEN_MINUTES + 1);
    const failing = vi.fn(unreachable);
    expect(await opened(record, "providerKey", failing, blob, current)).toBe(SECRET);
    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("provider_secret_stale");
    expect(logged).not.toContain(SECRET);
    // Not refreshed: every request goes back to the vault first.
    vi.setSystemTime(Date.now() + HOUR - 2);
    expect(await opened(record, "providerKey", failing, blob, current)).toBe(SECRET);
    expect(failing).toHaveBeenCalledTimes(2);

    // An hour past the copy's expiry, it no longer serves.
    vi.setSystemTime(Date.now() + 1);
    await expect(opened(record, "providerKey", failing, blob, current)).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
  });

  it("serves no stale copy when D1 does not confirm it is still the connection's own", async () => {
    const record = connection();
    await opened(record, "providerKey", () => Promise.resolve(SECRET), record.secretBlob!, current);
    vi.setSystemTime(Date.now() + TEN_MINUTES + 1);
    const notCurrent = vi.fn(() => Promise.resolve(false));
    await expect(opened(record, "providerKey", unreachable, record.secretBlob!, notCurrent)).rejects.toMatchObject({ status: 502 });
    expect(notCurrent).toHaveBeenCalledTimes(1);
  });

  it("never serves a stale copy through a fault in the deployment's own vault setup", async () => {
    const record = connection();
    const blob = record.secretBlob!;
    await opened(record, "providerKey", () => Promise.resolve(SECRET), blob, current);
    vi.setSystemTime(Date.now() + TEN_MINUTES + 1);
    const misconfigured = () => Promise.reject(new SecretVaultConfigurationError("the vault's key is missing", { setting: "SECRET_VAULT_MODE", problem: "missing" } as never));
    await expect(opened(record, "providerKey", misconfigured, blob, current)).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
  });

  it("drops the copy on a refusal the vault meant, so a later outage cannot bring it back", async () => {
    const record = connection();
    const blob = record.secretBlob!;
    await opened(record, "providerKey", () => Promise.resolve(SECRET), blob, current);
    vi.setSystemTime(Date.now() + TEN_MINUTES + 1);
    const refused = () => Promise.reject(new KmsClientError("forbidden", 403));
    await expect(opened(record, "providerKey", refused, blob, current)).rejects.toMatchObject({ status: 502 });
    await expect(opened(record, "providerKey", unreachable, blob, current)).rejects.toMatchObject({ status: 502 });
    expect(warn.mock.calls.flat().map(String).join(" ")).not.toContain("provider_secret_stale");
  });

  it("never serves a copy opened from another blob: a rotated key is not brought back", async () => {
    const record = connection();
    await opened(record, "providerKey", () => Promise.resolve(SECRET), record.secretBlob!, current);
    vi.setSystemTime(Date.now() + TEN_MINUTES + 1);
    await expect(opened(record, "providerKey", unreachable, `cfkms-env1.${crypto.randomUUID()}`, current)).rejects.toMatchObject({ status: 502 });
  });
});

describe("whether a credential is still the connection's own (read from D1, past the cache)", () => {
  async function seeded(): Promise<{ id: string; slug: string; blob: string }> {
    await seedAccount();
    const id = crypto.randomUUID().replaceAll("-", "");
    const slug = `openai-${id.slice(0, 6)}`;
    const blob = `cfkms-env1.${id}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO provider_connection
        (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
       VALUES (?, ?, 'openai', ?, 'OpenAI', 'active', ?, '1234', NULL, NULL, 1, 'usr_test', ?, ?)`,
    )
      .bind(id, ACCOUNT_ID, slug, blob, now, now)
      .run();
    return { id, slug, blob };
  }

  it("says yes for the same active connection with the same blob", async () => {
    const { slug, blob } = await seeded();
    const record = (await loadConnection(env, ACCOUNT_ID, slug))!;
    expect(await credentialStillCurrent(env, record, "providerKey", blob)).toBe(true);
  });

  it("says no after the key was rotated, or the connection disabled, while the old record is still cached here", async () => {
    const rotated = await seeded();
    const before = (await loadConnection(env, ACCOUNT_ID, rotated.slug))!;
    await env.DB.prepare("UPDATE provider_connection SET secret_blob = ? WHERE id = ?").bind(`cfkms-env1.new-${rotated.id}`, rotated.id).run();
    // The isolate's cache still holds the old record.
    expect((await loadConnection(env, ACCOUNT_ID, rotated.slug))?.secretBlob).toBe(rotated.blob);
    expect(await credentialStillCurrent(env, before, "providerKey", rotated.blob)).toBe(false);

    const disabled = await seeded();
    const cached = (await loadConnection(env, ACCOUNT_ID, disabled.slug))!;
    await env.DB.prepare("UPDATE provider_connection SET status = 'disabled' WHERE id = ?").bind(disabled.id).run();
    expect(await credentialStillCurrent(env, cached, "providerKey", disabled.blob)).toBe(false);

    const deleted = await seeded();
    const gone = (await loadConnection(env, ACCOUNT_ID, deleted.slug))!;
    await env.DB.prepare("DELETE FROM provider_connection WHERE id = ?").bind(deleted.id).run();
    expect(await credentialStillCurrent(env, gone, "providerKey", deleted.blob)).toBe(false);
  });
});
