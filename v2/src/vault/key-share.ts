/**
 * The credential a request brought, for an account with split keys on (plan
 * step 8j): what lets the vault open the account's root, and so its provider
 * keys, for this request only.
 *
 * It holds the credential's secret, so it never prints: `toJSON` and
 * `toString` name only the credential, and the secret is a private field no
 * log, spread or serializer can reach. The gateway passes it to the vault
 * with a call and nowhere else.
 *
 * Phase 1 makes one for an app key sent on the request. Phase 3 adds the
 * share an app sends at `/auth/token`, sealed into its gateway token.
 */
import type { KeySlotCredentialKind } from "../db/schema.ts";

/** A credential's keyslot, sealed, and the ids it is sealed to: account, credential, kind. */
export interface SealedKeySlot {
  readonly blob: string;
  readonly identity: readonly [accountId: string, credentialId: string, credentialKind: KeySlotCredentialKind];
}

/** What the vault is sent with a call (`vault/src/keys.js`, `RequestCredential`). */
export interface VaultRequestCredential {
  readonly secret: string;
  readonly slot: string;
  readonly slotIdentity: readonly string[];
}

export class KeyShare {
  readonly #secret: string;
  readonly slot: SealedKeySlot;

  constructor(secret: string, slot: SealedKeySlot) {
    this.#secret = secret;
    this.slot = slot;
  }

  /** The account whose root this credential's keyslot holds. */
  get accountId(): string {
    return this.slot.identity[0];
  }

  /** For the vault only. */
  forVault(): VaultRequestCredential {
    return { secret: this.#secret, slot: this.slot.blob, slotIdentity: [...this.slot.identity] };
  }

  toJSON(): Record<string, string> {
    return { credentialId: this.slot.identity[1], credentialKind: this.slot.identity[2] };
  }

  toString(): string {
    return `[key share ${this.slot.identity[2]} ${this.slot.identity[1]}]`;
  }
}
