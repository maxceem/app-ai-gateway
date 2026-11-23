/**
 * How a price typed in dollars is stored: whole nano-dollars per million
 * units, rounded up (`rateFromDollarsPerMillion` in `../money.ts`). The
 * console checks a typed price with the same rule, so it never shows one
 * figure and saves another.
 */
import { MoneyError, NANO_PER_DOLLAR, rateFromDollarsPerMillion } from "../money.ts";

/** The smallest step a price is stored in, in dollars. */
export const PRICE_STEP_DOLLARS = 1 / NANO_PER_DOLLAR;

const NANO_DIGITS = 9;

/** A stored amount in nano-dollars, written as dollars: 1500000 as "0.0015". */
function dollarsText(nanos: number): string {
  const text = String(nanos).padStart(NANO_DIGITS + 1, "0");
  const whole = text.slice(0, -NANO_DIGITS);
  const fraction = text.slice(-NANO_DIGITS).replace(/0+$/u, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/** A typed decimal's parts: its digits, and where the point stands. */
const DECIMAL = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u;

/** The most digits, and the largest exponent, a typed price may have; far beyond any price, and small enough to compute exactly. */
const MAX_DIGITS = 40;
const MAX_EXPONENT = 400;

/**
 * The typed decimal as whole nano-dollars, exactly, without passing through a
 * float; null when it is finer than one nano-dollar. `digits` and `exponent`
 * are already bounded, so the power stays small.
 */
function exactNanos(digits: string, fraction: string, exponent: number): bigint | null {
  const shift = exponent - fraction.length + NANO_DIGITS;
  if (shift >= 0) return BigInt(digits) * 10n ** BigInt(shift);
  const kept = digits.length + shift;
  // Every digit past the nano-dollar must be 0.
  if (!/^0*$/u.test(kept > 0 ? digits.slice(kept) : digits)) return null;
  return kept > 0 ? BigInt(digits.slice(0, kept)) : 0n;
}

/**
 * What is wrong with storing a typed price, or null when the gateway stores
 * exactly what was typed: not a plain amount, negative, absurdly long, too
 * large to store, or finer than the smallest step and so stored as another
 * figure, which the message names. The typed text is compared as a decimal,
 * so `1.0000000000000001` is caught even where a float reads it as 1.
 */
export function priceTextProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("-")) return "A price cannot be negative.";
  const match = DECIMAL.exec(trimmed);
  if (match === null || `${match[1]}${match[2] ?? ""}` === "") return "Enter an amount, such as 2.5.";
  const fraction = match[2] ?? "";
  const digits = `${match[1]}${fraction}`;
  // Zero, however it is written, is stored as zero.
  if (/^0*$/u.test(digits)) return null;
  const exponentText = (match[3] ?? "0").replace(/^\+/u, "");
  if (digits.length > MAX_DIGITS || exponentText.replace(/^-/u, "").replace(/^0+/u, "").length > 3 || Math.abs(Number(exponentText)) > MAX_EXPONENT) {
    return "This amount has too many digits, or too large an exponent, to be a price.";
  }
  const dollars = Number(trimmed);
  let stored: number;
  try {
    stored = rateFromDollarsPerMillion(dollars);
  } catch (error) {
    if (error instanceof MoneyError) return "This price is too large to store.";
    throw error;
  }
  if (exactNanos(digits, fraction, Number(exponentText)) === BigInt(stored)) return null;
  return `Prices are kept to $0.000000001; this would be stored as ${dollarsText(stored)}.`;
}
