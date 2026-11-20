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
import { log } from "../core/log.ts";
import type { GatewayIdentity } from "../core/types.ts";
import type { ChargeStatus, Measured, PriceSource } from "../ledger/labels.ts";
import { utcDay, type ChargeRow, type LedgerEntry, type OpenWorkRow } from "../ledger/write.ts";
import { fromDollars, type NanoDollars, type RateNanoPerMillion } from "../money.ts";
import type { ModelPrice, PriceSourceKind } from "../pricing/prices.ts";
import { billedUnits, priceInServedMode, reportsPricedMeasure } from "../pricing/tokens.ts";
import { usageMeasures } from "../usage/measures.ts";
import type { UsageObservation } from "../usage/observation.ts";
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
  const { usage } = outcome;
  const servedMode = outcome.servedMode ?? attempt.requestedMode;
  const succeeded = outcome.status === "ok" || outcome.status === "client_aborted";
  // The provider said yes (2xx), so an answer cut short may have been billed.
  const answered = outcome.httpStatus !== null && outcome.httpStatus >= 200 && outcome.httpStatus < 300;
  const facts = { app: attempt.appId, charge: id, providerType: attempt.providerType, providerSlug: attempt.providerSlug, model: attempt.model };

  const reported = outcome.providerCostUsd ?? null;
  // A mode value the gateway does not know, in the request or the response, is billed as an estimate.
  // So is a call whose answer did not say which of the request's models served it.
  const modeUnknown =
    attempt.requestedModeUnknown !== undefined || outcome.servedModeUnknown !== undefined || attempt.servedModelUnknown === true;
  const priced = usage === null || attempt.price === null ? null : priceInServedMode(attempt.price.price, usage, servedMode, modeUnknown);

  let costed: Costed;
  let measured: Measured;
  const openWork: OpenWorkRow[] = [];
  if (reported !== null) {
    // What the provider charged wins: it is the whole figure, discounts included.
    costed = { costNano: fromDollars(reported), priceSource: "provider_usd", estimate: false, rates: null };
    measured = outcome.cut ? "partial" : "complete";
  } else if (usage !== null) {
    measured = outcome.cut ? "partial" : "complete";
    if (attempt.price !== null && !reportsPricedMeasure(attempt.price.price, usage)) {
      // The answer reported a measure, but not the one the model is priced in:
      // a duration for a token-priced model, or tokens for a time-priced one.
      // Its price would multiply counters that were never sent, and no later
      // price can fix that, so the sweep is not asked (v1).
      costed = { costNano: null, priceSource: "unresolved", estimate: false, rates: null };
      log("error", "usage_unresolved_cost", { ...facts, reason: "no_priced_measure" });
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
      if (attempt.reportsCost && attempt.price === null) {
        // The provider's answer was meant to carry its cost, and did not.
        log("error", "usage_unresolved_cost", { ...facts, reason: "no_cost_reported" });
      } else {
        // A price will be ours or the customer's: the sweep tries again later.
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

  const billed = usage === null ? null : billedUnits(usage, attempt.price?.price ?? null);
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
    model: attempt.model,
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
    measures: usage === null ? {} : usageMeasures(usage, servedMode, modeUnknown),
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
