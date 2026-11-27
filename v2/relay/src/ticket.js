// @ts-check
/**
 * Session tickets (plan section 4.3, step 8j "Session tickets"): read and
 * checked here with the main Worker's public key. Only the main Worker holds
 * the private key that signs them.
 *
 * A ticket is `<payload>.<signature>`: the payload is base64url JSON, and the
 * signature is Ed25519 over the payload's characters, base64url. It travels in
 * the `authorization` header of the connection to the relay, never in a URL.
 *
 * The same file is in `v2/vault/src/ticket.js`: the two Workers are uploaded
 * apart and share no files. A test checks that the copies are the same.
 */

/** Longer than this is not a ticket. A ticket carries a sealed key, so it is a few KB at most. */
export const MAX_TICKET_LENGTH = 16 * 1024;
/** The ticket format this code reads. */
export const TICKET_VERSION = 1;

/**
 * What a ticket carries. `seal` is the session's copy of the provider
 * credentials, sealed by the vault until `sealUntil` (step 8j); the main
 * Worker never sees it opened. `url` is where the session connects, which the
 * vault checks against the address the seal is bound to.
 * @typedef {{
 *   v: number,
 *   sid: string,
 *   account: string,
 *   app: string,
 *   endUser: string | null,
 *   install: string | null,
 *   appleAccount: string | null,
 *   appKey: string | null,
 *   providerType: string,
 *   connection: string | null,
 *   operation: string,
 *   model: string | null,
 *   mode: "relayed" | "observed",
 *   slot: "conversational" | "streaming",
 *   sessionTotal: boolean,
 *   url: string,
 *   start: number,
 *   cap: number,
 *   exp: number,
 *   seal: { providerKey?: { blob: string, identity: string[], header?: string, format?: string }, cloudflareToken?: { blob: string, identity: string[] } },
 *   backend?: string[],
 * }} Ticket
 * `backend`: the models the session's backend may call (GPT-Live's, 9g), when its operation has one.
 */

/** @param {Uint8Array} bytes */
export function base64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** @param {string} text @returns {Uint8Array<ArrayBuffer> | null} */
export function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
const isText = (value) => typeof value === "string" && value !== "";
/** @param {unknown} value */
const isTextOrNull = (value) => value === null || typeof value === "string";
/** @param {unknown} value */
const isTime = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * The payload, when it has every field a ticket needs; else null.
 * @param {unknown} value
 * @returns {Ticket | null}
 */
function readPayload(value) {
  if (typeof value !== "object" || value === null) return null;
  const t = /** @type {Record<string, unknown>} */ (value);
  if (t.v !== TICKET_VERSION) return null;
  if (![t.sid, t.account, t.app, t.providerType, t.operation, t.url].every(isText)) return null;
  if (![t.endUser, t.install, t.appleAccount, t.appKey, t.connection, t.model].every(isTextOrNull)) return null;
  if (t.mode !== "relayed" && t.mode !== "observed") return null;
  if (t.slot !== "conversational" && t.slot !== "streaming") return null;
  if (typeof t.sessionTotal !== "boolean") return null;
  if (![t.start, t.cap, t.exp].every(isTime)) return null;
  if (typeof t.seal !== "object" || t.seal === null) return null;
  return /** @type {Ticket} */ (value);
}

/**
 * The ticket's payload, read without checking its signature; null when it is
 * not shaped like a ticket. Use only after `verifyTicket`, or to drop a bad
 * one early.
 * @param {unknown} ticket
 * @returns {{ payload: Ticket, signed: string, signature: Uint8Array<ArrayBuffer> } | null}
 */
export function parseTicket(ticket) {
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_LENGTH) return null;
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;
  const [signed = "", sig = ""] = parts;
  const json = fromBase64url(signed);
  const signature = fromBase64url(sig);
  if (json === null || signature === null || signature.byteLength !== 64) return null;
  try {
    const payload = readPayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)));
    return payload === null ? null : { payload, signed, signature };
  } catch {
    return null;
  }
}

/** @type {Map<string, Promise<CryptoKey>>} */
const publicKeys = new Map();

/**
 * The main Worker's public key, from its base64url form (32 bytes).
 * @param {string} encoded
 */
function publicKey(encoded) {
  let key = publicKeys.get(encoded);
  if (key === undefined) {
    const raw = fromBase64url(encoded);
    if (raw === null || raw.byteLength !== 32) throw new Error("the ticket public key is not 32 bytes of base64url");
    key = crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    publicKeys.set(encoded, key);
  }
  return key;
}

/**
 * The ticket's payload when its signature is the main Worker's; else null.
 * Expiry is the caller's to check: a restart may go on past it (8j).
 * Throws only when `publicKeyText` itself is not a key, which is a setup error.
 * @param {unknown} ticket
 * @param {unknown} publicKeyText
 * @returns {Promise<Ticket | null>}
 */
export async function verifyTicket(ticket, publicKeyText) {
  if (typeof publicKeyText !== "string" || publicKeyText === "") throw new Error("RELAY_TICKET_PUBLIC_KEY is not set");
  const key = await publicKey(publicKeyText);
  const parsed = parseTicket(ticket);
  if (parsed === null) return null;
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, parsed.signature, new TextEncoder().encode(parsed.signed));
  return valid ? parsed.payload : null;
}

/** The session's deadline: the ticket's start time plus its cap (crash table, "Who keeps what"). @param {Ticket} ticket */
export function deadlineOf(ticket) {
  return ticket.start + ticket.cap;
}
