import {
  SecretVaultBlobError,
  SecretVaultConfigurationError,
  type SecretVault,
  type SecretVaultContext,
} from "./types";

const KEK_PREFIX = "SECRET_VAULT_LOCAL_KEK_";
const KEK_PATTERN = /^SECRET_VAULT_LOCAL_KEK_V([1-9][0-9]{0,3})$/u;
const CURRENT_VERSION = "SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION";
const LOCAL_BLOB_PREFIX = "local1";
const IV_BYTES = 12;
const KEK_BYTES = 32;

const importedKeks = new Map<string, Promise<CryptoKey>>();

function decodeBase64(value: string, binding: string): Uint8Array<ArrayBuffer> {
  const material = value.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(material)) {
    throw new SecretVaultConfigurationError(`${binding} is not valid base64`);
  }
  let binary: string;
  try {
    binary = atob(material);
  } catch {
    throw new SecretVaultConfigurationError(`${binding} is not valid base64`);
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.length !== KEK_BYTES) {
    throw new SecretVaultConfigurationError(`${binding} must decode to ${KEK_BYTES} bytes`);
  }
  return bytes;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new SecretVaultBlobError("invalid local blob");
  const padded = value
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new SecretVaultBlobError("invalid local blob");
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function contextAad(context: SecretVaultContext): Uint8Array<ArrayBuffer> {
  const entries = Object.entries(context).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return new Uint8Array(new TextEncoder().encode(JSON.stringify(Object.fromEntries(entries))));
}

function importKek(material: string, binding: string): Promise<CryptoKey> {
  const cached = importedKeks.get(material);
  if (cached) return cached;
  const imported = crypto.subtle
    .importKey("raw", decodeBase64(material, binding), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
    .catch((error: unknown) => {
      importedKeks.delete(material);
      throw error;
    });
  importedKeks.set(material, imported);
  return imported;
}

function currentVersion(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,3}$/u.test(value.trim())) {
    throw new SecretVaultConfigurationError(`${CURRENT_VERSION} must be a positive integer string`);
  }
  return Number(value.trim());
}

export function createLocalSecretVault(env: Record<string, unknown>): SecretVault {
  const materials = new Map<number, { binding: string; material: string }>();
  for (const [binding, value] of Object.entries(env)) {
    if (!binding.startsWith(KEK_PREFIX) || binding === CURRENT_VERSION) continue;
    const match = KEK_PATTERN.exec(binding);
    if (!match?.[1]) {
      throw new SecretVaultConfigurationError(`${binding} is not a valid local KEK secret name`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new SecretVaultConfigurationError(`${binding} must be a non-empty base64 string`);
    }
    const material = value.trim();
    decodeBase64(material, binding);
    materials.set(Number(match[1]), { binding, material });
  }
  if (!materials.has(1)) {
    throw new SecretVaultConfigurationError("SECRET_VAULT_LOCAL_KEK_V1 is required in local mode");
  }
  const selectedVersion = currentVersion(env[CURRENT_VERSION]);
  if (!materials.has(selectedVersion)) {
    throw new SecretVaultConfigurationError(
      `${CURRENT_VERSION} is ${selectedVersion} but SECRET_VAULT_LOCAL_KEK_V${selectedVersion} is not set`,
    );
  }

  const key = async (version: number): Promise<CryptoKey> => {
    const entry = materials.get(version);
    if (!entry) throw new SecretVaultBlobError("local blob uses an unavailable KEK version");
    return importKek(entry.material, entry.binding);
  };

  return {
    mode: "local",
    encryptSecret: async (plaintext, context) => {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: contextAad(context) },
        await key(selectedVersion),
        new TextEncoder().encode(plaintext),
      ));
      return `${LOCAL_BLOB_PREFIX}.${selectedVersion}.${encodeBase64Url(iv)}.${encodeBase64Url(ciphertext)}`;
    },
    decryptSecret: async (blob, context) => {
      const parts = blob.split(".");
      if (parts.length !== 4 || parts[0] !== LOCAL_BLOB_PREFIX) {
        throw new SecretVaultBlobError("blob was not encrypted in local mode");
      }
      const version = Number(parts[1]);
      const ivPart = parts[2];
      const ciphertextPart = parts[3];
      if (!Number.isInteger(version) || version <= 0 || !ivPart || !ciphertextPart) {
        throw new SecretVaultBlobError("invalid local blob");
      }
      const iv = decodeBase64Url(ivPart);
      if (iv.length !== IV_BYTES) throw new SecretVaultBlobError("invalid local blob");
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: contextAad(context) },
          await key(version),
          decodeBase64Url(ciphertextPart),
        );
        return new TextDecoder().decode(plaintext);
      } catch (error) {
        if (error instanceof SecretVaultBlobError) throw error;
        throw new SecretVaultBlobError("decrypt failed");
      }
    },
  };
}
