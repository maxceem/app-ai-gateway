// @ts-check
/**
 * Sealing and opening provider credentials, with no npm packages.
 *
 * A sealed blob is AES-GCM under a key-encryption key (KEK) held only in this
 * Worker's secrets. Its additional data is the context the blob is bound to:
 * the account, the connection, and where the credential may be sent. A blob
 * moved to another row, or asked to open for another address, does not open.
 *
 * The format is the one the gateway used before the vault Worker existed:
 * `local1.<kek version>.<iv>.<ciphertext>`, base64url, with the context as
 * JSON with sorted keys. So a blob sealed by either side opens on the other.
 *
 * In `kms` mode the KEK lives in a cf-kms deployment instead
 * (`SECRET_VAULT_KMS_URL`, `SECRET_VAULT_KMS_TOKEN`), and a blob is cf-kms's
 * envelope (`./kms.js`), with the same context as additional data.
 */
import { ENVELOPE_PREFIX, KmsError, createKmsClient, secureKmsUrl } from "./kms.js";

/** @typedef {{ readonly [name: string]: unknown }} VaultEnv */

/** The caller identity every context carries; see `v2/src/vault/types.ts`. */
export const VAULT_SERVICE = "app-ai-gateway";

/**
 * Every kind of credential and the names of the ids it is bound to, in order.
 * The gateway's own table (`v2/src/vault/secrets.ts`) must name the same, and
 * a test checks that it does.
 *
 * - `providerKey`: the account, the connection, the provider type, the
 *   address the key may go to (a base URL, a Cloudflare AI Gateway path, or
 *   "" for the provider's own hosts, `./hosts.js`), and, for a custom
 *   provider, the header and format its key is sent in, fixed when it was
 *   saved ("" for a built-in type, whose headers `./hosts.js` lists).
 * - `cloudflareGatewayToken`: the account, the connection, and the Cloudflare
 *   account and gateway the token may go to.
 */
export const CONTEXT_NAMES = /** @type {const} */ ({
  providerKey: ["accountId", "connectionId", "providerType", "baseUrl", "keyHeader", "keyFormat"],
  cloudflareGatewayToken: ["accountId", "connectionId", "gatewayAccountId", "gatewayId"],
});

/** @typedef {keyof typeof CONTEXT_NAMES} SecretKind */

const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 256;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

/** A problem with this Worker's own settings: never caused by a caller. */
export class VaultConfigurationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(`vault: ${message}`);
    this.name = "VaultConfigurationError";
  }
}

/** A blob or an identity that cannot be used: it does not open, or is malformed. */
export class VaultBlobError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(`vault: ${message}`);
    this.name = "VaultBlobError";
  }
}

/**
 * The context a credential of `kind` is sealed and opened under.
 * @param {string} kind
 * @param {unknown} identity
 * @returns {Record<string, string>}
 */
export function secretContext(kind, identity) {
  if (kind !== "providerKey" && kind !== "cloudflareGatewayToken") throw new VaultBlobError("unknown credential kind");
  const names = CONTEXT_NAMES[kind];
  if (!Array.isArray(identity) || identity.length !== names.length || !identity.every((id) => typeof id === "string")) {
    throw new VaultBlobError("identity does not match its kind");
  }
  /** @type {Record<string, string>} */
  const context = {};
  names.forEach((name, index) => {
    const value = /** @type {string} */ (identity[index]);
    if (name.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(name) || value.length > MAX_VALUE_LENGTH) {
      throw new VaultBlobError("identity is not usable");
    }
    context[name] = value;
  });
  context.service = VAULT_SERVICE;
  return context;
}

const KEK_PREFIX = "SECRET_VAULT_LOCAL_KEK_";
const KEK_PATTERN = /^SECRET_VAULT_LOCAL_KEK_V([1-9][0-9]{0,3})$/u;
const CURRENT_VERSION = "SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION";
const BLOB_PREFIX = "local1";
const IV_BYTES = 12;
const KEK_BYTES = 32;

/** @param {string} value @returns {Uint8Array<ArrayBuffer>} */
function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** @param {string} value @returns {Uint8Array<ArrayBuffer>} */
function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new VaultBlobError("invalid blob");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  try {
    return fromBase64(padded);
  } catch {
    throw new VaultBlobError("invalid blob");
  }
}

/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

/** @param {Record<string, string>} context */
function additionalData(context) {
  const entries = Object.entries(context).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return new TextEncoder().encode(JSON.stringify(Object.fromEntries(entries)));
}

/** @type {Map<string, Promise<CryptoKey>>} */
const importedKeks = new Map();

/**
 * This Worker's KEKs, by version, and the one new blobs use.
 * @param {VaultEnv} env
 */
function keks(env) {
  /** @type {Map<number, string>} */
  const materials = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(KEK_PREFIX) || name === CURRENT_VERSION) continue;
    const match = KEK_PATTERN.exec(name);
    if (!match?.[1]) throw new VaultConfigurationError(`${name} is not a valid KEK secret name`);
    if (typeof value !== "string" || value.trim() === "") throw new VaultConfigurationError(`${name} must be set`);
    materials.set(Number(match[1]), value.trim());
  }
  const raw = env[CURRENT_VERSION];
  const current = raw === undefined ? 1 : typeof raw === "string" && /^[1-9][0-9]{0,3}$/u.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(current)) throw new VaultConfigurationError(`${CURRENT_VERSION} must be a positive integer string`);
  if (!materials.has(current)) throw new VaultConfigurationError(`SECRET_VAULT_LOCAL_KEK_V${current} is not set`);
  return { materials, current };
}

/** A KEK's bytes: valid base64 of exactly 32 bytes. @param {string} material @returns {Uint8Array<ArrayBuffer>} */
function kekBytes(material) {
  /** @type {Uint8Array<ArrayBuffer>} */
  let bytes;
  try {
    bytes = fromBase64(material);
  } catch {
    throw new VaultConfigurationError("a KEK is not valid base64");
  }
  if (bytes.length !== KEK_BYTES) throw new VaultConfigurationError(`a KEK must decode to ${KEK_BYTES} bytes`);
  return bytes;
}

/** @param {string} material @returns {Promise<CryptoKey>} */
function importKek(material) {
  const cached = importedKeks.get(material);
  if (cached) return cached;
  const bytes = kekBytes(material);
  const imported = crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]).catch((error) => {
    importedKeks.delete(material);
    throw error;
  });
  importedKeks.set(material, imported);
  return imported;
}

const LOCAL_SETTINGS = "SECRET_VAULT_LOCAL_";
const KMS_SETTINGS = "SECRET_VAULT_KMS_";

/**
 * This Worker's mode, `local` or `kms`. Settings of the other mode are
 * refused, so a half-moved deployment fails loudly rather than seal with the
 * wrong key.
 * @param {VaultEnv} env
 * @returns {"local" | "kms"}
 */
function vaultMode(env) {
  const mode = env.SECRET_VAULT_MODE;
  if (mode !== "local" && mode !== "kms") throw new VaultConfigurationError("SECRET_VAULT_MODE must be local or kms");
  const other = mode === "kms" ? LOCAL_SETTINGS : KMS_SETTINGS;
  if (Object.keys(env).some((name) => name.startsWith(other))) throw new VaultConfigurationError(`${other}* settings are not allowed in ${mode} mode`);
  return mode;
}

/** @type {WeakMap<object, ReturnType<typeof createKmsClient>>} */
const kmsClients = new WeakMap();

/** @param {VaultEnv} env */
function kms(env) {
  const cached = kmsClients.get(env);
  if (cached) return cached;
  const url = env.SECRET_VAULT_KMS_URL;
  const token = env.SECRET_VAULT_KMS_TOKEN;
  if (typeof url !== "string" || url.trim() === "") throw new VaultConfigurationError("SECRET_VAULT_KMS_URL is required in kms mode");
  if (typeof token !== "string" || token.trim() === "") throw new VaultConfigurationError("SECRET_VAULT_KMS_TOKEN is required in kms mode");
  if (!secureKmsUrl(url.trim())) throw new VaultConfigurationError("SECRET_VAULT_KMS_URL must be an https URL");
  const client = createKmsClient({ url: url.trim(), token: token.trim() });
  kmsClients.set(env, client);
  return client;
}

/**
 * Whether this Worker can seal and open: its settings are complete and agree.
 * Nothing is sent to cf-kms.
 * @param {VaultEnv} env
 * @returns {"ok" | "misconfigured"}
 */
export function vaultStatus(env) {
  try {
    if (vaultMode(env) === "kms") kms(env);
    else for (const material of keks(env).materials.values()) kekBytes(material);
    return "ok";
  } catch {
    return "misconfigured";
  }
}

/**
 * Seals `plaintext` to `identity`.
 * @param {VaultEnv} env
 * @param {string} kind
 * @param {unknown} identity
 * @param {string} plaintext
 * @returns {Promise<string>}
 */
export async function seal(env, kind, identity, plaintext) {
  if (typeof plaintext !== "string" || plaintext === "") throw new VaultBlobError("nothing to seal");
  const context = secretContext(kind, identity);
  if (vaultMode(env) === "kms") return kms(env).encryptSecret(plaintext, context);
  const { materials, current } = keks(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKek(/** @type {string} */ (materials.get(current)));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(context) }, key, new TextEncoder().encode(plaintext)),
  );
  return `${BLOB_PREFIX}.${current}.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

/**
 * Opens a blob sealed to `identity`. Never logged, never returned to a caller.
 * @param {VaultEnv} env
 * @param {string} kind
 * @param {unknown} identity
 * @param {unknown} blob
 * @param {AbortSignal} [signal] the caller's, for the call to cf-kms in kms mode
 * @returns {Promise<string>}
 */
export async function open(env, kind, identity, blob, signal) {
  const context = secretContext(kind, identity);
  if (typeof blob !== "string") throw new VaultBlobError("invalid blob");
  if (vaultMode(env) === "kms") {
    if (!blob.startsWith(`${ENVELOPE_PREFIX}.`)) throw new VaultBlobError("blob was not sealed in kms mode");
    try {
      return await kms(env).decryptSecret(blob, context, signal);
    } catch (error) {
      if (!(error instanceof KmsError)) throw error;
      if (error.code === "decrypt_failed" || error.code === "invalid_envelope") throw new VaultBlobError("blob does not open under this identity");
      if (error.code === "unauthorized") throw new VaultConfigurationError("SECRET_VAULT_KMS_TOKEN is refused by cf-kms");
      throw error;
    }
  }
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== BLOB_PREFIX) throw new VaultBlobError("blob was not sealed in local mode");
  const version = Number(parts[1]);
  const iv = fromBase64Url(parts[2] ?? "");
  const ciphertext = fromBase64Url(parts[3] ?? "");
  if (!Number.isInteger(version) || version <= 0 || iv.length !== IV_BYTES || ciphertext.length === 0) throw new VaultBlobError("invalid blob");
  const material = keks(env).materials.get(version);
  if (material === undefined) throw new VaultBlobError("blob uses an unavailable KEK version");
  const key = await importKek(material);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: additionalData(context) }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new VaultBlobError("blob does not open under this identity");
  }
}

/**
 * Seals a provider key again for the provider's own address, without the key
 * ever leaving this Worker: for a connection whose base URL or Cloudflare
 * gateway is removed. The vault enforces the rule itself, whatever the caller
 * asks: the same account, connection, provider type and key placement, and only to "" (the
 * provider's own hosts, which this Worker knows). A key is never moved to an
 * address someone names; that needs the key again.
 * @param {VaultEnv} env
 * @param {string} kind
 * @param {unknown} from
 * @param {unknown} to
 * @param {unknown} blob
 * @returns {Promise<string>}
 */
export async function reseal(env, kind, from, to, blob) {
  if (kind !== "providerKey") throw new VaultBlobError("only a provider key can be sealed again");
  const source = secretContext(kind, from);
  const target = secretContext(kind, to);
  const same = ["accountId", "connectionId", "providerType", "keyHeader", "keyFormat"].every((name) => source[name] === target[name]);
  if (!same || target.baseUrl !== "") throw new VaultBlobError("a key can only be sealed again for its provider's own address");
  return seal(env, kind, to, await open(env, kind, from, blob));
}
