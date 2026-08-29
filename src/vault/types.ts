export type SecretVaultMode = "kms" | "local";

export interface SecretVaultContext {
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
