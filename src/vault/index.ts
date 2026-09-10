import { KmsClientError } from "@maxceem/cf-kms/client";
import { log } from "../core/log";
import { createKmsSecretVault } from "./kms";
import { createLocalSecretVault } from "./local";
import {
  SecretVaultBlobError,
  SecretVaultConfigurationError,
  type SecretVault,
  type SecretVaultMode,
} from "./types";

export type { SecretVault, SecretVaultContext, SecretVaultMode } from "./types";
export { SecretVaultBlobError, SecretVaultConfigurationError } from "./types";

const vaultByEnv = new WeakMap<object, SecretVault>();

function requiredString(
  env: Record<string, unknown>,
  binding: string,
  mode: SecretVaultMode,
): string {
  const value = env[binding];
  if (typeof value !== "string" || value.trim() === "") {
    throw new SecretVaultConfigurationError(`${binding} is required in ${mode} mode`);
  }
  return value.trim();
}

function rejectMixedBindings(
  env: Record<string, unknown>,
  prefix: string,
  mode: SecretVaultMode,
): void {
  const binding = Object.keys(env).find((name) => name.startsWith(prefix));
  if (binding) {
    throw new SecretVaultConfigurationError(`${binding} is not allowed in ${mode} mode`);
  }
}

function createVault(envObject: object): SecretVault {
  const env = envObject as Record<string, unknown>;
  const mode = env.SECRET_VAULT_MODE;
  if (mode !== "kms" && mode !== "local") {
    throw new SecretVaultConfigurationError("SECRET_VAULT_MODE must be either kms or local");
  }
  if (mode === "kms") {
    rejectMixedBindings(env, "SECRET_VAULT_LOCAL_", mode);
    return createKmsSecretVault(
      envObject,
      requiredString(env, "SECRET_VAULT_KMS_URL", mode),
      requiredString(env, "SECRET_VAULT_KMS_TOKEN", mode),
    );
  }
  rejectMixedBindings(env, "SECRET_VAULT_KMS_", mode);
  return createLocalSecretVault(env);
}

export function secretVault(env: unknown): SecretVault {
  if (typeof env !== "object" || env === null) {
    throw new SecretVaultConfigurationError("env must be an object");
  }
  const cached = vaultByEnv.get(env);
  if (cached) return cached;
  try {
    const vault = createVault(env);
    vaultByEnv.set(env, vault);
    return vault;
  } catch (error) {
    log("error", "secret_vault_misconfigured", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * cf-kms codes for a decrypt that will keep failing until something is fixed:
 * the envelope does not open under its context, the caller token is refused,
 * the blob is malformed. Everything else the client can throw — a network
 * error, `request_failed`, `invalid_response`, a 5xx — says the deployment is
 * unreachable, which the next attempt may well survive.
 */
const KMS_CONFIGURATION_CODES = new Set(["decrypt_failed", "unauthorized", "invalid_envelope"]);

/**
 * Whether a decrypt failed because the vault could not be reached, rather than
 * because the deployment's own configuration is wrong: the blob, the mode, the
 * encryption context, the caller credential, or bindings this vault cannot even
 * be constructed from.
 *
 * Callers may serve a last-known plaintext through an outage; serving one
 * through a configuration fault would hide the fault instead — a deploy that
 * dropped its KEK or its cf-kms token has to fail loudly rather than keep
 * answering from an isolate's memory for an hour.
 */
export function isVaultTransportFailure(error: unknown): boolean {
  if (error instanceof SecretVaultBlobError) return false;
  if (error instanceof SecretVaultConfigurationError) return false;
  if (error instanceof KmsClientError) return !KMS_CONFIGURATION_CODES.has(error.code);
  return true;
}

export function vaultStatus(env: unknown): "ok" | "misconfigured" {
  try {
    secretVault(env);
    return "ok";
  } catch {
    return "misconfigured";
  }
}
