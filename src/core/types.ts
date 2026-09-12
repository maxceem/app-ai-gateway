import type { EndpointApiStyle } from "./providers";

export type { EndpointApiStyle, ProviderType } from "./providers";

export interface ClaimRequirement {
  path: string;
  contains?: string | string[];
  equals?: string | number | boolean;
}

export type GatewayAuthMethod = "attest" | "api_key";

/** The identity providers the console knows how to write an issuer for. */
export const ISSUER_PROVIDERS = ["firebase", "supabase", "auth0", "clerk", "custom"] as const;
export type IssuerProvider = (typeof ISSUER_PROVIDERS)[number];

/** How `required_claims` says a user has paid. */
export const ENTITLEMENT_CHECKS = ["revenuecat", "custom"] as const;
export type EntitlementCheck = (typeof ENTITLEMENT_CHECKS)[number];

export interface IssuerAuthConfig {
  jwks_url: string;
  /**
   * Accepted `iss` values. Required, and the only thing that scopes an app to
   * one tenant: Firebase, Sign in with Apple and Google Sign-In all sign every
   * customer's tokens with one shared key set, so a JWKS URL identifies nobody.
   * Stored as a list because a project can be migrated between issuers.
   */
  issuer: string[];
  /** Accepted `aud` values, required for the same reason as {@link issuer}. */
  audience: string[];
  user_id_claim: string;
  token_header?: string;
  required_claims: ClaimRequirement[];
  max_token_lifetime_seconds: number;
  /**
   * Which provider the scoping fields were written for, and which kind of
   * paid-user check `required_claims` implements. The console's bookkeeping:
   * the gateway verifies from the fields above and reads neither. They are
   * carried through the parse rather than derived, because a check like
   * RevenueCat is a claim of an ordinary shape — nothing in the stored claim
   * says it was meant as one, so a save that dropped this would reopen the
   * form on "custom" and leave the operator re-answering a question they
   * already answered.
   */
  provider?: IssuerProvider;
  entitlement?: EntitlementCheck;
}

export type AppAttestEnvironment = "production" | "development";

/**
 * How the gateway learns which end user a request acts for — the one question
 * `end_user` answers, and the reason it is a union rather than a set of flags.
 * `type` says how the *client* proves itself; this says how the *user* is
 * identified. The two are orthogonal, and keeping them apart is what stops a
 * configuration from claiming two identities at once.
 *
 * Ordered by how much the answer can be trusted: asserted by a backend you
 * control, proved by an installation Apple attested, or proved by a token the
 * gateway verifies against an issuer.
 */
export interface HeaderEndUser {
  /**
   * Asserted by the caller in a header, and therefore only meaningful when the
   * caller is the organization's own server. Required whenever it is chosen:
   * an app that collects user ids and tolerates their absence would silently
   * meter half its traffic as one user.
   */
  source: "header";
  /** Lowercased on the way in, since header lookups are case-insensitive. */
  header: string;
}

export interface IssuerEndUser {
  source: "issuer";
  issuer: IssuerAuthConfig;
}

export interface AppInstallEndUser {
  /**
   * The App Attest key id, which Apple binds to one installation of one app on
   * one device. Nothing is self-reported, so per-install limits and blocks hold
   * without a login — but the key does not survive reinstalling or clearing the
   * app's data, so a determined user can shed one by starting over.
   */
  source: "app_install";
}

/** An `api_key` app cannot use `app_install`: it has no attested key. */
export type ApiKeyEndUser = HeaderEndUser | IssuerEndUser;

/**
 * An App Attest app cannot use `header`: the client is the end user's own
 * device, so letting it name itself would put the party being limited in charge
 * of the limit.
 */
export type AppAttestEndUser = IssuerEndUser | AppInstallEndUser;

export type EndUserIdentity = HeaderEndUser | IssuerEndUser | AppInstallEndUser;

export interface AppleAppAttestAuthentication {
  type: "apple_app_attest";
  app_attest: {
    team_id: string;
    bundle_id: string;
    /** Resolved, so never empty: a stored config without one reads as production-only. */
    environments: AppAttestEnvironment[];
  };
  /** Mandatory: an attested client always resolves to some end user. */
  end_user: AppAttestEndUser;
}

/**
 * As written to `config_json`, where `environments` appears only for an
 * application that opted in. Keeping it absent otherwise means an ordinary edit
 * never rewrites a configuration to name a default it never asked for, the same
 * way an absent `limits` stays absent.
 */
export interface StoredAppleAppAttestAuthentication {
  type: "apple_app_attest";
  app_attest: {
    team_id: string;
    bundle_id: string;
    environments?: AppAttestEnvironment[];
  };
  end_user: AppAttestEndUser;
}

export interface ApiKeyAuthentication {
  type: "api_key";
  /**
   * Absent means the application has no end users at all, not that they default
   * to something. Every request is then the API key's own, `per_user` limits are
   * refused as meaningless, and usage records no user.
   */
  end_user?: ApiKeyEndUser;
}

export type AuthenticationConfig = AppleAppAttestAuthentication | ApiKeyAuthentication;
export type StoredAuthenticationConfig = StoredAppleAppAttestAuthentication | ApiKeyAuthentication;

export interface ProviderProxyConfig {
  allowed_paths: AllowedPath[];
  allowed_models: string[];
  max_output_tokens?: number;
}

export type OutputClampStyle =
  | "responses"
  | "chat_completions"
  | "gemini_native"
  | "anthropic"
  | "none";

export interface AllowedPathConfig {
  path: string;
  fixed_model?: string;
  clamp?: OutputClampStyle;
}

export type AllowedPath = string | AllowedPathConfig;

export interface RoutingConfig {
  providers: {
    mode: "all" | "selected";
    selected?: Record<string, ProviderProxyConfig>;
  };
  model_rewrites: Record<string, string>;
}

export interface ResolvedRoutingConfig {
  providerMode: "all" | "selected";
  providers: Record<string, ProviderProxyConfig>;
  modelRewrites: Record<string, string>;
}

/**
 * Limits an organization sets on its own application, applied to that
 * application's end users.
 *
 * Not to be confused with the plan allowance in `src/do/OrgQuota.ts`: that is
 * the gateway operator metering the organization, this is the organization
 * policing the people using its app. Neither constrains the other, and a
 * request refused here never spends the allowance.
 *
 * `null` on any field means unlimited. `per_user` applies independently to
 * every authenticated end user; `per_app` is shared by all of them at once.
 */
export interface LimitScopeConfig {
  requests: {
    per_minute: number | null;
    per_day: number | null;
  };
  spending: {
    monthly_usd: number | null;
  };
}

export interface LimitsConfig {
  per_user: LimitScopeConfig;
  per_app: LimitScopeConfig;
}

/**
 * Named endpoints resolve provider and model on the server so an operator can
 * swap models without shipping a new client. Only providers whose native
 * request shape the gateway can compose are allowed.
 */
export interface EndpointTarget {
  /** Provider instance slug, resolved to a provider type at request time. */
  provider: string;
  model: string;
}

export interface EndpointConfig extends EndpointTarget {
  api_style: EndpointApiStyle;
  params?: Record<string, unknown>;
  max_output_tokens?: number;
  fallback?: EndpointTarget[];
}

export type EndpointsConfig = Record<string, EndpointConfig>;

export interface StoredAppConfig {
  authentication: StoredAuthenticationConfig;
  routing: RoutingConfig;
  /** Absent means unlimited, the same way an absent `endpoints` means none. */
  limits?: LimitsConfig;
  endpoints?: EndpointsConfig;
}

/** {@link LimitScopeConfig} as the request path reads it: budgets in microUSD. */
export interface ResolvedLimitScope {
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  monthlyBudgetMicrousd: number | null;
}

export interface ResolvedLimitsConfig {
  perUser: ResolvedLimitScope;
  perApp: ResolvedLimitScope;
}

export interface AppConfig {
  id: string;
  organizationId: string;
  name: string;
  authentication: AuthenticationConfig;
  routing: ResolvedRoutingConfig;
  /** Always present; an app with no `limits` block resolves to all-null. */
  limits: ResolvedLimitsConfig;
  endpoints: EndpointsConfig;
  status: "active" | "disabled";
}

export interface GatewayIdentity {
  appId: string;
  /**
   * Null when the application identifies no end users, which is a real state
   * rather than a missing value: there is nobody to meter, block or attribute
   * usage to, and every per-user facility is skipped rather than applied to a
   * stand-in. Only an `api_key` app with no `end_user` reaches it.
   */
  userId: string | null;
  jti: string;
  expiresAt: number;
  authMethod: GatewayAuthMethod;
  credentialType: "api_key" | "gateway_token";
  apiKeyId?: string;
}

export interface UsageCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}
