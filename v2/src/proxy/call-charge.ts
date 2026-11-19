/**
 * The charge for one upstream attempt of a call (plan sections 4.2, 4.3).
 *
 * Labels come from what the attempt actually has:
 *
 * - The provider reported usage: `measured: complete`, or `partial` when the
 *   app went away or the stream broke first. Priced from the customer's rate
 *   or ours (`customer_rate`, `list_rate`).
 * - Usage but no price (a price that disappeared after the app was set up):
 *   the usage is kept, the cost stays empty, `price_source: unresolved`, and
 *   an `unresolved` open-work row asks the sweep to price it later.
 * - A successful answer with no usage at all: as v1, the cost is unknown,
 *   never $0. The cost stays empty, `price_source: unresolved`, `measured:
 *   estimated` (or `partial` when cut), and it is logged as
 *   `usage_unresolved_cost` so the monitor alerts. There is nothing for the
 *   sweep to price, so no open work.
 * - A failed attempt that cost nothing: empty cost, shown as "—".
 */
import { log } from "../core/log.ts";
import type { GatewayIdentity } from "../core/types.ts";
import type { ChargeStatus, Measured, PriceSource } from "../ledger/labels.ts";
import { utcDay, type ChargeRow, type LedgerEntry, type OpenWorkRow } from "../ledger/write.ts";
import type { ModelPrice, PriceSourceKind } from "../pricing/prices.ts";
import { priceTokens, totalTokens, type TokenUsage } from "../pricing/tokens.ts";

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
  readonly price: { readonly price: ModelPrice; readonly source: PriceSourceKind } | null;
  readonly startedAt: number;
  readonly appVersion: string | null;
  readonly clientTraceId: string | null;
}

export interface AttemptOutcome {
  readonly status: ChargeStatus;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly usage: TokenUsage | null;
  /** The app or the provider ended the answer before it was complete. */
  readonly cut: boolean;
  readonly latencyMs: number | null;
}

export function chargeId(requestId: string, seq: number): string {
  return `${requestId}:${seq}`;
}

export function callCharge(attempt: CallAttempt, outcome: AttemptOutcome, now = Date.now()): LedgerEntry {
  const id = chargeId(attempt.requestId, attempt.seq);
  const { usage } = outcome;
  const priced = usage === null || attempt.price === null ? null : priceTokens(attempt.price.price, usage);
  const succeeded = outcome.status === "ok" || outcome.status === "client_aborted";

  let priceSource: PriceSource;
  let measured: Measured;
  const openWork: OpenWorkRow[] = [];
  if (usage !== null) {
    measured = outcome.cut ? "partial" : "complete";
    if (priced !== null) {
      priceSource = attempt.price!.source;
    } else {
      priceSource = "unresolved";
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
      log("error", "usage_unpriced_model", {
        app: attempt.appId,
        charge: id,
        providerType: attempt.providerType,
        providerSlug: attempt.providerSlug,
        model: attempt.model,
      });
    }
  } else if (succeeded) {
    priceSource = "unresolved";
    measured = outcome.cut ? "partial" : "estimated";
    log("error", "usage_unresolved_cost", {
      app: attempt.appId,
      charge: id,
      providerType: attempt.providerType,
      providerSlug: attempt.providerSlug,
      model: attempt.model,
      reason: outcome.cut ? "client_aborted" : "no_usage_reported",
    });
  } else {
    // A failed attempt with no usage: nothing was billed.
    priceSource = attempt.price?.source ?? "unresolved";
    measured = "complete";
  }

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
    preset: null,
    model: attempt.model,
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    errorCode: outcome.errorCode,
    costNano: priced?.cost ?? null,
    measured,
    priceSource,
    priceIsEstimate: false,
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    unit: usage === null ? null : "tokens",
    units: usage === null ? null : totalTokens(usage),
    measures:
      usage === null
        ? {}
        : {
            input_tokens: usage.inputTokens,
            cached_input_tokens: usage.cachedInputTokens,
            cache_write_tokens: usage.cacheWriteTokens,
            output_tokens: usage.outputTokens,
          },
    rates: priced?.rates ?? null,
    sessionMs: null,
    correctionKind: null,
    correctsChargeId: null,
    latencyMs: outcome.latencyMs,
    appVersion: attempt.appVersion,
    authMethod: attempt.identity.authMethod,
    clientTraceId: attempt.clientTraceId,
    usedAt: attempt.startedAt,
    usageDay: utcDay(attempt.startedAt),
    writtenAt: now,
  };
  return { charge, openWork };
}
