/**
 * Moves sealed secrets from v1's vault to v2's, in memory only.
 *
 * Each side is a vault configuration, read from a file in the format of
 * `.dev.vars`: `SECRET_VAULT_MODE` and that mode's settings.
 *
 * - v1's blobs are opened with the gateway's own vault code
 *   (`src/vault/index.ts`), under v1's contexts: v1 names the ids a context
 *   binds differently, and the vault Worker opens only v2's.
 * - v2's blobs are sealed by the vault Worker's own module
 *   (`vault/src/seal.js`), so what the script writes is exactly what the
 *   deployed vault opens.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { secretVault } from "../../src/vault/index.ts";
import { SecretVaultBlobError, VAULT_SERVICE, type SecretVaultContext } from "../../src/vault/types.ts";
import { seal, vaultStatus } from "../../vault/src/seal.js";
import { SecretDoesNotOpen, type Resealer, type V1Sealed } from "./settings.ts";

/**
 * A vault configuration file, read as dotenv, the way the secrets upload
 * reads `.dev.vars` (`node:util`'s `parseEnv`): comments after a value,
 * quotes and `export` are understood. Only `SECRET_VAULT_*` names are kept.
 */
export function readVaultFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (name.startsWith("SECRET_VAULT_") && value !== undefined) env[name] = value;
  }
  return env;
}

/** v1's contexts, as v1's `src/vault/secrets.ts` writes them. */
function v1Context(sealed: V1Sealed): SecretVaultContext {
  const ids: Record<string, string> =
    sealed.kind === "providerKey"
      ? { organizationId: sealed.identity[0], providerId: sealed.identity[1], providerType: sealed.identity[2], baseUrl: sealed.identity[3] }
      : { organizationId: sealed.identity[0], providerGatewayId: sealed.identity[1] };
  return { ...ids, service: VAULT_SERVICE };
}

/**
 * Opens with v1's vault, seals with v2's. A vault that cannot be built throws
 * here, before anything is read.
 *
 * Only a blob that does not open under its row's context is that row's
 * problem (`SecretDoesNotOpen`): the row is left out and reported. Anything
 * else (a missing key version, cf-kms out of reach, v2's vault refusing to
 * seal) is the run's problem, and stops it before anything is written.
 */
export function vaultResealer(v1Env: Record<string, string>, v2Env: Record<string, string>): Resealer {
  const v1 = secretVault(v1Env);
  // The vault Worker's check, so v2's file is refused here as the deployed vault would refuse it.
  if (vaultStatus(v2Env) !== "ok") throw new Error("v2's vault settings are incomplete or disagree: SECRET_VAULT_MODE and only that mode's settings");
  return async (blob, from, to) => {
    let secret: string;
    try {
      secret = await v1.decryptSecret(blob, v1Context(from));
    } catch (error) {
      // A version the v1 vault file lacks is the file's fault, not the row's.
      if (error instanceof SecretVaultBlobError && !error.message.includes("unavailable KEK version")) throw new SecretDoesNotOpen(error.message);
      throw new Error(`v1's vault could not open a secret: ${(error as Error).message}`, { cause: error });
    }
    try {
      return await seal(v2Env, to.kind, [...to.identity], secret);
    } catch (error) {
      throw new Error(`v2's vault could not seal a secret: ${(error as Error).message}`, { cause: error });
    }
  };
}
