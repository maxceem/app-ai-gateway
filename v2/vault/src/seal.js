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
 */

/** @typedef {{ readonly [name: string]: unknown }} VaultEnv */

/** The caller identity every context carries; see `v2/src/vault/types.ts`. */
export const VAULT_SERVICE = "app-ai-gateway";

/**
 * Every kind of credential and the names of the ids it is bound to, in order.
 * The gateway's own table (`v2/src/vault/secrets.ts`) must name the same, and
 * a test checks that it does.
 *
 * - `providerKey`: the account, the connection, the provider type, and the
 *   address the key may go to: a base URL, a Cloudflare AI Gateway path, or
 *   "" for the provider's own hosts (`./hosts.js`).
 * - `cloudflareGatewayToken`: the account, the connection, and the Cloudflare
 *   account and gateway the token may go to.
 */
export const CONTEXT_NAMES = /** @type {const} */ ({
  providerKey: ["accountId", "connectionId", "providerType", "baseUrl"],
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
  if (env.SECRET_VAULT_MODE !== "local") {
    throw new VaultConfigurationError("SECRET_VAULT_MODE must be local; kms is not supported by this vault yet");
  }
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

/** @param {string} material @returns {Promise<CryptoKey>} */
function importKek(material) {
  const cached = importedKeks.get(material);
  if (cached) return cached;
  /** @type {Uint8Array<ArrayBuffer>} */
  let bytes;
  try {
    bytes = fromBase64(material);
  } catch {
    throw new VaultConfigurationError("a KEK is not valid base64");
  }
  if (bytes.length !== KEK_BYTES) throw new VaultConfigurationError(`a KEK must decode to ${KEK_BYTES} bytes`);
  const imported = crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]).catch((error) => {
    importedKeks.delete(material);
    throw error;
  });
  importedKeks.set(material, imported);
  return imported;
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
 * @returns {Promise<string>}
 */
export async function open(env, kind, identity, blob) {
  const context = secretContext(kind, identity);
  if (typeof blob !== "string") throw new VaultBlobError("invalid blob");
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
 * Seals again under a new identity, without the key ever leaving this Worker:
 * for a connection whose address changes back to one its key may go to.
 * @param {VaultEnv} env
 * @param {string} kind
 * @param {unknown} from
 * @param {unknown} to
 * @param {unknown} blob
 * @returns {Promise<string>}
 */
export async function reseal(env, kind, from, to, blob) {
  return seal(env, kind, to, await open(env, kind, from, blob));
}
