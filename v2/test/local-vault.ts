/**
 * The vault Worker's own modules (`v2/vault/src/`), run in this Worker for
 * the tests (`setVaultForTests`): the same code the `VAULT` binding runs, so
 * a test's fetch stand-in sees exactly what the vault sends. A test also runs
 * them through the real binding (`vault-binding.test.ts`).
 *
 * The vault's settings are its own (`TEST_VAULT_ENV`), never the gateway's:
 * the gateway Worker holds no vault secret (plan step 8i), in the tests too.
 */
import { callProvider, holds, storeCopy } from "../vault/src/call.js";
import { reseal, seal, vaultStatus } from "../vault/src/seal.js";
import { credentialMatches } from "../vault/src/split.js";
import { vaultAnswer, type VaultClient } from "../src/vault/client.ts";

/** The test vault's settings: local mode, a test-only key of 32 zero bytes, as `vitest.config.ts` gives the vault Worker. */
export const TEST_VAULT_ENV: Readonly<Record<string, string>> = Object.freeze({
  SECRET_VAULT_MODE: "local",
  SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION: "1",
  SECRET_VAULT_LOCAL_KEK_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
});

export function localVault(_env: Env): VaultClient {
  const vaultEnv = TEST_VAULT_ENV as Record<string, unknown>;
  return {
    seal: (kind, identity, plaintext, rootPublicKey) => seal(vaultEnv, kind, [...identity], plaintext, rootPublicKey),
    storeCopy: (credentials, expiresAt) => storeCopy(vaultEnv, credentials, expiresAt) as never,
    reseal: (kind, from, to, blob) => reseal(vaultEnv, kind, [...from], [...to], blob),
    call: async (input) => vaultAnswer(await callProvider(vaultEnv, input)),
    holds: (credentials, texts) => holds(vaultEnv, credentials, [...texts]),
    credentialMatches: (secret, publicKey) => credentialMatches(secret, publicKey),
    status: () => Promise.resolve(vaultStatus(vaultEnv)),
  };
}
