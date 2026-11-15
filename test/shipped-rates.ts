import models from "../src/usage/models.json";
import type { TokenRateField } from "../src/shared/token-rates";

/**
 * A test asserts the cost arithmetic — which rate each kind of token is billed
 * at, and when the long-context rate applies — never what a model costs. It
 * reads the rates from the model's entry instead of repeating them, and keeps
 * only the formula in its own words.
 *
 * The entry is the frozen copy's (`test/fixtures/price-list.json`), which
 * `test/frozen-prices.ts` puts in place of `src/usage/models.json` for every
 * test but the shipped list's own checks. The shipped list changes daily, so a
 * test that read it would break whenever a model it names left or moved.
 */
export type ShippedRates = Record<
  TokenRateField | "per_minute" | "per_hour" | "per_image" | "long_context_threshold",
  number
>;

/**
 * The shipped rates of one model. Reading a rate the entry does not have
 * throws, so a test that depends on, say, a cached price fails with a reason
 * when the catalog stops carrying one, instead of comparing against `NaN`.
 */
export function shippedRates(provider: string, model: string): ShippedRates {
  const catalog = models as Record<string, Record<string, Record<string, unknown>>>;
  const entry = catalog[provider]?.[model];
  if (entry === undefined) throw new Error(`${provider}/${model} is not in the test price list`);
  return new Proxy(entry, {
    get(target, field) {
      const value = target[field as string];
      if (typeof value !== "number") {
        throw new Error(`${provider}/${model} has no ${String(field)} in the test price list`);
      }
      return value;
    },
  }) as unknown as ShippedRates;
}

/** A cost as the spend totals hold it: `ROUND(cost_usd * 1000000)` in the triggers. */
export function microusd(costUsd: number): number {
  return Math.round(costUsd * 1_000_000);
}
