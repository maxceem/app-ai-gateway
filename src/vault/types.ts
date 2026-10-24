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
 * What a configuration problem is about, as constants a log line can name
 * without copying the message. A local KEK is named by its `kekVersion`
 * beside the `SECRET_VAULT_LOCAL_KEK_V<n>` family.
 */
export type SecretVaultSetting =
  | "env"
  | "SECRET_VAULT_MODE"
  | "SECRET_VAULT_KMS_URL"
  | "SECRET_VAULT_KMS_TOKEN"
  | "SECRET_VAULT_KMS_*"
  | "SECRET_VAULT_LOCAL_*"
  | "SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION"
  | "SECRET_VAULT_LOCAL_KEK_V<n>"
  | "context";

export type SecretVaultProblem = "missing" | "not_allowed" | "invalid";

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
