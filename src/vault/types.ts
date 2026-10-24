export type SecretVaultMode = "kms" | "local";

/**
 * The caller identity every encryption context carries.
 *
 * It does no cryptographic work: it is the same on every blob, so it separates
 * nothing that `organizationId` and the resource id do not already separate. It
 * is here because a cf-kms deployment pins its caller to it through
 * `requiredContext` — see the configuration guide — and refuses, as
 * `unauthorized`, any request whose context omits it. Required by the type so
 * that omitting it fails `pnpm run check` rather than a deployment running
 * `kms` mode, which is how it was first found.
 */
export const VAULT_SERVICE = "app-ai-gateway";

export interface SecretVaultContext {
  readonly service: typeof VAULT_SERVICE;
  readonly [key: string]: string;
}

export interface SecretVault {
  readonly mode: SecretVaultMode;
  encryptSecret(plaintext: string, context: SecretVaultContext): Promise<string>;
  decryptSecret(blob: string, context: SecretVaultContext): Promise<string>;
}

/**
 * What a configuration problem is about, spelled as constants so a log line
 * can name it: the message also names the binding, but a log copies no text
 * an error carries. A local KEK is named by its `kekVersion` beside the
 * `SECRET_VAULT_LOCAL_KEK_V<n>` family.
 */
export const SECRET_VAULT_SETTINGS = [
  "env",
  "SECRET_VAULT_MODE",
  "SECRET_VAULT_KMS_URL",
  "SECRET_VAULT_KMS_TOKEN",
  "SECRET_VAULT_KMS_*",
  "SECRET_VAULT_LOCAL_*",
  "SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION",
  "SECRET_VAULT_LOCAL_KEK_V<n>",
  "context",
] as const;
export type SecretVaultSetting = (typeof SECRET_VAULT_SETTINGS)[number];

export const SECRET_VAULT_PROBLEMS = ["missing", "not_allowed", "invalid"] as const;
export type SecretVaultProblem = (typeof SECRET_VAULT_PROBLEMS)[number];

export interface SecretVaultConfigurationDetail {
  setting: SecretVaultSetting;
  problem: SecretVaultProblem;
  kekVersion?: number;
}

export class SecretVaultConfigurationError extends Error {
  readonly setting: SecretVaultSetting;
  readonly problem: SecretVaultProblem;
  readonly kekVersion?: number;

  constructor(message: string, detail: SecretVaultConfigurationDetail) {
    super(`secret vault: ${message}`);
    this.name = "SecretVaultConfigurationError";
    this.setting = detail.setting;
    this.problem = detail.problem;
    if (detail.kekVersion !== undefined) this.kekVersion = detail.kekVersion;
  }
}

export class SecretVaultBlobError extends Error {
  constructor(message: string) {
    super(`secret vault: ${message}`);
    this.name = "SecretVaultBlobError";
  }
}
