import { randomBytes, randomUUID } from "node:crypto";

export function deploymentVersionIds(output) {
  const deployments = JSON.parse(output);
  if (!Array.isArray(deployments)) throw new Error("Unexpected Wrangler deployment list");
  if (deployments.length === 0) return [];
  if (deployments.some((d) => typeof d?.created_on !== "string" || !Number.isFinite(Date.parse(d.created_on)))) {
    throw new Error("Unexpected Wrangler deployment dates");
  }
  const latest = deployments.reduce((a, b) => Date.parse(a.created_on) >= Date.parse(b.created_on) ? a : b);
  const versions = latest.versions;
  if (!Array.isArray(versions) || versions.length === 0
    || versions.some((v) => typeof v?.version_id !== "string" || !v.version_id)) {
    throw new Error("Unexpected Wrangler deployment versions");
  }
  return [...new Set(versions.map((v) => v.version_id))];
}

export function deploymentIdFromVersion(output) {
  const bindings = JSON.parse(output)?.resources?.bindings;
  if (!Array.isArray(bindings)) throw new Error("Unexpected Wrangler version bindings");
  const binding = bindings.find((b) => b.name === "DEPLOYMENT_ID");
  if (!binding) return undefined;
  if (binding.type !== "plain_text" || typeof binding.text !== "string") {
    throw new Error("The deployed DEPLOYMENT_ID must be a plain-text binding");
  }
  // Older installations can have the original empty placeholder.
  return binding.text || undefined;
}

export function resolveDeploymentId(existingIds, configured, local, generate = randomUUID) {
  const unique = new Set(existingIds);
  if (unique.size > 1) {
    throw new Error("Active Worker versions disagree on DEPLOYMENT_ID; resolve this before deploying");
  }
  const existing = existingIds[0];
  if (existing && configured && existing !== configured) {
    throw new Error("Configured DEPLOYMENT_ID differs from the deployed identity; preserve the deployed value");
  }
  // A local development identity must never replace an established deployment.
  const id = existing || configured || local || generate();
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    throw new Error("Invalid DEPLOYMENT_ID: expected 8–128 letters, digits, underscores or hyphens");
  }
  return id;
}

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
