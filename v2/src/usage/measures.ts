/**
 * A usage as a charge's measures (D7), and back.
 *
 * Token buckets keep their own columns too. The measures add what a token
 * count alone cannot price again: each modality's share of a side, each
 * variant's share of a bucket, and the service mode
 * that served the request when it is not standard. So the sweep can price an
 * `unresolved` charge later exactly as the request would have been.
 */
import type { Modality, ModalityCounts, TokenVariants, UsageObservation } from "./observation.ts";
import { isStandardMode, parseServiceModeName, serviceModeName, STANDARD_MODE, type ServiceMode } from "./service-modes.ts";
import { VARIANTS } from "./token-rates.ts";

const SIDES = ["input", "output"] as const;
const COUNTED = ["image", "audio", "video", "unknown"] as const;

export function usageMeasures(usage: UsageObservation, mode: ServiceMode): Record<string, number | string> {
  const measures: Record<string, number | string> = {
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    output_tokens: usage.outputTokens,
  };
  for (const side of SIDES) {
    const counts = usage.modalityTokens?.[side];
    if (counts === undefined) continue;
    // Recorded even when empty: an empty split says "all text", which differs from no split at all.
    measures[`${side}_split`] = 1;
    for (const kind of COUNTED) {
      const count = counts[kind];
      if (count !== undefined && count > 0) measures[`${side}_${kind}_tokens`] = count;
    }
  }
  for (const variant of VARIANTS) {
    const counts = usage.tokenVariants?.[variant.bucket] as Partial<Record<string, number>> | undefined;
    const count = counts?.[variant.name];
    if (count !== undefined && count > 0) measures[`${variant.field}_tokens`] = count;
  }
  if (!isStandardMode(mode)) measures.service_mode = serviceModeName(mode);
  return measures;
}

function count(measures: Readonly<Record<string, number | string>>, key: string): number | undefined {
  const value = measures[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The usage and service mode a charge's measures hold, or null when it has no token counts. */
export function usageFromMeasures(measures: Readonly<Record<string, number | string>>): { usage: UsageObservation; mode: ServiceMode } | null {
  const input = count(measures, "input_tokens");
  const output = count(measures, "output_tokens");
  if (input === undefined || output === undefined) return null;
  const modalityTokens: { input?: ModalityCounts; output?: ModalityCounts } = {};
  for (const side of SIDES) {
    if (count(measures, `${side}_split`) === undefined) continue;
    const counts: Partial<Record<Modality | "unknown", number>> = {};
    for (const kind of COUNTED) {
      const value = count(measures, `${side}_${kind}_tokens`);
      if (value !== undefined) counts[kind] = value;
    }
    modalityTokens[side] = counts;
  }
  let tokenVariants: Record<string, Record<string, number>> | undefined;
  for (const variant of VARIANTS) {
    const value = count(measures, `${variant.field}_tokens`);
    if (value === undefined) continue;
    tokenVariants ??= {};
    (tokenVariants[variant.bucket] ??= {})[variant.name] = value;
  }
  const modeName = measures.service_mode;
  const usage: UsageObservation = {
    inputTokens: input,
    cachedInputTokens: count(measures, "cached_input_tokens") ?? 0,
    cacheWriteTokens: count(measures, "cache_write_tokens") ?? 0,
    outputTokens: output,
    ...(modalityTokens.input !== undefined || modalityTokens.output !== undefined ? { modalityTokens } : {}),
    ...(tokenVariants !== undefined ? { tokenVariants: tokenVariants as TokenVariants } : {}),
  };
  return { usage, mode: (typeof modeName === "string" ? parseServiceModeName(modeName) : null) ?? STANDARD_MODE };
}
