// Model review is explicit. A discovery never changes the catalog by itself.
import { MODEL_KINDS } from "./kinds.mjs";
import { AUDIO_FIELDS, PRICE_FIELDS } from "./price.mjs";
import { SOURCES } from "./sources.mjs";
import { MIN_PRICE, MAX_PRICE } from "./rules.mjs";


export function parseCommands(body) {
  if (body.length > 8000) throw new Error("Decision comments must be at most 8,000 characters.");
  const lines = body.trim().split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0 || lines.length > 50) throw new Error("Use 1–50 /models commands, one per line.");
  const seen = new Set();
  return lines.map((line) => {
    const match = /^\/models (add|skip) ([a-z][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._:/-]*)(?: (.+))?$/u.exec(line.trim());
    // An addition may name the model's kind, which overrides the one the lists
    // or the AI review gave it.
    if (!match || (match[1] === "add" && match[4] && !MODEL_KINDS.includes(match[4])) || (match[1] === "skip" && !match[4]?.trim())) {
      throw new Error(`Use /models add provider/model [${MODEL_KINDS.join("|")}] or /models skip provider/model reason.`);
    }
    const [, action, provider, model, rest] = match;
    const kind = action === "add" ? rest : undefined;
    const reason = action === "skip" ? rest : undefined;
    if (!Object.hasOwn(SOURCES, provider) || !SOURCES[provider].official) throw new Error(`No official discovery source for ${provider}.`);
    const id = `${provider}/${model}`;
    if (seen.has(id)) throw new Error(`Two decisions for ${id}.`);
    seen.add(id);
    if ((reason?.length ?? 0) > 500) throw new Error("Skip reasons must be at most 500 characters.");
    return { action, provider, model, ...(kind && { kind }), ...(reason && { reason: reason.trim() }) };
  });
}

/** Keep only the rates the gateway understands. Future rates are report-only. */
export function catalogRates(parsed) {
  if (!parsed) throw new Error("the official page does not list this model");
  if (parsed.unpriced) throw new Error(`no public price, ${parsed.unpriced}`);
  const fields = [...PRICE_FIELDS, ...AUDIO_FIELDS, "long_context_threshold"];
  const price = Object.fromEntries(fields.filter((field) => parsed[field] !== undefined).map((field) => [field, parsed[field]]));
  const audio = AUDIO_FIELDS.filter((field) => price[field] !== undefined);
  if (audio.length > 1 || (audio.length && (price.input !== undefined || price.output !== undefined))) throw new Error("Ambiguous billing units.");
  if (!audio.length && (price.input === undefined || price.output === undefined)) throw new Error("No supported input/output rates.");
  for (const [field, value] of Object.entries(price)) {
    if (!Number.isFinite(value) || value < 0 || (field === "long_context_threshold" ? !Number.isInteger(value) || value === 0 : value >= 1000)) {
      throw new Error(`Invalid ${field} rate.`);
    }
    if (PRICE_FIELDS.includes(field) && value !== 0 && (value <= MIN_PRICE || value >= MAX_PRICE)) throw new Error(`Suspicious ${field} rate.`);
  }
  if (price.long_context_threshold !== undefined && (price.long_input === undefined || price.long_output === undefined)) throw new Error("Incomplete long-context rates.");
  if (price.cached_input !== undefined && price.cached_input > price.input) throw new Error("Cached input is more expensive than input.");
  return price;
}
