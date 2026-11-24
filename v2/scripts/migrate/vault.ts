/**
 * Moves sealed secrets from v1's vault to v2's, in memory only.
 *
 * Each side is a vault configuration, read from a file in the format of
 * `.dev.vars`: `SECRET_VAULT_MODE` and that mode's settings. v1's local vault
 * and its contexts are the same as v2's, apart from the names of the ids a
 * context binds, so v2's vault code opens v1's blobs under v1's contexts.
 */
import { readFileSync } from "node:fs";
import { secretVault } from "../../src/vault/index.ts";
import { secretContext } from "../../src/vault/secrets.ts";
import { SecretVaultBlobError, VAULT_SERVICE, type SecretVaultContext } from "../../src/vault/types.ts";
import { SecretDoesNotOpen, type Resealer, type V1Sealed } from "./settings.ts";

/** A vault configuration file: `NAME=value` lines, `#` comments, values optionally quoted. Only `SECRET_VAULT_*` names are kept. */
export function readVaultFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/u.exec(line);
    if (match === null) throw new Error(`${path}: a line is not NAME=value`);
    const [, name, value] = match as unknown as [string, string, string];
    if (!name.startsWith("SECRET_VAULT_")) continue;
    env[name] = /^(["']).*\1$/u.test(value) ? value.slice(1, -1) : value;
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
  const v2 = secretVault(v2Env);
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
      return await (to.kind === "providerKey"
        ? v2.encryptSecret(secret, secretContext("providerKey", [...to.identity]))
        : v2.encryptSecret(secret, secretContext("cloudflareGatewayToken", [...to.identity])));
    } catch (error) {
      throw new Error(`v2's vault could not seal a secret: ${(error as Error).message}`, { cause: error });
    }
  };
}
