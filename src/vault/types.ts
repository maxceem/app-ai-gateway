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

export class SecretVaultConfigurationError extends Error {
  constructor(message: string) {
    super(`secret vault: ${message}`);
    this.name = "SecretVaultConfigurationError";
  }
}

export class SecretVaultBlobError extends Error {
  constructor(message: string) {
    super(`secret vault: ${message}`);
    this.name = "SecretVaultBlobError";
  }
}
