import { randomBytes } from "node:crypto";

export const REQUIRED_USER_SECRETS = ["SECRET_VAULT_LOCAL_KEK_V1"];

export function parseSecretList(output) {
  const parsed = JSON.parse(output.trim());
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry?.name !== "string")) {
    throw new Error("Wrangler returned an unexpected secret list");
  }
  return new Set(parsed.map((entry) => entry.name));
}

/**
 * The operator-supplied secrets a deployment cannot start without, derived from
 * the vault mode in the resolved Wrangler configuration's `vars`.
 */
export function requiredUserSecrets(config) {
  const vars = config?.vars ?? {};
  if (vars.SECRET_VAULT_MODE === "kms") {
    return ["SECRET_VAULT_KMS_URL", "SECRET_VAULT_KMS_TOKEN"];
  }
  const version = String(vars.SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION ?? "1");
  return [`SECRET_VAULT_LOCAL_KEK_V${version}`];
}

export function missingRequiredSecrets(existingNames, required = REQUIRED_USER_SECRETS) {
  return required.filter((name) => !existingNames.has(name));
}

export function createMissingGeneratedSecrets(existingNames, random = randomBytes) {
  const secrets = {};

  if (!existingNames.has("JWT_SECRET")) {
    secrets.JWT_SECRET = random(48).toString("base64url");
  }
  if (!existingNames.has("BETTER_AUTH_SECRET")) {
    secrets.BETTER_AUTH_SECRET = random(48).toString("base64url");
  }

  return secrets;
}
