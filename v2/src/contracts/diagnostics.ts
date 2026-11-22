/**
 * The diagnostics reads of the management API (v1's auth-event and
 * rejection-event endpoints): an app's sign-in attempts and the requests it
 * refused before they reached a provider, each kept 90 days, and a summary of
 * both over a trailing window.
 */
import { z } from "zod";
import { DaySchema } from "./admin.ts";

const LimitSchema = z.coerce.number().int().min(1, { error: "limit must be 1 to 200" }).max(200, { error: "limit must be 1 to 200" }).default(50);

/** How long both kinds of event are kept. */
export const DIAGNOSTICS_RETENTION_DAYS = 90;

/** The events an auth event records. */
export const AUTH_EVENT_NAMES = ["challenge", "register", "token_exchange"] as const;

/** Whose limit refused a request, where a limit did. */
export const REJECTION_SCOPES = ["user", "install", "apple_account", "app", "account"] as const;

const RangeQuery = {
  from: DaySchema("from").optional().meta({ description: "First UTC day, YYYY-MM-DD." }),
  to: DaySchema("to").optional().meta({ description: "Last UTC day, YYYY-MM-DD, inclusive; defaults to today." }),
  limit: LimitSchema,
  before: z.string().max(200).optional().meta({ description: "The `next_before` of the page before." }),
  user: z.string().max(200).optional().meta({ description: "An end user's id." }),
};

export const AuthEventListQuerySchema = z.object({
  ...RangeQuery,
  event: z.enum(AUTH_EVENT_NAMES).optional(),
  outcome: z.string().max(100).optional().meta({ description: "ok, an error code such as issuer_claims_missing, or a challenge outcome: abandoned, client_failed or client_recovered." }),
});

export const AuthEventSchema = z
  .object({
    id: z.string(),
    user_id: z.string().nullable(),
    event: z.enum(AUTH_EVENT_NAMES),
    auth_method: z.string().nullable(),
    outcome: z.string().meta({ description: "ok, an error code, or a challenge outcome. The list may grow." }),
    reason: z.string().nullable().meta({ description: "A short token saying more, such as an issuer's rejection reason." }),
    app_version: z.string().nullable(),
    client_sdk: z.string().nullable(),
    network_asn: z.number().int().nullable(),
    network_name: z.string().nullable(),
    latency_ms: z.number().int().nullable(),
    claim_delay_ms: z.number().int().nullable().meta({ description: "For a sign-in that ended the user's wait for an entitlement claim: how long the wait was." }),
    created_at: z.string().meta({ description: "ISO 8601." }),
  })
  .meta({ id: "AuthEvent" });

export const AuthEventListResponseSchema = z
  .object({
    app_id: z.string(),
    limit: z.number().int(),
    next_before: z.string().nullable().meta({ description: "Pass as `before` for the next, older page; null on the last one." }),
    events: z.array(AuthEventSchema).meta({ description: "Newest first. Kept 90 days." }),
  })
  .meta({ id: "AuthEventListResponse" });

export const RejectionEventListQuerySchema = z.object({
  ...RangeQuery,
  reason: z.string().max(100).optional().meta({ description: "Why it was refused, such as model_not_allowed or blocked_app_budget." }),
  scope: z.enum(REJECTION_SCOPES).optional(),
});

export const RejectionEventSchema = z
  .object({
    id: z.string(),
    user_id: z.string().nullable(),
    install_id: z.string().nullable(),
    app_key_id: z.string().nullable(),
    reason: z.string().meta({ description: "Why it was refused. The list may grow." }),
    scope: z.string().nullable().meta({ description: "Whose limit refused it, where a limit did: user, install, apple_account, app or account." }),
    provider_slug: z.string().nullable(),
    model: z.string().nullable().meta({ description: "The requested model, when it names one the gateway knows; unrecognized otherwise." }),
    operation: z.string().nullable(),
    app_version: z.string().nullable(),
    auth_method: z.string().nullable(),
    latency_ms: z.number().int().nullable(),
    created_at: z.string().meta({ description: "ISO 8601." }),
  })
  .meta({ id: "RejectionEvent" });

export const RejectionEventListResponseSchema = z
  .object({
    app_id: z.string(),
    limit: z.number().int(),
    next_before: z.string().nullable().meta({ description: "Pass as `before` for the next, older page; null on the last one." }),
    events: z.array(RejectionEventSchema).meta({ description: "Newest first. Samples, not every refusal; kept 90 days." }),
  })
  .meta({ id: "RejectionEventListResponse" });

export const AuthEventSummaryQuerySchema = z.object({
  days: z.coerce
    .number()
    .int({ error: "days must be an integer from 1 to 90" })
    .min(1, { error: "days must be an integer from 1 to 90" })
    .max(DIAGNOSTICS_RETENTION_DAYS, { error: "days must be an integer from 1 to 90" })
    .default(30)
    .meta({ description: "The trailing window in UTC days, ending today. Defaults to 30; at most 90, as long as events are kept." }),
});

export const AuthEventSummaryResponseSchema = z
  .object({
    app_id: z.string(),
    days: z.number().int(),
    from: z.string(),
    to: z.string(),
    daily: z
      .array(z.object({ date: z.string(), event: z.enum(AUTH_EVENT_NAMES), outcome: z.string(), reason: z.string().nullable(), count: z.number().int() }))
      .meta({ description: "Sign-in attempts per UTC day, by event, outcome and reason, oldest first." }),
    failing_networks: z
      .array(z.object({ network_asn: z.number().int(), network_name: z.string().nullable(), count: z.number().int(), last_seen: z.string() }))
      .meta({ description: "The networks failed sign-in attempts came from, busiest first, at most ten. Attempts that recovered on their own, and those from an unknown network, are left out. Apple's own network (714) is where App Review tests apps." }),
    failed_charges: z
      .array(z.object({ date: z.string(), count: z.number().int() }))
      .meta({ description: "Calls, session slices and job estimates per UTC day that did not end with success, from the usage totals." }),
    rejection_samples: z
      .array(z.object({ date: z.string(), reason: z.string(), scope: z.string().nullable(), count: z.number().int() }))
      .meta({ description: "Sampled refusals before a provider was reached, per UTC day. Samples, not exact request totals." }),
    token_exchange: z.object({
      total: z.number().int(),
      ok: z.number().int(),
      success_rate: z.number().nullable().meta({ description: "Null when the window has no exchanges at all, which is not a perfect score." }),
    }),
    claim_delay: z
      .object({ count: z.number().int(), avg_ms: z.number().nullable(), p50_ms: z.number().nullable(), p95_ms: z.number().nullable() })
      .meta({ description: "How long users waited for an entitlement claim to reach the issuer, for the waits that ended in the window." }),
    pending_users: z.number().int().meta({ description: "Active users waiting on an entitlement claim right now, counting waits that began within the last 90 days (as long as events are kept)." }),
  })
  .meta({ id: "AuthEventSummaryResponse" });
