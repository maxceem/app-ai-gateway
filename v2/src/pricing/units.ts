/**
 * Billed units other than tokens, and the rates that price them (plan section
 * 4.2, "Money"; step 4).
 *
 * One table says, for each unit rate a price may carry, which unit it bills
 * and what divides the stored count. Pricing, the save-time checks and the
 * charge's main unit all read it, so a new unit is one row here.
 *
 * Counts are whole numbers. A unit that can be fractional (seconds, fal's
 * billable units, credits) is stored at `MILLI_SCALE`, so 2.7 seconds is 2700.
 * A rate is integer nano-dollars per stated amount: per minute, per image,
 * per million characters. The cost is `count × rate ÷ per`, rounded up once
 * (`costOfRates` in `./tokens.ts`, over `priceUnitsMixed`).
 */
import { MILLI_SCALE } from "../money.ts";
import type { OperationDescription, Unit } from "../providers/operation.ts";
import type { UsageObservation } from "../usage/observation.ts";

/** Units stored at `MILLI_SCALE`; every other unit is a plain count. */
const MILLI_UNITS: ReadonlySet<Unit> = new Set<Unit>(["audio_seconds", "session_seconds", "video_seconds", "model_units", "credits", "megapixels"]);

/** The scale a unit's count is stored at: 1000 for a unit that can be fractional, else 1. */
export function unitScale(unit: Unit): number {
  return MILLI_UNITS.has(unit) ? MILLI_SCALE : 1;
}

/** A measure as stored: a whole count at the unit's scale. */
export function scaledCount(unit: Unit, value: number): number {
  const scaled = value * unitScale(unit);
  return Math.ceil(Number(scaled.toPrecision(15)));
}

export interface UnitRate {
  /** The rate's name in a price (the price file and a customer's rates), in dollars per `amount`. */
  readonly field: string;
  /** The units it bills. A time rate bills any time unit. */
  readonly units: readonly Unit[];
  /** How many stored counts one rate amount covers: 60,000 for a rate per minute on milliseconds. */
  readonly per: number;
}

const TIME_UNITS: readonly Unit[] = ["audio_seconds", "video_seconds", "session_seconds"];

/**
 * Every unit rate. A price with more than one bills, among the units its
 * usage reports, one the provider reported before one worked out from the
 * request, and among those the dearest (`preferred` in `./tokens.ts`).
 */
export const UNIT_RATES: readonly UnitRate[] = [
  { field: "per_minute", units: TIME_UNITS, per: 60 * MILLI_SCALE },
  { field: "per_hour", units: TIME_UNITS, per: 3600 * MILLI_SCALE },
  { field: "per_second", units: TIME_UNITS, per: MILLI_SCALE },
  { field: "per_image", units: ["images"], per: 1 },
  { field: "per_megapixel", units: ["megapixels"], per: MILLI_SCALE },
  { field: "per_million_characters", units: ["characters"], per: 1_000_000 },
  { field: "per_credit", units: ["credits"], per: MILLI_SCALE },
  { field: "per_unit", units: ["model_units"], per: MILLI_SCALE },
  { field: "per_request", units: ["requests"], per: 1 },
  { field: "per_text_message", units: ["text_messages"], per: 1 },
];

/** The names of every unit rate. */
export const UNIT_RATE_FIELDS: readonly string[] = UNIT_RATES.map((rate) => rate.field);

/**
 * A sample count: one whole unit, at the unit's scale (1000 for a fractional
 * unit, `unitScale`). A case only asks whether a price can bill it, so a probe
 * never overflows where one real unit would not.
 */
const sample = (unit: Unit): number => unitScale(unit);
const NO_TOKENS = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true } as const;
const SOME_TOKENS = { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } as const;

/** `usage` with the request's own measure beside it, as every meter keeps it (`src/proxy/meter.ts`). */
function withEstimate(usage: UsageObservation, estimate: Unit | undefined): UsageObservation {
  if (estimate === undefined || usage.units?.[estimate] !== undefined) return usage;
  return { ...usage, units: { ...usage.units, [estimate]: sample(estimate) }, estimatedUnits: [estimate] };
}

/**
 * The usages a meter can produce, as sample observations, grouped into the
 * ways one model's answers can come out. A model's price can bill an
 * operation in a way when every usage in it gets a price from the one charge
 * function (`priceInServedMode`). Saving and eligibility are worked out by
 * running that function over these cases (`src/pricing/billability.ts`), so
 * they can never disagree with the charge.
 *
 * - Usage in the response: tokens, or one of the units the meter declares its
 *   reader reports (a transcription's duration, an image API's images), or
 *   tokens and that unit together, each a way of its own, since a model
 *   answers in one of them (a reported unit is billed before tokens). Each keeps the
 *   request's measure beside it when the meter declares one, and an answer
 *   that reports nothing bills that measure alone (OpenAI's plain speech).
 * - A response header: one way, since the same model's answers can come any
 *   of its ways: the header present (beside the request's estimate and the
 *   body's measures), the header alone and the body alone where the meter
 *   reads the body, and the header missing (the estimate alone).
 * - A request measure: its unit, worked out from the request.
 * - A request count: one request, exact.
 * - Connection time: session seconds.
 * - A session's provider events: tokens, or session seconds.
 */
export function meterCases(operation: OperationDescription): readonly (readonly UsageObservation[])[] {
  const { meter } = operation;
  const reported = (unit: Unit): UsageObservation => ({ ...NO_TOKENS, units: { [unit]: sample(unit) } });
  switch (meter.kind) {
    case "response_json": {
      const estimate = meter.requestMeasure?.unit;
      const units = meter.units ?? [];
      const ways: UsageObservation[][] = [
        [withEstimate(SOME_TOKENS, estimate)],
        ...units.map((unit) => [withEstimate(reported(unit), estimate)]),
        ...units.map((unit) => [withEstimate({ ...SOME_TOKENS, units: { [unit]: sample(unit) } }, estimate)]),
      ];
      if (estimate !== undefined) ways.push([withEstimate(NO_TOKENS, estimate)]);
      return ways;
    }
    case "response_header": {
      const estimate = meter.estimate?.unit;
      const body = Object.fromEntries((meter.body?.units ?? []).map((unit) => [unit, sample(unit)]));
      const header = { [meter.unit]: sample(meter.unit) };
      const secondary = meter.body === undefined ? {} : { secondaryUnits: meter.body.units };
      // One way, since the same model's answers can come any of these ways:
      // the header, beside the body's measures where the meter reads them;
      // the header alone; the body alone; and, with an estimate, neither,
      // where the request's estimate bills.
      const way: UsageObservation[] = [withEstimate({ ...NO_TOKENS, ...secondary, units: { ...header, ...body } }, estimate)];
      if (meter.body !== undefined) {
        way.push(withEstimate({ ...NO_TOKENS, units: header }, estimate));
        way.push(withEstimate({ ...NO_TOKENS, ...secondary, units: body }, estimate));
      }
      if (estimate !== undefined) way.push({ ...withEstimate(NO_TOKENS, estimate), reportMissing: true });
      return [way];
    }
    case "request_measure":
      return [[withEstimate(NO_TOKENS, meter.unit)]];
    case "request_count":
      return [[{ ...NO_TOKENS, units: { requests: 1 } }]];
    case "wall_clock":
      return [[reported("session_seconds")]];
    case "provider_event":
      return [[SOME_TOKENS], [reported("session_seconds")]];
  }
}
