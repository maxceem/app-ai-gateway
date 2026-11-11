/**
 * Turning one served request into one `app_usage_event` row, and getting that
 * row written. What was observed comes from `./usage-readers.ts`, what it cost
 * from `./pricing.ts`, and who served it from the attempt's own attribution —
 * nothing here re-derives any of the three.
 */

import { markApiKeyUsed } from "../client-auth/api-keys";
import type { ProviderReport } from "../shared/cost-report";
import { type ResolvedRoute, routeCanonicalModel } from "../providers/route-adapters";
import { log } from "../core/log";
import { timeOrderedId } from "../core/ids";
import { storedAppVersion } from "../core/app-version";
import { type ObservedBody } from "./body-observer";
import {
  computeCost,
  EMPTY_USAGE,
  reportsPricedMeasure,
  resolveModelAuthor,
  type UsageObservation,
} from "./pricing";
import { observeResponse } from "./usage-readers";
import { type ProviderType, routeCostReport } from "../shared/providers";
import type { ApiStyle } from "../shared/capabilities";
import type { GatewayIdentity } from "../core/types";
import { database } from "../db/index";
import { appUsageEvent, type CostSource, type ProviderPricing } from "../db/schema";
import { errorFacts } from "../core/error-facts";
import { platformFailure } from "../core/platform-errors";

/** Everything a usage row records about which provider served an attempt. */

export interface AttemptAttribution {
  provider: ProviderType;
  /** The provider row that served the traffic. */
  providerId: string;
  /** Caller-visible provider instance slug at the time of the request. */
  providerSlug: string;
  /**
   * How the request was routed: which adapter carried it, the gateway row
   * behind it if any, and that row's own routing configuration. Known with
   * certainty at request time, so the attribution it settles is recorded for
   * every event — unlike the observed fields below, which the upstream has to
   * volunteer. It also carries the namespace an observed model ID is stripped
   * with, so canonicalizing inbound uses exactly the prefix the outbound
   * rewrite used.
   *
   * Named for the row's route, not the request's: `route` below is the
   * `slug/path` string this event records.
   */
  providerRoute: ResolvedRoute;
  /** That row's per-model pricing overrides, which win over the catalog. */
  pricing: ProviderPricing | null;
  /** Canonical model ID: the provider's own, whatever the route called it. */
  model: string;
  /** The API this attempt spoke, which is what picks the response reader. */
  apiStyle: ApiStyle;
  /** `slug/path`, the `route` column. */
  route: string;
}

interface UsageEventInput {
  env: Env;
  organizationId: string;
  /**
   * What the usage observer read off the response body, settled once the client
   * has the whole body or has walked away from it. Null when there was no body
   * to observe, as on a provider error.
   */
  observed: Promise<ObservedBody> | null;
  contentType: string;
  /** Who called: the app, the end user if there is one, and how they proved it. */
  identity: GatewayIdentity;
  /** Which provider row served the attempt, and how it was reached. */
  attribution: AttemptAttribution;
  /** Set for custom endpoint traffic; null for the passthrough proxy. */
  endpointSlug?: string | null;
  appVersion: string | null;
  status: "ok" | "provider_error";
  latencyMs: number;
  /**
   * Minted by the caller when something else must name this same event — the
   * stored conversation does — and generated here otherwise.
   */
  eventId?: string;
  /** The client's `X-Client-Trace-Id`, or null where it sent none. */
  clientTraceId?: string | null;
}

/**
 * A usage event, complete before anything is written. Construction is kept
 * separate from `persistUsageEvent` so the same value could later be handed to
 * a queue without changing how it is settled or stored.
 */
export interface UsageEvent {
  /** Stable across every retry and replay: it is what makes each step a no-op the second time. */
  eventId: string;
  /** The `app_usage_event` row exactly as it will be inserted. */
  row: typeof appUsageEvent.$inferInsert & { createdAt: string };
  /**
   * Billed duration for per-minute and per-hour models, which price on time
   * rather than tokens. Log-only: the row has no column for it, and the logged
   * value is the sole record of what a transcription cost was computed from.
   */
  audioSeconds?: number;
  /** Generated images for per-image models, log-only for the same reason. */
  images?: number;
}

/**
 * How a step that keeps failing is retried. The usage row is what every app
 * and user budget is read from, so losing it undercounts the customer's own
 * spend: it outlasts a platform outage. Marking an API key used only moves a
 * "last used" time that the next request on the key moves again, so it is not
 * worth holding the task open for and keeps to the short retries.
 */
type RetryPatience = "outlast_platform" | "brief";

/**
 * The short retries: three attempts, 25 ms and then 50 ms apart. What every
 * failure the platform is not known to clear on its own gets — a constraint or
 * trigger refusal, a bug in the gateway — and so all a step whose patience is
 * `brief` ever gets. Such an error fails the same way twenty seconds later, so
 * waiting on it would only hold the task open; the two quick retries are kept
 * for an error nobody has classified that is transient after all.
 */
const SHORT_ATTEMPTS = 3;
const SHORT_RETRY_DELAY_MS = 25;

/**
 * The long window, for an error `platformFailure` recognises as D1, a Durable
 * Object or the runtime failing underneath the gateway. The delay doubles from
 * 250 ms to a 4 s ceiling, and no retry starts more than 20 s after the first
 * attempt: nine or ten attempts when each fails fast, fewer when each is
 * slow, because the window is measured on the clock rather than by summing
 * the delays.
 *
 * Cloudflare cancels `waitUntil` work that has not settled 30 s after the
 * response is sent or the client disconnects ("`waitUntil` has a 30-second
 * time limit after invocation end",
 * https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil).
 * Recording starts at about that moment, once the observer has the whole body,
 * so a last attempt that starts by 20 s still has some 10 s to land or to log
 * `usage_record_failed`: a task the runtime cancels logs nothing at all. That
 * limit is shared by every `waitUntil` the request made, but they run side by
 * side, so it is one clock rather than a budget this step splits with others.
 *
 * An overloaded D1 gets the long window too. Its queue for the database is
 * full, and backing off is exactly what lets it drain; three retries inside
 * 75 ms would only have added to the queue before giving up.
 */
const PLATFORM_RETRY_WINDOW_MS = 20_000;
const PLATFORM_FIRST_DELAY_MS = 250;
const PLATFORM_MAX_DELAY_MS = 4_000;

/**
 * How long to wait before the attempt after `attempt`, or null to give up on
 * `error`. A platform failure meets every isolate that wrote at that moment,
 * and retrying them all on the same schedule would bring them back to an
 * overloaded database together; drawing each delay from the upper half of its
 * nominal value spreads them out without ever exceeding it, so the window
 * above still bounds the wait.
 */
function retryDelay(error: unknown, attempt: number, patience: RetryPatience): number | null {
  if (patience === "outlast_platform" && platformFailure(error) !== null) {
    const nominal = Math.min(PLATFORM_FIRST_DELAY_MS * 2 ** (attempt - 1), PLATFORM_MAX_DELAY_MS);
    return nominal / 2 + (Math.random() * nominal) / 2;
  }
  return attempt < SHORT_ATTEMPTS ? SHORT_RETRY_DELAY_MS * attempt : null;
}

type StepOutcome = { landed: true } | { landed: false; error: unknown; attempts: number };

/**
 * Retries one recording step within the current `waitUntil`, for as long as
 * `retryDelay` allows and never past the platform window. Retrying is only
 * safe because every step is idempotent: an ambiguous failure that actually
 * landed costs a wasted no-op, never a double charge or a duplicate row.
 * Each failure is classified on its own, so an outage that turns into a
 * refusal stops at the short retries' third attempt.
 */
async function withRetry(operation: () => Promise<unknown>, patience: RetryPatience): Promise<StepOutcome> {
  const started = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      await operation();
      return { landed: true };
    } catch (error) {
      const delay = retryDelay(error, attempt, patience);
      if (delay === null || Date.now() - started + delay > PLATFORM_RETRY_WINDOW_MS) {
        return { landed: false, error, attempts: attempt };
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * What a log line says about the request an event records: who made it, what
 * served it, and what it used and cost. Shared by the line that confirms the
 * event and the one that gives it up, so a lost event is described in exactly
 * the terms a recorded one is. Ids, counters and catalog names only: never a
 * request or response body, a header or a credential.
 */
function usageFacts(event: UsageEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    appId: event.row.appId,
    userId: event.row.userId,
    provider: event.row.providerType,
    providerSlug: event.row.providerSlug,
    model: event.row.model,
    status: event.row.status,
    // Undefined on a request the client read to the end, where JSON.stringify
    // drops the field: only an abort is worth saying out loud.
    aborted: event.row.clientAborted === 1 ? true : undefined,
    inputTokens: event.row.inputTokens,
    cachedInputTokens: event.row.cachedInputTokens,
    cacheWriteTokens: event.row.cacheWriteTokens,
    outputTokens: event.row.outputTokens,
    modalityTokens: event.row.modalityTokens,
    tokenVariants: event.row.tokenVariants,
    // Undefined for token-priced traffic, where JSON.stringify drops the field.
    audioSeconds: event.audioSeconds,
    images: event.images,
    costUsd: event.row.costUsd,
    costSource: event.row.costSource,
  };
}

/**
 * Runs a step to exhaustion and reports whether it landed. A step that never
 * succeeds is logged under one code and abandoned rather than rethrown: the
 * response was served long ago, and partial progress stays valid because a
 * later duplicate attempt is harmless.
 *
 * The log line is the only record left of an abandoned event, so it carries
 * what the row would have: with the organization and the creation time, which
 * pick the month's totals the insert trigger would have moved, the spend can
 * be rebuilt by hand, and replaying the same `eventId` can never count twice.
 * Only a `usage_insert` failure lost spend: an `api_key_used` failure is
 * described the same way, but its event's row had already landed.
 */
async function recordStep(
  step: string,
  event: UsageEvent,
  patience: RetryPatience,
  operation: () => Promise<unknown>,
): Promise<boolean> {
  const outcome = await withRetry(operation, patience);
  if (outcome.landed) return true;
  log("error", "usage_record_failed", {
    ...usageFacts(event),
    organizationId: event.row.organizationId,
    createdAt: event.row.createdAt,
    step,
    attempts: outcome.attempts,
    error: errorFacts(outcome.error),
  });
  return false;
}

/** Conflict on the unique `event_id` means a previous attempt already stored the row. */
function insertUsageEvent(env: Env, event: UsageEvent): Promise<unknown> {
  return database(env.DB)
    .insert(appUsageEvent)
    .values({
      ...event.row,
      eventId: event.eventId,
      appVersion: storedAppVersion(event.row.appVersion),
    })
    .onConflictDoNothing({ target: appUsageEvent.eventId });
}

/**
 * Persists the event, whose insert trigger moves both of its month's spend
 * totals in the same D1 write, then marks the API key used. A duplicate insert
 * changes no total, so every step can be retried without double counting. The
 * insert outlasts a platform outage of up to about twenty seconds; past that,
 * or on an error no wait would change, the event is given up and logged in
 * full.
 */
export async function persistUsageEvent(env: Env, event: UsageEvent): Promise<void> {
  const outcomes: boolean[] = [];
  outcomes.push(await recordStep("usage_insert", event, "outlast_platform", () => insertUsageEvent(env, event)));
  const apiKeyId = event.row.apiKeyId;
  if (apiKeyId) {
    outcomes.push(await recordStep("api_key_used", event, "brief", () => markApiKeyUsed(env, apiKeyId)));
  }
  if (!outcomes.every(Boolean)) return;
  log("info", "usage_recorded", usageFacts(event));
}

export async function recordUsageEvent(input: UsageEventInput): Promise<void> {
  const { attribution, identity } = input;
  // Minted before any work, so the observer read, the retries below and any
  // later replay of this same event all settle under one identity.
  const eventId = input.eventId ?? timeOrderedId();
  const createdAt = new Date().toISOString();
  let observed: UsageObservation | null = null;
  let report: ProviderReport | null = null;
  // Whether the client walked away mid-stream. It does not change the status —
  // the request was served as far as the caller wanted it — but it is why a
  // stream can end without the usage the provider only sends at the end.
  let aborted = false;
  if (input.observed) {
    const body = await input.observed;
    aborted = body.aborted;
    if (body.truncated) {
      // The response was too big to keep whole, so usage was read from its two
      // ends. Nothing is wrong with that, but how often it happens is the only
      // way to tell a rare batch call from a shape that no longer fits.
      log("info", "usage_observer_truncated", {
        eventId,
        appId: identity.appId,
        userId: identity.userId,
        provider: attribution.provider,
        contentType: input.contentType,
        totalBytes: body.totalBytes,
      });
    }
    try {
      const seen = observeResponse(
        body,
        input.contentType,
        attribution.provider,
        attribution.providerRoute.kind,
        attribution.apiStyle,
      );
      observed = seen.usage;
      report = seen.report;
    } catch (error) {
      log("warn", "usage_extraction_failed", {
        eventId,
        appId: identity.appId,
        userId: identity.userId,
        provider: attribution.provider,
        error: errorFacts(error),
      });
    }
  }
  const integration = routeCostReport(
    attribution.provider,
    attribution.providerRoute.kind,
    attribution.apiStyle,
  );
  const reporting = integration !== null;
  const reportedCost = report?.costUsd ?? null;
  const usage: UsageObservation = observed ?? EMPTY_USAGE;
  const price = computeCost(
    attribution.provider,
    attribution.model,
    usage,
    attribution.pricing,
  );
  // A provider that answered successfully and reported nothing readable would
  // otherwise bill a legitimate-looking $0 and consume no budget — a silent
  // spend-limit bypass. The event is still recorded and the response has already
  // been served: the traffic is marked, not refused.
  //
  // A cost-reporting route fails the same way one step later: its models are
  // billable *because* it reports a cost, so a response that reports none is
  // unresolved too, unless a local price can still answer for it.
  //
  // Known limitation, deliberately not papered over: a client that aborts a
  // reporting route's stream before the final chunk takes the cost report with
  // it, and this records the request unresolved at $0. The abort now cancels
  // the upstream, so the unmeasured spend stops at the disconnect rather than
  // running to completion, but repeated aborts are still unbudgeted spend.
  // Reconciling it needs OpenRouter's generation lookup (backlog); until then a
  // sustained unresolved count is the operator's signal, which is what
  // `usage_unresolved_cost` below exists to raise, with `client_aborted` naming
  // this cause.
  //
  // The third way to arrive here is a non-reporting route whose model has no
  // local price: the billability gate refused it, but a price deleted inside the
  // configuration cache window lets one request through. Nothing computed a cost
  // for it, so `computed` at $0 would claim a free request; the cost is unknown.
  //
  // The fourth is a response that reported a measure, just not the one the
  // model is priced in: a duration for a token-priced model, or tokens for a
  // time-priced one. Its price would multiply counters that were never sent.
  const unpriced = price === null && !reporting;
  const mismeasured = observed !== null
    && price !== null
    && !reportsPricedMeasure(attribution.provider, attribution.model, observed, attribution.pricing);
  const unresolved = input.status === "ok"
    && reportedCost === null
    && (observed === null || unpriced || mismeasured || (reporting && price === null));
  if (unresolved) {
    log("error", "usage_unresolved_cost", {
      eventId,
      appId: identity.appId,
      userId: identity.userId,
      provider: attribution.provider,
      providerSlug: attribution.providerSlug,
      model: attribution.model,
      route: attribution.route,
      contentType: input.contentType,
      // A client that hung up first is the explanation for everything that
      // follows, so it is reported ahead of the shape of what was missing.
      reason: aborted
        ? "client_aborted"
        : observed === null
          ? "no_usage_reported"
          : unpriced
            ? "no_local_price"
            : mismeasured
              ? "no_priced_measure"
              : "no_cost_reported",
    });
  }
  if (unpriced) {
    // Unpriced models are refused before they proxy, so reaching here means the
    // catalog and the gate disagree. Recording the event keeps its tokens; the
    // dedicated code makes the mispricing alertable, which a throw inside
    // `waitUntil` would not be.
    //
    // Not an error on a reporting route: those bill on the reported figure and
    // are expected to carry no local price at all.
    log("error", "usage_unpriced_model", {
      eventId,
      appId: identity.appId,
      userId: identity.userId,
      provider: attribution.provider,
      providerSlug: attribution.providerSlug,
      model: attribution.model,
    });
  }
  // The cost-source hierarchy: what the upstream charged, else what the local
  // catalog computes, else nothing anyone can stand behind.
  //
  // "What the upstream charged" is the whole figure, not one ledger of it. On a
  // BYOK request OpenRouter's own charge and the upstream provider's are
  // reported separately and both come out of the operator's money, so the
  // integration sums them before either column is written — `cost_usd` is what
  // debits budgets and `reported_cost_usd` is the same number, kept so a
  // reported event is distinguishable from a computed one at query time.
  const cost = reportedCost ?? price ?? 0;
  const costSource: CostSource = reportedCost !== null
    ? "reported"
    : unresolved
      ? "unresolved"
      : "computed";
  const gateway = attribution.providerRoute.gateway;
  // Observed values come solely from the parsed report: nothing else is entitled
  // to claim who served a request, so there is no caller-supplied alternative.
  const servedModel = report?.servedModel ?? null;
  await persistUsageEvent(input.env, {
    eventId,
    row: {
      eventId,
      appId: identity.appId,
      organizationId: input.organizationId,
      userId: identity.userId,
      installId: identity.installId,
      appleAccountId: identity.appleAccountId,
      apiKeyId: identity.apiKeyId ?? null,
      providerType: attribution.provider,
      providerId: attribution.providerId,
      providerSlug: attribution.providerSlug,
      providerGatewayId: gateway?.id ?? null,
      providerGatewayType: gateway?.type ?? null,
      // Behind an aggregator the configuration settles nothing: the
      // organization's own key always pays *that* service, and the question the
      // column answers is whose key paid for the inference behind it — which
      // only the response can say, per request. A provider that reports only
      // its own charge leaves the route's answer standing.
      credentialSource: integration?.readsCredentialSource
        ? (report?.credentialSource ?? null)
        : attribution.providerRoute.adapter.credentialSource,
      modelAuthor: resolveModelAuthor(attribution.provider, attribution.model),
      servedProvider: report?.servedProvider ?? null,
      servedModel: servedModel
        ? routeCanonicalModel(attribution.providerRoute, attribution.provider, servedModel)
        : null,
      model: attribution.model,
      route: attribution.route,
      endpointSlug: input.endpointSlug ?? null,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      // Never null on a new row: null is how a row recorded before the column
      // says nobody kept its breakdown, which repricing must not guess at.
      modalityTokens: usage.modalityTokens ?? {},
      // The same rule: `{}` is "split nothing", null is "recorded before the
      // split was kept".
      tokenVariants: usage.tokenVariants ?? {},
      costUsd: cost,
      costSource,
      reportedCostUsd: reportedCost,
      appVersion: input.appVersion,
      authMethod: identity.authMethod,
      status: input.status,
      clientAborted: aborted ? 1 : null,
      latencyMs: input.latencyMs,
      clientTraceId: input.clientTraceId ?? null,
      createdAt,
    },
    audioSeconds: usage.audioSeconds,
    images: usage.images,
  });
}
