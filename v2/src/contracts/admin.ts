/**
 * Request and response shapes of the minimal management API (step 1a part
 * 3). Names and shapes follow v1's `/v1/admin/...` where v1 has them:
 * snake_case for apps and keys, camelCase for providers, as in v1.
 *
 * Plain `zod`, so the console and the CLI can import it.
 */
import { z } from "zod";
import { AppConfigSchema, PROVIDER_SLUG_PATTERN } from "./app-config.ts";

export const APP_STATUSES = ["active", "disabled"] as const;

const AppNameSchema = z.string().trim().min(1).max(100);

export const AppSchema = z
  .object({
    id: z.string(),
    revision: z.number().int().positive(),
    name: z.string(),
    config: AppConfigSchema,
    status: z.enum(APP_STATUSES),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .meta({ id: "App" });

export const AppResponseSchema = z.object({ app: AppSchema }).meta({ id: "AppResponse" });
export const AppListResponseSchema = z.object({ apps: z.array(AppSchema) }).meta({ id: "AppListResponse" });

export const AppKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    key_prefix: z.string(),
    status: z.enum(["active", "revoked"]),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
  })
  .meta({ id: "AppKey" });

export const CreatedAppKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** The key itself, shown exactly once, here. */
    key: z.string(),
    key_prefix: z.string(),
    created_at: z.string(),
  })
  .meta({ id: "CreatedAppKey" });

export const CreatedAppResponseSchema = AppResponseSchema.extend({
  /** The first app key of an app-key app, shown once. Null for an App Attest app. */
  api_key: CreatedAppKeySchema.nullable(),
}).meta({ id: "CreatedAppResponse" });

export const AppCreateRequestSchema = z
  .object({
    name: AppNameSchema,
    config: z.unknown(),
    status: z.enum(APP_STATUSES).optional(),
  })
  .strict()
  .meta({ id: "AppCreateRequest" });

export const AppUpdateRequestSchema = z
  .object({
    name: AppNameSchema,
    config: z.unknown(),
    status: z.enum(APP_STATUSES).optional(),
    /** The revision the app was read at. A stale one answers `409 app_revision_conflict`. */
    revision: z.number().int().positive().optional(),
  })
  .strict()
  .meta({ id: "AppUpdateRequest" });

export const AppDeleteResponseSchema = z
  .object({ deleted: z.literal(true), app_id: z.string() })
  .meta({ id: "AppDeleteResponse" });

export const AppKeyListResponseSchema = z
  .object({ app_id: z.string(), keys: z.array(AppKeySchema) })
  .meta({ id: "AppKeyListResponse" });
export const AppKeyCreateRequestSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const AppKeyRevokeResponseSchema = z
  .object({ app_id: z.string(), key: AppKeySchema })
  .meta({ id: "AppKeyRevokeResponse" });

/**
 * A customer's own prices for one model, in dollars per million units, as v1
 * takes them. They are converted once to whole nano-dollars per million units
 * when saved.
 */
export const ModelPricingSchema = z
  .object({
    input: z.number().nonnegative().finite(),
    output: z.number().nonnegative().finite(),
    cached_input: z.number().nonnegative().finite().optional(),
    cache_write: z.number().nonnegative().finite().optional(),
    long_input: z.number().nonnegative().finite().optional(),
    long_cached_input: z.number().nonnegative().finite().optional(),
    long_cache_write: z.number().nonnegative().finite().optional(),
    long_output: z.number().nonnegative().finite().optional(),
    long_context_threshold: z.number().int().positive().optional(),
  })
  .strict();

const ProviderPricingSchema = z.record(z.string().trim().min(1).max(200), ModelPricingSchema);

export const ProviderSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    slug: z.string(),
    name: z.string(),
    status: z.enum(["active", "disabled"]),
    /** The last characters of the key. The key itself is never returned. */
    secretHint: z.string().nullable(),
    baseUrl: z.string().nullable(),
    pricing: ProviderPricingSchema.nullable(),
    revision: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "Provider" });

export const ProviderResponseSchema = z.object({ provider: ProviderSchema }).meta({ id: "ProviderResponse" });
export const ProviderListResponseSchema = z
  .object({ providers: z.array(ProviderSchema) })
  .meta({ id: "ProviderListResponse" });

const SecretSchema = z.string().min(1).max(4096);

export const ProviderCreateRequestSchema = z
  .object({
    type: z.string().trim().min(1),
    name: z.string().trim().min(1).max(100),
    slug: z.string().regex(PROVIDER_SLUG_PATTERN, { error: "slug must be lowercase letters, digits and dashes" }).optional(),
    secret: SecretSchema,
    baseUrl: z.string().optional(),
    pricing: ProviderPricingSchema.optional(),
  })
  .strict()
  .meta({ id: "ProviderCreateRequest" });

export const ProviderUpdateRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(100).optional(),
    secret: SecretSchema.optional(),
    baseUrl: z.string().nullable().optional(),
    pricing: ProviderPricingSchema.nullable().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict()
  .meta({ id: "ProviderUpdateRequest" });

export const ProviderDeleteResponseSchema = z
  .object({ deleted: z.literal(true), provider_id: z.string() })
  .meta({ id: "ProviderDeleteResponse" });
