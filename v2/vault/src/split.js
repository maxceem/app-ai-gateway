// @ts-check
/**
 * Split keys (plan step 8j): what a stolen copy of the data and the KEK
 * cannot open.
 *
 * - An account has one **root key**, an X25519 private key that exists only
 *   inside keyslots. The database keeps its public key.
 * - Its provider keys and Cloudflare tokens are sealed to the root's public
 *   key with HPKE (`./hpke.js`), and that is sealed with the KEK as before.
 * - Each credential (an app key now; iOS shares and passkeys later) has a
 *   **keyslot**: the root key sealed to the credential's public key, again
 *   inside the KEK. The credential's key pair comes from its secret, which
 *   only the customer holds, so the server can open a keyslot only while a
 *   request brings that secret.
 *
 * A sealed value is self-describing: `agwsplit1.<enc>.<ciphertext>`, base64url,
 * inside the KEK layer. A key saved before split keys were on has no prefix
 * and opens as it always did.
 */
import { deriveKeyPair, expand, extract, openBase, publicKeyOf, sealBase } from "./hpke.js";

export const SPLIT_PREFIX = "agwsplit1.";

/** The HPKE `info` for each thing sealed, so a value sealed as one is never opened as the other. */
const INFO = /** @type {const} */ ({
  secret: "agw split key v1 secret",
  keySlot: "agw split key v1 keyslot",
});

const CREDENTIAL_INFO = "agw credential key v1";
const ROOT_BYTES = 32;

const encoder = new TextEncoder();

/** A value this layer cannot use: it does not open, or is not one of its own. */
export class SplitKeyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(`split keys: ${message}`);
    this.name = "SplitKeyError";
  }
}

/** @param {Uint8Array} bytes */
export function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

/** @param {string} value @returns {Uint8Array<ArrayBuffer>} */
export function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new SplitKeyError("not base64url");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  /** @type {string} */
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new SplitKeyError("not base64url");
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Whether an opened KEK layer holds a split-key value. @param {string} text */
export function isSplit(text) {
  return text.startsWith(SPLIT_PREFIX);
}

/** A public key as stored: base64url of 32 bytes. @param {unknown} value */
export function readPublicKey(value) {
  if (typeof value !== "string") throw new SplitKeyError("a public key is a string");
  const bytes = fromBase64Url(value);
  if (bytes.length !== 32) throw new SplitKeyError("a public key is 32 bytes");
  return bytes;
}

/**
 * A credential's key pair, from its secret: an app key as the app sends it,
 * or (later) an iOS share. It is not the auth hash: HKDF with its own label,
 * then HPKE's DeriveKeyPair, so the hash the database keeps leads nowhere.
 * @param {string} secret
 */
export async function credentialKeyPair(secret) {
  if (typeof secret !== "string" || secret === "") throw new SplitKeyError("no credential secret");
  const prk = await extract(new Uint8Array(0), encoder.encode(secret));
  return deriveKeyPair(await expand(prk, encoder.encode(CREDENTIAL_INFO), 32));
}

/** A credential's public key, as stored with its keyslot. @param {string} secret */
export async function credentialPublicKey(secret) {
  return toBase64Url((await credentialKeyPair(secret)).publicKey);
}

/**
 * Whether a credential's secret is the one a keyslot was made for: its public
 * key, derived again, is the stored one. The gateway asks this when an app
 * sends an iOS share at `/auth/token`, so a wrong share is refused there,
 * before any call. Only yes or no leaves the vault.
 * @param {unknown} secret
 * @param {unknown} publicKey
 */
export async function credentialMatches(secret, publicKey) {
  if (typeof secret !== "string" || secret === "" || typeof publicKey !== "string") return false;
  try {
    return (await credentialPublicKey(secret)) === toBase64Url(readPublicKey(publicKey));
  } catch {
    return false;
  }
}

/** A new root key and its public key. Only ever kept inside keyslots. */
export async function newRoot() {
  const privateKey = crypto.getRandomValues(new Uint8Array(ROOT_BYTES));
  return { privateKey, publicKey: toBase64Url(await publicKeyOf(privateKey)) };
}

/**
 * Seals `plaintext` to a public key, bound to `aad`.
 * @param {"secret" | "keySlot"} what
 * @param {Uint8Array} publicKey
 * @param {Uint8Array} aad
 * @param {Uint8Array} plaintext
 */
async function sealTo(what, publicKey, aad, plaintext) {
  const { enc, ciphertext } = await sealBase({ publicKey, info: encoder.encode(INFO[what]), aad, plaintext });
  return `${SPLIT_PREFIX}${toBase64Url(enc)}.${toBase64Url(ciphertext)}`;
}

/**
 * Opens a value `sealTo` made, with the private key it was sealed to.
 * @param {"secret" | "keySlot"} what
 * @param {Uint8Array} privateKey
 * @param {Uint8Array} aad
 * @param {string} text
 */
async function openFrom(what, privateKey, aad, text) {
  if (!isSplit(text)) throw new SplitKeyError("not a split-key value");
  const parts = text.slice(SPLIT_PREFIX.length).split(".");
  if (parts.length !== 2) throw new SplitKeyError("not a split-key value");
  const enc = fromBase64Url(parts[0] ?? "");
  const ciphertext = fromBase64Url(parts[1] ?? "");
  if (enc.length !== 32 || ciphertext.length < 16) throw new SplitKeyError("not a split-key value");
  try {
    return await openBase({ privateKey, enc, info: encoder.encode(INFO[what]), aad, ciphertext });
  } catch {
    throw new SplitKeyError("does not open with this key");
  }
}

/**
 * A provider key or Cloudflare token sealed to an account's root public key.
 * `aad` is the context it is sealed under, the same as the KEK layer's.
 * @param {string} rootPublicKey base64url
 * @param {Uint8Array} aad
 * @param {string} plaintext
 */
export function sealSecretToRoot(rootPublicKey, aad, plaintext) {
  return sealTo("secret", readPublicKey(rootPublicKey), aad, encoder.encode(plaintext));
}

/** @param {Uint8Array} rootPrivateKey @param {Uint8Array} aad @param {string} text */
export async function openSecretWithRoot(rootPrivateKey, aad, text) {
  return new TextDecoder().decode(await openFrom("secret", rootPrivateKey, aad, text));
}

/**
 * A keyslot's inner value: the root key sealed to a credential's public key.
 * @param {Uint8Array} rootPrivateKey
 * @param {string} credentialPublicKey base64url
 * @param {Uint8Array} aad the keyslot's context
 */
export function sealRootToCredential(rootPrivateKey, credentialPublicKey, aad) {
  if (rootPrivateKey.length !== ROOT_BYTES) throw new SplitKeyError("a root key is 32 bytes");
  return sealTo("keySlot", readPublicKey(credentialPublicKey), aad, rootPrivateKey);
}

/**
 * The root key a keyslot holds, opened with the credential's secret.
 * @param {string} secret
 * @param {Uint8Array} aad the keyslot's context
 * @param {string} text
 */
export async function openRootWithCredential(secret, aad, text) {
  const { privateKey } = await credentialKeyPair(secret);
  const root = await openFrom("keySlot", privateKey, aad, text);
  if (root.length !== ROOT_BYTES) throw new SplitKeyError("a root key is 32 bytes");
  return root;
}

