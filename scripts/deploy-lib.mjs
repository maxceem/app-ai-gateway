import { randomBytes } from "node:crypto";

export const REQUIRED_USER_SECRETS = [
  "CF_AIG_GATEWAY_ID",
  "CF_AIG_TOKEN",
  "SECRET_VAULT_LOCAL_KEK_V1",
];

export function parseSecretList(output) {
  const parsed = JSON.parse(output.trim());
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry?.name !== "string")) {
    throw new Error("Wrangler returned an unexpected secret list");
  }
  return new Set(parsed.map((entry) => entry.name));
}

export function missingRequiredSecrets(existingNames) {
  return REQUIRED_USER_SECRETS.filter((name) => !existingNames.has(name));
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
