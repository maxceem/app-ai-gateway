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
 * (`priceUnitsPer`).
 */
import { MILLI_SCALE } from "../money.ts";
import type { OperationDescription, Unit } from "../providers/operation.ts";

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
 * Every unit rate, in the order a price is read: a price with more than one
 * bills the first its usage reports.
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
];

/** The names of every unit rate. */
export const UNIT_RATE_FIELDS: readonly string[] = UNIT_RATES.map((rate) => rate.field);

/**
 * The units an operation can measure, so the price of a model it serves must
 * be in one of them (or bill tokens, where `tokens` is listed).
 *
 * - Usage in the response: tokens, plus the units its meter declares its
 *   reader reports (a transcription's duration, an image API's images), plus the request
 *   measure that bills an answer that reports no usage.
 * - A response header: its unit, and its request estimate's.
 * - A request measure: its unit.
 * - A request count: requests.
 */
export function operationUnits(operation: OperationDescription): readonly (Unit | "tokens")[] {
  const { meter } = operation;
  switch (meter.kind) {
    case "response_json": {
      // The units its reader reports are declared on the meter, never inferred from the style.
      const units: (Unit | "tokens")[] = ["tokens", ...(meter.units ?? [])];
      if (meter.requestMeasure !== undefined) units.push(meter.requestMeasure.unit);
      return units;
    }
    case "response_header":
      return meter.estimate === undefined ? [meter.unit] : [meter.unit, meter.estimate.unit];
    case "request_measure":
      return [meter.unit];
    case "request_count":
      return ["requests"];
    case "wall_clock":
      return ["session_seconds"];
    case "provider_event":
      return [];
  }
}
