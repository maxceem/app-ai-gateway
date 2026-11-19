/**
 * Corrections: settling a charge or a job from the provider's final figure,
 * and pricing an `unresolved` charge (plan section 4.2, rules S2–S5, S10–S13
 * in v2-prep/admission-and-settlement.md).
 *
 * - A correction is a new row with only the difference. The original row
 *   never changes (S2).
 * - Only a final figure settles anything (S3): callers pass what the provider
 *   reports once the work is done, never a provisional figure.
 * - There is one settlement per charge or job. Its correction id is made from
 *   the owner's id, so a client poll and the sweep that settle the same thing
 *   at once write one row: the second is skipped as a duplicate (S4).
 * - Two kinds of final figure (S5): units are priced with the rates stored on
 *   the original charge, never with today's price file; dollars are used as
 *   the provider reports them.
 * - A correction keeps the corrected charge's usage date (S12), changes
 *   dollars only, never plan minutes, and never counts as a request (S13).
 * - A job settles only once its estimate is in the ledger, not while the
 *   estimate is still waiting in the failed-write store (S10).
 */
import { priceUnitsSum, rate, nano, type NanoDollars } from "../money.ts";
import { resolvePrice, type CustomerRates } from "../pricing/prices.ts";
import { priceTokens, totalTokens } from "../pricing/tokens.ts";
import type { CorrectionKind, PriceSource } from "./labels.ts";
import { chargeFromRow, insertChargeStatement, readCharge, type ChargeRow } from "./write.ts";

/** The provider's final figure for a charge or a job. */
export type FinalFigure =
  /**
   * Final units per rate bucket (such as `{ input: 1200, output: 340 }` or
   * fal's billed units), priced with the rates stored on the original charge.
   * `units` is the new total of the charge's main billed unit, for the rollups.
   */
  | { readonly kind: "units"; readonly buckets: Readonly<Record<string, number>>; readonly units?: number }
  /** The provider's final dollar figure, as nano-dollars, used as it is. */
  | { readonly kind: "dollars"; readonly costNano: NanoDollars };

export type SettleResult =
  /** The correction was written now. */
  | { readonly status: "settled"; readonly correction: ChargeRow }
  /** It had been settled already: the correction id exists. */
  | { readonly status: "already" }
  /** The original charge is not in the ledger (yet): try again later. */
  | { readonly status: "charge_missing" }
  /** The original charge has no stored rate for a bucket the final figure names. */
  | { readonly status: "no_rate"; readonly bucket: string };

/** The id of the one settlement of a charge. */
export function chargeSettlementId(chargeId: string): string {
  return `settle:charge:${chargeId}`;
}

/** The id of the one settlement of a job. */
export function jobSettlementId(jobId: string): string {
  return `settle:job:${jobId}`;
}

/** The id of the one correction that prices an `unresolved` charge. */
export function pricingCorrectionId(chargeId: string): string {
  return `price:${chargeId}`;
}

/**
 * A correction row for one charge: the original's identity and usage date,
 * with only the difference in dollars and in the main billed unit.
 */
export function correctionOf(
  original: ChargeRow,
  input: {
    readonly id: string;
    readonly kind: CorrectionKind;
    readonly costNano: NanoDollars;
    readonly unitsDelta: number | null;
    readonly priceSource: PriceSource;
    readonly rates: Readonly<Record<string, number>> | null;
    readonly measures: Readonly<Record<string, number>>;
    readonly now: number;
  },
): ChargeRow {
  return {
    ...original,
    id: input.id,
    kind: "correction",
    seq: null,
    httpStatus: null,
    errorCode: null,
    costNano: input.costNano,
    measured: "complete",
    priceSource: input.priceSource,
    priceIsEstimate: input.kind === "pricing" ? false : original.priceIsEstimate,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    units: input.unitsDelta,
    measures: input.measures,
    rates: input.rates,
    sessionMs: null,
    correctionKind: input.kind,
    correctsChargeId: original.id,
    latencyMs: null,
    // Same usage date as the charge it corrects (S12).
    usedAt: original.usedAt,
    usageDay: original.usageDay,
    writtenAt: input.now,
  };
}

/** The correction for a final figure against an original charge, or why there is none. */
function correctionFor(
  original: ChargeRow,
  final: FinalFigure,
  id: string,
  now: number,
): ChargeRow | { readonly noRate: string } {
  const before = original.costNano ?? 0;
  if (final.kind === "dollars") {
    return correctionOf(original, {
      id,
      kind: "dollars",
      costNano: nano(final.costNano - before),
      unitsDelta: null,
      priceSource: "provider_usd",
      rates: null,
      measures: { final_cost_nano: final.costNano },
      now,
    });
  }
  const parts: [number, ReturnType<typeof rate>][] = [];
  for (const [bucket, units] of Object.entries(final.buckets)) {
    const stored = original.rates?.[bucket];
    if (stored === undefined) return { noRate: bucket };
    parts.push([units, rate(stored)]);
  }
  const finalCost = priceUnitsSum(parts);
  return correctionOf(original, {
    id,
    kind: "units",
    costNano: nano(finalCost - before),
    unitsDelta: final.units === undefined ? null : final.units - (original.units ?? 0),
    priceSource: original.priceSource,
    rates: original.rates,
    measures: { ...final.buckets },
    now,
  });
}

async function writeCorrection(db: D1Database, correction: ChargeRow, doneWork: string | null): Promise<boolean> {
  const statements = [insertChargeStatement(db, correction)];
  if (doneWork !== null) statements.push(db.prepare("DELETE FROM open_work WHERE id = ?").bind(doneWork));
  const [inserted] = await db.batch(statements);
  return (inserted?.meta.changes ?? 0) > 0;
}

/**
 * Settles one charge from the provider's final figure, such as a Deepgram
 * request record or a provider cost lookup. Safe to call twice: the second
 * call finds the correction id taken. `doneWork` is an open-work row to remove
 * in the same batch.
 */
export async function settleCharge(
  db: D1Database,
  input: { readonly chargeId: string; readonly final: FinalFigure; readonly now: number; readonly doneWork?: string },
): Promise<SettleResult> {
  const original = await readCharge(db, input.chargeId);
  if (original === null) return { status: "charge_missing" };
  const correction = correctionFor(original, input.final, chargeSettlementId(original.id), input.now);
  if ("noRate" in correction) return { status: "no_rate", bucket: correction.noRate };
  const written = await writeCorrection(db, correction, input.doneWork ?? null);
  return written ? { status: "settled", correction } : { status: "already" };
}

/**
 * Settles a job from its final figure, against its estimate (S10): the
 * estimate must already be in the ledger. While it is still in the
 * failed-write store, this answers `charge_missing` and the caller tries
 * again later. A client poll and the sweep may both call it: one row results.
 */
export async function settleJob(
  db: D1Database,
  input: { readonly jobId: string; readonly final: FinalFigure; readonly now: number; readonly doneWork?: string },
): Promise<SettleResult> {
  const row = await db
    .prepare("SELECT * FROM charge WHERE owner_type = 'job' AND owner_id = ? AND kind = 'estimate' ORDER BY seq LIMIT 1")
    .bind(input.jobId)
    .first<Record<string, unknown>>();
  if (row === null) return { status: "charge_missing" };
  const estimate = chargeFromRow(row);
  const correction = correctionFor(estimate, input.final, jobSettlementId(input.jobId), input.now);
  if ("noRate" in correction) return { status: "no_rate", bucket: correction.noRate };
  const written = await writeCorrection(db, correction, input.doneWork ?? null);
  return written ? { status: "settled", correction } : { status: "already" };
}

export type PricingResult =
  | { readonly status: "priced"; readonly correction: ChargeRow }
  | { readonly status: "already" }
  | { readonly status: "charge_missing" }
  /** Still no price, ours or the customer's. Try again later. */
  | { readonly status: "no_price" };

/**
 * Prices an `unresolved` charge with the first price that exists (S11): the
 * customer's own rate on the connection, then ours. The correction holds the
 * whole cost, keeps the charge's usage date, and is the one pricing
 * correction of that charge.
 */
export async function priceUnresolvedCharge(
  db: D1Database,
  input: { readonly chargeId: string; readonly now: number; readonly doneWork?: string },
): Promise<PricingResult> {
  const original = await readCharge(db, input.chargeId);
  if (original === null) return { status: "charge_missing" };
  if (original.priceSource !== "unresolved" || original.model === null) return { status: "already" };
  const connection =
    original.providerConnectionId === null
      ? null
      : await db
          .prepare("SELECT rates_json FROM provider_connection WHERE id = ?")
          .bind(original.providerConnectionId)
          .first<{ rates_json: string | null }>();
  const customer =
    connection?.rates_json === null || connection?.rates_json === undefined
      ? null
      : (JSON.parse(connection.rates_json) as CustomerRates);
  const resolved = resolvePrice(original.providerType, original.model, customer);
  if (resolved === null) return { status: "no_price" };
  // Token usage is what step 1a stores; other units are priced when their providers arrive.
  if (original.inputTokens === null || original.outputTokens === null) return { status: "no_price" };
  const usage = {
    inputTokens: original.inputTokens,
    cachedInputTokens: original.cachedInputTokens ?? 0,
    cacheWriteTokens: original.cacheWriteTokens ?? 0,
    outputTokens: original.outputTokens,
  };
  const priced = priceTokens(resolved.price, usage);
  if (priced === null) return { status: "no_price" };
  const correction = correctionOf(original, {
    id: pricingCorrectionId(original.id),
    kind: "pricing",
    costNano: nano(priced.cost - (original.costNano ?? 0)),
    unitsDelta: null,
    priceSource: resolved.source,
    rates: priced.rates,
    measures: { tokens: totalTokens(usage) },
    now: input.now,
  });
  const written = await writeCorrection(db, correction, input.doneWork ?? null);
  return written ? { status: "priced", correction } : { status: "already" };
}
