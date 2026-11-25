// @ts-check
/**
 * A small client for a cf-kms deployment, for the vault's `kms` mode, with no
 * npm packages. It reads and writes the same envelope as
 * `@maxceem/cf-kms/client`, which the migration script still uses, so a blob
 * sealed by either opens on the other (a test checks it):
 * `cfkms-env1.<wrapped data key>.<iv>.<ciphertext>`, AES-GCM under a data key
 * cf-kms wraps, with the context as additional data.
 *
 * The opened data key is cached in memory for five minutes, by its wrapped
 * form and the context, as the package does. The token goes out on every call
 * to cf-kms, so plain HTTP is refused, loopback aside, and a redirect is never
 * followed.
 */

export const ENVELOPE_PREFIX = "cfkms-env1";
const IV_BYTES = 12;
const CACHE_TTL_MS = 300_000;
/**
 * How long one cf-kms call may take: far under any provider's time limit, so
 * a stalled cf-kms ends as the vault's own refusal (nothing sent, nothing
 * charged) rather than as the caller giving up on a call it cannot tell apart.
 */
export const KMS_TIMEOUT_MS = 5_000;
const MAX_CACHE_ENTRIES = 512;

/** A cf-kms call or envelope that failed, by cf-kms's own code. */
export class KmsError extends Error {
  /** @param {string} code @param {number} status */
  constructor(code, status) {
    super(`cf-kms: ${code}`);
    this.name = "KmsError";
    this.code = code;
    this.status = status;
  }
}

/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

/** @param {string} value @returns {Uint8Array<ArrayBuffer>} */
function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new KmsError("invalid_envelope", 0);
  /** @type {string} */
  let binary;
  try {
    binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "="));
  } catch {
    // A length no base64 can have, such as 4n+1.
    throw new KmsError("invalid_envelope", 0);
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** @param {Record<string, string>} context */
function canonical(context) {
  const entries = Object.entries(context).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

/**
 * Whether the token may be sent to `url`: a URL that parses, with no query or
 * fragment (the API paths are added to it), over https or loopback for local work.
 * @param {string} url
 */
export function secureKmsUrl(url) {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (parsed.search !== "" || parsed.hash !== "" || url.includes("?") || url.includes("#")) return false;
  return /^https:\/\//iu.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/iu.test(url);
}

/** @param {Uint8Array<ArrayBuffer>} bytes */
function importDataKey(bytes) {
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * @param {{ readonly url: string, readonly token: string }} options
 */
export function createKmsClient(options) {
  if (!secureKmsUrl(options.url)) throw new KmsError("insecure_url", 0);
  // Built from the parsed URL: its origin and path, with the API path added.
  const parsed = new URL(options.url);
  const baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
  /** @type {Map<string, { key: CryptoKey, expiresAt: number }>} */
  const cache = new Map();

  /**
   * @param {string} path
   * @param {unknown} body
   * @param {readonly string[]} fields
   * @param {AbortSignal} [signal] the caller's own, if it has one: the call stops at whichever ends first
   * @param {number} [until] the caller's own end, in epoch ms, when sooner than this call's limit
   * @returns {Promise<Record<string, unknown>>}
   */
  async function call(path, body, fields, signal, until) {
    const wait = Math.min(KMS_TIMEOUT_MS, until === undefined ? KMS_TIMEOUT_MS : until - Date.now());
    if (wait <= 0) throw new KmsError("timeout", 0);
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(new KmsError("timeout", 0)), wait);
    const stop = signal === undefined ? limit.signal : AbortSignal.any([limit.signal, signal]);
    try {
      return await send(path, body, fields, stop);
    } catch (error) {
      if (limit.signal.aborted) throw new KmsError("timeout", 0);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {string} path
   * @param {unknown} body
   * @param {readonly string[]} fields
   * @param {AbortSignal} signal
   * @returns {Promise<Record<string, unknown>>}
   */
  async function send(path, body, fields, signal) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      // Never follow a redirect: it would take the token somewhere else.
      redirect: "manual",
      signal,
    });
    if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      await response.body?.cancel();
      throw new KmsError("redirect_refused", response.status);
    }
    /** @type {unknown} */
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new KmsError("invalid_response", response.status);
    }
    const record = /** @type {Record<string, unknown> | null} */ (typeof payload === "object" ? payload : null);
    if (!response.ok) {
      const error = /** @type {{ code?: unknown } | undefined} */ (record?.error);
      throw new KmsError(typeof error?.code === "string" ? error.code : "request_failed", response.status);
    }
    if (record === null || fields.some((field) => typeof record[field] !== "string") || typeof record.kekVersion !== "number") {
      throw new KmsError("invalid_response", response.status);
    }
    return record;
  }

  /** @param {string} cacheKey @param {CryptoKey} key */
  function remember(cacheKey, key) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(cacheKey, { key, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  return {
    /**
     * @param {string} plaintext
     * @param {Record<string, string>} context
     */
    async encryptSecret(plaintext, context) {
      const issued = await call("/v1/generate-data-key", { encryptionContext: context }, ["plaintextKey", "wrappedKey"]);
      const key = await importDataKey(fromBase64Url(/** @type {string} */ (issued.plaintextKey)));
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const aad = new TextEncoder().encode(canonical(context));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new TextEncoder().encode(plaintext)));
      const wrapped = /** @type {string} */ (issued.wrappedKey);
      remember(`${wrapped}\u0000${canonical(context)}`, key);
      return `${ENVELOPE_PREFIX}.${wrapped}.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
    },

    /**
     * @param {string} blob
     * @param {Record<string, string>} context
     * @param {AbortSignal} [signal]
     * @param {number} [until]
     */
    async decryptSecret(blob, context, signal, until) {
      const parts = blob.split(".");
      // The wrapped key has dots of its own: it is everything between the prefix and the iv and ciphertext.
      if (parts.length < 4 || parts[0] !== ENVELOPE_PREFIX) throw new KmsError("invalid_envelope", 0);
      const wrapped = parts.slice(1, -2).join(".");
      const iv = fromBase64Url(parts[parts.length - 2] ?? "");
      const ciphertext = fromBase64Url(parts[parts.length - 1] ?? "");
      if (wrapped === "" || iv.length !== IV_BYTES) throw new KmsError("invalid_envelope", 0);
      const cacheKey = `${wrapped}\u0000${canonical(context)}`;
      const cached = cache.get(cacheKey);
      let key = cached !== undefined && cached.expiresAt > Date.now() ? cached.key : null;
      if (key === null) {
        cache.delete(cacheKey);
        const opened = await call("/v1/decrypt", { wrappedKey: wrapped, encryptionContext: context }, ["plaintextKey"], signal, until);
        key = await importDataKey(fromBase64Url(/** @type {string} */ (opened.plaintextKey)));
        remember(cacheKey, key);
      }
      try {
        const aad = new TextEncoder().encode(canonical(context));
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ciphertext));
      } catch {
        throw new KmsError("decrypt_failed", 0);
      }
    },
  };
}
