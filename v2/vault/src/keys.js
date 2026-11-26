// @ts-check
/**
 * The key for this request: the one function every opening of a provider
 * key or Cloudflare token goes through (plan step 8j, "Rule for every later
 * step"). It opens the KEK layer, and, for an account with split keys on,
 * the account's root from the keyslot of the credential the request brought,
 * then the key with the root.
 *
 * Opened keys are kept in this isolate for a short while. The cache is keyed
 * by the blob, its whole identity, and a hash of the credential that opened
 * it, so a request reuses an opened key only when it brought the same
 * credential itself.
 */
import { VaultBlobError, additionalData, open, secretContext } from "./seal.js";
import { isSplit, openRootWithCredential, openSecretWithRoot } from "./split.js";

/** @typedef {import("./seal.js").VaultEnv} VaultEnv */

/**
 * The credential a request brought, for a split-key account: its secret (an
 * app key as the app sent it; an iOS share later), and its keyslot, sealed,
 * with the ids it is sealed to (account, credential, kind).
 * @typedef {{ readonly secret: string, readonly slot: string, readonly slotIdentity: readonly string[] }} RequestCredential
 */

/**
 * What one call opens, so a call that carries a provider key and a Cloudflare
 * token opens the account's root once.
 * @typedef {{ root?: Promise<Uint8Array> }} CallMemo
 */

/**
 * The kinds a request may open: a connection's own credentials, or a copy
 * stored for work with no app request.
 * @typedef {"providerKey" | "cloudflareGatewayToken" | "storedProviderKey" | "storedCloudflareToken"} OpenableKind
 */

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 10_000;

/** @type {Map<string, { value: string, at: number }>} */
const openedCache = new Map();

/** For the tests: forget every opened key. */
export function forgetOpenedKeys() {
  openedCache.clear();
}

/** @param {string} text */
async function sha256(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * When a stored copy stops opening, from its identity's last id.
 * @param {readonly string[]} identity
 */
export function storedUntil(identity) {
  const raw = identity[identity.length - 1] ?? "";
  return /^[1-9][0-9]{0,15}$/u.test(raw) ? Number(raw) : NaN;
}

/** @param {unknown} credential @returns {RequestCredential | null} */
export function readRequestCredential(credential) {
  if (credential === undefined || credential === null) return null;
  if (typeof credential !== "object") throw new VaultBlobError("invalid credential");
  const { secret, slot, slotIdentity } = /** @type {Record<string, unknown>} */ (credential);
  if (typeof secret !== "string" || secret === "" || typeof slot !== "string") throw new VaultBlobError("invalid credential");
  if (!Array.isArray(slotIdentity) || slotIdentity.length !== 3 || !slotIdentity.every((id) => typeof id === "string")) {
    throw new VaultBlobError("invalid credential");
  }
  return { secret, slot, slotIdentity: /** @type {string[]} */ (slotIdentity) };
}

/**
 * The account's root, from the credential's keyslot. The keyslot must belong
 * to the same account as the key it opens.
 * @param {VaultEnv} env
 * @param {RequestCredential} credential
 * @param {string} accountId
 * @param {AbortSignal} [signal]
 * @param {number} [until]
 */
async function rootFor(env, credential, accountId, signal, until) {
  if (credential.slotIdentity[0] !== accountId) throw new VaultBlobError("the credential belongs to another account");
  const sealed = await open(env, "keySlot", credential.slotIdentity, credential.slot, signal, until);
  try {
    return await openRootWithCredential(credential.secret, additionalData(secretContext("keySlot", credential.slotIdentity)), sealed);
  } catch {
    throw new VaultBlobError("the keyslot does not open with this credential");
  }
}

/**
 * Opens one credential for this request.
 * @param {VaultEnv} env
 * @param {OpenableKind} kind
 * @param {readonly string[]} identity
 * @param {string} blob
 * @param {{ credential?: RequestCredential | null, memo?: CallMemo, signal?: AbortSignal, until?: number }} [options]
 * @returns {Promise<string>}
 */
export async function keyForRequest(env, kind, identity, blob, options = {}) {
  const stored = kind === "storedProviderKey" || kind === "storedCloudflareToken";
  // Checked before the cache, so a copy never outlives its own time.
  if (stored && !(storedUntil(identity) > Date.now())) throw new VaultBlobError("the stored copy has expired");
  const credential = options.credential ?? null;
  const tag = credential === null ? "" : `${credential.slotIdentity.join("\u0001")}\u0001${await sha256(credential.secret)}`;
  const cacheKey = [kind, ...identity, blob, tag].join("\u0000");
  const cached = openedCache.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const text = await open(env, kind, identity, blob, options.signal, options.until);
  /** @type {string} */
  let value = text;
  if (isSplit(text)) {
    // A stored copy is the key itself, never something still sealed to a root.
    if (stored || credential === null) throw new VaultBlobError("this key opens only with the app's credential");
    const memo = options.memo ?? {};
    memo.root ??= rootFor(env, credential, identity[0] ?? "", options.signal, options.until);
    try {
      value = await openSecretWithRoot(await memo.root, additionalData(secretContext(kind, identity)), text);
    } catch (error) {
      if (error instanceof VaultBlobError) throw error;
      throw new VaultBlobError("the key does not open with this account's root");
    }
  }
  openedCache.delete(cacheKey);
  if (openedCache.size >= CACHE_MAX) {
    const oldest = openedCache.keys().next().value;
    if (oldest !== undefined) openedCache.delete(oldest);
  }
  openedCache.set(cacheKey, { value, at: Date.now() });
  return value;
}
