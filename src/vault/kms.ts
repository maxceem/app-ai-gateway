import { createKmsClient, type KmsClient } from "@maxceem/cf-kms/client";
import { SecretVaultBlobError, type SecretVault } from "./types";

const clients = new WeakMap<object, KmsClient>();

export function createKmsSecretVault(
  env: object,
  url: string,
  token: string,
): SecretVault {
  let client = clients.get(env);
  if (!client) {
    client = createKmsClient({ url, token, cacheTtlMs: 300_000 });
    clients.set(env, client);
  }
  return {
    mode: "kms",
    encryptSecret: (plaintext, context) => client.encryptSecret(plaintext, context),
    decryptSecret: async (blob, context) => {
      if (!blob.startsWith("cfkms-env1.")) {
        throw new SecretVaultBlobError("blob was not encrypted in kms mode");
      }
      return client.decryptSecret(blob, context);
    },
  };
}
