/**
 * Custom model prices while they are still being typed, and the one reading of
 * a finished set of rows.
 *
 * Pricing is ordinary non-secret data, so nothing here is about credentials:
 * it is the arithmetic of a repeatable form, kept away from the dialog that
 * renders it so it can be read and tested on its own.
 */

import type { ProviderPricing } from "@/lib/types";

type StoredPrice = ProviderPricing[string];

/**
 * The optional rates the form has a field for. Each one left blank is not
 * sent, and its tokens bill at the matching text price: cached and cache-write
 * tokens at the input price, audio at the input or output price, and cached
 * audio at the cached price.
 */
export const OPTIONAL_RATES = [
  "cached_input",
  "cache_write",
  "audio_input",
  "audio_output",
  "cached_input_audio",
] as const;

export type OptionalRate = (typeof OPTIONAL_RATES)[number];

/** The audio rates. A realtime model needs all three, and a cached price too. */
export const AUDIO_RATES = ["audio_input", "audio_output", "cached_input_audio"] as const satisfies
  readonly OptionalRate[];

/** The rates the form shows a field for; every other one rides along in `rest`. */
type ShownRate = "input" | "output" | OptionalRate;

/** A repeatable pricing row while it is still being typed. */
export interface PricingDraft {
  model: string;
  input: string;
  output: string;
  /** The optional rates as typed. A missing or blank one is not sent. */
  rates?: Partial<Record<OptionalRate, string>>;
  /** Whether the row shows its audio fields, which most models never need. */
  showAudio?: boolean;
  /**
   * Whatever else the stored price carries — a one-hour cache-write rate or
   * long-context rates set through the API — which the form has no field for
   * and must send back untouched, or saving the dialog would erase it.
   */
  rest?: Omit<StoredPrice, ShownRate>;
}

/** The stored prices as rows, which is how the form holds them. */
export function toDrafts(pricing: ProviderPricing | null): PricingDraft[] {
  return Object.entries(pricing ?? {}).map(([model, entry]) => {
    const { input, output, ...others } = entry;
    const rates: Partial<Record<OptionalRate, string>> = {};
    const rest: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(others)) {
      if (value === undefined) continue;
      if ((OPTIONAL_RATES as readonly string[]).includes(name)) rates[name as OptionalRate] = String(value);
      else rest[name] = value;
    }
    return {
      model,
      input: String(input),
      output: String(output),
      rates,
      showAudio: AUDIO_RATES.some((name) => rates[name] !== undefined),
      ...(Object.keys(rest).length > 0 && { rest: rest as PricingDraft["rest"] }),
    };
  });
}

/** A typed price, or `null` where it is not a number of zero or more. */
function rate(text: string): number | null {
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Returns the object to send, or a message naming the first unusable row.
 *
 * A row left entirely blank is dropped, so an operator can leave a spare one
 * lying around. Anything else must be complete: `Number("")` is 0, and a price
 * of $0 has to be a deliberate answer rather than an empty field, because
 * entering a price is what allows a model to be proxied at all. The optional
 * prices are the exception: left blank, they are simply not sent.
 */
export function draftsToPricing(
  drafts: PricingDraft[],
): { pricing: ProviderPricing } | { error: string } {
  const pricing: ProviderPricing = {};
  for (const draft of drafts) {
    const model = draft.model.trim();
    const input = draft.input.trim();
    const output = draft.output.trim();
    const typed = OPTIONAL_RATES
      .map((name) => [name, draft.rates?.[name]?.trim() ?? ""] as const)
      .filter(([, text]) => text !== "");
    if (!model && !input && !output && typed.length === 0 && !draft.rest) continue;
    if (!model) return { error: "Every pricing row needs a model name" };
    if (!input || !output) {
      return { error: `Enter both prices for ${model} — use 0 only if it is genuinely free` };
    }
    const inputPrice = rate(input);
    const outputPrice = rate(output);
    const optional = typed.map(([name, text]) => [name, rate(text)] as const);
    if (inputPrice === null || outputPrice === null || optional.some(([, value]) => value === null)) {
      return { error: `Prices for ${model} must be numbers of 0 or more` };
    }
    // Two rows for one model would otherwise let the last one win in silence.
    if (Object.hasOwn(pricing, model)) {
      return { error: `${model} is priced twice — remove the duplicate row` };
    }
    pricing[model] = {
      ...draft.rest,
      input: inputPrice,
      output: outputPrice,
      ...Object.fromEntries(optional),
    };
  }
  return { pricing };
}
