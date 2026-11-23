/**
 * Reading a typed number exactly as written. A price in dollars is stored as
 * whole nano-dollars per million units, rounded up (`rateFromDollarsPerMillion`
 * in `../money.ts`); the console reads a typed price with the same rule, so it
 * never shows one figure and saves another. Every comparison here is made on
 * the decimal text, never through a float.
 */
import { MoneyError, rateFromDollarsPerMillion } from "../money.ts";

const NANO_DIGITS = 9;

/** The most significant digits, and the largest power of ten, a typed price may have: far beyond any price, and small enough to compute exactly. */
const MAX_DIGITS = 40;
const MAX_EXPONENT = 400;

/**
 * A decimal as its sign, its significant digits (no leading or trailing
 * zeros) and the power of ten just past its first digit: `0.0015` is
 * `{digits: "15", exponent: -2}`, read as 0.15 × 10^-2. Zero is
 * `{digits: ""}`. Null for text that is not a plain decimal.
 */
export function decimalParts(text: string): { negative: boolean; digits: string; exponent: number } | null {
  const match = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(text.trim());
  if (match === null || `${match[2]}${match[3] ?? ""}` === "") return null;
  const whole = match[2] ?? "";
  const all = `${whole}${match[3] ?? ""}`;
  const leading = /^0*/u.exec(all)![0].length;
  const digits = all.slice(leading).replace(/0+$/u, "");
  if (digits === "") return { negative: false, digits: "", exponent: 0 };
  return { negative: match[1] === "-", digits, exponent: whole.length - leading + Number(match[4] ?? "0") };
}

const sameParts = (a: ReturnType<typeof decimalParts>, b: ReturnType<typeof decimalParts>): boolean =>
  a !== null && b !== null && a.negative === b.negative && a.digits === b.digits && a.exponent === b.exponent;

/**
 * Whether a number sent as JSON is exactly the one written: a float reads
 * `0.99999999999999999` as 1, and `1e-400` as 0.
 */
export function readsAsWritten(number: string): boolean {
  return sameParts(decimalParts(number), decimalParts(String(Number(number))));
}

/** A stored amount in nano-dollars, written as dollars: 1500000 as "0.0015". */
function dollarsText(nanos: number): string {
  const text = String(nanos).padStart(NANO_DIGITS + 1, "0");
  const whole = text.slice(0, -NANO_DIGITS);
  const fraction = text.slice(-NANO_DIGITS).replace(/0+$/u, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * A typed price, read: its value in dollars, or what is wrong with it. Wrong
 * is: not a plain amount (`example` shows one), negative, absurdly long, too
 * large to store, or finer than the smallest step and so stored as another
 * figure, which the message names (`1e-10`, `1.0000000000000001`, or `1e-400`,
 * which would be stored as 0).
 */
export function readPrice(text: string, example = "2.5"): { readonly value: number } | { readonly problem: string } {
  const parts = decimalParts(text);
  if (parts === null) return { problem: `Enter an amount, such as ${example}.` };
  if (parts.negative && parts.digits !== "") return { problem: "A price cannot be negative." };
  // Zero, however it is written, is stored as zero.
  if (parts.digits === "") return { value: 0 };
  if (parts.digits.length > MAX_DIGITS || Math.abs(parts.exponent) > MAX_EXPONENT) {
    return { problem: "This amount has too many digits, or too large an exponent, to be a price." };
  }
  const value = Number(text.trim());
  let stored: number;
  try {
    stored = rateFromDollarsPerMillion(value);
  } catch (error) {
    if (error instanceof MoneyError) return { problem: "This price is too large to store." };
    throw error;
  }
  // The typed amount in nano-dollars, exactly: a whole number only when no digit falls past the nano-dollar.
  const shift = parts.exponent - parts.digits.length + NANO_DIGITS;
  if (shift >= 0 && BigInt(parts.digits) * 10n ** BigInt(shift) === BigInt(stored)) return { value };
  return { problem: `Prices are kept to $0.000000001; this would be stored as ${dollarsText(stored)}.` };
}
