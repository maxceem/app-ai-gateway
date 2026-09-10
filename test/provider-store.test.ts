import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProviderCaches,
  decryptProviderGatewaySecret,
  encryptionContext,
  gatewayEncryptionContext,
  resolveProvider,
  secretCacheKeys,
} from "../src/core/provider-store";
import { database } from "../src/db";
import { provider } from "../src/db/schema";
import { secretVault } from "../src/vault";
import { TEST_OPERATOR_USER_ID } from "./helpers";

const ORGANIZATION_ID = "provider-store-organization";
const PROVIDER_ID = "provider-store-openai";
const PROVIDER_SLUG = "openai";
const SECRET = "sk-provider-store";
const KMS_URL = "https://kms.example.test";
const DATA_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * A fresh env object per call, so every decrypt reaches the stubbed cf-kms:
 * the vault is memoized per env identity and its client caches unwrapped data
 * keys for five minutes, which would otherwise answer the second decrypt from
 * inside the client instead of exercising the vault at all.
 */
function kmsEnv(): Env {
  const bindings = { ...env } as Record<string, unknown>;
  for (const name of Object.keys(bindings)) {
    if (name.startsWith("SECRET_VAULT_")) delete bindings[name];
  }
  return {
    ...bindings,
    SECRET_VAULT_MODE: "kms",
    SECRET_VAULT_KMS_URL: KMS_URL,
    SECRET_VAULT_KMS_TOKEN: "ckms_app-ai-gateway_test",
  } as Env;
}

const unwrapSucceeds = (): Response => Response.json({ plaintextKey: DATA_KEY, kekVersion: 1 });

/** What the next `/v1/decrypt` does. Reassigned by the test that needs it. */
let onUnwrap: () => Response = unwrapSucceeds;
let unwrapCalls = 0;

function stubKms(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/v1/generate-data-key")) {
      return Response.json({
        plaintextKey: DATA_KEY,
        wrappedKey: "cfkms1.1.test-wrapped-key",
        kekVersion: 1,
      });
    }
    unwrapCalls += 1;
    return onUnwrap();
  });
}

/** Replaces the row with one whose blob only the stubbed cf-kms can open. */
async function seedKmsProvider(): Promise<void> {
  const blob = await secretVault(kmsEnv()).encryptSecret(
    SECRET,
    encryptionContext(ORGANIZATION_ID, PROVIDER_ID),
  );
  await database(env.DB).delete(provider).where(eq(provider.id, PROVIDER_ID));
  await database(env.DB).insert(provider).values({
    id: PROVIDER_ID,
    organizationId: ORGANIZATION_ID,
    type: "openai",
    slug: PROVIDER_SLUG,
    name: "Provider store openai",
    secretBlob: blob,
    secretHint: SECRET.slice(-4),
    createdBy: TEST_OPERATOR_USER_ID,
  });
  clearProviderCaches();
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Provider Store Test', 'operator-test-owner', datetime('now'), datetime('now'))`,
  ).bind(ORGANIZATION_ID).run();
});

beforeEach(async () => {
  clearProviderCaches();
  onUnwrap = unwrapSucceeds;
  unwrapCalls = 0;
  stubKms();
  await seedKmsProvider();
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearProviderCaches();
  await database(env.DB).delete(provider).where(eq(provider.id, PROVIDER_ID));
});

describe("provider secrets when the vault cannot decrypt", () => {
  it("serves the last decrypted secret through an unreachable vault, then stops", async () => {
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(resolveProvider(kmsEnv(), ORGANIZATION_ID, PROVIDER_SLUG))
      .resolves.toMatchObject({ secret: SECRET });
    expect(unwrapCalls).toBe(1);

    // Inside the TTL nothing is asked of the vault at all.
    await expect(resolveProvider(kmsEnv(), ORGANIZATION_ID, PROVIDER_SLUG))
      .resolves.toMatchObject({ secret: SECRET });
    expect(unwrapCalls).toBe(1);

    onUnwrap = () => {
      throw new TypeError("network connection lost");
    };
    vi.mocked(Date.now).mockReturnValue(start + 61_000);
    await expect(resolveProvider(kmsEnv(), ORGANIZATION_ID, PROVIDER_SLUG))
      .resolves.toMatchObject({ secret: SECRET });
    expect(unwrapCalls).toBe(2);
    const stale = warnSpy.mock.calls.flat().join(" ");
    expect(stale).toContain("provider_secret_stale");
    expect(stale).toContain(PROVIDER_ID);
    expect(stale).not.toContain(SECRET);
    expect(errorSpy).not.toHaveBeenCalled();

    // The entry is never refreshed by a stale read, so the window is measured
    // from the last real decrypt.
    vi.mocked(Date.now).mockReturnValue(start + 60_000 + 60 * 60_000);
    await expect(resolveProvider(kmsEnv(), ORGANIZATION_ID, PROVIDER_SLUG))
      .rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("provider_secret_unavailable");
  });

  it("treats a cf-kms 5xx as transport and serves the last known secret", async () => {
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(resolveProvider(kmsEnv(), ORGANIZATION_ID, PROVIDER_SLUG))
      .resolves.toMatchObject({ secret: SECRET });

    onUnwrap = () => Response.json({ error: { code: "request_failed" } }, { status: 503 });
    vi.mocked(Date.now).mockReturnValue(start + 61_000);
    await expect(resolveProvider(kmsEnv(), ORGANIZATION_ID, PROVIDER_SLUG))
      .resolves.toMatchObject({ secret: SECRET });
  });

  it("refuses a configuration failure even though a decrypted secret is cached", async () => {
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(resolveProvider(kmsEnv(), ORGANIZATION_ID, PROVIDER_SLUG))
      .resolves.toMatchObject({ secret: SECRET });
    vi.mocked(Date.now).mockReturnValue(start + 61_000);

    // The deployment's own local-mode env: a SecretVaultBlobError, because this
    // blob was never encrypted in that mode.
    await expect(resolveProvider(env, ORGANIZATION_ID, PROVIDER_SLUG))
      .rejects.toMatchObject({ status: 502, code: "provider_unavailable" });

    // A vault that cannot even be constructed — here a deploy that lost its
    // cf-kms token — is a configuration fact of the same kind.
    const withoutToken = { ...kmsEnv(), SECRET_VAULT_KMS_TOKEN: "" } as Env;
    await expect(resolveProvider(withoutToken, ORGANIZATION_ID, PROVIDER_SLUG))
      .rejects.toMatchObject({ status: 502, code: "provider_unavailable" });

    // A cf-kms verdict on the blob or on the caller token is just as final.
    for (const code of ["unauthorized", "decrypt_failed", "invalid_envelope"]) {
      onUnwrap = () => Response.json({ error: { code } }, { status: 403 });
      await expect(resolveProvider(kmsEnv(), ORGANIZATION_ID, PROVIDER_SLUG))
        .rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
    }

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("provider_secret_unavailable");
  });
});

// Every entry is a real encrypt and decrypt through the local vault, so this
// one test is slower than the default 5 s timeout allows.
it("bounds the secret cache and evicts the oldest entry first", async () => {
  clearProviderCaches();
  const vault = secretVault(env);
  const keys: string[] = [];

  for (let index = 0; index < 5_001; index += 1) {
    const gatewayId = `provider-store-gateway-${index}`;
    const context = gatewayEncryptionContext(ORGANIZATION_ID, gatewayId);
    const blob = await vault.encryptSecret(SECRET, context);
    keys.push(`${gatewayId}\0${blob}`);
    await expect(decryptProviderGatewaySecret(env, ORGANIZATION_ID, gatewayId, blob))
      .resolves.toBe(SECRET);
  }

  const cached = secretCacheKeys();
  expect(cached).toHaveLength(5_000);
  expect(cached[0]).toBe(keys[1]);
  expect(cached.at(-1)).toBe(keys.at(-1));
  expect(cached).not.toContain(keys[0]);
}, 60_000);
