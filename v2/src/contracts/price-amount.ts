/**
 * How a price typed in dollars is stored: whole nano-dollars per million
 * units, rounded up (`rateFromDollarsPerMillion` in `../money.ts`). The
 * console checks a typed price with the same rule, so it never shows one
 * figure and saves another.
 */
import { MoneyError, NANO_PER_DOLLAR, rateFromDollarsPerMillion } from "../money.ts";

/** The smallest step a price is stored in, in dollars. */
export const PRICE_STEP_DOLLARS = 1 / NANO_PER_DOLLAR;

/**
 * What is wrong with storing `dollars` as a price, or null when it is stored
 * exactly as typed: too large to store, or finer than the smallest step and
 * so rounded up to a different figure.
 */
export function priceAmountProblem(dollars: number): string | null {
  let stored: number;
  try {
    stored = rateFromDollarsPerMillion(dollars);
  } catch (error) {
    if (error instanceof MoneyError) return "This price is too large to store.";
    throw error;
  }
  const back = Number((stored / NANO_PER_DOLLAR).toPrecision(15));
  if (back === dollars) return null;
  return `Prices are kept to $0.000000001; this would be stored as ${back.toFixed(9).replace(/0+$/u, "").replace(/\.$/u, "")}.`;
}
