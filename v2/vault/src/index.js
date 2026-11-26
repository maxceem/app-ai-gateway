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
 * - `status`: whether its settings let it seal and open, for the health check.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { callFromRequest, holds, storeCopy } from "./call.js";
import { reseal, seal, vaultStatus } from "./seal.js";

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

  status() {
    return vaultStatus(this.env);
  }
}
