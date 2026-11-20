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

export const AppNameSchema = z.string().trim().min(1).max(100);

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
    /**
     * Sending this connection's traffic through Cloudflare AI Gateway (D13). The
     * token itself is never returned. Optional, as every field added to an answer
     * is, so a client reading an older gateway's answer still accepts it.
     */
    cloudflareGateway: z
      .object({ accountId: z.string(), gatewayId: z.string(), tokenHint: z.string().nullable() })
      .nullable()
      .optional(),
    /** For Vercel AI Gateway: the serving providers pinned on every request (`providerOptions.gateway.only`). */
    servingProviders: z.array(z.string()).nullable().optional(),
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

export const SecretSchema = z.string().min(1).max(4096);

const CloudflareIdSchema = z.string().trim().min(1).max(100);

/**
 * For Vercel AI Gateway: the serving providers a connection may use, pinned
 * by the gateway on every request over the app's own value (v1's
 * `providerOnly`). Vercel judges the names: its list of providers changes.
 */
const ServingProvidersSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(50)
  .refine((values) => new Set(values).size === values.length, { error: "servingProviders cannot repeat a value" });

/**
 * Sending a connection's traffic through Cloudflare AI Gateway (D13): the
 * Cloudflare account and gateway, and a Cloudflare token for it. With it, the
 * provider key is optional: Cloudflare can use the keys in its own key store.
 */
const CloudflareGatewayInputSchema = z
  .object({ accountId: CloudflareIdSchema, gatewayId: CloudflareIdSchema, token: SecretSchema })
  .strict();

export const ProviderCreateRequestSchema = z
  .object({
    type: z.string().trim().min(1),
    name: z.string().trim().min(1).max(100),
    slug: z.string().regex(PROVIDER_SLUG_PATTERN, { error: "slug must be lowercase letters, digits and dashes" }).optional(),
    /** The provider's key. Optional only through Cloudflare AI Gateway, which can use the keys it stores. */
    secret: SecretSchema.optional(),
    baseUrl: z.string().optional(),
    cloudflareGateway: CloudflareGatewayInputSchema.optional(),
    servingProviders: ServingProvidersSchema.optional(),
    pricing: ProviderPricingSchema.optional(),
  })
  .strict()
  .meta({ id: "ProviderCreateRequest" });

export const ProviderUpdateRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(100).optional(),
    /** A new key, or null to remove the stored one, which only a connection through Cloudflare AI Gateway may. */
    secret: SecretSchema.nullable().optional(),
    baseUrl: z.string().nullable().optional(),
    /**
     * A new Cloudflare AI Gateway setting, or null to stop using it. The token
     * may be left out to keep the stored one, for the same account and gateway.
     */
    cloudflareGateway: CloudflareGatewayInputSchema.partial({ token: true }).nullable().optional(),
    /** The serving providers to pin, or null to stop pinning. */
    servingProviders: ServingProvidersSchema.nullable().optional(),
    pricing: ProviderPricingSchema.nullable().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict()
  .meta({ id: "ProviderUpdateRequest" });

export const ProviderDeleteResponseSchema = z
  .object({ deleted: z.literal(true), provider_id: z.string() })
  .meta({ id: "ProviderDeleteResponse" });

// ---------------------------------------------------------------------------
// Step 1d: the rest of the management API

/** The most operations one patch may carry, as v1. */
export const APP_PATCH_MAX_OPERATIONS = 100;

/**
 * Where a patch operation applies, as a JSON Pointer (RFC 6901) into the app
 * `getApp` answers with: `/name`, `/status`, or anything under `/config`. The
 * id, revision and times are not the patch's to change. Without a regex flag,
 * because it is published as an OpenAPI `pattern`.
 */
const AppPatchPathSchema = z
  .string()
  .regex(/^\/(?:name|status|config(?:\/(?:[^~/]|~[01])*)*)$/, {
    error: "path must be /name, /status or a JSON Pointer under /config",
  })
  .meta({ example: "/config/limits/per_app/requests/per_minute" });

/** What `add` and `replace` write. Required, even when it is `null`. */
const AppPatchValueSchema = z.unknown().nonoptional({ error: "value is required; send null to write null" });

/**
 * One change, as RFC 6902 (JSON Patch) defines it, limited to the three
 * operations that change a document. `null` is a value like any other: it
 * sets a limit to unlimited, and only `remove` deletes.
 */
export const AppPatchOperationSchema = z
  .discriminatedUnion(
    "op",
    [
      z.object({ op: z.literal("add"), path: AppPatchPathSchema, value: AppPatchValueSchema }).strict(),
      z.object({ op: z.literal("replace"), path: AppPatchPathSchema, value: AppPatchValueSchema }).strict(),
      z.object({ op: z.literal("remove"), path: AppPatchPathSchema }).strict(),
    ],
    { error: "op must be add, replace or remove" },
  )
  .meta({ id: "AppPatchOperation" });
export type AppPatchOperation = z.infer<typeof AppPatchOperationSchema>;

export const AppPatchRequestSchema = z
  .object({
    /** The revision the app was read at, as for `PUT`. */
    revision: z.number().int().positive().optional(),
    operations: z
      .array(AppPatchOperationSchema)
      .min(1, { error: "operations must name at least one change" })
      .max(APP_PATCH_MAX_OPERATIONS, { error: `operations can name at most ${APP_PATCH_MAX_OPERATIONS} changes` }),
  })
  .strict()
  .meta({ id: "AppPatchRequest" });

/** A whole app as `PUT` takes it, without the revision: what the validate routes judge. */
export const AppValidateRequestSchema = z
  .object({ name: AppNameSchema, config: z.unknown(), status: z.enum(APP_STATUSES).optional() })
  .strict()
  .meta({ id: "AppValidateRequest" });

export const AppValidateResponseSchema = z
  .object({ valid: z.literal(true), app_id: z.string() })
  .meta({ id: "AppValidateResponse" });

export const AppDraftValidateResponseSchema = z.object({ valid: z.literal(true) }).meta({ id: "AppDraftValidateResponse" });

export const AppCheckResponseSchema = z
  .object({
    app_id: z.string(),
    status: z.enum(APP_STATUSES),
    providers: z
      .array(
        z.object({
          id: z.string().nullable(),
          slug: z.string(),
          status: z.enum(["active", "disabled", "missing"]),
        }),
      )
      .meta({
        description:
          "Every provider connection the app's routing names. A disabled one is listed as disabled, and one that was deleted as missing, with a null id.",
      }),
    ready: z.boolean().meta({ description: "Whether the app is active and at least one connection it names is active." }),
    limitations: z.array(z.string()).meta({ description: "What this check did not exercise, one sentence each." }),
  })
  .meta({ id: "AppCheckResponse" });

/** An app's end user, as the management API lists them (v1's shape). */
export const EndUserSchema = z
  .object({
    id: z.string(),
    status: z.enum(["active", "blocked"]),
    installs: z.number().int().meta({
      description: "How many App Attest keys the user holds: one per install. Always 0 on server apps.",
    }),
    is_install: z.boolean().meta({ description: "Whether this id is itself an App Attest key, so the row is one install." }),
    created_at: z.string().nullable(),
    last_seen_at: z.string().nullable(),
    is_virtual: z.boolean().meta({
      description:
        "True for a user id that only the app's usage or refusals name, such as a server app's end-user header. Such a user has no row, and cannot be blocked.",
    }),
    usage: z
      .object({
        charges: z.number().int().meta({ description: "Charges in the month, corrections not counted." }),
        failed: z.number().int().meta({ description: "Of those, attempts that did not end with success." }),
        cost_nano: z.number().int().meta({ description: "What the month cost, in nano-dollars, corrections included." }),
        input_tokens: z.number().int(),
        cached_input_tokens: z.number().int(),
        output_tokens: z.number().int(),
      })
      .meta({ description: "The user's usage in `month`, from the ledger." }),
  })
  .meta({ id: "EndUser" });

/** A UTC month, `YYYY-MM`. */
export const MonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, { error: "month must be YYYY-MM" });

export const EndUserListQuerySchema = z.object({
  month: MonthSchema.optional().meta({ description: "YYYY-MM; defaults to the current UTC month." }),
  query: z.string().max(200).optional().meta({ description: "Part of the user id." }),
  status: z.enum(["active", "blocked"]).optional(),
  limit: z.coerce.number().int().min(1, { error: "limit must be 1 to 200" }).max(200, { error: "limit must be 1 to 200" }).default(50),
  offset: z.coerce.number().int().min(0, { error: "offset must be 0 or more" }).default(0),
});

export const EndUserQuerySchema = z.object({
  month: MonthSchema.optional().meta({ description: "YYYY-MM; defaults to the current UTC month." }),
});

export const EndUserListResponseSchema = z
  .object({
    app_id: z.string(),
    month: z.string(),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    users: z.array(EndUserSchema),
  })
  .meta({ id: "EndUserListResponse" });

export const EndUserResponseSchema = z
  .object({ app_id: z.string(), month: z.string(), user: EndUserSchema })
  .meta({ id: "EndUserResponse" });

export const EndUserBlockResponseSchema = z
  .object({ app_id: z.string(), user_id: z.string(), blocked: z.boolean() })
  .meta({ id: "EndUserBlockResponse" });

/** The price file as it is: dollars per million units, keyed by provider type and model. */
export const PriceListResponseSchema = z
  .object({ prices: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))) })
  .meta({ id: "PriceListResponse" });

export const ProviderTestRequestSchema = z
  .object({
    type: z.string().trim().min(1),
    secret: SecretSchema.optional(),
    baseUrl: z.string().optional(),
    cloudflareGateway: CloudflareGatewayInputSchema.optional(),
  })
  .strict()
  .meta({ id: "ProviderTestRequest" });

/**
 * What a key test found. Only `rejected` says the key is probably wrong (a key
 * restricted so it cannot list models may also get it). Every other
 * reason means "not proven", and must never stop someone from saving a key
 * they know is right.
 */
export const ProviderTestResponseSchema = z
  .object({
    validated: z.boolean(),
    reason: z.enum(["no_probe", "unreachable", "unexpected_status", "rejected"]).optional().meta({
      description:
        "Why the key was not confirmed. no_probe: this provider has no cheap call to test with. unreachable: no answer in time. unexpected_status: an answer that proves nothing either way. rejected: the provider refused the key with 401. Usually the key is wrong, but some providers answer 401 for a key restricted so it cannot list models.",
    }),
    status: z.number().int().optional().meta({ description: "The provider's HTTP status, for unexpected_status and rejected." }),
  })
  .meta({ id: "ProviderTestResponse" });
