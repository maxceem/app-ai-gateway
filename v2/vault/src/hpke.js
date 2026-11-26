// @ts-check
/**
 * HPKE (RFC 9180) in its base mode, written on WebCrypto with no npm
 * packages: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, and AES-GCM. Split keys
 * (plan step 8j) use AES-256-GCM; AES-128-GCM is here only so the RFC's own
 * test vectors (appendix A.1) can check the rest. Each message is sealed on
 * its own, so only sequence number 0 is ever used.
 *
 * X25519 keys are raw 32-byte strings, as the RFC writes them.
 */

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
/** AEAD ids and their key lengths. */
export const AEAD = /** @type {const} */ ({ aes128gcm: 0x0001, aes256gcm: 0x0002 });
/** @type {Record<number, number>} */
const KEY_LENGTH = { [AEAD.aes128gcm]: 16, [AEAD.aes256gcm]: 32 };
const NONCE_LENGTH = 12;
const HASH_LENGTH = 32;
const KEY_BYTES = 32;
/** The X25519 base point, u = 9: multiplying it by a private key gives the public key. */
const BASE_POINT = new Uint8Array(32);
BASE_POINT[0] = 9;
/** The fixed DER prefix of an X25519 private key in PKCS #8 (RFC 8410), before its 32 bytes. */
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

const encoder = new TextEncoder();

/** @param {Uint8Array[]} parts @returns {Uint8Array<ArrayBuffer>} */
export function concat(...parts) {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((sum, part) => sum + part.length, 0)));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** @param {number} value @param {number} length */
function i2osp(value, length) {
  const out = new Uint8Array(length);
  for (let index = length - 1, rest = value; index >= 0; index -= 1, rest = Math.floor(rest / 256)) out[index] = rest % 256;
  return out;
}

/** @param {Uint8Array} bytes @returns {Uint8Array<ArrayBuffer>} */
function copy(bytes) {
  return concat(bytes);
}

/** @param {Uint8Array} key @param {Uint8Array} data */
async function hmac(key, data) {
  // An empty salt is a key of HashLen zeros (RFC 5869); WebCrypto refuses a zero-length HMAC key.
  const material = key.length === 0 ? new Uint8Array(HASH_LENGTH) : copy(key);
  const imported = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, copy(data)));
}

/** HKDF-Extract (RFC 5869). @param {Uint8Array} salt @param {Uint8Array} ikm */
export function extract(salt, ikm) {
  return hmac(salt, ikm);
}

/** HKDF-Expand (RFC 5869). @param {Uint8Array} prk @param {Uint8Array} info @param {number} length */
export async function expand(prk, info, length) {
  /** @type {Uint8Array[]} */
  const blocks = [];
  let previous = new Uint8Array(0);
  for (let counter = 1; blocks.length * HASH_LENGTH < length; counter += 1) {
    previous = await hmac(prk, concat(previous, info, Uint8Array.of(counter)));
    blocks.push(previous);
  }
  return concat(...blocks).slice(0, length);
}

/** @param {Uint8Array} suite @param {Uint8Array} salt @param {string} label @param {Uint8Array} ikm */
function labeledExtract(suite, salt, label, ikm) {
  return extract(salt, concat(encoder.encode("HPKE-v1"), suite, encoder.encode(label), ikm));
}

/** @param {Uint8Array} suite @param {Uint8Array} prk @param {string} label @param {Uint8Array} info @param {number} length */
function labeledExpand(suite, prk, label, info, length) {
  return expand(prk, concat(i2osp(length, 2), encoder.encode("HPKE-v1"), suite, encoder.encode(label), info), length);
}

const KEM_SUITE = concat(encoder.encode("KEM"), i2osp(KEM_ID, 2));

/** @param {number} aead */
function hpkeSuite(aead) {
  return concat(encoder.encode("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(aead, 2));
}

/** @param {Uint8Array} privateKey */
function importPrivate(privateKey) {
  if (privateKey.length !== KEY_BYTES) throw new Error("an X25519 private key is 32 bytes");
  return crypto.subtle.importKey("pkcs8", concat(PKCS8_PREFIX, privateKey), { name: "X25519" }, false, ["deriveBits"]);
}

/** X25519(privateKey, publicKey): the shared point, refused when it is all zeros. @param {Uint8Array} privateKey @param {Uint8Array} publicKey */
async function x25519(privateKey, publicKey) {
  if (publicKey.length !== KEY_BYTES) throw new Error("an X25519 public key is 32 bytes");
  const peer = await crypto.subtle.importKey("raw", copy(publicKey), { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, await importPrivate(privateKey), 256));
  if (shared.every((byte) => byte === 0)) throw new Error("X25519 gave an all-zero result");
  return shared;
}

/** The public key of an X25519 private key. @param {Uint8Array} privateKey */
export function publicKeyOf(privateKey) {
  return x25519(privateKey, BASE_POINT);
}

/**
 * DeriveKeyPair (RFC 9180, 7.1.3) for X25519: the same input always gives
 * the same key pair.
 * @param {Uint8Array} ikm at least 32 bytes
 */
export async function deriveKeyPair(ikm) {
  if (ikm.length < KEY_BYTES) throw new Error("DeriveKeyPair needs at least 32 bytes");
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), "dkp_prk", ikm);
  const privateKey = await labeledExpand(KEM_SUITE, prk, "sk", new Uint8Array(0), KEY_BYTES);
  return { privateKey, publicKey: await publicKeyOf(privateKey) };
}

/** @param {Uint8Array} dh @param {Uint8Array} kemContext */
async function extractAndExpand(dh, kemContext) {
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", kemContext, HASH_LENGTH);
}

/**
 * The base-mode key schedule: the AEAD key and nonce for one shared secret.
 * @param {number} aead
 * @param {Uint8Array} sharedSecret
 * @param {Uint8Array} info
 */
export async function keySchedule(aead, sharedSecret, info) {
  const length = KEY_LENGTH[aead];
  if (length === undefined) throw new Error("unsupported AEAD");
  const suite = hpkeSuite(aead);
  const empty = new Uint8Array(0);
  const pskIdHash = await labeledExtract(suite, empty, "psk_id_hash", empty);
  const infoHash = await labeledExtract(suite, empty, "info_hash", info);
  const context = concat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = await labeledExtract(suite, sharedSecret, "secret", empty);
  return {
    key: await labeledExpand(suite, secret, "key", context, length),
    baseNonce: await labeledExpand(suite, secret, "base_nonce", context, NONCE_LENGTH),
  };
}

/**
 * Encap: a shared secret for `publicKey`, and `enc` to send with it. The
 * ephemeral key is random unless `ikmE` is given (the RFC's test vectors).
 * @param {Uint8Array} publicKey
 * @param {Uint8Array} [ikmE]
 */
export async function encap(publicKey, ikmE) {
  const ephemeral = await deriveKeyPair(ikmE ?? crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
  const dh = await x25519(ephemeral.privateKey, publicKey);
  const enc = ephemeral.publicKey;
  return { sharedSecret: await extractAndExpand(dh, concat(enc, publicKey)), enc };
}

/** Decap: the shared secret `enc` carries for this private key. @param {Uint8Array} enc @param {Uint8Array} privateKey */
export async function decap(enc, privateKey) {
  const dh = await x25519(privateKey, enc);
  return extractAndExpand(dh, concat(enc, await publicKeyOf(privateKey)));
}

/** @param {Uint8Array} key @param {number} aead */
function aesKey(key, aead) {
  if (key.length !== KEY_LENGTH[aead]) throw new Error("wrong AEAD key length");
  return crypto.subtle.importKey("raw", copy(key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * SealBase: one message to `publicKey`, bound to `info` and `aad`.
 * @param {{ publicKey: Uint8Array, info: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, aead?: number, ikmE?: Uint8Array }} input
 */
export async function sealBase(input) {
  const aead = input.aead ?? AEAD.aes256gcm;
  const { sharedSecret, enc } = await encap(input.publicKey, input.ikmE);
  const { key, baseNonce } = await keySchedule(aead, sharedSecret, input.info);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: baseNonce, additionalData: copy(input.aad) },
    await aesKey(key, aead),
    copy(input.plaintext),
  );
  return { enc, ciphertext: new Uint8Array(ciphertext) };
}

/**
 * OpenBase: the message `enc` and `ciphertext` carry, or a throw when it does
 * not open with this key, `info` and `aad`.
 * @param {{ privateKey: Uint8Array, enc: Uint8Array, info: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array, aead?: number }} input
 */
export async function openBase(input) {
  const aead = input.aead ?? AEAD.aes256gcm;
  const sharedSecret = await decap(input.enc, input.privateKey);
  const { key, baseNonce } = await keySchedule(aead, sharedSecret, input.info);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: baseNonce, additionalData: copy(input.aad) },
    await aesKey(key, aead),
    copy(input.ciphertext),
  );
  return new Uint8Array(plaintext);
}
