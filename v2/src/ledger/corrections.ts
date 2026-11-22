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
 * - A correction holds the final figure minus everything already booked for
 *   that charge: the charge itself and its earlier corrections. The
 *   difference is worked out inside the insert, so a pricing correction and
 *   a final settlement of one charge never both add its full cost. Pricing
 *   stops once a final settlement exists; the settlement already includes it.
 */
import { rate, nano, type NanoDollars } from "../money.ts";
import { billingForCharge, priceSources } from "../pricing/billability.ts";
import { costOfRates, priceInServedMode } from "../pricing/tokens.ts";
import { usageFromMeasures } from "../usage/measures.ts";
import { STANDARD_MODE } from "../usage/service-modes.ts";
import type { CorrectionKind, PriceSource } from "./labels.ts";
import { chargeFromRow, insertChargeWithCostStatement, readCharge, type ChargeRow } from "./write.ts";

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
    readonly measures: Readonly<Record<string, number | string>>;
    readonly now: number;
    /** A pricing correction billed at an estimate, such as a service mode with no price. */
    readonly estimate?: boolean;
    /** The unit the correction's cost is in, where the price bills another than the charge recorded. */
    readonly unit?: string;
    /** How complete the measure the correction billed is: a pricing correction's comes from its pricing result. */
    readonly measured?: "complete" | "estimated";
  },
): ChargeRow {
  return {
    ...original,
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    id: input.id,
    kind: "correction",
    seq: null,
    httpStatus: null,
    errorCode: null,
    costNano: input.costNano,
    measured: input.measured ?? "complete",
    priceSource: input.priceSource,
    priceIsEstimate: input.kind === "pricing" ? (input.estimate ?? false) : original.priceIsEstimate,
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
): { readonly correction: ChargeRow; readonly finalCost: NanoDollars } | { readonly noRate: string } {
  const before = original.costNano ?? 0;
  if (final.kind === "dollars") {
    const correction = correctionOf(original, {
      id,
      kind: "dollars",
      costNano: nano(final.costNano - before),
      unitsDelta: null,
      priceSource: "provider_usd",
      rates: null,
      measures: { final_cost_nano: final.costNano },
      now,
    });
    return { correction, finalCost: final.costNano };
  }
  // Each bucket is a rate the charge stored, priced by the one cost formula the
  // live charge uses (a token rate per million, a unit rate per its amount).
  const parts: [string, number, ReturnType<typeof rate>][] = [];
  for (const [bucket, units] of Object.entries(final.buckets)) {
    const stored = original.rates?.[bucket];
    if (stored === undefined) return { noRate: bucket };
    parts.push([bucket, units, rate(stored)]);
  }
  const finalCost = costOfRates(parts);
  const correction = correctionOf(original, {
    id,
    kind: "units",
    costNano: nano(finalCost - before),
    unitsDelta: final.units === undefined ? null : final.units - (original.units ?? 0),
    priceSource: original.priceSource,
    rates: original.rates,
    measures: { ...final.buckets },
    now,
  });
  return { correction, finalCost };
}

/**
 * Writes a correction whose cost is `finalCost` minus what is already booked
 * for the charge it corrects (the charge and its earlier corrections), worked
 * out inside the insert. It is written only while the charge it corrects is
 * in the ledger, so the difference is never worked out against a charge not
 * written yet, and never past the ledger's late-booking rule: a correction is
 * dated on its charge's day (`./late-booking.ts`).
 * With `unlessSettled`, it is not written once any final settlement (a
 * charge's or a job's) corrects the same charge. Returns the row as written,
 * or null when it was not written.
 */
async function writeCorrection(
  db: D1Database,
  correction: ChargeRow,
  /** The real time of writing: the late-booking rule is judged against it, never the row's own. */
  now: number,
  finalCost: NanoDollars,
  doneWork: string | null,
  unlessSettled = false,
  doneJob: string | null = null,
): Promise<ChargeRow | null> {
  const correctedId = correction.correctsChargeId!;
  const statements = [
    insertChargeWithCostStatement(
      db,
      correction,
      now,
      `? - COALESCE((SELECT cost_nano FROM charge WHERE id = ?), 0)
         - COALESCE((SELECT SUM(cost_nano) FROM charge WHERE corrects_charge_id = ?), 0)`,
      [finalCost, correctedId, correctedId],
      {
        // Only while the charge it corrects is in the ledger.
        sql: `EXISTS (SELECT 1 FROM charge WHERE id = ?)${
          unlessSettled
            ? // No final settlement of this charge (its own, or its job's), and no
              // session-level total that already covers it (the session it belongs
              // to, settled with a provider total).
              ` AND NOT EXISTS (SELECT 1 FROM charge WHERE corrects_charge_id = ? AND correction_kind IN ('units', 'dollars'))
              AND NOT EXISTS (SELECT 1 FROM session WHERE ? = 'session' AND id = ? AND settlement = 'settled' AND session_total_nano IS NOT NULL)`
            : ""
        }`,
        params: unlessSettled ? [correctedId, correctedId, correction.ownerType, correction.ownerId] : [correctedId],
      },
    ),
  ];
  if (doneWork !== null) statements.push(db.prepare("DELETE FROM open_work WHERE id = ?").bind(doneWork));
  // A settled job needs no more work: its check and every figure saved for it go, once the correction exists.
  if (doneJob !== null) statements.push(db.prepare("DELETE FROM open_work WHERE owner_type = 'job' AND owner_id = ?").bind(doneJob));
  const [inserted] = await db.batch(statements);
  if ((inserted?.meta.changes ?? 0) === 0) return null;
  return readCharge(db, correction.id);
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
  const built = correctionFor(original, input.final, chargeSettlementId(original.id), input.now);
  if ("noRate" in built) return { status: "no_rate", bucket: built.noRate };
  const written = await writeCorrection(db, built.correction, input.now, built.finalCost, input.doneWork ?? null);
  return written !== null ? { status: "settled", correction: written } : { status: "already" };
}

/**
 * Settles a job from its final figure, against its estimate (S10): the
 * estimate must already be in the ledger. While it is still in the
 * failed-write store, this answers `charge_missing` and the caller tries
 * again later. A client poll and the sweep may both call it: one row results.
 * The same batch removes every open-work row of the job.
 */
export async function settleJob(
  db: D1Database,
  input: { readonly jobId: string; readonly final: FinalFigure; readonly now: number },
): Promise<SettleResult> {
  const estimate = await jobEstimateCharge(db, input.jobId);
  if (estimate === null) return { status: "charge_missing" };
  return settleJobFrom(db, estimate, input.final, input.now);
}

/** A job's estimate charge, or null while it is not in the ledger (the settlement barrier). */
export async function jobEstimateCharge(db: D1Database, jobId: string): Promise<ChargeRow | null> {
  const row = await db
    .prepare("SELECT * FROM charge WHERE owner_type = 'job' AND owner_id = ? AND kind = 'estimate' ORDER BY seq LIMIT 1")
    .bind(jobId)
    .first<Record<string, unknown>>();
  return row === null ? null : chargeFromRow(row);
}

/** Whether a job's settlement correction is in the ledger. */
export async function jobSettled(db: D1Database, jobId: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM charge WHERE id = ?").bind(jobSettlementId(jobId)).first()) !== null;
}

/** Settles a job from its estimate, already read. */
export async function settleJobFrom(
  db: D1Database,
  estimate: ChargeRow,
  final: FinalFigure,
  now: number,
): Promise<Exclude<SettleResult, { readonly status: "charge_missing" }>> {
  const jobId = estimate.ownerId;
  const built = correctionFor(estimate, final, jobSettlementId(jobId), now);
  if ("noRate" in built) return { status: "no_rate", bucket: built.noRate };
  const written = await writeCorrection(db, built.correction, now, built.finalCost, null, false, jobId);
  return written !== null ? { status: "settled", correction: written } : { status: "already" };
}

export type PricingResult =
  | { readonly status: "priced"; readonly correction: ChargeRow }
  | { readonly status: "already" }
  | { readonly status: "charge_missing" }
  /** Still no price, ours or the customer's. Try again later. */
  | { readonly status: "no_price" };

/** A charge's token columns as a standard-mode usage, for a charge whose measures hold none. */
function tokenColumns(charge: ChargeRow): ReturnType<typeof usageFromMeasures> {
  if (charge.inputTokens === null || charge.outputTokens === null) return null;
  return {
    usage: {
      inputTokens: charge.inputTokens,
      cachedInputTokens: charge.cachedInputTokens ?? 0,
      cacheWriteTokens: charge.cacheWriteTokens ?? 0,
      outputTokens: charge.outputTokens,
    },
    mode: STANDARD_MODE,
    doubt: false,
  };
}

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
  // A final settlement (the charge's own, or its job's) already holds its cost:
  // nothing to price, even while the model still has no rate.
  const settled = await db
    .prepare("SELECT 1 FROM charge WHERE corrects_charge_id = ? AND correction_kind IN ('units', 'dollars') LIMIT 1")
    .bind(original.id)
    .first();
  if (settled !== null) return { status: "already" };
  // So does a session settled with a provider total, for each of its slices.
  if (original.ownerType === "session") {
    const session = await db
      .prepare("SELECT 1 FROM session WHERE id = ? AND settlement = 'settled' AND session_total_nano IS NOT NULL")
      .bind(original.ownerId)
      .first();
    if (session !== null) return { status: "already" };
  }
  const connection =
    original.providerConnectionId === null
      ? null
      : await db
          .prepare("SELECT rates_json FROM provider_connection WHERE id = ?")
          .bind(original.providerConnectionId)
          .first<{ rates_json: string | null }>();
  const resolved = billingForCharge(priceSources({ type: original.providerType, rates_json: connection?.rates_json ?? null }), original.model);
  if (resolved === null) return { status: "no_price" };
  // Priced exactly as the request would have been: the stored usage, with its
  // modalities and variants, in the service mode that served it.
  const stored = usageFromMeasures(original.measures) ?? tokenColumns(original);
  if (stored === null) return { status: "no_price" };
  const { usage } = stored;
  const priced = priceInServedMode(resolved.price, usage, stored.mode, stored.doubt);
  if (priced === null) return { status: "no_price" };
  // The unit and count the price billed, from the pricing result itself.
  const billed = { unit: priced.unit, units: priced.units };
  const correction = correctionOf(original, {
    id: pricingCorrectionId(original.id),
    kind: "pricing",
    costNano: nano(priced.cost - (original.costNano ?? 0)),
    unitsDelta: null,
    priceSource: resolved.source,
    rates: priced.rates,
    measures: { [billed.unit]: billed.units },
    // Its cost lands in the rollup of the unit the price bills.
    unit: billed.unit,
    now: input.now,
    estimate: priced.estimated,
    measured: priced.measured,
  });
  // Never after a final settlement that already holds its cost: the charge's
  // own, its job's, or its session's provider total.
  const written = await writeCorrection(db, correction, input.now, priced.cost, input.doneWork ?? null, true);
  return written !== null ? { status: "priced", correction: written } : { status: "already" };
}
