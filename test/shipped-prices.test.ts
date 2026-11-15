import { describe, expect, it } from "vitest";
import models from "../src/usage/models.json";
import { providerModelAuthor } from "../src/providers/provider-type";
import { hasTokenModelPrice, resolveModelAuthor } from "../src/usage/pricing";
import { MODEL_KINDS, type ModelKind } from "../src/shared/model-kinds";
import { LONG_RATE_FIELDS, TOKEN_RATE_FIELDS, type TokenRateField } from "../src/shared/token-rates";
import { PROVIDER_TYPES, type ProviderType } from "../src/shared/providers";

// The one test file that reads the shipped price list: `test/frozen-prices.ts`
// gives every other one a frozen copy. A provider adds, retires and reprices
// models all the time, so nothing here names a model. Each test is a rule over
// every entry, and fails only when an entry is actually wrong.

/**
 * The catalog is market data typed by hand, and its one unit mistake — a price
 * entered per 1K tokens, or in cents — would be invisible: the request still
 * proxies, the event still records, and the bill is wrong by three orders of
 * magnitude. These assertions are about the *shape* of the numbers, not their
 * values, so they keep holding as prices move.
 */
describe("the shipped price catalog", () => {
  const catalog = models as Record<string, Record<string, Record<string, unknown>>>;
  const PRICED_FIELDS = new Set<string>([
    ...TOKEN_RATE_FIELDS,
    "per_minute",
    "per_hour",
    "per_image",
    "long_context_threshold",
  ]);

  it("prices every catalogued model in dollars per million tokens", () => {
    for (const [provider, models] of Object.entries(catalog)) {
      expect([provider, PROVIDER_TYPES]).toContainEqual(provider);
      for (const [model, entry] of Object.entries(models)) {
        const where = `${provider}/${model}`;
        for (const [field, value] of Object.entries(entry)) {
          if (field === "author") {
            expect([where, typeof value]).toEqual([where, "string"]);
            continue;
          }
          if (field === "kind") {
            expect([where, MODEL_KINDS.includes(value as ModelKind)]).toEqual([where, true]);
            continue;
          }
          if (field === "retirement_date") {
            // A real calendar day, as the daily model sync writes it.
            const day = String(value);
            expect([where, /^\d{4}-\d{2}-\d{2}$/.test(day), new Date(`${day}T00:00:00Z`).toISOString().startsWith(day)])
              .toEqual([where, true, true]);
            continue;
          }
          if (field === "price_changes") {
            // Days in order, each changing at least one rate the entry's
            // billing unit uses, held to the same band as the entry's own.
            expect([where, Array.isArray(value) && value.length > 0]).toEqual([where, true]);
            let previous = "";
            for (const change of value as Record<string, unknown>[]) {
              const day = String(change.from);
              expect([where, day, /^\d{4}-\d{2}-\d{2}$/.test(day), new Date(`${day}T00:00:00Z`).toISOString().startsWith(day), day > previous])
                .toEqual([where, day, true, true, true]);
              previous = day;
              const rates = Object.entries(change).filter(([key]) => key !== "from");
              expect([where, day, rates.length > 0]).toEqual([where, day, true]);
              for (const [rate, amount] of rates) {
                expect([where, day, rate, PRICED_FIELDS.has(rate), typeof amount]).toEqual([where, day, rate, true, "number"]);
                if (rate === "long_context_threshold") continue;
                const unit = entry.per_minute !== undefined ? "per_minute" : entry.per_hour !== undefined ? "per_hour" : entry.per_image !== undefined ? "per_image" : "token";
                expect([where, day, rate, unit === "token" ? TOKEN_RATE_FIELDS.includes(rate as TokenRateField) : rate === unit])
                  .toEqual([where, day, rate, true]);
                expect([where, day, rate, (amount as number) > 0.001 && (amount as number) < 1000]).toEqual([where, day, rate, true]);
              }
            }
            continue;
          }
          // A field the rate config does not name would be silently unbilled.
          expect([where, field, PRICED_FIELDS.has(field)]).toEqual([where, field, true]);
          expect([where, field, typeof value]).toEqual([where, field, "number"]);
          expect([where, field, (value as number) >= 0]).toEqual([where, field, true]);
        }
        if (entry.per_minute !== undefined || entry.per_hour !== undefined) continue;
        if (entry.per_image !== undefined) {
          // Dollars per image: a few cents, never a per-1M figure entered by mistake.
          const perImage = entry.per_image as number;
          expect([where, perImage > 0 && perImage < 10]).toEqual([where, true]);
          continue;
        }
        // Per-1M units: a $3/1M model is `3`, not `0.000003` and not `300`.
        // Nothing real sits outside this band, and both mistakes leave it.
        for (const field of TOKEN_RATE_FIELDS) {
          const value = entry[field] as number | undefined;
          if (value === undefined || value === 0) continue;
          expect([where, field, value > 0.001 && value < 1000])
            .toEqual([where, field, true]);
        }
        // A discount that is not a discount is a data-entry slip, and it would
        // over-bill every cached token on that model.
        if (typeof entry.cached_input === "number") {
          expect([where, entry.cached_input <= (entry.input as number)])
            .toEqual([where, true]);
        }
        expect([where, hasTokenModelPrice(provider as ProviderType, model)])
          .toEqual([where, true]);
      }
    }
  });

  /**
   * The kind decides which endpoints a model may serve, so every entry names
   * one, and one its billing unit agrees with: an image price is an image
   * model's, and a time price is a transcription's or a realtime session's.
   * Token prices fit every kind, image models included.
   */
  it("names a kind for every catalogued model that fits how it is billed", () => {
    for (const [provider, models] of Object.entries(catalog)) {
      for (const [model, entry] of Object.entries(models)) {
        const where = `${provider}/${model}`;
        const kind = entry.kind as ModelKind;
        expect([where, MODEL_KINDS.includes(kind)]).toEqual([where, true]);
        if (entry.per_image !== undefined) expect([where, kind]).toEqual([where, "image"]);
        if (entry.per_minute !== undefined || entry.per_hour !== undefined) {
          expect([where, ["transcription", "realtime"].includes(kind)]).toEqual([where, true]);
        }
      }
    }
  });

  /**
   * A provider type with no default author has to name one per entry, or its
   * usage rows aggregate under "unknown" — which is the whole reason the
   * dimension is stored rather than derived from the provider type.
   */
  it("names an author for every model whose provider type has none", () => {
    for (const type of PROVIDER_TYPES) {
      if (providerModelAuthor(type) !== null) continue;
      for (const model of Object.keys(catalog[type] ?? {})) {
        expect([`${type}/${model}`, resolveModelAuthor(type, model)])
          .not.toEqual([`${type}/${model}`, null]);
      }
    }
  });

  /**
   * A long-context rate applies only above its entry's threshold, so one
   * without the other bills wrong in silence: long rates with no threshold
   * never apply, and a threshold with no long rate changes nothing.
   */
  it("pairs every long-context rate with a threshold", () => {
    for (const [provider, models] of Object.entries(catalog)) {
      for (const [model, entry] of Object.entries(models)) {
        const where = `${provider}/${model}`;
        const longRates = LONG_RATE_FIELDS.filter((field) => entry[field] !== undefined);
        const threshold = entry.long_context_threshold;
        if (threshold === undefined) {
          expect([where, longRates]).toEqual([where, []]);
          continue;
        }
        expect([where, Number.isInteger(threshold) && (threshold as number) > 0]).toEqual([where, true]);
        expect([where, longRates.length > 0]).toEqual([where, true]);
      }
    }
  });
});
