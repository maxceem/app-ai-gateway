/**
 * The gateway stores money as whole nano-dollars (plan D20); people read and
 * type dollars. Converting happens here only, at the edge of a form.
 */
export const NANO_PER_DOLLAR = 1_000_000_000;

/** A nano-dollar amount as dollars, the way {@link formatCost} shows costs. */
export function nanoToDollars(nano: number): number {
  return nano / NANO_PER_DOLLAR;
}

/**
 * Dollars a person typed, such as `25` or `0.5`, as whole nano-dollars. Null
 * for anything that is not a plain amount of 0 or more: the form says so
 * instead of guessing.
 */
export function dollarsToNano(input: string): number | null {
  const text = input.trim();
  if (!/^\d+(?:\.\d{1,9})?$/u.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  const value = Number(whole) * NANO_PER_DOLLAR + Number(fraction.padEnd(9, "0"));
  return Number.isSafeInteger(value) ? value : null;
}

/** Nano-dollars as the text a dollars field shows, with no trailing zeros. */
export function nanoToDollarText(nano: number): string {
  const whole = Math.floor(nano / NANO_PER_DOLLAR);
  const fraction = String(nano % NANO_PER_DOLLAR).padStart(9, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
