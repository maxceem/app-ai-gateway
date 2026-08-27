import { z } from "zod";
import { ENDPOINT_PROVIDER_TYPES, PROVIDER_TYPES } from "../core/providers.ts";

export const ProviderTypeSchema = z.enum(PROVIDER_TYPES);

const EndpointProviderTypeSchema = z.enum(ENDPOINT_PROVIDER_TYPES);

const NullableLimit = z.number().nonnegative().nullable();

const ClaimRequirementSchema = z.object({
  path: z.string(),
  contains: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const IssuerAuthenticationSchema = z.object({
  jwks_url: z.url(),
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
  provider: EndpointProviderTypeSchema,
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
    per_minute: NullableLimit,
    per_day: NullableLimit,
  }),
  spending: z.object({ monthly_usd: NullableLimit }),
});

export const AppConfigSchema = z.object({
  authentication: z.discriminatedUnion("type", [
    AppleAppAttestAuthenticationSchema,
    ApiKeyAuthenticationSchema,
  ]),
  routing: z.object({
    providers: z.object({
      mode: z.enum(["all", "selected"]),
      selected: z.partialRecord(
        ProviderTypeSchema,
        ProviderPolicySchema,
      ).optional(),
    }),
    model_rewrites: z.record(z.string(), z.string()),
  }),
  limits: z.object({
    per_user: LimitScopeSchema,
    per_app: LimitScopeSchema,
  }),
  endpoints: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/u), EndpointSchema).optional(),
}).meta({ id: "AppConfig" });

export const AppWriteSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
  name: z.string().min(1).max(100),
  config: AppConfigSchema,
  status: z.enum(["active", "disabled"]).optional(),
}).meta({ id: "AppWrite" });

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
  month: z.string().regex(/^\d{4}-\d{2}$/u),
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

export const ProviderCreateRequestSchema = z.object({
  type: ProviderTypeSchema,
  name: ProviderNameSchema,
  secret: ProviderSecretSchema,
  pricing: ProviderPricingSchema.optional(),
}).strict().meta({ id: "ProviderCreateRequest" });

export const ProviderCfAigPresetRequestSchema = z.object({
  accountId: z.string().trim().min(1).max(100),
  gatewayId: z.string().trim().min(1).max(100),
  token: ProviderSecretSchema,
  types: z.array(ProviderTypeSchema).min(1),
  name: ProviderNameSchema,
}).strict().meta({ id: "ProviderCfAigPresetRequest" });

export const ProviderUpdateRequestSchema = z.object({
  name: ProviderNameSchema.optional(),
  secret: ProviderSecretSchema.optional(),
  /** A full replace; `null` clears every override. */
  pricing: ProviderPricingSchema.nullable().optional(),
}).strict().refine(
  (value) => value.name !== undefined || value.secret !== undefined || value.pricing !== undefined,
  { message: "Provide at least one of name, secret, or pricing" },
).meta({ id: "ProviderUpdateRequest" });

export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);

export const OrganizationSelectRequestSchema = z.object({
  organizationId: z.string().trim().min(1),
}).meta({ id: "OrganizationSelectRequest" });

export const OrganizationMemberRoleUpdateRequestSchema = z.object({
  role: OrganizationRoleSchema,
}).meta({ id: "OrganizationMemberRoleUpdateRequest" });
