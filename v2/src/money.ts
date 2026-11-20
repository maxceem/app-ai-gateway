/**
 * Money, as whole nano-dollars (plan D20).
 *
 * - Every amount is an integer number of nano-dollars: 1 = $0.000000001.
 * - Rates are integer nano-dollars per million units.
 * - Rounding happens once, when a charge is priced, and always up, so a priced
 *   charge is never free by accident. After that, sums, corrections and
 *   rollups are exact integer addition.
 * - Dollars appear only at the edges: read from the price file or a provider,
 *   and formatted for display.
 *
 * `NanoDollars` is a branded number, so a plain number (perhaps a float in
 * dollars) cannot be passed where money is expected without going through
 * one of the helpers here.
 */

declare const nanoDollars: unique symbol;

/** A whole number of nano-dollars. Make one with the helpers below. */
export type NanoDollars = number & { readonly [nanoDollars]: true };

/** A rate: whole nano-dollars per million units. */
export type RateNanoPerMillion = number & { readonly [nanoDollars]: "rate" };

export const NANO_PER_DOLLAR = 1_000_000_000;
const MILLION = 1_000_000n;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`${what} must be a safe whole number, got ${value}`);
}

/** Wraps a value already known to be whole nano-dollars, such as one read from D1. */
export function nano(value: number): NanoDollars {
  assertSafeInteger(value, "An amount of nano-dollars");
  return value as NanoDollars;
}

/** Wraps a value already known to be a whole rate in nano-dollars per million units. */
export function rate(value: number): RateNanoPerMillion {
  assertSafeInteger(value, "A rate");
  if (value < 0) throw new MoneyError(`A rate cannot be negative, got ${value}`);
  return value as RateNanoPerMillion;
}

/**
 * Converts dollars once, rounding up, so a positive amount never becomes 0.
 * Used for provider-reported dollars and amounts typed in dollars.
 */
export function fromDollars(dollars: number): NanoDollars {
  if (!Number.isFinite(dollars)) throw new MoneyError(`Dollars must be a finite number, got ${dollars}`);
  // Through a decimal string, so 0.1 is 100000000 and not 100000000.00000001 rounded up.
  const value = Math.ceil(Number((dollars * NANO_PER_DOLLAR).toPrecision(15)));
  return nano(Object.is(value, -0) ? 0 : value);
}

/** Converts a price in dollars per million units, as the price file writes it, to a rate. */
export function rateFromDollarsPerMillion(dollarsPerMillion: number): RateNanoPerMillion {
  if (!Number.isFinite(dollarsPerMillion) || dollarsPerMillion < 0) {
    throw new MoneyError(`A price must be a finite number of dollars, 0 or more, got ${dollarsPerMillion}`);
  }
  const value = Math.ceil(Number((dollarsPerMillion * NANO_PER_DOLLAR).toPrecision(15)));
  return rate(value);
}

/**
 * The cost of `units` at `ratePerMillion`: units × rate ÷ 1,000,000, rounded
 * up. The product is taken in BigInt, because it can pass 2^53 even when the
 * result cannot (100,000 tokens at $600 per million is 6×10^16 before the
 * division).
 */
export function priceUnits(units: number, ratePerMillion: RateNanoPerMillion): NanoDollars {
  assertSafeInteger(units, "A count of units");
  if (units < 0) throw new MoneyError(`A count of units cannot be negative, got ${units}`);
  const product = BigInt(units) * BigInt(ratePerMillion);
  const cost = (product + MILLION - 1n) / MILLION;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError("The cost is too large to store");
  return Number(cost) as NanoDollars;
}

/**
 * The cost of several unit counts, each at its own rate, rounded up once over
 * the whole: Σ units × rate ÷ 1,000,000. A charge rounds once (D20), not once
 * per bucket.
 */
export function priceUnitsSum(parts: readonly (readonly [units: number, rate: RateNanoPerMillion])[]): NanoDollars {
  let product = 0n;
  for (const [units, perMillion] of parts) {
    assertSafeInteger(units, "A count of units");
    if (units < 0) throw new MoneyError(`A count of units cannot be negative, got ${units}`);
    product += BigInt(units) * BigInt(perMillion);
  }
  const cost = (product + MILLION - 1n) / MILLION;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError("The cost is too large to store");
  return Number(cost) as NanoDollars;
}

/**
 * The cost of `units` at a rate per `per` units, rounded up: units × rate ÷
 * per. For a rate per minute applied to milliseconds of audio, `per` is
 * 60,000, so the measure is never a fraction (plan section 4.2: priced once
 * per charge as nano-dollars per minute × seconds ÷ 60). In BigInt, as
 * {@link priceUnits}.
 */
export function priceUnitsPer(units: number, ratePerUnit: RateNanoPerMillion, per: number): NanoDollars {
  assertSafeInteger(units, "A count of units");
  assertSafeInteger(per, "A unit divisor");
  if (units < 0) throw new MoneyError(`A count of units cannot be negative, got ${units}`);
  if (per <= 0) throw new MoneyError(`A unit divisor must be positive, got ${per}`);
  const divisor = BigInt(per);
  const cost = (BigInt(units) * BigInt(ratePerUnit) + divisor - 1n) / divisor;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError("The cost is too large to store");
  return Number(cost) as NanoDollars;
}

/** Exact integer sum of a list of amounts. */
export function sumMoney(amounts: Iterable<NanoDollars>): NanoDollars {
  let total = 0;
  for (const amount of amounts) total += amount;
  return nano(total);
}

/** Exact integer sum of a few amounts. */
export function addMoney(...amounts: readonly NanoDollars[]): NanoDollars {
  return sumMoney(amounts);
}

/** `final - original`, the difference a correction holds. */
export function difference(final: NanoDollars, original: NanoDollars): NanoDollars {
  return nano(final - original);
}

/** For display only: dollars with up to nine decimals, without trailing zeros. */
export function formatDollars(amount: NanoDollars): string {
  const negative = amount < 0;
  const absolute = BigInt(Math.abs(amount));
  const whole = absolute / BigInt(NANO_PER_DOLLAR);
  const fraction = (absolute % BigInt(NANO_PER_DOLLAR)).toString().padStart(9, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}$${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/** Fixed integer scale for fractional measures, such as seconds: 1 second = 1000. */
export const MILLI_SCALE = 1000;

/** A fractional measure at the fixed scale, rounded up. */
export function toMilli(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new MoneyError(`A measure must be finite and 0 or more, got ${value}`);
  return Math.ceil(Number((value * MILLI_SCALE).toPrecision(15)));
}
