// @ts-check
/**
 * The vault Worker: the only Worker that opens provider keys outside a live
 * session. Plain JavaScript with no npm packages, uploaded as it is.
 *
 * The gateway reaches it through one service binding (`VAULT`):
 * - `fetch`: one call to a provider, with the sealed credentials in the
 *   `x-agw-vault` header (`./call.js`);
 * - `holds`: which texts echo a call's credentials, for stored conversations;
 * - `seal`: a new credential, sealed as soon as it arrives (to the account's
 *   root as well, for an account with split keys on);
 * - `storeCopy`: copies of a call's credentials for work with no app request
 *   (split keys, plan step 8j);
 * - `reseal`: a credential sealed again for a new address, without leaving;
 * - `credentialMatches`: whether an app's credential (an iOS share) is the one
 *   its keyslot was made for (split keys, phase 3);
 * - `status`: whether its settings let it seal and open, for the health check.
 *
 * The relay reaches it through another entrypoint, `RelayKeys`, that only the
 * relay is bound to: it opens a live session's key (`./relay.js`). The deploy
 * refuses a gateway bound to it.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { callFromRequest, holds, storeCopy } from "./call.js";
import { reseal, seal, vaultStatus } from "./seal.js";
import { credentialMatches } from "./split.js";
import { sessionKey } from "./relay.js";

/** @extends {WorkerEntrypoint<import("./seal.js").VaultEnv>} */
export default class Vault extends WorkerEntrypoint {
  /**
   * @override
   * @param {Request} request
   */
  fetch(request) {
    return callFromRequest(this.env, request);
  }

  /**
   * @param {string} kind
   * @param {string[]} identity
   * @param {string} plaintext
   * @param {string} [rootPublicKey] the account's, when split keys are on
   */
  seal(kind, identity, plaintext, rootPublicKey) {
    return seal(this.env, kind, identity, plaintext, rootPublicKey);
  }

  /**
   * @param {unknown} credentials
   * @param {number} expiresAt
   */
  storeCopy(credentials, expiresAt) {
    return storeCopy(this.env, credentials, expiresAt);
  }

  /**
   * @param {unknown} credentials
   * @param {string[]} texts
   */
  holds(credentials, texts) {
    return holds(this.env, credentials, texts);
  }

  /**
   * @param {string} kind
   * @param {string[]} from
   * @param {string[]} to
   * @param {string} blob
   */
  reseal(kind, from, to, blob) {
    return reseal(this.env, kind, from, to, blob);
  }

  /**
   * @param {string} secret
   * @param {string} publicKey
   */
  credentialMatches(secret, publicKey) {
    return credentialMatches(secret, publicKey);
  }

  status() {
    return vaultStatus(this.env);
  }
}

/**
 * The relay's own entrypoint (plan step 9a): the key for a live session, from
 * its ticket. Only the relay is bound to it.
 * @extends {WorkerEntrypoint<import("./seal.js").VaultEnv>}
 */
export class RelayKeys extends WorkerEntrypoint {
  /**
   * @param {string} ticket
   * @param {{ restart?: boolean }} [options] a restart may go on past the ticket's expiry, not past the seal's
   */
  sessionKey(ticket, options) {
    return sessionKey(this.env, ticket, { restart: options?.restart === true });
  }
}
