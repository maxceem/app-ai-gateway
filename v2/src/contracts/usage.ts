/**
 * The usage reads of the management API (v1's usage endpoints, read from the
 * v2 ledger): month totals, days, a breakdown by one dimension, the account's
 * month with every app in it, and the charges themselves.
 *
 * Totals come from the rollups (`usage_day`, and `usage_month` for days older
 * than 400). Charges are the ledger's own rows, kept 90 days.
 */
import { z } from "zod";
import { CHARGE_KINDS, CHARGE_STATUSES, MEASURED, OWNER_TYPES, PRICE_SOURCES } from "../ledger/labels.ts";
import { DaySchema, MonthSchema } from "./admin.ts";

/** Units stored at `MILLI_SCALE` (a thousandth each), for clients that show counts. */
export { MILLI_SCALED_UNITS } from "../ledger/labels.ts";
export { MILLI_SCALE } from "../money.ts";

const LimitSchema = z.coerce.number().int().min(1, { error: "limit must be 1 to 200" }).max(200, { error: "limit must be 1 to 200" }).default(50);

/** The longest day range one read covers: as far back as day totals are kept. */
export const USAGE_RANGE_MAX_DAYS = 400;

/**
 * The longest range read from the charges themselves: a breakdown by a
 * dimension the rollups lack (which groups every charge in it), and the charge
 * list filtered by anything with no index of its own (anything but `owner` or
 * `user`), whose default is the last 30 days.
 */
export const USAGE_CHARGE_RANGE_MAX_DAYS = 31;

export const UsageTotalsSchema = z
  .object({
    charges: z.number().int().meta({ description: "Calls, session slices and job estimates. Corrections are not counted: they change the cost of a charge already counted." }),
    failed: z.number().int().meta({ description: "Of those, attempts that did not end with success." }),
    unpriced: z.number().int().meta({ description: "Of those, charges that still have no price: not priced yet, or a passthrough path with no price. Their cost counts as 0. Once a pricing correction prices one, its cost is added and it leaves this count. It may also count failed attempts that cost nothing, where the provider reports its own price and a failure reported none." }),
    cost_nano: z.number().int().meta({ description: "What it cost, in nano-dollars (1 = $0.000000001), corrections included." }),
    cost_usd: z.number().meta({ description: "The same cost in dollars, for display." }),
    input_tokens: z.number().int(),
    cached_input_tokens: z.number().int(),
    cache_write_tokens: z.number().int(),
    output_tokens: z.number().int(),
    session_ms: z.number().int().meta({ description: "Connection time of live sessions, in milliseconds." }),
  })
  .meta({ id: "UsageTotals" });

export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageMonthQuerySchema = z.object({
  month: MonthSchema.optional().meta({ description: "YYYY-MM; defaults to the current UTC month." }),
});

export const UsageRangeQuerySchema = z.object({
  from: DaySchema("from").optional().meta({ description: "First UTC day, YYYY-MM-DD; defaults to 29 days before `to`." }),
  to: DaySchema("to").optional().meta({ description: "Last UTC day, YYYY-MM-DD, inclusive; defaults to today." }),
});

export const AppUsageResponseSchema = z
  .object({ app_id: z.string(), month: z.string() })
  .extend(UsageTotalsSchema.shape)
  .extend({
    first_usage_day: z.string().nullable().optional().meta({
      description: "The UTC day of the app's oldest usage still kept (YYYY-MM-DD, or YYYY-MM once it is only in month totals). Null when the app has never made a call; absent from older gateways.",
    }),
  })
  .meta({ id: "AppUsageResponse" });

export const AccountUsageResponseSchema = z
  .object({
    month: z.string(),
    totals: UsageTotalsSchema,
    apps: z
      .array(
        z.object({ app_id: z.string(), name: z.string().nullable(), deleted: z.boolean() }).extend(UsageTotalsSchema.shape),
      )
      .meta({ description: "Every app with usage in the month, largest cost first. A deleted app keeps its usage, with a null name." }),
    first_usage_day: z.string().nullable().meta({
      description: "The UTC day of the account's oldest usage still kept (YYYY-MM-DD, or YYYY-MM once it is only in month totals). Null when the account has never made a call.",
    }),
  })
  .meta({ id: "AccountUsageResponse" });

export const UsageTimeseriesResponseSchema = z
  .object({
    app_id: z.string(),
    from: z.string(),
    to: z.string(),
    buckets: z
      .array(z.object({ day: z.string(), provider_type: z.string() }).extend(UsageTotalsSchema.shape))
      .meta({ description: "One bucket per day and provider type with usage, oldest first. Days older than 400 are kept only as month totals, so they have no buckets." }),
  })
  .meta({ id: "UsageTimeseriesResponse" });

/**
 * What a breakdown can group by. The first five are in the day totals, kept
 * 400 days; the rest are read from the charges themselves, kept 90 days.
 */
export const USAGE_TOTALS_DIMENSIONS = ["model", "provider", "connection", "status", "unit"] as const;
export const USAGE_CHARGE_DIMENSIONS = ["user", "install", "operation", "preset", "price_source", "measured", "app_version"] as const;
export const USAGE_DIMENSIONS = [...USAGE_TOTALS_DIMENSIONS, ...USAGE_CHARGE_DIMENSIONS] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export const UsageBreakdownQuerySchema = UsageRangeQuerySchema.extend({
  by: z.enum(USAGE_DIMENSIONS).default("model").meta({
    description:
      "What to group by. model, provider (type), connection, status (ok or failed) and unit come from day totals, kept 400 days. user, install, operation, preset, price_source, measured and app_version come from the charges, kept 90 days, over at most 31 days; a correction groups under its own price_source and measured.",
  }),
  limit: LimitSchema,
});

export const UsageBreakdownResponseSchema = z
  .object({
    app_id: z.string(),
    by: z.enum(USAGE_DIMENSIONS),
    from: z.string(),
    to: z.string(),
    rows: z
      .array(
        z
          .object({
            key: z.string().nullable().meta({ description: "The value grouped by; null where the charges name none." }),
            label: z.string().nullable().optional().meta({ description: "A readable name for the key where it has one: a connection's slug." }),
          })
          .extend(UsageTotalsSchema.shape),
      )
      .meta({ description: "Largest cost first, then most charges." }),
  })
  .meta({ id: "UsageBreakdownResponse" });

/** A charge's status, or `failed` for every status but ok. */
export const CHARGE_STATUS_FILTERS = [...CHARGE_STATUSES, "failed"] as const;

export const ChargeListQuerySchema = UsageRangeQuerySchema.extend({
  limit: LimitSchema,
  before: z.string().max(200).optional().meta({ description: "The `next_before` of the page before." }),
  kind: z.enum(CHARGE_KINDS).optional(),
  status: z.enum(CHARGE_STATUS_FILTERS).optional().meta({ description: "A status, or failed for every status but ok." }),
  provider: z.string().max(100).optional().meta({ description: "A provider type, such as openai." }),
  connection: z.string().max(200).optional().meta({ description: "A provider connection's id." }),
  model: z.string().max(200).optional().meta({ description: "A model." }),
  user: z.string().max(200).optional().meta({ description: "An end user's id." }),
  install: z.string().max(200).optional().meta({ description: "An install: an App Attest key id." }),
  operation: z.string().max(200).optional(),
  owner: z.string().max(200).optional().meta({ description: "A call, session or job id: all its charges, corrections included." }),
  price_source: z.enum(PRICE_SOURCES).optional(),
  measured: z.enum(MEASURED).optional(),
  trace: z
    .string()
    .max(128)
    .optional()
    .meta({ description: "Only the requests the client sent with this X-Client-Trace-Id." }),
});

export const ChargeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(CHARGE_KINDS).meta({ description: "attempt (one upstream attempt of a call), slice (a session checkpoint), estimate (a job at submit) or correction." }),
    owner_type: z.enum(OWNER_TYPES),
    owner_id: z.string().meta({ description: "The call, session or job the charge belongs to." }),
    corrects_charge_id: z.string().nullable().meta({ description: "For a correction: the charge it corrects." }),
    correction_kind: z.string().nullable().meta({ description: "For a correction: units, dollars or pricing." }),
    status: z.string().meta({ description: "How the attempt ended: ok, provider_error, timeout, network_error or client_aborted. The list may grow." }),
    http_status: z.number().int().nullable(),
    error_code: z.string().nullable(),
    provider_type: z.string(),
    provider_connection_id: z.string().nullable(),
    operation: z.string(),
    preset: z.string().nullable(),
    model: z.string().nullable(),
    end_user_id: z.string().nullable(),
    install_id: z.string().nullable(),
    cost_nano: z.number().int().nullable().meta({ description: "In nano-dollars. Null for a failed attempt that cost nothing, shown as —." }),
    cost_usd: z.number().nullable(),
    measured: z.enum(MEASURED),
    price_source: z.enum(PRICE_SOURCES),
    price_is_estimate: z.boolean().meta({ description: "The cost is not exact: a job's estimate, before its final figure corrects it, or the closest known price for a service mode with no exact one." }),
    input_tokens: z.number().int().nullable(),
    cached_input_tokens: z.number().int().nullable(),
    cache_write_tokens: z.number().int().nullable(),
    output_tokens: z.number().int().nullable(),
    unit: z.string().nullable(),
    units: z.number().nullable(),
    session_ms: z.number().int().nullable(),
    latency_ms: z.number().int().nullable(),
    app_version: z.string().nullable(),
    auth_method: z.string().nullable(),
    client_trace_id: z.string().nullable(),
    used_at: z.string().meta({ description: "When the usage happened, ISO 8601." }),
    usage_day: z.string().meta({ description: "The UTC day the charge counts on." }),
  })
  .meta({ id: "Charge" });

export const ChargeListResponseSchema = z
  .object({
    app_id: z.string(),
    limit: z.number().int(),
    next_before: z.string().nullable().meta({ description: "Pass as `before` for the next, older page; null on the last one." }),
    charges: z.array(ChargeSchema).meta({ description: "Newest first. Charges are kept 90 days." }),
  })
  .meta({ id: "ChargeListResponse" });
