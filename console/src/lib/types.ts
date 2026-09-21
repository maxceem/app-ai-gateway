/**
 * The API's types, under the names the console calls them by.
 *
 * This file used to describe every wire shape a second time, by hand, with
 * nothing that noticed when the gateway's own answer moved. It is now a barrel
 * over `src/contracts`, which is where those shapes are defined once and where
 * the Worker's handlers are checked against them. Type-only, so the console
 * bundle gains nothing at runtime.
 *
 * What is still written here is what has no API counterpart: the billing
 * service's own contract, which the gateway passes through rather than owns,
 * and the editor's view of an application, whose configuration model lives in
 * `./config-types` because it is a form, not a wire format.
 */
import type { AppConfigDraft } from "./config-types";
import type { AppConfig } from "@shared/app-config";
import type { AppResponse as WireAppResponse, CreatedApiKey } from "@contracts/responses";

export type {
  ApiKeyListResponse,
  AppListResponse,
  AppSummary,
  AuthEvent,
  AuthEventSummary,
  BreakdownResponse,
  BreakdownRow,
  CreatedApiKey,
  GatewayUser,
  ManagementKeyListResponse,
  ModelPrice,
  OrganizationListResponse,
  OrganizationMembership,
  OrganizationSummary,
  PricesResponse,
  ProviderGatewayListResponse,
  ProviderGatewayResponse,
  ProviderListResponse,
  ProviderResponse,
  TimeseriesBucket,
  TimeseriesResponse,
  UsageEvent,
  UsageTotals,
  UserListResponse,
} from "@contracts/responses";

export type {
  GatewayRouteConfigInput as GatewayRouteConfig,
  OrganizationRole,
  ProviderCreateRequest as ProviderCreateBody,
  ProviderGatewayCreateRequest as ProviderGatewayCreateBody,
  ProviderGatewayTestRequest as ProviderGatewayTestBody,
  ProviderPricing,
  ProviderTestRequest as ProviderTestBody,
  ProviderUpdateRequest as ProviderUpdateBody,
} from "@contracts/schemas";

import type {
  ApiKey,
  AuthEvent,
  AuthEventList,
  AuthEventSummary,
  ConsoleCapabilitiesResponse,
  CreatedManagementKeyResponse,
  IdentitySession,
  ManagementKeySummary,
  ProviderGatewayProbeReason,
  ProviderGatewaySummary,
  ProviderGatewayTestResponse,
  ProviderSummary,
  UsageEvent,
  UsageEventList,
} from "@contracts/responses";

/** Optional deployment features, read once before the app renders. */
export type Capabilities = ConsoleCapabilitiesResponse;

export type Session = IdentitySession["session"];
export type SessionResponse = IdentitySession;
export type IdentityUser = NonNullable<Session["user"]>;

export type ManagementKey = ManagementKeySummary;
/** The plaintext token is present exactly once, in the create response. */
export type CreatedManagementKey = CreatedManagementKeyResponse["key"];

export type ProviderGateway = ProviderGatewaySummary;
export type ProviderGatewayType = ProviderGatewaySummary["type"];
export type CfAigConfig = Extract<ProviderGatewaySummary, { type: "cf_aig" }>["config"];
/** Vercel's origin is fixed in adapter code, so its config is empty. */
export type VercelGatewayConfig = Extract<ProviderGatewaySummary, { type: "vercel" }>["config"];

export type ProviderCredential = ProviderSummary;

/**
 * Why a probe did not confirm a credential. The gateway dry run is the wider of
 * the two — only it reports `rejected` — and the console shows both through one
 * component, so it reads the wider vocabulary.
 */
export type ProbeReason = ProviderGatewayProbeReason;
export type ProviderTestResult = ProviderGatewayTestResponse;

export type ApiKeyRow = ApiKey;
export type UsageStatus = UsageEvent["status"];
export type CostSource = NonNullable<UsageEvent["cost_source"]>;
export type CredentialSource = NonNullable<UsageEvent["credential_source"]>;
export type EventsResponse = UsageEventList;
export type AuthEventName = AuthEvent["event"];
export type AuthEventsResponse = AuthEventList;
export type AuthOutcomeBucket = AuthEventSummary["daily"][number];
export type UsageFailureBucket = AuthEventSummary["usage_failures"][number];

/**
 * An application as the editor holds it.
 *
 * Everything except `config` comes straight from the API's own `AppResponse`.
 * `config` is the console's model — see `./config-types` — because the editor
 * works on partially filled forms and named draft states the wire format has
 * no vocabulary for. It is the one shape here that is deliberately not the
 * contract's, and `client-api.ts` is where the two meet.
 */
type AppMetadata = Omit<WireAppResponse["app"], "config">;
export type AppRow = AppMetadata & { config: AppConfig };

export interface ValidAppResponse {
  kind: "valid";
  app: AppRow;
  config_error: null;
}

export interface InvalidAppResponse {
  kind: "invalid";
  app: AppMetadata & { config: Record<string, unknown> };
  config_error: string;
}

export type AppResponse = ValidAppResponse | InvalidAppResponse;

export interface AppUpsertBody {
  name: string;
  config: AppConfigDraft;
  status?: "active" | "disabled";
}

/**
 * Creating an app carries no id: the gateway derives one from the name and
 * answers with the created application, whose `app.id` holds it.
 */
export type AppCreateBody = AppUpsertBody;

/**
 * A create answers with the application itself, exactly as a read or an update
 * does, plus the one-time key an API-key application is born with.
 */
export type CreatedApp = ValidAppResponse & { api_key: CreatedApiKey | null };

export interface MonthlyUsage {
  app_id: string;
  month: string;
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

// ---------------------------------------------------------------------------
// The optional billing service's contract.
//
// Not sourced from `src/contracts`: these are the shapes of a separate Worker
// the gateway may be bound to, passed through unchanged. The gateway declares
// them in `src/billing/`, which imports its own error and logging modules and
// so cannot be read from a browser build without splitting it up — a change
// that belongs with the billing system rather than with this one.
// ---------------------------------------------------------------------------

/** Raw LemonSqueezy subscription status, passed through unmapped. */
export type BillingSubscriptionStatus =
  | "on_trial"
  | "active"
  | "paused"
  | "past_due"
  | "unpaid"
  | "cancelled"
  | "expired";

/**
 * The plan the organization may use right now. Resolved either from an
 * access-granting subscription or, failing that, from the service's default
 * plan — which is what `isDefault` distinguishes.
 */
export interface EntitledPlan {
  planKey: string;
  planName: string;
  limits?: unknown;
  isDefault: boolean;
}

/**
 * What the organization is paying for, reported whether or not it still
 * entitles anything: a lapsed subscription is exactly what "your plan ended"
 * is written from.
 */
export interface SubscriptionState {
  subscriptionId: string | null;
  status: BillingSubscriptionStatus;
  planKey: string;
  planName: string;
  billingPeriod: "month" | "year" | null;
  renewsAt: string | null;
  endsAt: string | null;
  trialEndsAt: string | null;
  source: "lemon_squeezy" | "manual";
  createdAt: string;
  updatedAt: string;
  billingAnchorDay: number | null;
  billingAnchorAt: string;
  billingScheduleUpdatedAt: string;
}

/**
 * Mirrors the gateway's `GatewayBillingAccess`. The two non-`billed` states are
 * the gateway's own: the billing service does not know it is absent, nor that
 * it is unreachable.
 */
export type BillingAccess =
  | { state: "self_hosted" }
  | { state: "unavailable"; billingErrorCode?: string }
  | {
      state: "billed";
      plan: EntitledPlan | null;
      subscription: SubscriptionState | null;
      /** The last reading, served because the billing service is unreachable. */
      stale?: true;
      billingErrorCode?: string;
    };

/**
 * The organization's current plan period against the allowance its plan grants.
 * `limit` is absent on a plan that sets no ceiling. Only ever read from a
 * deployment with billing enabled; self-hosted consoles never fetch it.
 */
export interface OrganizationQuota {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  used: number;
  limit?: number;
  resetAt: string;
}

/**
 * The plan's ceilings, parsed by the gateway rather than read raw off
 * `plan.limits`. Every key is optional and an absent one means unlimited, so an
 * empty object is a plan with no ceilings at all.
 */
export interface PlanLimits {
  maxRequestsPerMonth?: number;
  maxApps?: number;
  maxProviders?: number;
  maxProviderGateways?: number;
  maxActiveKeysPerApp?: number;
}

export interface BillingStatusResponse {
  access: BillingAccess;
  limits: PlanLimits;
  quota: OrganizationQuota | null;
}

export interface BillingPrice {
  billingPeriod: "month" | "year";
  priceAmountCents: number;
  priceCurrency: string;
}

export interface BillingPlan {
  planKey: string;
  name: string;
  description: string;
  features: string[];
  trialDays: number;
  prices: BillingPrice[];
}

export interface BillingPlansResponse {
  plans: BillingPlan[];
}
