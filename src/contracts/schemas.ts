import { z } from "zod";
import { MAX_BASE_URL_LENGTH } from "../core/origin-guard.ts";
import { PROVIDER_SLUG_PATTERN, PROVIDER_TYPES } from "../core/providers.ts";

/**
 * Registry-driven, and deliberately narrower than the database's own CHECK: the
 * column admits every provider type on the roadmap so widening it never costs
 * another table rebuild, while a type is only creatable once `PROVIDER_REGISTRY`
 * says how to reach, authenticate and price it. The database is permissive; the
 * runtime registry is authoritative.
 */
export const ProviderTypeSchema = z.enum(PROVIDER_TYPES);

/**
 * A request-count limit: a whole number of requests, or null for unlimited.
 * Zero is not a limit, it is a closed door, and is rejected as a likely typo.
 */
const NullableRequestLimit = z.number().int().positive().nullable();

/** A spending limit in USD, or null for unlimited. Zero is allowed and means no spend. */
const NullableSpendLimit = z.number().nonnegative().nullable();
export const SlugSchema = z.string().regex(PROVIDER_SLUG_PATTERN);

const ClaimRequirementSchema = z.object({
  path: z.string(),
  contains: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

/**
 * One value or a list of alternatives, for the two claims that scope an app to
 * a tenant. A list covers a migration between two issuers or bundle ids.
 */
const IssuerClaimValuesSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const IssuerAuthenticationSchema = z.object({
  jwks_url: z.url(),
  /**
   * Required: several issuers publish one JWKS for every customer — Firebase
   * signs all projects with the same keys — so without `iss` and `aud` a token
   * minted in an attacker's own project verifies against this app.
   */
  issuer: IssuerClaimValuesSchema,
  audience: IssuerClaimValuesSchema,
  user_id_claim: z.string(),
  token_header: z.string().optional(),
  required_claims: z.array(ClaimRequirementSchema),
  max_token_lifetime_seconds: z.number().int().positive(),
}).strict();

const AppleAppAttestAuthenticationSchema = z.object({
  type: z.literal("apple_app_attest"),
  issuer: IssuerAuthenticationSchema,
  app_attest: z.object({
    team_id: z.string(),
    bundle_id: z.string(),
  }).strict(),
}).strict();

const ApiKeyAuthenticationSchema = z.object({
  type: z.literal("api_key"),
  issuer: IssuerAuthenticationSchema.optional(),
  end_user: z.object({
    header: z.literal("x-end-user-id"),
    required: z.boolean(),
    fallback: z.literal("api_key"),
  }).strict(),
}).strict();

const ProviderPolicySchema = z.object({
  allowed_paths: z.array(z.union([
    z.string(),
    z.object({
      path: z.string(),
      fixed_model: z.string().optional(),
      clamp: z.enum(["responses", "chat_completions", "gemini_native", "anthropic", "none"]).optional(),
    }),
  ])),
  allowed_models: z.array(z.string()),
  max_output_tokens: z.number().int().positive().optional(),
});

const EndpointTargetSchema = z.object({
  provider: SlugSchema,
  model: z.string().min(1),
});

const EndpointSchema = EndpointTargetSchema.extend({
  api_style: z.enum(["responses", "transcription"]),
  params: z.record(z.string(), z.unknown()).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  fallback: z.array(EndpointTargetSchema).optional(),
});

const LimitScopeSchema = z.object({
  requests: z.object({
    per_minute: NullableRequestLimit,
    per_day: NullableRequestLimit,
  }),
  spending: z.object({ monthly_usd: NullableSpendLimit }),
});

export const AppConfigSchema = z.object({
  authentication: z.discriminatedUnion("type", [
    AppleAppAttestAuthenticationSchema,
    ApiKeyAuthenticationSchema,
  ]),
  routing: z.object({
    providers: z.object({
      mode: z.enum(["all", "selected"]),
      selected: z.record(SlugSchema, ProviderPolicySchema).optional(),
    }),
    model_rewrites: z.record(z.string(), z.string()),
  }),
  /**
   * The organization's own limits on its app's end users. Optional: an absent
   * block is unlimited, so an app that never sets one stores nothing.
   */
  limits: z.object({
    per_user: LimitScopeSchema,
    per_app: LimitScopeSchema,
  }).optional(),
  endpoints: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/), EndpointSchema).optional(),
}).meta({ id: "AppConfig" });

/**
 * The body of every application write. It carries no `id`: the gateway derives
 * one from `name` on create and answers with it as `app.id`, and no request may
 * choose or change it. Strict, so a client still sending `id` is told that in
 * so many words instead of having it silently ignored.
 */
export const AppWriteSchema = z.object({
  name: z.string().min(1).max(100),
  config: AppConfigSchema,
  status: z.enum(["active", "disabled"]).optional(),
}).strict().meta({ id: "AppWrite" });

/** The answer to a body that still names an id, wherever one is rejected. */
export const APP_ID_IS_SERVER_ASSIGNED =
  "id is assigned by the server: omit it and read app.id from the response";

export const AppAttestRegisterRequestSchema = z.object({
  issuer_token: z.string().min(1),
  key_id: z.string().min(1),
  attestation: z.string().min(1),
  challenge: z.string().min(1),
}).meta({ id: "AppAttestRegisterRequest" });

export const AppAttestTokenRequestSchema = z.object({
  issuer_token: z.string().min(1),
  key_id: z.string().min(1),
  assertion: z.string().min(1),
  challenge: z.string().min(1),
}).meta({ id: "AppAttestTokenRequest" });

export const ApiKeyTokenRequestSchema = z.object({
  issuer_token: z.string().min(1),
  api_key: z.string().min(1),
}).strict().meta({ id: "ApiKeyTokenRequest" });

export const UsageRepriceRequestSchema = z.object({
  provider: ProviderTypeSchema,
  model: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  apply: z.boolean().default(false),
}).strict().meta({ id: "UsageRepriceRequest" });

/**
 * Per-1M-token overrides for models the shipped catalog does not cover, or
 * covers with a stale price. `$0` is enterable for genuinely free models.
 */
export const ProviderPricingSchema = z.record(
  z.string().trim().min(1).max(200),
  z.object({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
  }).strict(),
).meta({ id: "ProviderPricing" });

const ProviderNameSchema = z.string().trim().min(1).max(100);
const ProviderSecretSchema = z.string().min(1).max(4096);

/**
 * An operator's own origin for a direct provider instance. Only the shape is
 * checked here; the rules that make it safe — https, a public registrable host,
 * no port, no credentials, no query — live in `src/core/origin-guard.ts`, which
 * also returns the canonical form that is stored. Keeping them there means one
 * implementation for the write paths, the probe, and any future reuse, rather
 * than a regex in a contract that would inevitably drift from it.
 */
const ProviderBaseUrlSchema = z.string().trim().min(1).max(MAX_BASE_URL_LENGTH);

/** Says why the two fields are exclusive, rather than that one is invalid. */
function assertBaseUrlIsDirect(
  value: { baseUrl?: string; providerGatewayId?: string },
  context: z.RefinementCtx,
): void {
  if (value.baseUrl !== undefined && value.providerGatewayId !== undefined) {
    context.addIssue({
      code: "custom",
      message:
        "A gateway-routed instance cannot carry a base URL: the gateway owns the upstream origin",
      path: ["baseUrl"],
    });
  }
}

/**
 * How one provider row is routed inside its gateway. The referenced gateway's
 * type selects what is meaningful here, and its adapter rejects the rest — a
 * Cloudflare AI Gateway, for instance, accepts no routing configuration at all.
 */
export const GatewayRouteConfigSchema = z.object({
  modelPrefix: z.string().trim().min(1).max(100).optional(),
  providerOnly: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
}).strict().meta({ id: "GatewayRouteConfig" });

export const ProviderCreateRequestSchema = z.object({
  type: ProviderTypeSchema,
  name: ProviderNameSchema,
  slug: SlugSchema.optional(),
  secret: ProviderSecretSchema.optional(),
  providerGatewayId: z.string().trim().min(1).optional(),
  gatewayRoute: GatewayRouteConfigSchema.optional(),
  baseUrl: ProviderBaseUrlSchema.optional(),
  pricing: ProviderPricingSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.secret === undefined) === (value.providerGatewayId === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Provide exactly one of secret or providerGatewayId",
      path: ["secret"],
    });
  }
  assertBaseUrlIsDirect(value, context);
}).meta({ id: "ProviderCreateRequest" });

/**
 * A dry run of {@link ProviderCreateRequestSchema}: the same credential, minus
 * everything that only matters once a row is stored.
 */
export const ProviderTestRequestSchema = z.object({
  type: ProviderTypeSchema,
  secret: ProviderSecretSchema.optional(),
  providerGatewayId: z.string().trim().min(1).optional(),
  /** Probed at the origin the instance would really use, override included. */
  baseUrl: ProviderBaseUrlSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.secret === undefined) === (value.providerGatewayId === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Provide exactly one of secret or providerGatewayId",
      path: ["secret"],
    });
  }
  assertBaseUrlIsDirect(value, context);
}).meta({ id: "ProviderTestRequest" });

/**
 * One member per gateway type that has an adapter, discriminated by `type`
 * because each gateway needs a different set of non-secret fields to be
 * reachable at all. The stored `type` column already admits every planned name,
 * so adding a gateway is an adapter plus a member here — never a table rebuild.
 *
 * Vercel asks for nothing but a name and a token: its origin is fixed in
 * adapter code, and the token alone identifies the Vercel team.
 */
export const ProviderGatewayCreateRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cf_aig"),
    name: ProviderNameSchema,
    accountId: z.string().trim().min(1).max(100),
    gatewayId: z.string().trim().min(1).max(100),
    token: ProviderSecretSchema,
  }).strict(),
  z.object({
    type: z.literal("vercel"),
    name: ProviderNameSchema,
    token: ProviderSecretSchema,
  }).strict(),
], {
  error: "Provider gateway type must be one of cf_aig, vercel",
}).meta({ id: "ProviderGatewayCreateRequest" });

/**
 * A dry run of {@link ProviderGatewayCreateRequestSchema}: the same members
 * minus the name, so the connection is probed exactly as a create would probe
 * it, without a row having to exist.
 */
export const ProviderGatewayTestRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cf_aig"),
    accountId: z.string().trim().min(1).max(100),
    gatewayId: z.string().trim().min(1).max(100),
    token: ProviderSecretSchema,
  }).strict(),
  z.object({
    type: z.literal("vercel"),
    token: ProviderSecretSchema,
  }).strict(),
], {
  error: "Provider gateway type must be one of cf_aig, vercel",
}).meta({ id: "ProviderGatewayTestRequest" });

export const ProviderGatewayUpdateRequestSchema = z.object({
  name: ProviderNameSchema,
}).strict().meta({ id: "ProviderGatewayUpdateRequest" });

export const ProviderGatewayRotateRequestSchema = z.object({
  token: ProviderSecretSchema,
}).strict().meta({ id: "ProviderGatewayRotateRequest" });

/**
 * Why a new origin comes with a new key. A provider secret is write-only: it is
 * encrypted on the way in and never read back out to a caller, and that has to
 * include reading it back out *through* an origin the operator just typed.
 * Decrypting the stored key to probe a fresh host would make the base URL field
 * a way for an admin, or a management-key holder, to have the gateway hand the
 * organization's key to a server they control.
 */
export const BASE_URL_REQUIRES_SECRET =
  "Changing the base URL requires re-supplying the provider key, because the stored key is never sent to a new origin";

export const ProviderUpdateRequestSchema = z.object({
  name: ProviderNameSchema.optional(),
  secret: ProviderSecretSchema.optional(),
  /** A full replace; `null` clears the row's routing configuration. */
  gatewayRoute: GatewayRouteConfigSchema.nullable().optional(),
  /**
   * `null` returns the instance to its provider type's own base URL, and needs
   * nothing else. Any other value needs `secret` in the same request; see
   * {@link BASE_URL_REQUIRES_SECRET}.
   */
  baseUrl: ProviderBaseUrlSchema.nullable().optional(),
  /** A full replace; `null` clears every override. */
  pricing: ProviderPricingSchema.nullable().optional(),
  /**
   * A reversible pause. Disabling keeps the secret, the pricing and the slug, so
   * nothing can take the slug meanwhile and re-enabling always succeeds.
   */
  status: z.enum(["active", "disabled"]).optional(),
}).strict().superRefine((value, context) => {
  if (
    value.name === undefined
    && value.secret === undefined
    && value.gatewayRoute === undefined
    && value.baseUrl === undefined
    && value.pricing === undefined
    && value.status === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Provide at least one of name, secret, gatewayRoute, baseUrl, pricing, or status",
    });
  }
  if (value.baseUrl !== undefined && value.baseUrl !== null && value.secret === undefined) {
    context.addIssue({ code: "custom", message: BASE_URL_REQUIRES_SECRET, path: ["secret"] });
  }
}).meta({ id: "ProviderUpdateRequest" });

export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);

export const OrganizationSelectRequestSchema = z.object({
  organizationId: z.string().trim().min(1),
}).meta({ id: "OrganizationSelectRequest" });
