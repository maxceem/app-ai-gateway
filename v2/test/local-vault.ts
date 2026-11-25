/**
 * The vault Worker's own modules (`v2/vault/src/`), run in this Worker for
 * the tests (`setVaultForTests`): the same code the `VAULT` binding runs, so
 * a test's fetch stand-in sees exactly what the vault sends. A test also runs
 * them through the real binding (`vault-binding.test.ts`).
 */
import { callProvider, holds } from "../vault/src/call.js";
import { reseal, seal } from "../vault/src/seal.js";
import { vaultAnswer, type VaultClient } from "../src/vault/client.ts";

export function localVault(env: Env): VaultClient {
  const vaultEnv = env as unknown as Record<string, unknown>;
  return {
    seal: (kind, identity, plaintext) => seal(vaultEnv, kind, [...identity], plaintext),
    reseal: (kind, from, to, blob) => reseal(vaultEnv, kind, [...from], [...to], blob),
    call: async (input) => vaultAnswer(await callProvider(vaultEnv, input)),
    holds: (credentials, texts) => holds(vaultEnv, credentials, [...texts]),
  };
}
