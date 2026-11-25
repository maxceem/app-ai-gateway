/**
 * The key vault: local and cf-kms modes, their configuration checks, and the
 * secret contexts every sealed value is bound to.
 *
 * Ported from v1's `vault.test.ts` and `vault-secrets.test.ts`. The health
 * check's `vault` field is covered in `worker.test.ts`.
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SecretVaultBlobError,
  SecretVaultConfigurationError,
  secretVault,
  type SecretVaultContext,
} from "../src/vault/index.ts";
import {
  openSecret,
  sealSecret,
  secretContext,
  secretIdentityLength,
  SECRET_KINDS,
  type SecretKind,
} from "../src/vault/secrets.ts";

const TEST_KEK_V1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TEST_KEK_V2 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const DATA_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CONTEXT = {
  service: "app-ai-gateway",
  accountId: "account_test",
  connectionId: "connection_test",
} satisfies SecretVaultContext;

afterEach(() => vi.restoreAllMocks());

describe("local key vault", () => {
  it("encrypts with the current version and binds the blob to its context", async () => {
    const vault = secretVault({
      SECRET_VAULT_MODE: "local",
      SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "2",
      SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1,
      SECRET_VAULT_LOCAL_KEK_V2: TEST_KEK_V2,
    });

    const blob = await vault.encryptSecret("sk-local-secret", CONTEXT);
    expect(blob).toMatch(/^local1\.2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    await expect(vault.decryptSecret(blob, CONTEXT)).resolves.toBe("sk-local-secret");
    await expect(vault.decryptSecret(blob, { ...CONTEXT, connectionId: "other" }))
      .rejects.toThrow("decrypt failed");
  });

  it("keeps older KEK versions for opening blobs sealed before a rotation", async () => {
    const before = secretVault({ SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1 });
    const blob = await before.encryptSecret("rotated-later", CONTEXT);
    const after = secretVault({
      SECRET_VAULT_MODE: "local",
      SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "2",
      SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1,
      SECRET_VAULT_LOCAL_KEK_V2: TEST_KEK_V2,
    });

    await expect(after.decryptSecret(blob, CONTEXT)).resolves.toBe("rotated-later");
  });

  it("refuses a blob whose KEK version is no longer configured", async () => {
    const rotated = secretVault({
      SECRET_VAULT_MODE: "local",
      SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "2",
      SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1,
      SECRET_VAULT_LOCAL_KEK_V2: TEST_KEK_V2,
    });
    const blob = await rotated.encryptSecret("needs-v2", CONTEXT);
    const withoutV2 = secretVault({ SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1 });

    await expect(withoutV2.decryptSecret(blob, CONTEXT)).rejects.toBeInstanceOf(SecretVaultBlobError);
  });

  it.each([
    "local1",
    "local1.1.iv",
    "local1.x.aaaa.bbbb",
    "local1.1.!!!!.bbbb",
    "local1.1.aaaa.bbbb",
  ])("refuses the malformed blob %j as a blob error", async (blob) => {
    const vault = secretVault({ SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1 });
    await expect(vault.decryptSecret(blob, CONTEXT)).rejects.toBeInstanceOf(SecretVaultBlobError);
  });
});

describe("cf-kms key vault", () => {
  it("uses the real envelope client against a stand-in cf-kms", async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, headers: new Headers(init?.headers), body });
      if (url.endsWith("/v1/generate-data-key")) {
        return Response.json({ plaintextKey: DATA_KEY, wrappedKey: "cfkms1.1.test-wrapped-key", kekVersion: 1 });
      }
      return Response.json({ plaintextKey: DATA_KEY, kekVersion: 1 });
    });
    const config = {
      SECRET_VAULT_MODE: "kms",
      SECRET_VAULT_KMS_URL: "https://kms.example.test",
      SECRET_VAULT_KMS_TOKEN: "ckms_app-ai-gateway_test",
    };

    const blob = await secretVault(config).encryptSecret("sk-kms-secret", CONTEXT);
    // A fresh vault for another env object: no data key cached from the seal.
    await expect(secretVault({ ...config }).decryptSecret(blob, CONTEXT)).resolves.toBe("sk-kms-secret");

    expect(blob).toMatch(/^cfkms-env1\./u);
    expect(calls.map((call) => call.url)).toEqual([
      "https://kms.example.test/v1/generate-data-key",
      "https://kms.example.test/v1/decrypt",
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer ckms_app-ai-gateway_test");
      expect(call.body.encryptionContext).toEqual(CONTEXT);
    }
  });
});

describe("key vault configuration", () => {
  it.each([
    [{}, { setting: "SECRET_VAULT_MODE", problem: "invalid" }],
    [{ SECRET_VAULT_MODE: "unknown" }, { setting: "SECRET_VAULT_MODE", problem: "invalid" }],
    [{ SECRET_VAULT_MODE: "kms" }, { setting: "SECRET_VAULT_KMS_URL", problem: "missing" }],
    [
      { SECRET_VAULT_MODE: "kms", SECRET_VAULT_KMS_URL: "https://kms.example.test" },
      { setting: "SECRET_VAULT_KMS_TOKEN", problem: "missing" },
    ],
    [
      { SECRET_VAULT_MODE: "kms", SECRET_VAULT_KMS_URL: "http://planted-kms-host.example.test", SECRET_VAULT_KMS_TOKEN: "planted-token" },
      { setting: "SECRET_VAULT_KMS_URL", problem: "invalid" },
    ],
    [{ SECRET_VAULT_MODE: "local" }, { setting: "SECRET_VAULT_LOCAL_KEK_V<n>", problem: "missing", kekVersion: 1 }],
    [
      { SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_V1: "not-base64" },
      { setting: "SECRET_VAULT_LOCAL_KEK_V<n>", problem: "invalid", kekVersion: 1 },
    ],
    [
      { SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_V1: "AAAA" },
      { setting: "SECRET_VAULT_LOCAL_KEK_V<n>", problem: "invalid", kekVersion: 1 },
    ],
    [
      { SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "2", SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1 },
      { setting: "SECRET_VAULT_LOCAL_KEK_V<n>", problem: "missing", kekVersion: 2 },
    ],
    [
      { SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "two", SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1 },
      { setting: "SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION", problem: "invalid" },
    ],
  ])("refuses configuration %#, logging the setting and never a value", (config, vault) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => secretVault(config)).toThrow(SecretVaultConfigurationError);
    const lines = errorSpy.mock.calls.flat().map((line) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({
      message: "secret_vault_misconfigured",
      error: expect.objectContaining({ class: "SecretVaultConfigurationError" }),
      vault,
    }));
    const logged = errorSpy.mock.calls.flat().join(" ");
    // The mode and the version number are not secret, and short enough to
    // appear in a timestamp; every other setting's value must never be logged.
    for (const [setting, value] of Object.entries(config)) {
      if (setting === "SECRET_VAULT_MODE" || setting === "SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION") continue;
      expect(logged).not.toContain(value);
    }
  });

  it("refuses settings that belong to the other mode", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => secretVault({
      SECRET_VAULT_MODE: "kms",
      SECRET_VAULT_KMS_URL: "https://kms.example.test",
      SECRET_VAULT_KMS_TOKEN: "token",
      SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1,
    })).toThrow("SECRET_VAULT_LOCAL_KEK_V1 is not allowed in kms mode");
    expect(() => secretVault({
      SECRET_VAULT_MODE: "local",
      SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1,
      SECRET_VAULT_KMS_TOKEN: "token",
    })).toThrow("SECRET_VAULT_KMS_TOKEN is not allowed in local mode");
  });

  it("refuses a blob made by the other mode before trying to open it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const local = secretVault({ SECRET_VAULT_MODE: "local", SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1 });
    const kms = secretVault({
      SECRET_VAULT_MODE: "kms",
      SECRET_VAULT_KMS_URL: "https://kms.example.test",
      SECRET_VAULT_KMS_TOKEN: "token",
    });

    await expect(local.decryptSecret("cfkms-env1.wrapped.iv.ciphertext", CONTEXT))
      .rejects.toBeInstanceOf(SecretVaultBlobError);
    await expect(kms.decryptSecret("local1.1.iv.ciphertext", CONTEXT))
      .rejects.toBeInstanceOf(SecretVaultBlobError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Stand-in ids, one per field the kind binds to, built from the table's own
 * arity so a kind added later is covered on the day it is added.
 */
function identity(kind: SecretKind, filler = "x"): string[] {
  return Array.from({ length: secretIdentityLength(kind) }, (_, index) => `${filler}-${index}`);
}

// cf-kms's limits on an encryption context, repeated on purpose: a test that
// imported them from the code under test would pass if that code loosened them.
const MAX_ENTRIES = 8;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 256;

describe("secret contexts", () => {
  it("covers at least one kind", () => {
    expect(SECRET_KINDS.length).toBeGreaterThan(0);
  });

  it.each(SECRET_KINDS)("binds %s to a context cf-kms accepts", (kind) => {
    const context = secretContext(kind, identity(kind) as never);
    // A cf-kms caller is pinned to this value, and a context without it is
    // refused as `unauthorized`, in kms mode only, which no test suite runs.
    expect(context.service).toBe("app-ai-gateway");
    const entries = Object.entries(context);
    expect(entries.length).toBeLessThanOrEqual(MAX_ENTRIES);
    for (const [key, value] of entries) {
      expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
      expect(key.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
      expect(value.length).toBeLessThanOrEqual(MAX_VALUE_LENGTH);
    }
  });

  it.each(SECRET_KINDS)("tells one %s from another", (kind) => {
    expect(secretContext(kind, identity(kind) as never))
      .not.toEqual(secretContext(kind, identity(kind, "other") as never));
  });

  it("gives every kind a context of its own", () => {
    const rendered = SECRET_KINDS.map((kind) => JSON.stringify(secretContext(kind, identity(kind) as never)));
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("refuses an id too long for a context value", () => {
    const kind = SECRET_KINDS[0]!;
    const oversized = identity(kind).map(() => "z".repeat(MAX_VALUE_LENGTH + 1));
    expect(() => secretContext(kind, oversized as never)).toThrow(SecretVaultConfigurationError);
  });
});

describe("sealed secrets", () => {
  it.each(SECRET_KINDS)("opens a sealed %s under the same identity", async (kind) => {
    const ids = identity(kind) as never;
    const blob = await sealSecret(env, kind, ids, "secret-value");
    await expect(openSecret(env, kind, ids, blob)).resolves.toBe("secret-value");
  });

  it.each(SECRET_KINDS)("will not open a %s under another identity", async (kind) => {
    const blob = await sealSecret(env, kind, identity(kind) as never, "secret-value");
    await expect(openSecret(env, kind, identity(kind, "other") as never, blob)).rejects.toThrow();
  });

  it("refuses a provider key moved to another account, type or destination", async () => {
    const original = ["account-a", "conn-a", "custom", "https://first.example.test/v1/", "x-my-key", "{key}"] as const;
    const blob = await sealSecret(env, "providerKey", [...original], "secret-value");
    for (const changed of [
      ["account-b", original[1], original[2], original[3], original[4], original[5]],
      [original[0], original[1], "anthropic", original[3], original[4], original[5]],
      [original[0], original[1], original[2], "https://second.example.test/v1/", original[4], original[5]],
      // A custom key's placement is sealed too: another header or format does not open it.
      [original[0], original[1], original[2], original[3], "origin", original[5]],
      [original[0], original[1], original[2], original[3], original[4], "Bearer {key}"],
    ] as const) {
      await expect(openSecret(env, "providerKey", [...changed], blob)).rejects.toThrow();
    }
  });
});
