/**
 * The charge for one upstream attempt of a call (plan sections 4.2, 4.3).
 *
 * The cost comes from, in order: what the provider reported it charged
 * (`provider_usd`), then the customer's rate or ours priced in the service
 * mode that served the request (`customer_rate`, `list_rate`), else nothing
 * anyone can stand behind (`unresolved`). Labels come from what the attempt
 * actually has:
 *
 * - The provider reported usage: `measured: complete`, or `partial` when the
 *   app went away or the stream broke first.
 * - Usage but no price (a price that disappeared after the app was set up):
 *   the usage is kept, the cost stays empty, `price_source: unresolved`, and
 *   an `unresolved` open-work row asks the sweep to price it later.
 * - A mode the model has no price in, or a mode value the gateway does not
 *   know: billed at the closest known price, never under standard, and
 *   marked as an estimate (`AGENTS.md`).
 * - A successful answer with no usage at all: as v1, the cost is unknown,
 *   never $0. The cost stays empty, `price_source: unresolved`, `measured:
 *   estimated` (or `partial` when cut), and it is logged as
 *   `usage_unresolved_cost` so the monitor alerts.
 * - Usage in another unit than the model's price (a duration alone for a
 *   token-priced model): the cost is unknown, `unresolved`, logged as
 *   `usage_unresolved_cost`, and the sweep is not asked, since no later
 *   price can bill a measure that was never sent.
 * - A failed attempt that cost nothing: empty cost, shown as "—".
 *
 * The charge's unit is the one its price bills: tokens, or audio seconds
 * (stored in milliseconds) or images for a model priced by time or per image.
 */
import { storedAppVersion } from "../core/app-version.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import type { GatewayIdentity } from "../core/types.ts";
import type { ChargeStatus, Measured, PriceSource } from "../ledger/labels.ts";
import { utcDay, type ChargeRow, type LedgerEntry, type OpenWorkRow } from "../ledger/write.ts";
import { fromDollars, MoneyError, type NanoDollars, type RateNanoPerMillion } from "../money.ts";
import type { ModelPrice, PriceSourceKind } from "../pricing/prices.ts";
import { chargedMeasure, priceInServedMode } from "../pricing/tokens.ts";
import { declaredOperation } from "../providers/presets.ts";
import { costReportStep } from "../usage/cost-reports.ts";
import { usageMeasures, type EstimateReason } from "../usage/measures.ts";
import { hasMeasure, withoutReport, type UsageObservation } from "../usage/observation.ts";
import { isStandardMode, serviceModeName, type ServiceMode, type ServiceModeValue } from "../usage/service-modes.ts";
import type { Alternatives } from "./alternatives.ts";

/** When the sweep first tries to price an `unresolved` charge. */
export const UNRESOLVED_FIRST_TRY_MS = 60 * 60 * 1000;

export interface CallAttempt {
  readonly requestId: string;
  readonly seq: number;
  readonly accountId: string;
  readonly appId: string;
  readonly identity: GatewayIdentity;
  readonly providerType: string;
  readonly connectionId: string;
  readonly providerSlug: string;
  readonly operation: string;
  readonly model: string;
  /** The preset the call came through, if any. Written on each of its attempts. */
  readonly preset?: string | null;
  readonly price: { readonly price: ModelPrice; readonly source: PriceSourceKind } | null;
  /** The operation's answers carry the provider's own cost. */
  readonly reportsCost: boolean;
  /** A passthrough path with no price: charged `not_priced`, never priced later (`resolvePassthrough`). */
  readonly notPriced?: true;
  /** The service mode the request asked for. */
  readonly requestedMode: ServiceMode;
  /** A value of the request's mode the gateway does not know: it is billed at standard, as an estimate. */
  readonly requestedModeUnknown?: ServiceModeValue;
  readonly startedAt: number;
  readonly appVersion: string | null;
  readonly clientTraceId: string | null;
  /** The request's other models the provider may serve it with, each judged and priced (`./alternatives.ts`). */
  readonly alternatives?: Alternatives;
  /** The answer did not say which of the request's models served it: the price is an estimate. */
  readonly servedModelUnknown?: true;
  /**
   * What the operation's meter measured from the request, if it takes
   * anything from it (`./request-fields.ts`): the usage of a request-measured
   * call, and the fallback of one whose answer reports nothing.
   */
  readonly requestUsage?: UsageObservation | null;
  /** The request's price key values (`./request-fields.ts`), kept on its usage so it is priced, and priced later, with them. */
  readonly priceKeys?: Readonly<Record<string, string>>;
  /** Options the request named that the provider bills on top at a price the gateway does not have: the charge is an estimate. */
  readonly unpricedOptions?: readonly string[];
  /** Price keys the provider chooses for this request (`answeredWhen`): the answer's values are billed (`./meter.ts`). */
  readonly answeredKeys?: readonly string[];
  /** The provider may serve another model (`answeredWhen` on the model): the priced models each name the answer reports stands for. */
  readonly servedModels?: Readonly<Record<string, readonly string[]>>;
  /** The audio is billed once per channel (`perChannelWhen`, `./meter.ts`). */
  readonly perChannel?: true;
  /** The provider may bill more than the request's measure (`inDoubtWhen`, `./meter.ts`). */
  readonly measureInDoubt?: true;
  /** The cache-write variant the answer's one cache-write count bills as (`cacheWriteKeptFor`). */
  readonly cacheWriteVariant?: "1h";
}

export interface AttemptOutcome {
  readonly status: ChargeStatus;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly usage: UsageObservation | null;
  /** What the provider reported it charged, in dollars. */
  readonly providerCostUsd?: number | null;
  /** The mode that served the attempt, from the response. The request's mode when absent. */
  readonly servedMode?: ServiceMode;
  /** A value of the response's mode the gateway does not know: billed at least at standard, as an estimate. */
  readonly servedModeUnknown?: ServiceModeValue;
  /** The app or the provider ended the answer before it was complete. */
  readonly cut: boolean;
  readonly latencyMs: number | null;
}

/** `priceInServedMode`, with a figure too large to price read as no price, so the caller can fall back. */
function pricedOrNull(price: ModelPrice, usage: UsageObservation, mode: ServiceMode, doubt: boolean): ReturnType<typeof priceInServedMode> {
  try {
    return priceInServedMode(price, usage, mode, doubt);
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

/**
 * The usage with its cache writes billed as the variant the request asked
 * for (`cacheWriteKeptFor`), where the answer reports them as one count and
 * no split of its own.
 */
function keptCacheWrites(usage: UsageObservation | null, variant: "1h" | undefined): UsageObservation | null {
  if (usage === null || variant === undefined || usage.cacheWriteTokens <= 0) return usage;
  const variants = usage.tokenVariants as Partial<Record<string, Partial<Record<string, number>>>> | undefined;
  if (variants?.cache_write !== undefined && Object.keys(variants.cache_write).length > 0) return usage;
  return { ...usage, tokenVariants: { ...usage.tokenVariants, cache_write: { [variant]: usage.cacheWriteTokens } } as UsageObservation["tokenVariants"] };
}

/**
 * What to charge in place of a provider's rounded figure (`costReportStep`),
 * or null to charge the figure. Only where the figure is below our price for
 * the call's usage, at the tier that served it, by no more than the rounding
 * can explain (a small Perplexity call reads $0). Then our price is charged,
 * as an estimate, so never below the model's standard rate. A figure further
 * below is the provider's own, a discount, and stands.
 */
function roundedReplacement(
  attempt: CallAttempt,
  reported: number,
  usage: UsageObservation | null,
  served: ServiceMode,
  priced: { readonly cost: NanoDollars } | null,
): NonNullable<ReturnType<typeof priceInServedMode>> | null {
  if (usage === null || attempt.price === null || priced === null) return null;
  const meter = declaredOperation(attempt.operation)?.meter;
  const step = meter?.kind === "response_json" && meter.providerCost !== undefined ? costReportStep(meter.providerCost) : null;
  if (step === null) return null;
  try {
    const gap = priced.cost - fromDollars(reported);
    if (gap <= 0 || gap > fromDollars(step)) return null;
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
  // Priced as an estimate: the dearer of the served tier's price and the model's standard one.
  return pricedOrNull(attempt.price.price, usage, served, true);
}

export function chargeId(requestId: string, seq: number): string {
  return `${requestId}:${seq}`;
}

interface Costed {
  readonly costNano: NanoDollars | null;
  readonly priceSource: PriceSource;
  readonly estimate: boolean;
  readonly rates: Readonly<Record<string, RateNanoPerMillion>> | null;
}

export function callCharge(attempt: CallAttempt, outcome: AttemptOutcome, now = Date.now()): LedgerEntry {
  const id = chargeId(attempt.requestId, attempt.seq);
  let usage = keptCacheWrites(outcome.usage, attempt.cacheWriteVariant);
  const servedMode = outcome.servedMode ?? attempt.requestedMode;
  const succeeded = outcome.status === "ok" || outcome.status === "client_aborted";
  // The provider said yes (2xx), so an answer cut short may have been billed.
  const answered = outcome.httpStatus !== null && outcome.httpStatus >= 200 && outcome.httpStatus < 300;
  const facts = { app: attempt.appId, charge: id, providerType: attempt.providerType, providerSlug: attempt.providerSlug, model: attempt.model };

  const reported = outcome.providerCostUsd ?? null;
  // Every reason a charge is an estimate, each judged and logged on its own,
  // never skipped because an earlier one already applies:
  // - a mode value the gateway does not know, in the request or the response;
  // - an answer that did not say which of the request's models served it,
  //   or, where the provider may change the model, did not name the billed one;
  // - an option billed on top at a price the gateway does not have;
  // - a stream whose final event was cut, its usage read from an earlier event;
  // - a measure the reader worked out, not one the answer reported;
  // - an answer that should have carried the provider's own cost and did not.
  const costNotReported = attempt.reportsCost && reported === null && usage !== null;
  const judged: [EstimateReason, boolean][] = [
    ["service_mode", attempt.requestedModeUnknown !== undefined || outcome.servedModeUnknown !== undefined],
    ["served_model", attempt.servedModelUnknown === true],
    ["unpriced_option", (attempt.unpricedOptions?.length ?? 0) > 0],
    ["final_event_unread", usage?.finalEventUnread === true],
    ["measure_worked_out", usage?.measureWorkedOut === true],
    ["served_model", usage !== null && servedModelInDoubt(attempt, usage, facts)],
    ["cost_not_reported", costNotReported],
  ];
  const reasons = [...new Set(judged.filter(([, applies]) => applies).map(([reason]) => reason))];
  const modeUnknown = reasons.length > 0;
  if (usage?.finalEventUnread === true) log("warn", "usage_final_event_unread", facts);
  if (usage?.measureWorkedOut === true) log("warn", "usage_measure_worked_out", facts);
  // Priced at our rates instead, as an estimate, when a price exists; logged as unresolved below when none does.
  if (costNotReported && attempt.price !== null) log("warn", "provider_cost_not_reported", facts);
  // A key the answer was to name and did not bills at its dearest value, as an estimate (`keyCandidates`).
  const unanswered = (attempt.answeredKeys ?? []).filter(
    (key) => usage !== null && usage.priceKeys?.[key] === undefined && usage.priceKeyChoices?.[key] === undefined,
  );
  if (unanswered.length > 0) log("warn", "price_key_unanswered", { ...facts, keys: unanswered.join(",") });
  if (usage?.reportMissing === true) log("warn", "usage_report_missing", facts);
  let priced = usage === null || attempt.price === null ? null : pricedOrNull(attempt.price.price, usage, servedMode, modeUnknown);
  if (priced === null && attempt.price !== null && usage !== null && reported === null && usage.reportMissing !== true) {
    // A report whose charge cannot be stored (a figure far too large) is no
    // report: the request's estimate prices the call instead, as when a
    // header is missing.
    const fallback = withoutReport(usage);
    const repriced = fallback === null ? null : pricedOrNull(attempt.price.price, fallback, servedMode, modeUnknown);
    if (repriced !== null) {
      log("warn", "usage_report_unpriceable", facts);
      usage = fallback;
      priced = repriced;
    }
  }

  let costed: Costed;
  let measured: Measured;
  const openWork: OpenWorkRow[] = [];
  const rounded = reported === null ? null : roundedReplacement(attempt, reported, usage, servedMode, priced);
  if (reported !== null && rounded !== null) {
    // The provider's figure is rounded coarser than the call costs (a small
    // Perplexity call reads $0): its usage at our price is charged instead,
    // as an estimate, never below the standard rate.
    priced = rounded;
    costed = { costNano: rounded.cost, priceSource: attempt.price!.source, estimate: true, rates: rounded.rates };
    measured = outcome.cut ? "partial" : "complete";
    reasons.push("cost_rounded");
    log("warn", "provider_cost_rounded_below_price", { ...facts, reportedUsd: reported });
  } else if (reported !== null) {
    // What the provider charged wins: it is the whole figure, discounts included.
    costed = { costNano: fromDollars(reported), priceSource: "provider_usd", estimate: false, rates: null };
    measured = outcome.cut ? "partial" : "complete";
  } else if (attempt.notPriced === true) {
    // A passthrough path the customer listed with no price (plan section
    // 4.5): there is nothing to price, now or later, so nothing is retried or
    // logged as unpriced. The console says budgets are not enforced for it.
    costed = { costNano: null, priceSource: "not_priced", estimate: false, rates: null };
    measured = "complete";
  } else if (usage !== null) {
    // Set below, from the measure the pricing result billed.
    measured = "complete";
    // An unresolved charge with a measure is always retried: the sweep prices
    // it once a price for that measure exists (the customer adds a rate).
    const retried = (): void => {
      openWork.push({
        id: `unresolved:${id}`,
        kind: "unresolved",
        accountId: attempt.accountId,
        appId: attempt.appId,
        ownerType: "call",
        ownerId: attempt.requestId,
        chargeId: id,
        detail: { providerType: attempt.providerType, model: attempt.model },
        dueAt: now + UNRESOLVED_FIRST_TRY_MS,
        createdAt: now,
      });
    };
    if (attempt.price !== null && priced === null) {
      // The answer reported a measure, but not the one the model is priced in:
      // a duration for a token-priced model, or tokens for a time-priced one.
      // Like every unresolved charge with a measure, it is retried: a rate for
      // that measure (tokens included) may be added later.
      costed = { costNano: null, priceSource: "unresolved", estimate: false, rates: null };
      const measured = hasMeasure(usage);
      if (measured) retried();
      log("error", "usage_unresolved_cost", { ...facts, reason: "no_priced_measure", retried: measured });
    } else if (priced !== null) {
      costed = {
        costNano: priced.cost,
        priceSource: attempt.price!.source,
        estimate: priced.estimated,
        rates: priced.rates,
      };
      logModes(attempt, servedMode, outcome.servedModeUnknown, priced.estimated, facts);
    } else {
      costed = { costNano: null, priceSource: "unresolved", estimate: false, rates: null };
      if (attempt.reportsCost) {
        // The provider's answer was meant to carry its cost, and did not. With
        // a measure beside it, a rate added later still prices it.
        const measured = hasMeasure(usage);
        if (measured) retried();
        log("error", "usage_unresolved_cost", { ...facts, reason: "no_cost_reported", retried: measured });
      } else {
        // A price will be ours or the customer's: the sweep tries again later.
        retried();
        log("error", "usage_unpriced_model", facts);
      }
    }
  } else if (succeeded || (outcome.cut && answered)) {
    // An answer that started and reported no usage, or broke off before it
    // did: the provider may have billed for it, so the cost is unknown.
    costed = { costNano: null, priceSource: "unresolved", estimate: false, rates: null };
    measured = outcome.cut ? "partial" : "estimated";
    log("error", "usage_unresolved_cost", {
      ...facts,
      reason: outcome.status === "client_aborted" ? "client_aborted" : outcome.cut ? "upstream_failed" : "no_usage_reported",
    });
  } else {
    // A failed attempt with no usage: nothing was billed.
    costed = { costNano: null, priceSource: attempt.price?.source ?? "unresolved", estimate: false, rates: null };
    measured = "complete";
  }

  // The unit, count and label the charge keeps, decided in one place (`chargedMeasure`).
  const billed = usage === null ? null : chargedMeasure(priced, usage);
  if (billed !== null && reported === null) measured = outcome.cut ? "partial" : billed.measured;
  const charge: ChargeRow = {
    id,
    kind: "attempt",
    accountId: attempt.accountId,
    appId: attempt.appId,
    endUserId: attempt.identity.userId,
    installId: attempt.identity.installId,
    appleAccountId: attempt.identity.appleAccountId,
    appKeyId: attempt.identity.apiKeyId ?? null,
    ownerType: "call",
    ownerId: attempt.requestId,
    seq: attempt.seq,
    providerType: attempt.providerType,
    providerConnectionId: attempt.connectionId,
    operation: attempt.operation,
    preset: attempt.preset ?? null,
    // A passthrough call has no model (`PASSTHROUGH_OPERATION`).
    model: attempt.model === "" ? null : attempt.model,
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    errorCode: outcome.errorCode,
    costNano: costed.costNano,
    measured,
    priceSource: costed.priceSource,
    priceIsEstimate: costed.estimate,
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    unit: billed === null ? null : billed.unit,
    units: billed === null ? null : billed.units,
    measures: usage === null ? {} : usageMeasures(usage, servedMode, reasons),
    rates: costed.rates,
    sessionMs: null,
    correctionKind: null,
    correctsChargeId: null,
    latencyMs: outcome.latencyMs,
    appVersion: storedAppVersion(attempt.appVersion),
    authMethod: attempt.identity.authMethod,
    clientTraceId: attempt.clientTraceId,
    usedAt: attempt.startedAt,
    usageDay: utcDay(attempt.startedAt),
    writtenAt: now,
  };
  return { charge, openWork };
}

/**
 * The monitored log lines for a priced attempt's service mode, with v1's
 * names: a value the gateway does not know, and a mode the model has no price
 * in. A mode the request did not ask for, which the response says served it,
 * is a provider default the request never showed, and alerts on its own name.
 */
function logModes(
  attempt: CallAttempt,
  served: ServiceMode,
  servedUnknown: ServiceModeValue | undefined,
  estimated: boolean,
  facts: Record<string, unknown>,
): void {
  for (const [source, value] of [
    ["request", attempt.requestedModeUnknown],
    ["response", servedUnknown],
  ] as const) {
    if (value === undefined) continue;
    log("warn", "service_mode_unknown", { ...facts, source, field: value.field, value: value.value });
  }
  if (!estimated || isStandardMode(served)) return;
  const asked = serviceModeName(served) === serviceModeName(attempt.requestedMode);
  log("warn", asked ? "service_mode_unpriced" : "served_mode_unpriced", { ...facts, serviceMode: serviceModeName(served) });
}

/**
 * Whether the model that served an answer is in doubt: the provider may
 * serve another model for this request (`servedModels`), and the answer
 * names none, or names one that is not the billed model. Each model it names
 * must be the billed one by one of its own names: the billed model itself,
 * exactly, or a name the operation declares stands for it (`servedAs`). One
 * that is not, on any channel, is a fallback. Logged; the charge is then an
 * estimate, at least at the model's standard price.
 */
function servedModelInDoubt(attempt: CallAttempt, usage: UsageObservation, facts: Readonly<Record<string, unknown>>): boolean {
  const servedAs = attempt.servedModels;
  if (servedAs === undefined) return false;
  const reported = usage.reportedModels ?? [];
  const isBilled = (name: string) => name === attempt.model || (Object.hasOwn(servedAs, name) && servedAs[name]!.includes(attempt.model));
  if (reported.length > 0 && reported.every((names) => names.some(isBilled))) return false;
  log("warn", reported.length === 0 ? "served_model_unknown" : "served_model_unexpected", facts);
  return true;
}

/**
 * The attempt's charge. If pricing throws (a cost too large to store, say),
 * the charge is still written, unpriced, and the failure is logged: a charge
 * is never lost or silently miscounted. The retry carries neither the price
 * nor the provider's own figure, so it never meets the same throwing report.
 */
export function safeCharge(attempt: CallAttempt, outcome: AttemptOutcome, now = Date.now()): LedgerEntry {
  try {
    return callCharge(attempt, outcome, now);
  } catch (error) {
    log("error", "usage_pricing_failed", {
      app: attempt.appId,
      providerSlug: attempt.providerSlug,
      model: attempt.model,
      error: errorFacts(error),
    });
    return callCharge({ ...attempt, price: null }, { ...outcome, providerCostUsd: null }, now);
  }
}
