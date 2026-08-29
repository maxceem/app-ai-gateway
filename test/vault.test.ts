import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import {
  SecretVaultBlobError,
  SecretVaultConfigurationError,
  secretVault,
} from "../src/vault";

const TEST_KEK_V1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TEST_KEK_V2 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const DATA_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CONTEXT = {
  service: "app-ai-gateway",
  organizationId: "org_test",
  providerId: "provider_test",
};

afterEach(() => vi.restoreAllMocks());

describe("local secret vault", () => {
  it("encrypts with the current version and binds ciphertext to its context", async () => {
    const vault = secretVault({
      SECRET_VAULT_MODE: "local",
      SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "2",
      SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1,
      SECRET_VAULT_LOCAL_KEK_V2: TEST_KEK_V2,
    });

    const blob = await vault.encryptSecret("sk-local-secret", CONTEXT);
    expect(blob).toMatch(/^local1\.2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    await expect(vault.decryptSecret(blob, CONTEXT)).resolves.toBe("sk-local-secret");
    await expect(vault.decryptSecret(blob, { ...CONTEXT, providerId: "other" }))
      .rejects.toThrow("decrypt failed");
  });

  it("keeps older KEK versions available for decryption", async () => {
    const oldVault = secretVault({
      SECRET_VAULT_MODE: "local",
      SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1,
    });
    const blob = await oldVault.encryptSecret("rotated-later", CONTEXT);
    const rotatedVault = secretVault({
      SECRET_VAULT_MODE: "local",
      SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "2",
      SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1,
      SECRET_VAULT_LOCAL_KEK_V2: TEST_KEK_V2,
    });

    await expect(rotatedVault.decryptSecret(blob, CONTEXT)).resolves.toBe("rotated-later");
  });
});

describe("kms secret vault", () => {
  it("uses the real envelope client against a wrap and unwrap stub", async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, headers: new Headers(init?.headers), body });
      if (url.endsWith("/v1/generate-data-key")) {
        return Response.json({
          plaintextKey: DATA_KEY,
          wrappedKey: "cfkms1.1.test-wrapped-key",
          kekVersion: 1,
        });
      }
      return Response.json({ plaintextKey: DATA_KEY, kekVersion: 1 });
    });
    const config = {
      SECRET_VAULT_MODE: "kms",
      SECRET_VAULT_KMS_URL: "https://kms.example.test",
      SECRET_VAULT_KMS_TOKEN: "ckms_ai-gateway_test",
    };

    const blob = await secretVault(config).encryptSecret("sk-kms-secret", CONTEXT);
    const coldVault = secretVault({ ...config });
    await expect(coldVault.decryptSecret(blob, CONTEXT)).resolves.toBe("sk-kms-secret");

    expect(blob).toMatch(/^cfkms-env1\./u);
    expect(calls.map((call) => call.url)).toEqual([
      "https://kms.example.test/v1/generate-data-key",
      "https://kms.example.test/v1/decrypt",
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer ckms_ai-gateway_test");
      expect(call.body.encryptionContext).toEqual(CONTEXT);
    }
  });
});

describe("secret vault validation", () => {
  it.each([
    [{}, "SECRET_VAULT_MODE"],
    [{ SECRET_VAULT_MODE: "unknown" }, "SECRET_VAULT_MODE"],
    [{ SECRET_VAULT_MODE: "kms" }, "SECRET_VAULT_KMS_URL"],
    [{
      SECRET_VAULT_MODE: "kms",
      SECRET_VAULT_KMS_URL: "https://kms.example.test",
    }, "SECRET_VAULT_KMS_TOKEN"],
    [{ SECRET_VAULT_MODE: "local" }, "SECRET_VAULT_LOCAL_KEK_V1"],
    [{
      SECRET_VAULT_MODE: "local",
      SECRET_VAULT_LOCAL_KEK_V1: "not-base64",
    }, "SECRET_VAULT_LOCAL_KEK_V1"],
    [{
      SECRET_VAULT_MODE: "local",
      SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "2",
      SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1,
    }, "SECRET_VAULT_LOCAL_KEK_V2"],
  ])("fails loudly for invalid configuration %#", (config, binding) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => secretVault(config)).toThrow(SecretVaultConfigurationError);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain(binding);
  });

  it("rejects variables from the other vault mode", () => {
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

  it("rejects a blob produced by the other mode before attempting decryption", async () => {
    const local = secretVault({
      SECRET_VAULT_MODE: "local",
      SECRET_VAULT_LOCAL_KEK_V1: TEST_KEK_V1,
    });
    const kms = secretVault({
      SECRET_VAULT_MODE: "kms",
      SECRET_VAULT_KMS_URL: "https://kms.example.test",
      SECRET_VAULT_KMS_TOKEN: "token",
    });

    await expect(local.decryptSecret("cfkms-env1.wrapped.iv.ciphertext", CONTEXT))
      .rejects.toBeInstanceOf(SecretVaultBlobError);
    await expect(kms.decryptSecret("local1.1.iv.ciphertext", CONTEXT))
      .rejects.toBeInstanceOf(SecretVaultBlobError);
  });

  it("reports a broken vault without exposing configuration details in health", async () => {
    const response = await app.fetch(
      new Request("https://example.test/v1/healthz"),
      { ...env, SECRET_VAULT_LOCAL_KEK_V1: "invalid" },
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "ai-gateway",
      vault: "misconfigured",
    });
  });
});
