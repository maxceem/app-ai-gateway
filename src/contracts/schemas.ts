import { z } from "zod";

const NullableLimit = z.number().nonnegative().nullable();

const ClaimRequirementSchema = z.object({
  path: z.string(),
  contains: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const AppleAppAttestAuthenticationSchema = z.object({
  type: z.literal("apple_app_attest"),
  issuer: z.object({
    jwks_url: z.url(),
    user_id_claim: z.string(),
    token_header: z.string().optional(),
    required_claims: z.array(ClaimRequirementSchema),
    max_token_lifetime_seconds: z.number().int().positive(),
  }),
  app_attest: z.object({
    team_id: z.string(),
    bundle_id: z.string(),
    environments: z.array(z.enum(["production", "development"])).min(1),
  }),
  development_access: z.boolean(),
});

const ApiKeyAuthenticationSchema = z.object({
  type: z.literal("api_key"),
  end_user: z.object({
    header: z.literal("x-end-user-id"),
    required: z.boolean(),
    fallback: z.literal("api_key"),
  }),
});

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
  provider: z.enum(["openai", "xai"]),
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
        z.enum(["openai", "anthropic", "xai", "gemini", "perplexity"]),
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

export const DevelopmentTokenRequestSchema = z.object({
  issuer_token: z.string().min(1),
  dev_secret: z.string().min(1),
}).strict().meta({ id: "DevelopmentTokenRequest" });

export const UsageRepriceRequestSchema = z.object({
  provider: z.enum(["openai", "anthropic", "xai", "gemini", "perplexity"]),
  model: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/u),
  apply: z.boolean().default(false),
}).strict().meta({ id: "UsageRepriceRequest" });
