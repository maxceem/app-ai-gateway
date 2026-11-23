/**
 * A connection's own prices as a form edits them: one row per model, with the
 * token rates most prices use and one unit rate. Anything else a stored price
 * carries (cache-write and modality rates, long-context rates, service modes,
 * rates by a request field) is kept exactly as stored and never shown as a
 * field, so editing a row changes only the fields its inputs name.
 */

/** The token rates a row shows, in dollars per million tokens. */
export const TOKEN_FIELDS = [
  { field: "input", label: "Input" },
  { field: "output", label: "Output" },
  { field: "cached_input", label: "Cached input" },
] as const;

/** The unit rates a row may set, in dollars per unit. */
export const UNIT_FIELDS = [
  { field: "per_request", label: "per request or job" },
  { field: "per_image", label: "per image" },
  { field: "per_video", label: "per video" },
  { field: "per_second", label: "per second" },
  { field: "per_minute", label: "per minute" },
  { field: "per_hour", label: "per hour" },
  { field: "per_megapixel", label: "per megapixel" },
  { field: "per_million_characters", label: "per million characters" },
  { field: "per_credit", label: "per credit" },
  { field: "per_unit", label: "per billed unit" },
  { field: "per_text_message", label: "per text message" },
] as const;

const UNIT_NAMES: readonly string[] = UNIT_FIELDS.map((entry) => entry.field);

type StoredPrice = Record<string, unknown>;
export type StoredPricing = Record<string, StoredPrice>;

export interface PriceRow {
  /** A key for React, stable while the row lives. */
  key: string;
  model: string;
  /** The typed text of each token rate, "" for none. */
  tokens: Record<(typeof TOKEN_FIELDS)[number]["field"], string>;
  /** The unit rate's field, or "" for none, and its typed amount. */
  unitField: string;
  unitAmount: string;
  /** The model's price as stored, or null for a new row. Fields the row does not show come from here. */
  original: StoredPrice | null;
  /** The model name it was stored under, or null for a new row. */
  originalModel: string | null;
}

const textOf = (value: unknown): string => (typeof value === "number" ? String(value) : "");

let rowCount = 0;
const nextKey = () => `price-${++rowCount}`;

/** The unit rate a stored price shows: its only one, or none when it has several (they stay as stored). */
function shownUnit(price: StoredPrice): string {
  const units = UNIT_NAMES.filter((field) => typeof price[field] === "number");
  return units.length === 1 ? units[0]! : "";
}

export function rowsOf(pricing: StoredPricing | null): PriceRow[] {
  return Object.entries(pricing ?? {}).map(([model, price]) => {
    const unitField = shownUnit(price);
    return {
      key: nextKey(),
      model,
      tokens: { input: textOf(price.input), output: textOf(price.output), cached_input: textOf(price.cached_input) },
      unitField,
      unitAmount: unitField === "" ? "" : textOf(price[unitField]),
      original: price,
      originalModel: model,
    };
  });
}

export function emptyRow(): PriceRow {
  return { key: nextKey(), model: "", tokens: { input: "", output: "", cached_input: "" }, unitField: "", unitAmount: "", original: null, originalModel: null };
}

/** The stored fields a row keeps without showing them. */
export function hiddenFields(row: PriceRow): string[] {
  if (row.original === null) return [];
  // A stored price with several unit rates shows none of them, and keeps them all.
  const shown = new Set<string>([...TOKEN_FIELDS.map((entry) => entry.field), shownUnit(row.original)]);
  return Object.keys(row.original).filter((field) => !shown.has(field));
}

const AMOUNT = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;

/** A typed amount as a number, null for empty, or undefined when it is not an amount. */
function amountOf(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!AMOUNT.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** What is wrong with a row, field by field, in words. */
export function rowProblems(row: PriceRow, rows: readonly PriceRow[]): Record<string, string> {
  const problems: Record<string, string> = {};
  const model = row.model.trim();
  if (model === "") problems.model = "Name the model.";
  else if (rows.some((other) => other !== row && other.model.trim() === model)) problems.model = "This model is listed twice.";
  for (const { field } of TOKEN_FIELDS) {
    if (amountOf(row.tokens[field]) === undefined) problems[field] = "Enter an amount, such as 2.5.";
  }
  if (row.unitField !== "" && amountOf(row.unitAmount) === undefined) problems.unit = "Enter an amount, such as 0.04.";
  const input = amountOf(row.tokens.input);
  const output = amountOf(row.tokens.output);
  if (!problems.input && !problems.output && (input === null) !== (output === null)) {
    problems[input === null ? "input" : "output"] = "Input and output are priced together.";
  }
  const priced = TOKEN_FIELDS.some(({ field }) => amountOf(row.tokens[field]) !== null) || (row.unitField !== "" && amountOf(row.unitAmount) !== null);
  if (!priced && hiddenFields(row).length === 0 && !problems.unit) problems.row = "Give this model at least one rate.";
  return problems;
}

/** The pricing the rows save as: each row's stored price with only the fields its inputs show changed. */
export function pricingOf(rows: readonly PriceRow[]): StoredPricing | null {
  const pricing: StoredPricing = {};
  for (const row of rows) {
    const price: StoredPrice = row.original === null ? {} : structuredClone(row.original);
    for (const { field } of TOKEN_FIELDS) {
      const value = amountOf(row.tokens[field]);
      if (value === null || value === undefined) delete price[field];
      else price[field] = value;
    }
    const storedUnit = row.original === null ? "" : shownUnit(row.original);
    if (storedUnit !== "" && storedUnit !== row.unitField) delete price[storedUnit];
    if (row.unitField !== "") {
      const value = amountOf(row.unitAmount);
      if (value === null || value === undefined) delete price[row.unitField];
      else price[row.unitField] = value;
    }
    pricing[row.model.trim()] = price;
  }
  return Object.keys(pricing).length === 0 ? null : pricing;
}
