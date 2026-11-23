import { createKmsClient, type KmsClient } from "@maxceem/cf-kms/client";
import { SecretVaultBlobError, type SecretVault } from "./types.ts";

const clients = new WeakMap<object, KmsClient>();

/**
 * How long one call to cf-kms may take to answer. Well inside the 120 s a
 * request's key may take to open: a cf-kms that hangs becomes a timeout, which
 * counts as the vault being unreachable, so a key that D1 confirms is still
 * current can serve from its last copy instead of the request hanging.
 */
export const KMS_CALL_DEADLINE_MS = 5_000;

/** `fetch` that gives up after `deadlineMs`, with a `TimeoutError`, once the answer's headers are late. */
export function fetchWithDeadline(deadlineMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("cf-kms did not answer in time", "TimeoutError")), deadlineMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createKmsSecretVault(
  env: object,
  url: string,
  token: string,
  deadlineMs: number = KMS_CALL_DEADLINE_MS,
): SecretVault {
  let client = clients.get(env);
  if (!client) {
    client = createKmsClient({ url, token, cacheTtlMs: 300_000, fetch: fetchWithDeadline(deadlineMs) });
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
