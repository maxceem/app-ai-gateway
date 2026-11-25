// @ts-check
/**
 * The vault Worker: the only Worker that opens provider keys outside a live
 * session. Plain JavaScript with no npm packages, uploaded as it is.
 *
 * The gateway reaches it through one service binding (`VAULT`):
 * - `fetch`: one call to a provider, with the sealed credentials in the
 *   `x-agw-vault` header (`./call.js`);
 * - `holds`: which texts echo a call's credentials, for stored conversations;
 * - `seal`: a new credential, sealed as soon as it arrives;
 * - `reseal`: a credential sealed again for a new address, without leaving.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { callFromRequest, holds } from "./call.js";
import { reseal, seal } from "./seal.js";

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
   */
  seal(kind, identity, plaintext) {
    return seal(this.env, kind, identity, plaintext);
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
}
