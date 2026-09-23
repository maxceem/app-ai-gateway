/**
 * Custom model prices while they are still being typed, and the one reading of
 * a finished set of rows.
 *
 * Pricing is ordinary non-secret data, so nothing here is about credentials:
 * it is the arithmetic of a repeatable form, kept away from the dialog that
 * renders it so it can be read and tested on its own.
 */

import type { ProviderPricing } from "@/lib/types";

/** A repeatable pricing row while it is still being typed. */
export interface PricingDraft {
  model: string;
  input: string;
  output: string;
}

/** The stored prices as rows, which is how the form holds them. */
export function toDrafts(pricing: ProviderPricing | null): PricingDraft[] {
  return Object.entries(pricing ?? {}).map(([model, entry]) => ({
    model,
    input: String(entry.input),
    output: String(entry.output),
  }));
}

/**
 * Returns the object to send, or a message naming the first unusable row.
 *
 * A row left entirely blank is dropped, so an operator can leave a spare one
 * lying around. Anything else must be complete: `Number("")` is 0, and a price
 * of $0 has to be a deliberate answer rather than an empty field, because
 * entering a price is what allows a model to be proxied at all.
 */
export function draftsToPricing(
  drafts: PricingDraft[],
): { pricing: ProviderPricing } | { error: string } {
  const pricing: ProviderPricing = {};
  for (const draft of drafts) {
    const model = draft.model.trim();
    const input = draft.input.trim();
    const output = draft.output.trim();
    if (!model && !input && !output) continue;
    if (!model) return { error: "Every pricing row needs a model name" };
    if (!input || !output) {
      return { error: `Enter both prices for ${model} — use 0 only if it is genuinely free` };
    }
    const inputPrice = Number(input);
    const outputPrice = Number(output);
    if (
      !Number.isFinite(inputPrice) || inputPrice < 0
      || !Number.isFinite(outputPrice) || outputPrice < 0
    ) {
      return { error: `Prices for ${model} must be numbers of 0 or more` };
    }
    // Two rows for one model would otherwise let the last one win in silence.
    if (Object.hasOwn(pricing, model)) {
      return { error: `${model} is priced twice — remove the duplicate row` };
    }
    pricing[model] = { input: inputPrice, output: outputPrice };
  }
  return { pricing };
}
