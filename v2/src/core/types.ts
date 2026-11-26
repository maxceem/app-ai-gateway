import type { KeyShare } from "../vault/key-share.ts";
import type { AuthenticationConfig, ConversationsConfig, LimitsConfig, PresetsConfig, RoutingConfig } from "../contracts/app-config.ts";

/** How the client first proved itself. A gateway token carries this over from its exchange. */
export type AuthMethod = "attest" | "api_key";

/** An app as the request path reads it. */
export interface AppRecord {
  id: string;
  accountId: string;
  name: string;
  status: "active" | "disabled";
  revision: number;
  authentication: AuthenticationConfig;
  routing: RoutingConfig;
  /** The limits the customer set on the app and its end users. */
  limits: LimitsConfig;
  /** The app's presets, by slug (plan section 4.4). */
  presets: PresetsConfig;
  /** Conversation storage, where the app turned it on (`conversations.store`); null otherwise. */
  conversations: ConversationsConfig | null;
  /**
   * Whether the app's account is waiting for its owner's email address, so
   * refused where the deployment verifies email (`../core/account-standing.ts`),
   * read with the app itself.
   */
  accountPending: boolean;
}

interface GatewayIdentityFields {
  appId: string;
  /** Null for an app that identifies no end users. */
  userId: string | null;
  /** What this request presented: an app key on every request, or a gateway token. */
  credentialType: "api_key" | "gateway_token";
  /** The app key that authenticated the request, or that the gateway token was exchanged with. */
  apiKeyId?: string;
  /**
   * For an account with split keys on, the credential that opens its
   * provider keys for this request (plan step 8j). Set only when the
   * credential has a keyslot; it never prints.
   */
  keyShare?: KeyShare;
}

/**
 * Who a request is, and how the client proved it.
 *
 * `installId` is the App Attest key id of the install. Every App Attest
 * identity has one. `appleAccountId` is the hashed Apple Account the install
 * belongs to, when the token exchange was given an App Store transaction that
 * verified.
 */
export type GatewayIdentity =
  | (GatewayIdentityFields & { authMethod: "attest"; installId: string; appleAccountId: string | null })
  | (GatewayIdentityFields & { authMethod: "api_key"; installId: null; appleAccountId: null });
