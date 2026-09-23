/**
 * The API's types, under the names the console calls them by.
 *
 * A barrel over `src/contracts`, which is where those shapes are defined once
 * and where the Worker's handlers are checked against them, so the console can
 * never describe a wire shape the gateway has moved. Type-only, so the console
 * bundle gains nothing at runtime.
 *
 * The one shape still written here is the editor's view of an application,
 * whose configuration model lives in `./config-types` because it is a form,
 * not a wire format.
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

/**
 * The optional billing service's contract.
 *
 * Its shapes belong to a separate Worker the gateway may be bound to and
 * passes through unchanged, so they are declared in `src/contracts/billing.ts`
 * beside the rest of the wire format rather than as interfaces here — the
 * gateway's RPC contract and the seven documented `/v1/admin/billing`
 * operations read the same definitions.
 */
export type {
  BillingPlanOffer as BillingPlan,
  BillingPlanOfferPrice as BillingPrice,
  BillingPlansResponse,
  BillingStatusResponse,
  BillingSubscriptionStatus,
  EntitledPlan,
  GatewayBillingAccess as BillingAccess,
  OrganizationQuotaStatus as OrganizationQuota,
  PlanLimits,
  SubscriptionActions,
  SubscriptionState,
} from "@contracts/billing";
