/**
 * The price file v2 prices with, as written: v1's `models.json`, copied whole
 * from v1's main branch (D16), plus `models.v2.json`, the prices only v2 has
 * (units v1 does not bill, such as OpenAI's per-character speech). A copy of
 * v1's file never touches the overlay, so v2's own prices survive it.
 *
 * The one place the two are merged. The overlay only adds: a model v1's file
 * already lists keeps v1's entry, and a test fails so the overlay's copy is
 * removed.
 */
import models from "./models.json";
import overlay from "./models.v2.json";

export type PriceFile = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>>;

/** v1's price file. */
export const V1_PRICE_FILE = models as PriceFile;
/** The prices only v2 has. */
export const V2_PRICE_OVERLAY = overlay as PriceFile;

function merged(base: PriceFile, extra: PriceFile): PriceFile {
  const out: Record<string, Record<string, Readonly<Record<string, unknown>>>> = {};
  for (const [provider, entries] of Object.entries(base)) out[provider] = { ...entries };
  for (const [provider, entries] of Object.entries(extra)) {
    const target = (out[provider] ??= {});
    for (const [model, entry] of Object.entries(entries)) if (!Object.hasOwn(target, model)) target[model] = entry;
  }
  return out;
}

/** The whole price file: v1's, plus v2's own prices. */
export const PRICE_FILE: PriceFile = merged(V1_PRICE_FILE, V2_PRICE_OVERLAY);
