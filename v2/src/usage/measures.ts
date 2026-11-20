/**
 * A usage as a charge's measures (D7), and back.
 *
 * Token buckets keep their own columns too. The measures add what a token
 * count alone cannot price again: each modality's share of a side, each
 * variant's share of a bucket, the seconds of audio or the images a model
 * priced by time or per image bills, and the service mode that served the
 * request when it is not standard, the counts in other units (characters,
 * credits, ...) and the price key values the request named. So the sweep can price an
 * `unresolved` charge later exactly as the request would have been.
 */
import { toMilli } from "../money.ts";
import { UNITS, type Unit } from "../providers/operation.ts";
import type { Modality, ModalityCounts, TokenVariants, UsageObservation } from "./observation.ts";
import { isStandardMode, parseServiceModeName, serviceModeName, STANDARD_MODE, type ServiceMode } from "./service-modes.ts";
import { VARIANTS } from "./token-rates.ts";

const SIDES = ["input", "output"] as const;
const COUNTED = ["image", "audio", "video", "unknown"] as const;

/**
 * `modeUnknown`: the request or the response named a mode value the gateway
 * does not know, so any price of it is an estimate. Kept, so a later pricing
 * is marked the same way.
 */
export function usageMeasures(usage: UsageObservation, mode: ServiceMode, modeUnknown = false): Record<string, number | string> {
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
  // Seconds at the fixed scale, so the stored figure is a whole number.
  if (usage.audioSeconds !== undefined) measures.audio_ms = toMilli(usage.audioSeconds);
  if (usage.images !== undefined) measures.images = usage.images;
  if (usage.noTokens === true) measures.no_tokens = 1;
  for (const unit of UNITS) {
    const counted = usage.units?.[unit];
    if (counted !== undefined) measures[`units_${unit}`] = counted;
  }
  if (usage.estimatedUnits !== undefined && usage.estimatedUnits.length > 0) measures.estimated_units = usage.estimatedUnits.join(",");
  if (usage.secondaryUnits !== undefined && usage.secondaryUnits.length > 0) measures.secondary_units = usage.secondaryUnits.join(",");
  if (usage.reportMissing === true) measures.report_missing = 1;
  for (const [key, value] of Object.entries(usage.priceKeys ?? {})) measures[`key_${key}`] = value;
  if (!isStandardMode(mode)) measures.service_mode = serviceModeName(mode);
  if (modeUnknown) measures.service_mode_unknown = 1;
  return measures;
}

function count(measures: Readonly<Record<string, number | string>>, key: string): number | undefined {
  const value = measures[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The usage and service mode a charge's measures hold, or null when it has no token counts. */
export function usageFromMeasures(
  measures: Readonly<Record<string, number | string>>,
): { usage: UsageObservation; mode: ServiceMode; modeUnknown: boolean } | null {
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
  const units: Partial<Record<Unit, number>> = {};
  for (const unit of UNITS) {
    const value = count(measures, `units_${unit}`);
    if (value !== undefined) units[unit] = value;
  }
  const priceKeys: Record<string, string> = {};
  for (const [name, value] of Object.entries(measures)) {
    if (name.startsWith("key_") && typeof value === "string") priceKeys[name.slice("key_".length)] = value;
  }
  const audioMs = count(measures, "audio_ms");
  const images = count(measures, "images");
  const usage: UsageObservation = {
    inputTokens: input,
    cachedInputTokens: count(measures, "cached_input_tokens") ?? 0,
    cacheWriteTokens: count(measures, "cache_write_tokens") ?? 0,
    outputTokens: output,
    ...(modalityTokens.input !== undefined || modalityTokens.output !== undefined ? { modalityTokens } : {}),
    ...(tokenVariants !== undefined ? { tokenVariants: tokenVariants as TokenVariants } : {}),
    ...(audioMs !== undefined ? { audioSeconds: audioMs / 1000 } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(count(measures, "no_tokens") !== undefined ? { noTokens: true as const } : {}),
    ...(Object.keys(units).length > 0 ? { units } : {}),
    ...(typeof measures.estimated_units === "string"
      ? { estimatedUnits: measures.estimated_units.split(",").filter((unit): unit is Unit => (UNITS as readonly string[]).includes(unit)) }
      : {}),
    ...(typeof measures.secondary_units === "string"
      ? { secondaryUnits: measures.secondary_units.split(",").filter((unit): unit is Unit => (UNITS as readonly string[]).includes(unit)) }
      : {}),
    ...(count(measures, "report_missing") !== undefined ? { reportMissing: true as const } : {}),
    ...(Object.keys(priceKeys).length > 0 ? { priceKeys } : {}),
  };
  return {
    usage,
    mode: (typeof modeName === "string" ? parseServiceModeName(modeName) : null) ?? STANDARD_MODE,
    modeUnknown: count(measures, "service_mode_unknown") !== undefined,
  };
}
