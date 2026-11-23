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

/**
 * The typed decimal as whole nano-dollars, exactly, without passing through a
 * float; null when it is finer than one nano-dollar or not a plain decimal.
 */
function exactNanos(text: string): bigint | null {
  const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(text.trim());
  if (match === null || `${match[1]}${match[2] ?? ""}` === "") return null;
  const fraction = match[2] ?? "";
  const digits = `${match[1]}${fraction}`;
  const shift = Number(match[3] ?? "0") - fraction.length + NANO_DIGITS;
  if (shift >= 0) return BigInt(digits) * 10n ** BigInt(shift);
  const kept = digits.length + shift;
  // Every digit past the nano-dollar must be 0.
  if (!/^0*$/u.test(kept > 0 ? digits.slice(kept) : digits)) return null;
  return kept > 0 ? BigInt(digits.slice(0, kept)) : 0n;
}

/**
 * What is wrong with storing a typed price, or null when the gateway stores
 * exactly what was typed: too large to store, or finer than the smallest step
 * and so stored as another figure, which the message names. The typed text is
 * compared as a decimal, so `1.0000000000000001` is caught even where a float
 * reads it as 1.
 */
export function priceTextProblem(text: string): string | null {
  const dollars = Number(text.trim());
  let stored: number;
  try {
    stored = rateFromDollarsPerMillion(dollars);
  } catch (error) {
    if (error instanceof MoneyError) return "This price is too large to store.";
    throw error;
  }
  if (exactNanos(text) === BigInt(stored)) return null;
  return `Prices are kept to $0.000000001; this would be stored as ${dollarsText(stored)}.`;
}
