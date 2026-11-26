// @ts-check
/**
 * The relay's way to a session's provider key (plan steps 8i, 8j and 9a): the
 * only place the vault hands out a plaintext key, and only to the relay,
 * which alone is bound to the `RelayKeys` entrypoint.
 *
 * The vault checks the ticket itself, whatever the relay or the main Worker
 * say: the signature with the main Worker's public key; at the start, that
 * the ticket has not expired; on a restart, only the session seal's own
 * expiry, so a call can recover after its start ticket has expired (8j). It
 * opens only a session seal (a stored copy, bound to its own expiry), and
 * only for the account the ticket names. It answers with the key and the one
 * address the seal allows for the ticket's `url`: every call that carries the
 * key goes there and nowhere else (crash table, "Who keeps what").
 *
 * It never logs a key, a ticket or an address: only a code and the session id.
 */
import { allowedUrl, readCredentials } from "./call.js";
import { keyForRequest } from "./keys.js";
import { VaultBlobError, VaultConfigurationError } from "./seal.js";
import { verifyTicket } from "./ticket.js";

/**
 * What the relay gets: the key, where it goes, and the one address it may be
 * sent to. `cloudflareToken` is set for a connection through Cloudflare AI Gateway.
 * @typedef {{ key?: { value: string, header: string, format: string }, cloudflareToken?: string, target: string }} SessionKey
 */

/** A refusal the relay can act on: a code, never a secret. */
export class RelayKeyRefused extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "RelayKeyRefused";
    this.code = code;
  }
}

/**
 * @param {string} code
 * @param {string | null} sessionId
 * @returns {never}
 */
function refuse(code, sessionId) {
  console.log(JSON.stringify({ level: "warn", message: "relay_key_refused", code, session: sessionId }));
  throw new RelayKeyRefused(code);
}

/**
 * The session's key, for the relay.
 * @param {import("./seal.js").VaultEnv} env
 * @param {unknown} ticketText
 * @param {{ restart?: boolean, now?: number }} [options]
 * @returns {Promise<SessionKey>}
 */
export async function sessionKey(env, ticketText, options = {}) {
  /** @type {import("./ticket.js").Ticket | null} */
  let ticket;
  try {
    ticket = await verifyTicket(ticketText, env.RELAY_TICKET_PUBLIC_KEY);
  } catch {
    return refuse("misconfigured", null);
  }
  if (ticket === null) return refuse("ticket_refused", null);
  const now = options.now ?? Date.now();
  if (options.restart !== true && now >= ticket.exp) return refuse("ticket_expired", ticket.sid);
  const credentials = readCredentials(ticket.seal);
  if (credentials === null) return refuse("bad_seal", ticket.sid);
  const key = credentials.providerKey;
  const token = credentials.cloudflareToken;
  // Only session seals: copies bound to their own expiry, for this ticket's account.
  if (key !== undefined && (key.identity.length !== 7 || key.identity[0] !== ticket.account)) return refuse("bad_seal", ticket.sid);
  if (token !== undefined && (token.identity.length !== 5 || token.identity[0] !== ticket.account)) return refuse("bad_seal", ticket.sid);
  const target = allowedUrl(ticket.url, credentials);
  if (target === null) return refuse("destination_refused", ticket.sid);
  const memo = {};
  try {
    /** @type {SessionKey} */
    const answer = { target };
    if (key !== undefined) {
      const value = await keyForRequest(env, "storedProviderKey", key.identity, key.blob, { credential: null, memo });
      answer.key = { value, header: key.header ?? "", format: key.format ?? "" };
    }
    if (token !== undefined) answer.cloudflareToken = await keyForRequest(env, "storedCloudflareToken", token.identity, token.blob, { credential: null, memo });
    return answer;
  } catch (error) {
    if (error instanceof VaultConfigurationError) return refuse("misconfigured", ticket.sid);
    if (error instanceof VaultBlobError) return refuse("credential_unavailable", ticket.sid);
    return refuse("credential_unavailable", ticket.sid);
  }
}
