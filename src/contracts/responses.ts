/**
 * Every documented response body, as one schema per shape.
 *
 * These are the definition of the wire format. `openapi.ts` imports them and
 * publishes them,
 * the Worker handlers `satisfies` the inferred types so a drifting handler
 * fails `pnpm run check`, the console imports the types alone, and the CLI
 * parses real responses with the schemas themselves.
 *
 * Plain `zod`, never `@hono/zod-openapi`: the CLI bundles this module and must
 * not pull Hono in behind it. `.meta({ id })` registers a named component
 * exactly as `.openapi("Name")` does, and `.meta({ description })` a field
 * description — the generated document is byte-identical either way.
 */
import { z } from "zod";
import { PROVIDER_TYPES } from "../core/providers.ts";
import {
  AppConfigSchema,
  GatewayRouteConfigSchema,
  OrganizationRoleSchema,
  ProviderPricingSchema,
  StoredSlugSchema,
} from "./schemas.ts";

/**
 * What happened to one served request: answered (`ok`), failed upstream, or
 * refused before any provider was called — by the organization's own app
 * limits (`blocked_app_*`), by the plan allowance (`blocked_billing`), or by an
 * operator (`blocked_user`). The one list: the stored column, the recorder, the
 * event filter and this document all read it.
 */
export const USAGE_STATUSES = [
  "ok",
  "provider_error",
  "blocked_app_rate",
  "blocked_app_budget",
  "blocked_billing",
  "blocked_user",
] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

/** The dimensions a usage breakdown can group by. */
export const USAGE_BREAKDOWN_DIMENSIONS = [
  "model",
  "provider",
  "provider_slug",
  "provider_gateway",
  "credential_source",
  "model_author",
  "user",
  "status",
  "cost_source",
  "route",
  "endpoint",
  "app_version",
] as const;
export type UsageBreakdownDimension = (typeof USAGE_BREAKDOWN_DIMENSIONS)[number];

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().meta({
      description: "Machine-readable facts about this rejection, present only where the code alone is not actionable. A billing_request_quota_exceeded rejection carries periodId, periodStart, periodEnd, limit, used, and resetAt; a billing_plan_limit_reached rejection carries limit and used; an app_rate_limited or app_budget_exhausted rejection carries scope, either user or app; a rate_limited rejection carries scope naming the endpoint policy that refused, plus limit, windowSeconds, retryAfterSeconds and resetAt.",
    }),
  }),
}).meta({ id: "ErrorResponse" });

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("app-ai-gateway"),
  vault: z.enum(["ok", "misconfigured"]),
});

export const ConsoleCapabilitiesResponseSchema = z.object({
  billing: z.boolean(),
  registrationOpen: z.boolean(),
  googleAuth: z.boolean(),
  termsOfServiceUrl: z.string().url().optional(),
  privacyPolicyUrl: z.string().url().optional(),
  apiBaseUrl: z.string().url().optional(),
});

export const AppAttestChallengeResponseSchema = z.object({
  challenge: z.string(),
  expires_in: z.number(),
});

export const AppAttestRegisterResponseSchema = z.object({ user_id: z.string() });

export const GatewayTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

/**
 * Where one end user stands against the limits their application sets.
 *
 * The account's request allowance is deliberately absent: that is the
 * organization's arrangement with the gateway rather than its users' business,
 * and it is reported on the rejection that spends it.
 */
export const CurrentUserResponseSchema = z.object({
  user_id: z.string(),
  limits: z.object({
    requests_today: z.number().int().nullable().meta({ description: "Requests this user has made so far in the current UTC day. Null when the application sets no per-user limit, in which case requests are not counted at all." }),
    requests_remaining: z.number().int().nullable().meta({ description: "What is left of requests_per_day. Null when no daily limit is set." }),
    requests_per_minute: z.number().nullable().meta({ description: "The per-user per-minute limit this app sets. Null means unlimited." }),
    requests_per_day: z.number().nullable().meta({ description: "The per-user per-day limit this app sets. Null means unlimited." }),
    monthly_cost_usd: z.number().meta({ description: "What this user's traffic has cost so far in the current UTC calendar month." }),
    monthly_budget_usd: z.number().nullable().meta({ description: "The per-user monthly spending budget this app sets. Null means unlimited." }),
    blocked: z.boolean().meta({ description: "Whether this user has been blocked in the console." }),
  }).meta({
    description: "The limits the app sets on this user, and where the user stands against them. The account's request allowance is not reported here: it is shared by all apps, and is reported on the rejection that spends it.",
  }),
});

export const UsageEventSchema = z.object({
  id: z.number().int(),
  /** Null for an application that identifies no end users. */
  user_id: z.string().nullable(),
  api_key_id: z.string().nullable().meta({
    description: "Non-secret ID of the application API key that authenticated the request, including the client-proof key carried by an exchanged gateway token.",
  }),
  provider: z.string(),
  provider_slug: z.string().nullable(),
  provider_gateway_id: z.string().nullable().meta({
    description: "The gateway connection that carried the request, or null for a direct call. Recorded for every routed request; the id is kept even after the gateway row is deleted.",
  }),
  provider_gateway_type: z.string().nullable().meta({
    description: "That gateway's type at request time, for example cf_aig.",
  }),
  credential_source: z.enum(["direct", "byok", "gateway_system", "unknown"]).nullable().meta({
    description: "Whose credential paid, where something settles it: `direct` for an instance holding its own key, `byok` when a gateway serves it from your own key store or when a reporting upstream says your own key paid for the inference. Never inferred from a successful response; null when nothing settles it.",
  }),
  model_author: z.string().nullable().meta({
    description: "Who made the model, resolved when the event was recorded. An analytics dimension only — it never affects budgets or allowlists.",
  }),
  served_provider: z.string().nullable().meta({
    description: "The serving provider the upstream named, when it names one — the host OpenRouter routed to, for instance. Null means unknown, never a guarantee.",
  }),
  served_model: z.string().nullable().meta({
    description: "The serving model the upstream named, canonicalized back to the provider's own model ID.",
  }),
  model: z.string(),
  route: z.string(),
  endpoint_slug: z.string().nullable(),
  input_tokens: z.number().int(),
  cached_input_tokens: z.number().int(),
  cache_write_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_usd: z.number(),
  reported_cost_usd: z.number().nullable().meta({
    description: "What the upstream said the request cost, on routes that report one. Null everywhere else; cost_usd stays the billed figure either way.",
  }),
  cost_source: z.enum(["computed", "reported", "unresolved"]).nullable().meta({
    description: "How cost_usd was determined. `reported` is the upstream's own figure for this request, which is what was billed; `computed` is this deployment's price catalog; `unresolved` means the provider answered successfully but neither source could establish a cost, so the zero is unknown rather than measured. Null on blocked traffic and on events recorded before this field existed.",
  }),
  app_version: z.string().nullable(),
  auth_method: z.enum(["attest", "api_key"]).nullable(),
  status: z.enum(USAGE_STATUSES),
  client_aborted: z.number().int().nullable().meta({
    description: "1 when the client disconnected before the upstream finished streaming, which cancelled the provider call; null otherwise. Not a failure — the request was served as far as the caller wanted it — but an aborted stream often takes the provider's end-of-response usage with it, which is why such an event may carry cost_source unresolved.",
  }),
  latency_ms: z.number().int().nullable(),
  created_at: z.string(),
}).meta({ id: "UsageEvent" });

export const UsageEventListSchema = z.object({
  app_id: z.string(),
  limit: z.number().int(),
  next_before_id: z.number().int().nullable(),
  events: z.array(UsageEventSchema),
});

export const AuthEventSchema = z.object({
  id: z.number().int(),
  user_id: z.string().nullable().meta({
    description: "The verified issuer identity, where the attempt got far enough to establish one. Null for attempts refused before any identity was trusted.",
  }),
  event: z.enum(["token_exchange", "register"]),
  auth_method: z.enum(["attest", "api_key"]).nullable(),
  outcome: z.string().meta({
    description: "`ok`, or the error code the client was handed — for example issuer_claims_missing, issuer_token_rejected, attest_failed.",
  }),
  reason: z.string().nullable().meta({
    description: "The granular cause behind the outcome, for example claims_missing, bad_signature, jwks_unreachable. Diagnostic only: clients never see it.",
  }),
  app_version: z.string().nullable(),
  latency_ms: z.number().int().nullable(),
  claim_delay_ms: z.number().int().nullable().meta({
    description: "Set only on the exchange that ended a claim-propagation window: how long the user waited from their first issuer_claims_missing rejection.",
  }),
  created_at: z.string(),
}).meta({ id: "AuthEvent" });

export const AuthEventListSchema = z.object({
  app_id: z.string(),
  limit: z.number().int(),
  next_before_id: z.number().int().nullable(),
  events: z.array(AuthEventSchema),
});

export const AuthEventSummarySchema = z.object({
  app_id: z.string(),
  days: z.number().int(),
  from: z.string(),
  to: z.string(),
  daily: z.array(z.object({
    date: z.string(),
    event: z.enum(["token_exchange", "register"]),
    outcome: z.string(),
    reason: z.string().nullable(),
    count: z.number().int(),
  })).meta({ description: "Authentication attempts per day, grouped by outcome and granular reason." }),
  usage_failures: z.array(z.object({
    date: z.string(),
    status: z.string(),
    count: z.number().int(),
  })).meta({ description: "Non-ok proxied requests per day, so proxy-path failures appear in the same view." }),
  token_exchange: z.object({
    total: z.number().int(),
    ok: z.number().int(),
    success_rate: z.number().nullable().meta({
      description: "Null when the window contains no exchanges at all, which is not the same as a perfect score.",
    }),
  }),
  claim_delay: z.object({
    count: z.number().int(),
    avg_ms: z.number().nullable(),
    p50_ms: z.number().nullable(),
    p95_ms: z.number().nullable(),
  }).meta({ description: "How long users waited for a required entitlement claim to propagate, over the window." }),
  pending_users: z.number().int().meta({
    description: "Users currently inside an unclosed claim-propagation window — stuck mid-activation right now.",
  }),
}).meta({ id: "AuthEventSummary" });

/**
 * The one shape every single-application route answers with. Reading an app,
 * creating one and updating one all return the same object, so a client parses
 * one type and never has to ask which route produced it.
 */
export const AppResponseSchema = z.object({
  app: z.object({
    revision: z.number().int().positive(),
    id: z.string().meta({ description: "The gateway-assigned id, and the `{app}` segment of every URL for this application." }),
    name: z.string(),
    /**
     * An `AppConfig` — the parsed one, which is also the stored one: what the
     * gateway accepts is what it keeps, so there is no second "resolved" view
     * of it to publish. The one exception is the row this shape's own
     * `config_error` describes: a configuration written before a schema change
     * is returned as it is stored, so an operator can read and repair it, and
     * that is why this is declared as the union rather than as `AppConfig`.
     */
    config: z.union([AppConfigSchema, z.record(z.string(), z.unknown())]),
    status: z.enum(["active", "disabled"]),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  config_error: z.string().nullable().meta({ description: "Why the stored configuration does not parse, for a row written before a schema change. Always null on create and update, which validate before they write." }),
}).meta({ id: "AppResponse" });

export const AppDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  app_id: z.string(),
  removed_users: z.number().int(),
  usage_events_retained: z.literal(true),
});

export const ManagementKeySummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  name: z.string(),
  tokenHint: z.string().meta({
    description: "Last four characters of the token for display.",
    example: "x9Qb",
  }),
  enabled: z.boolean().meta({
    description:
      "Whether the key may authenticate. False for a revoked key, and for one issued by a trusted exchange that has not committed yet.",
  }),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

export const ManagementKeyListResponseSchema = z.object({
  keys: z.array(ManagementKeySummarySchema),
});

export const CreatedManagementKeyResponseSchema = z.object({
  key: ManagementKeySummarySchema.extend({ plaintext: z.string() }),
});

export const ManagementKeyResponseSchema = z.object({ key: ManagementKeySummarySchema });

export const ProviderSummarySchema = z.object({
  id: z.string(),
  type: z.enum(PROVIDER_TYPES),
  slug: StoredSlugSchema.meta({ description: "The URL segment used under /proxy/{slug}/, unique across your providers." }),
  name: z.string(),
  secretHint: z.string().nullable().meta({
    description: "Last characters of a direct provider key; null when a shared provider gateway owns the token.",
  }),
  providerGatewayId: z.string().nullable(),
  gatewayRoute: GatewayRouteConfigSchema.nullable().meta({
    description: "How this instance is routed inside its gateway. Always null for a direct instance and for gateways that take no routing configuration, such as Cloudflare AI Gateway.",
  }),
  baseUrl: z.string().nullable().meta({
    description: "Your own origin replacing the provider type's own base URL, stored canonicalized (https, public host, default port, trailing slash). Null means the provider type's own base URL is used. Always null on a gateway-routed instance, which cannot carry one.",
    example: "https://my-resource.openai.azure.com/openai/v1/",
  }),
  pricing: ProviderPricingSchema.nullable(),
  revision: z.number().int().positive(),
  status: z.enum(["active", "disabled"]).meta({
    description: "disabled is a reversible pause: the row keeps its secret, its pricing and its slug, and requests to it fail with provider_disabled until it is enabled again.",
  }),
  createdAt: z.string(),
  createdBy: z.string(),
}).meta({ id: "Provider" });

export const ProviderValidatedSchema = z.boolean().meta({
  description: "Whether the live probe confirmed the credential. false means the probe was inconclusive (provider outage, or no probe exists for this provider), not that the credential is bad — a credential the provider refuses fails this request with provider_key_invalid.",
});

export const ProbeReasonSchema = z.enum(["no_probe", "unreachable", "unexpected_status"]).meta({
  description: "Why an unvalidated probe proved nothing. Absent when validated is true.",
});

export const ProbeStatusSchema = z.number().int().meta({
  description: "The upstream status behind an unexpected_status or rejected reason.",
});

export const ProviderListResponseSchema = z.object({
  providers: z.array(ProviderSummarySchema),
});

export const ProviderResponseSchema = z.object({ provider: ProviderSummarySchema });

export const ProviderTestResponseSchema = z.object({
  validated: ProviderValidatedSchema,
  reason: ProbeReasonSchema.optional(),
  status: ProbeStatusSchema.optional(),
});

export const ProviderDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  provider_id: z.string(),
});

/** Everything about a gateway that does not depend on which gateway it is. */
const providerGatewayFields = {
  id: z.string(),
  name: z.string(),
  secretHint: z.string().meta({
    description: "The last characters of the gateway token. The token itself is never returned.",
  }),
  providerCount: z.number().int().nonnegative().meta({
    description: "Active provider instances routed through this gateway.",
  }),
  referencedCount: z.number().int().nonnegative().meta({
    description:
      "All provider instances referencing this gateway, including disabled rows retained for re-enabling. Deletion is refused while this is above zero.",
  }),
  revision: z.number().int().positive(),
  status: z.enum(["active", "revoked"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
};

/**
 * Discriminated by `type`, because each gateway's `config` is its own shape:
 * Cloudflare's account and gateway pair, and nothing at all for Vercel, whose
 * origin is fixed in adapter code and whose team is named by the token.
 */
export const ProviderGatewaySummarySchema = z.discriminatedUnion("type", [
  z.object({
    ...providerGatewayFields,
    type: z.literal("cf_aig"),
    config: z.object({ accountId: z.string(), gatewayId: z.string() }),
  }),
  z.object({
    ...providerGatewayFields,
    type: z.literal("vercel"),
    config: z.object({}).meta({
      description: "Vercel's origin is fixed in adapter code, so it has no configuration of its own.",
    }),
  }),
]).meta({ id: "ProviderGateway" });

export const GatewayValidatedSchema = z.boolean().meta({
  description: "Whether the live probe confirmed the connection. Unlike the providers API, a refused token is not an error here: a Cloudflare AI Gateway answers 401 both for a wrong token and for a gateway that is not finished being set up, so the verdict is reported as reason: rejected and the caller decides what it means.",
});

export const GatewayProbeReasonSchema = z
  .enum(["no_probe", "unreachable", "unexpected_status", "rejected"])
  .meta({
    description: "Why the probe did not confirm the connection. Absent when validated is true. rejected means the gateway refused the token.",
  });

export const ProviderGatewayListResponseSchema = z.object({
  gateways: z.array(ProviderGatewaySummarySchema),
});

export const ProviderGatewayResponseSchema = z.object({
  gateway: ProviderGatewaySummarySchema,
});

export const ProviderGatewayTestResponseSchema = z.object({
  validated: GatewayValidatedSchema,
  reason: GatewayProbeReasonSchema.optional(),
  status: ProbeStatusSchema.optional(),
});

export const ProviderGatewayDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  provider_gateway_id: z.string(),
});

export const OrganizationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  claimed: z.boolean(),
  expiresAt: z.string().nullable(),
});

export const OrganizationMembershipSchema = z.object({
  organization: OrganizationSummarySchema,
  role: OrganizationRoleSchema,
  status: z.literal("active"),
  joinedAt: z.string(),
});

export const IdentitySessionSchema = z.object({
  session: z.object({
    user: z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      kind: z.enum(["human", "service"]),
      emailVerified: z.boolean(),
      image: z.string().nullable(),
      createdAt: z.string(),
    }).nullable(),
    organization: OrganizationSummarySchema.nullable(),
    role: OrganizationRoleSchema,
    memberships: z.array(OrganizationMembershipSchema),
    credentialType: z.enum(["session", "apiKey"]),
    /**
     * How the caller proved who they are: `interactive` for a human who just
     * signed in, `credential` for a key. The CLI's browser handoff refuses to
     * complete a claim on anything but the former, and this is where a client
     * can see which it holds.
     */
    assurance: z.enum(["interactive", "credential"]).nullable(),
    /** The identity acting, which for a management key is the key's owner. */
    actor: z.object({
      type: z.literal("user"),
      id: z.string(),
      kind: z.enum(["human", "service"]),
      credentialId: z.string().nullable(),
      actionSource: z.string(),
    }).nullable(),
  }),
});

export const OrganizationListResponseSchema = z.object({
  organizations: z.array(OrganizationMembershipSchema),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type GatewayTokenResponse = z.infer<typeof GatewayTokenResponseSchema>;
export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;
export type ConsoleCapabilitiesResponse = z.infer<typeof ConsoleCapabilitiesResponseSchema>;
export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type UsageEventList = z.infer<typeof UsageEventListSchema>;
export type AuthEvent = z.infer<typeof AuthEventSchema>;
export type AuthEventList = z.infer<typeof AuthEventListSchema>;
export type AuthEventSummary = z.infer<typeof AuthEventSummarySchema>;
export type AppResponse = z.infer<typeof AppResponseSchema>;
export type AppDeleteResponse = z.infer<typeof AppDeleteResponseSchema>;
export type ManagementKeySummary = z.infer<typeof ManagementKeySummarySchema>;
export type ManagementKeyListResponse = z.infer<typeof ManagementKeyListResponseSchema>;
export type CreatedManagementKeyResponse = z.infer<typeof CreatedManagementKeyResponseSchema>;
export type ManagementKeyResponse = z.infer<typeof ManagementKeyResponseSchema>;
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;
export type ProbeReason = z.infer<typeof ProbeReasonSchema>;
export type ProviderGatewayProbeReason = z.infer<typeof GatewayProbeReasonSchema>;
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;
export type ProviderTestResponse = z.infer<typeof ProviderTestResponseSchema>;
export type ProviderDeleteResponse = z.infer<typeof ProviderDeleteResponseSchema>;
export type ProviderGatewaySummary = z.infer<typeof ProviderGatewaySummarySchema>;
export type ProviderGatewayListResponse = z.infer<typeof ProviderGatewayListResponseSchema>;
export type ProviderGatewayResponse = z.infer<typeof ProviderGatewayResponseSchema>;
export type ProviderGatewayTestResponse = z.infer<typeof ProviderGatewayTestResponseSchema>;
export type ProviderGatewayDeleteResponse = z.infer<typeof ProviderGatewayDeleteResponseSchema>;
export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>;
export type OrganizationMembership = z.infer<typeof OrganizationMembershipSchema>;
export type IdentitySession = z.infer<typeof IdentitySessionSchema>;
export type OrganizationListResponse = z.infer<typeof OrganizationListResponseSchema>;

/**
 * The rest of the admin surface. `./catalog.ts` documents each operation with
 * these, so the handler, the document, the console and the CLI all move
 * together.
 */
export const UsageTotalsSchema = z.object({
  requests: z.number(),
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  cache_write_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
  errors: z.number(),
  blocked: z.number(),
});

export const AppSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "disabled"]),
  authentication_type: z.enum(["apple_app_attest", "api_key", "invalid"]),
  apple_bundle_id: z.string().nullable(),
  created_at: z.string(),
  providers: z.array(z.string()),
  /**
   * The slugs this app names outright: selected-mode policy keys, endpoint
   * targets and endpoint fallbacks. Unlike `providers`, an all-mode app is not
   * expanded here — it reaches every instance without referencing any.
   */
  referenced_providers: z.array(z.string()),
  allowed_model_count: z.number(),
  /** What the whole app may spend this month; `null` is unlimited. */
  monthly_budget_usd: z.number().nullable(),
  users: z.object({ total: z.number(), blocked: z.number() }),
  usage: UsageTotalsSchema,
});

export const AppListResponseSchema = z.object({
  month: z.string(),
  has_proxied_requests: z.boolean().meta({
    description:
      "Whether this account has ever had a request recorded, at any time. Unlike the per-application `usage` totals beside it, which cover `month` only, this does not reset when a new month begins, and it never goes from true back to false. Intended for first-run interfaces that stop offering setup guidance once traffic has started.",
  }),
  apps: z.array(AppSummarySchema),
});

export const AppValidateResponseSchema = z.object({
  valid: z.literal(true),
  app_id: z.string(),
  exists: z.boolean(),
});

export const CreatedApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The plaintext key, present exactly once, in the create response. */
  key: z.string(),
  key_prefix: z.string(),
  created_at: z.string(),
});

export const CreatedAppResponseSchema = AppResponseSchema.extend({
  api_key: CreatedApiKeySchema.nullable(),
});

export const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  status: z.enum(["active", "revoked"]),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

export const ApiKeyListResponseSchema = z.object({
  app_id: z.string(),
  keys: z.array(ApiKeySchema),
});

export const ApiKeyRevokeResponseSchema = z.object({
  app_id: z.string(),
  key: ApiKeySchema,
});

export const GatewayUserSchema = z.object({
  id: z.string(),
  status: z.enum(["active", "blocked"]),
  attest_key_id: z.string().nullable(),
  attest_registered: z.boolean(),
  attest_counter: z.number(),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
  is_virtual: z.boolean(),
  usage: UsageTotalsSchema,
});

export const UserListResponseSchema = z.object({
  app_id: z.string(),
  month: z.string(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  users: z.array(GatewayUserSchema),
});

export const UserResponseSchema = z.object({
  app_id: z.string(),
  month: z.string(),
  user: GatewayUserSchema,
});

export const UserBlockResponseSchema = z.object({
  app_id: z.string(),
  user_id: z.string(),
  blocked: z.boolean(),
});

export const MonthlyUsageResponseSchema = z.object({
  app_id: z.string(),
  month: z.string(),
  requests: z.number(),
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  cache_write_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
});

export const TimeseriesBucketSchema = UsageTotalsSchema.extend({
  date: z.string(),
  provider: z.string(),
});

export const TimeseriesResponseSchema = z.object({
  app_id: z.string(),
  from: z.string(),
  to: z.string(),
  buckets: z.array(TimeseriesBucketSchema),
});

export const BreakdownRowSchema = UsageTotalsSchema.extend({
  key: z.string().nullable(),
});

export const BreakdownResponseSchema = z.object({
  app_id: z.string(),
  by: z.enum(USAGE_BREAKDOWN_DIMENSIONS),
  from: z.string(),
  to: z.string(),
  rows: z.array(BreakdownRowSchema),
});

/**
 * What a repricing run would change, or did.
 *
 * `applied` is the difference between a dry run and a write: a dry run is the
 * only one that can report `unpriced_events`, because an apply refuses outright
 * rather than leaving some events at a stale figure.
 */
export const UsageRepriceResponseSchema = z.object({
  app_id: z.string(),
  provider: z.string(),
  model: z.string(),
  month: z.string(),
  applied: z.boolean(),
  matched_events: z.number().int(),
  unmetered_events: z.number().int().meta({
    description: "Matched events that carried no readable usage, and so were repriced to the zero their zero counts imply while keeping whatever cost_source they had. A non-zero number means the month contains spend nothing could meter, which repricing cannot fix and must not appear to have fixed.",
  }),
  unpriced_events: z.number().int().meta({
    description: "Dry-run only: matched events whose serving instance can no longer price them.",
  }),
  unpriced_cost_usd: z.number(),
  previous_cost_usd: z.number(),
  recalculated_cost_usd: z.number(),
  delta_usd: z.number(),
  reconciled_users: z.number().int().meta({
    description: "End-user spend ledgers reprojected inside this request; the rest are left to scheduled recovery.",
  }),
});

export const ModelPriceSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cached_input: z.number().optional(),
  cache_write: z.number().optional(),
  per_minute: z.number().optional(),
  per_hour: z.number().optional(),
  long_context_threshold: z.number().optional(),
  long_input: z.number().optional(),
  long_output: z.number().optional(),
  long_cached_input: z.number().optional(),
  long_cache_write: z.number().optional(),
});

export const PricesResponseSchema = z.object({
  prices: z.record(z.string(), z.record(z.string(), ModelPriceSchema)),
});

export type UsageTotals = z.infer<typeof UsageTotalsSchema>;
export type AppSummary = z.infer<typeof AppSummarySchema>;
export type AppListResponse = z.infer<typeof AppListResponseSchema>;
export type AppValidateResponse = z.infer<typeof AppValidateResponseSchema>;
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;
export type CreatedAppResponse = z.infer<typeof CreatedAppResponseSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponseSchema>;
export type ApiKeyRevokeResponse = z.infer<typeof ApiKeyRevokeResponseSchema>;
export type GatewayUser = z.infer<typeof GatewayUserSchema>;
export type UserListResponse = z.infer<typeof UserListResponseSchema>;
export type UserResponse = z.infer<typeof UserResponseSchema>;
export type UserBlockResponse = z.infer<typeof UserBlockResponseSchema>;
export type MonthlyUsageResponse = z.infer<typeof MonthlyUsageResponseSchema>;
export type TimeseriesBucket = z.infer<typeof TimeseriesBucketSchema>;
export type TimeseriesResponse = z.infer<typeof TimeseriesResponseSchema>;
export type BreakdownRow = z.infer<typeof BreakdownRowSchema>;
export type BreakdownResponse = z.infer<typeof BreakdownResponseSchema>;
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export type PricesResponse = z.infer<typeof PricesResponseSchema>;
export type UsageRepriceResponse = z.infer<typeof UsageRepriceResponseSchema>;
