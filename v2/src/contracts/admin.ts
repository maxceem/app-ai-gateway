/**
 * Request and response shapes of the minimal management API (step 1a part
 * 3). Names and shapes follow v1's `/v1/admin/...` where v1 has them:
 * snake_case for apps and keys, camelCase for providers, as in v1.
 *
 * Plain `zod`, so the console and the CLI can import it.
 */
import { z } from "zod";
import { AppConfigSchema, PROVIDER_SLUG_PATTERN } from "./app-config.ts";
import { RATE_FIELDS } from "../usage/token-rates.ts";
import { parseServiceModeName } from "../usage/service-modes.ts";

export const APP_STATUSES = ["active", "disabled"] as const;

export const AppNameSchema = z.string().trim().min(1).max(100);

/** Something about an app that will stop working on a stated date (v1's `AppWarning`). */
export const AppWarningSchema = z
  .object({
    code: z.string().meta({ description: "Stable identifier of what the warning is about." }),
    message: z.string().meta({ description: "What will stop, when, and what to do about it, in one sentence or two." }),
    until: z.string().optional().meta({ description: "ISO 8601 UTC instant the behaviour stops." }),
    docs_url: z.string().optional().meta({ description: "Where the change is described." }),
  })
  .meta({ id: "AppWarning" });

export const AppSchema = z
  .object({
    id: z.string(),
    revision: z.number().int().positive(),
    name: z.string(),
    config: AppConfigSchema,
    status: z.enum(APP_STATUSES),
    created_at: z.string(),
    updated_at: z.string(),
    warnings: z.array(AppWarningSchema).optional().meta({
      description:
        "Behaviour of this app that will stop on a stated date, worked out when the app is read; empty when there is none. Read-only: tell the person who owns the app, and act before each date. Absent on older gateways.",
    }),
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

const PriceAmountSchema = z.number().nonnegative().finite();

/** Every rate a price may carry, each optional: a token rate per million tokens, or a unit rate (`src/pricing/units.ts`). */
const RATE_SHAPE = Object.fromEntries(RATE_FIELDS.map((field) => [field, PriceAmountSchema.optional()])) as Record<
  string,
  z.ZodOptional<typeof PriceAmountSchema>
>;

/** A set of rates, in dollars. */
const PriceRatesSchema = z.object(RATE_SHAPE).strict();

/** A model's price in one service mode: a factor on its standard rates, and any rate the mode prices apart. */
const PricingModeSchema = z.object({ factor: PriceAmountSchema.optional(), ...RATE_SHAPE }).strict();

const PRICE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u;

/**
 * A customer's own prices for one model, in dollars, as v1 takes them, in any
 * unit (plan section 4.2): token rates per million tokens, and unit rates per
 * the amount each names (`per_minute`, `per_image`, `per_million_characters`,
 * `per_credit`, `per_unit`, `per_request`, ...). They are converted once to
 * whole nano-dollars when saved.
 *
 * - `modes`: prices in service modes other than standard. Left out, the price
 *   list's mode factors apply to these rates (v1).
 * - `by`: rates that depend on a request field an operation names as a price
 *   key, such as `{ "size": { "1024x1024": { "per_image": 0.04 } } }`.
 */
export const ModelPricingSchema = z
  .object({
    ...RATE_SHAPE,
    long_context_threshold: z.number().int().positive().optional(),
    modes: z
      .record(
        z.string().refine((name) => name !== "standard" && parseServiceModeName(name) !== null, {
          message: "Name a service mode: flex, priority, fast or ultrafast, a region such as us or eu, or a tier+region pair",
        }),
        PricingModeSchema,
      )
      .optional(),
    by: z
      .record(
        z.string().regex(PRICE_KEY_PATTERN, "A price key is lowercase letters, digits and _"),
        z.record(z.string().min(1).max(100), PriceRatesSchema),
      )
      .optional(),
  })
  .strict()
  .superRefine((price, context) => {
    const entry = price as Record<string, unknown>;
    if ((entry.input === undefined) !== (entry.output === undefined)) {
      context.addIssue({ code: "custom", message: "input and output are priced together" });
    }
    if (price.long_context_threshold === undefined && Object.keys(entry).some((field) => field.startsWith("long_") && field !== "long_context_threshold")) {
      context.addIssue({ code: "custom", message: "Long-context rates need long_context_threshold" });
    }
  });

const ProviderPricingSchema = z.record(z.string().trim().min(1).max(200), ModelPricingSchema);

/** The one name that cannot be a key anywhere in prices: as a key it would reach the object's prototype, not be stored. */
export const RESERVED_PRICE_KEY = "__proto__";

/** Where a `__proto__` key stands in prices, as a dotted path, or null: model names trimmed, nested keys as written. */
export function reservedPriceKeyPath(value: unknown, path: readonly string[] = []): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  for (const [key, inner] of Object.entries(value)) {
    const name = path.length === 0 ? key.trim() : key;
    if (name === RESERVED_PRICE_KEY) return [...path, key].join(".");
    const found = reservedPriceKeyPath(inner, [...path, key]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * A connection's own prices as a request sends them. Model names are trimmed
 * when saved, so two that differ only by surrounding spaces would quietly
 * become one, keeping only the last: such a pair is refused instead, naming
 * both. A `__proto__` key anywhere in them is refused first, naming where it
 * stands, before the record is read; `constructor` and `prototype` stay
 * ordinary model names, as they always were. Prices already saved are never
 * judged by this again.
 */
const ProviderPricingInputSchema = z.preprocess((value, context) => {
  const reserved = reservedPriceKeyPath(value);
  if (reserved !== null) {
    context.issues.push({ code: "custom", input: value, message: `${reserved}: "__proto__" cannot be a name in prices` });
    return value;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const seen = new Map<string, string>();
    for (const name of Object.keys(value)) {
      const trimmed = name.trim();
      const earlier = seen.get(trimmed);
      if (earlier !== undefined) {
        context.issues.push({
          code: "custom",
          input: value,
          message: `${JSON.stringify(earlier)} and ${JSON.stringify(name)} name the same model once surrounding spaces are removed`,
        });
      } else seen.set(trimmed, name);
    }
  }
  return value;
}, ProviderPricingSchema);

/**
 * The built-in API styles a custom provider's path may name. Each is served
 * as an operation named `custom.<style>`, metered by that style's usage
 * reader at the connection's own rates. One path per style.
 */
export const CUSTOM_PATH_STYLES = [
  "openai-chat",
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "openai-embeddings",
  "openai-images",
  "openai-transcription",
  "openai-speech",
] as const;

/** The provider type of a custom provider: one the gateway does not know, at the base URL the connection names. */
export { CUSTOM_PROVIDER_TYPE } from "../providers/custom.ts";

/**
 * One request field a listed path sets, over whatever the app sends (plan
 * section 4.5, "Safe defaults"). For a path the provider knows, the gateway
 * suggests values and writes them in when the path is first listed; the
 * customer may change or remove them. An answer adds `label`, `reason` and
 * `suggested_value` to a field the provider suggests, so a person or an
 * agent sees why it is there. A request may send them back: they are ignored.
 */
export const FieldSettingSchema = z
  .object({
    /** A JSON body field, or a query parameter. */
    in: z.enum(["body", "query"]),
    /** The field's name. A body name with dots is a nested field, such as `client_secret.expires_after`. */
    name: z.string().trim().min(1).max(200),
    /** The value set. A query parameter's is a string. With `as: "time_from_now"`, a whole number of seconds. */
    value: z.unknown().nonoptional({ error: "value is required" }),
    /** `time_from_now`: the gateway writes the time `value` seconds after it sends the request, in RFC 3339. */
    as: z.enum(["time_from_now"]).optional(),
    /** Other spellings the provider reads for the same field, removed so it reads only this one. */
    aliases: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    /** In an answer, for a field the provider suggests: a short name for it. */
    label: z.string().optional(),
    /** In an answer, for a field the provider suggests: why. */
    reason: z.string().optional(),
    /** In an answer, for a field the provider suggests: the value it suggests, which `value` may differ from. */
    suggested_value: z.unknown().optional(),
  })
  .strict()
  .meta({ id: "FieldSetting" });

/**
 * A path a provider connection lists for passthrough (plan section 4.5): a
 * path of the provider the gateway does not declare, forwarded as it is to
 * apps that enable `passthrough`. `{name}` parts match exactly one segment,
 * and stand only where an id is: after the provider's API prefix (such as
 * `v1`) one fixed segment comes before the first, and no two stand next to
 * each other.
 */
export const PassthroughPathSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().trim().min(1).max(500),
    /** A flat price per request, in dollars, charged for each answer the provider accepts. Without it, its calls are not priced and budgets are not enforced on them. */
    per_request: z.number().finite().nonnegative().optional(),
    /**
     * A custom provider's path only: the built-in API style it speaks. It is
     * then served as the operation `custom.<style>`, metered by that style and
     * priced at the connection's rates for its models, not passed through.
     */
    style: z.enum(CUSTOM_PATH_STYLES).optional(),
    /**
     * Request fields set on every request to the path, over what the app
     * sends. Left out on a path the provider suggests values for, the
     * suggested ones are written in when the path is first listed; an empty
     * list sets none. Shown only when it sets some.
     */
    set_fields: z.array(FieldSettingSchema).max(20).optional(),
  })
  .strict()
  .meta({ id: "PassthroughPath" });

/**
 * How a custom provider's key is sent: the header, and its value with
 * `{key}` where the key goes, such as `Bearer {key}`.
 */
export const CustomAuthSchema = z
  .object({
    header: z.string().trim().toLowerCase().min(1).max(100),
    format: z.string().min(5).max(200),
  })
  .strict()
  .meta({ id: "CustomProviderAuth" });

const PassthroughListSchema = z.array(PassthroughPathSchema).max(100, { error: "passthrough may list at most 100 paths" });

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
    /** The paths it lists for passthrough. Left out when it lists none. */
    passthrough: z.array(PassthroughPathSchema).optional(),
    /** A custom provider's key header and format. Left out for a built-in provider. */
    auth: CustomAuthSchema.optional(),
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

/** What every provider key must be, so conversation history can always recognise an echo of it. */
export const PROVIDER_SECRET_RULE = "a provider key is at least 8 characters, with no quotes, backslashes or control characters";

/**
 * Whether a provider key, or a Cloudflare token, can be saved. A key shorter
 * than 8 characters would match ordinary text, and a quote, backslash or
 * control character is escaped when JSON carries it: either would let an echo
 * of the key reach stored conversations unnoticed. Judged only on a key being
 * saved: a stored key is never sent back, so it is never judged again.
 */
export function providerSecretAccepted(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return value.length >= 8 && !/["\\\u0000-\u001f\u007f]/u.test(value);
}

export const ProviderSecretSchema = SecretSchema.refine(providerSecretAccepted, { error: PROVIDER_SECRET_RULE });

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
  .object({ accountId: CloudflareIdSchema, gatewayId: CloudflareIdSchema, token: ProviderSecretSchema })
  .strict();

export const ProviderCreateRequestSchema = z
  .object({
    type: z.string().trim().min(1),
    name: z.string().trim().min(1).max(100),
    slug: z.string().regex(PROVIDER_SLUG_PATTERN, { error: "slug must be lowercase letters, digits and dashes" }).optional(),
    /** The provider's key. Optional only through Cloudflare AI Gateway, which can use the keys it stores. */
    secret: ProviderSecretSchema.optional(),
    baseUrl: z.string().optional(),
    cloudflareGateway: CloudflareGatewayInputSchema.optional(),
    servingProviders: ServingProvidersSchema.optional(),
    /** Paths to forward as they are, to apps that enable `passthrough` on this connection. */
    passthrough: PassthroughListSchema.optional(),
    /** For type `custom` only, and needed there with `baseUrl`: how its key is sent. */
    auth: CustomAuthSchema.optional(),
    pricing: ProviderPricingInputSchema.optional(),
  })
  .strict()
  .meta({ id: "ProviderCreateRequest" });

export const ProviderUpdateRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(100).optional(),
    /** A new key, or null to remove the stored one, which only a connection through Cloudflare AI Gateway may. */
    secret: ProviderSecretSchema.nullable().optional(),
    baseUrl: z.string().nullable().optional(),
    /**
     * A new Cloudflare AI Gateway setting, or null to stop using it. The token
     * may be left out to keep the stored one, for the same account and gateway.
     */
    cloudflareGateway: CloudflareGatewayInputSchema.partial({ token: true }).nullable().optional(),
    /** The serving providers to pin, or null to stop pinning. */
    servingProviders: ServingProvidersSchema.nullable().optional(),
    /** The whole new list of passthrough paths, or null to list none. */
    passthrough: PassthroughListSchema.nullable().optional(),
    /** A custom provider's new key header and format. */
    auth: CustomAuthSchema.optional(),
    pricing: ProviderPricingInputSchema.nullable().optional(),
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

/**
 * The years a month or day may name: 1970 (the ledger's times start there) to
 * 2999. Outside them, month and day arithmetic in JavaScript and as text stops
 * being plain (years before 100, and the year after 9999).
 */
const YEAR = "(?:19[7-9]\\d|2\\d{3})";

/** A UTC month, `YYYY-MM`, from 1970-01 to 2999-12. */
export const MonthSchema = z
  .string()
  .regex(new RegExp(`^${YEAR}-(?:0[1-9]|1[0-2])$`), { error: "month must be YYYY-MM, from 1970-01 to 2999-12" });

/** Whether `YYYY-MM-DD` names a day the calendar has (no 2025-02-29, no 04-31). */
function realDay(value: string): boolean {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** A UTC day, `YYYY-MM-DD`, a real one, from 1970-01-01 to 2999-12-31. */
export const DaySchema = (name: string) =>
  z
    .string()
    .regex(new RegExp(`^${YEAR}-\\d{2}-\\d{2}$`), { error: `${name} must be YYYY-MM-DD, from 1970-01-01 to 2999-12-31` })
    .refine(realDay, { error: `${name} is not a real day` });

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

export const JobListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1, { error: "limit must be 1 to 200" }).max(200, { error: "limit must be 1 to 200" }).default(50),
  offset: z.coerce.number().int().min(0, { error: "offset must be 0 or more" }).default(0),
  settled: z.enum(["true", "false"]).optional().meta({
    description: "false: only jobs not settled to the provider's final figure (still checking, estimate kept or given up), such as a result that came too late to count. true: only settled jobs.",
  }),
});

/** Where a job's charge stands. */
export const JOB_STATES = ["settled", "checking", "estimate_kept", "gave_up"] as const;

export const JobSummarySchema = z
  .object({
    id: z.string().meta({ description: "The job's id in the ledger." }),
    provider_slug: z.string().nullable(),
    operation: z.string(),
    model: z.string().nullable(),
    end_user_id: z.string().nullable(),
    submitted_at: z.string().meta({ description: "When the job was submitted, ISO 8601." }),
    estimate_nano: z.number().int().nullable().meta({ description: "The estimate charged at submit, in nano-dollars; null when it has no price yet." }),
    correction_nano: z.number().int().nullable().meta({ description: "What the job's corrections added or removed, in nano-dollars; null when it has none." }),
    total_nano: z.number().int().nullable().meta({ description: "The estimate and its corrections together, in nano-dollars." }),
    measured: z.string().meta({ description: "How complete the usage is: the estimate's label until the job settles, then the settlement's." }),
    price_source: z.string(),
    state: z.enum(JOB_STATES).meta({
      description:
        "`settled`: corrected to the provider's final figure. `checking`: the gateway still checks the job. `estimate_kept`: the provider gave no figure the price can use, so the estimate stays. `gave_up`: the job's result could not be read in time; the estimate stays.",
    }),
    settled_at: z.string().nullable().meta({ description: "When the job was settled, ISO 8601." }),
    next_check_at: z
      .string()
      .nullable()
      .optional()
      .meta({ description: "While `checking`: when the gateway next checks the job, ISO 8601. A time well in the past means the check is overdue." }),
  })
  .meta({ id: "JobSummary" });

export const JobListResponseSchema = z
  .object({
    app_id: z.string(),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    jobs: z.array(JobSummarySchema),
  })
  .meta({ id: "JobListResponse" });

export const ConversationListQuerySchema = z.object({
  from: DaySchema("from").optional().meta({ description: "First UTC day, YYYY-MM-DD; defaults to the oldest stored." }),
  to: DaySchema("to").optional().meta({ description: "Last UTC day, YYYY-MM-DD, inclusive; defaults to today." }),
  cursor: z.string().max(1024).optional().meta({ description: "The `next_cursor` of the page before." }),
});

export const ConversationFileListSchema = z
  .object({
    app_id: z.string(),
    files: z.array(
      z.object({
        name: z.string().meta({ description: "The file's name within the app: `<YYYY-MM-DD>/<HHMMSS>-<batch>.jsonl.gz`." }),
        size: z.number().int().meta({ description: "Bytes, gzipped." }),
        records: z.number().int().nullable().meta({ description: "How many calls the file holds, one per line." }),
        uploaded_at: z.string().meta({ description: "When the file was written, ISO 8601." }),
      }),
    ),
    next_cursor: z.string().nullable().meta({ description: "Pass as `cursor` for the next page; null on the last one." }),
  })
  .meta({ id: "ConversationFileList" });

export const ConversationFileQuerySchema = z.object({
  name: z.string().meta({ description: "A file name from the listing, or a media name a record gives, `<YYYY-MM-DD>/media/<sha256>.<ext>`." }),
});

/** The price file as it is: dollars per million units, keyed by provider type and model. */
export const PriceListResponseSchema = z
  .object({ prices: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))) })
  .meta({ id: "PriceListResponse" });

export const ProviderTestRequestSchema = z
  .object({
    type: z.string().trim().min(1),
    secret: ProviderSecretSchema.optional(),
    baseUrl: z.string().optional(),
    cloudflareGateway: CloudflareGatewayInputSchema.optional(),
    /** For type `custom`: how its key is sent. */
    auth: CustomAuthSchema.optional(),
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
