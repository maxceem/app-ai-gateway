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
   * Whether the app's account may serve traffic where the deployment verifies
   * email (`../core/account-standing.ts`), read with the app itself.
   */
  accountActivated: boolean;
}

interface GatewayIdentityFields {
  appId: string;
  /** Null for an app that identifies no end users. */
  userId: string | null;
  /** What this request presented: an app key on every request, or a gateway token. */
  credentialType: "api_key" | "gateway_token";
  /** The app key that authenticated the request, or that the gateway token was exchanged with. */
  apiKeyId?: string;
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
