import { log } from "../core/log";
import { createKmsSecretVault } from "./kms";
import { createLocalSecretVault } from "./local";
import {
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

export function vaultStatus(env: unknown): "ok" | "misconfigured" {
  try {
    secretVault(env);
    return "ok";
  } catch {
    return "misconfigured";
  }
}
