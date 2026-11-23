import { priceTextProblem } from "@contracts/price-amount";

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

// `String` of any finite number reads back as the same number through `amountOf`, exponents included.
const textOf = (value: unknown): string => (typeof value === "number" ? String(value) : "");

let rowCount = 0;
const nextKey = () => `price-${++rowCount}`;

const unitsOf = (price: StoredPrice): string[] => UNIT_NAMES.filter((field) => Object.hasOwn(price, field));

/** The unit rate a stored price shows: its only one, or none when it has several (they stay as stored). */
function shownUnit(price: StoredPrice): string {
  const units = unitsOf(price);
  return units.length === 1 ? units[0]! : "";
}

/** A stored price with several unit rates: its unit fields are kept as stored and edited as JSON only. */
export function severalUnits(row: PriceRow): boolean {
  return row.original !== null && unitsOf(row.original).length > 1;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether the form can show these prices without losing anything: each entry
 * is a price object, and every rate the form shows is a number. Anything else
 * is edited as JSON only.
 */
export function formCanShow(pricing: unknown): pricing is StoredPricing | null {
  if (pricing === null) return true;
  if (!isPlainObject(pricing)) return false;
  return Object.values(pricing).every(
    (price) =>
      isPlainObject(price) &&
      [...TOKEN_FIELDS.map((entry) => entry.field), ...UNIT_NAMES].every((field) => !Object.hasOwn(price, field) || (typeof price[field] === "number" && Number.isFinite(price[field]))),
  );
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

const AMOUNT = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/** A typed amount as a number, null for empty, or undefined when it is not an amount. */
function amountOf(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!AMOUNT.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * What is wrong with a typed amount, by the gateway's own money rules, or
 * null: not an amount, a positive amount too small to read as one (it would
 * become 0), or one the gateway would store as a different figure.
 */
function amountProblem(text: string): string | null {
  const value = amountOf(text);
  if (value === undefined) return "Enter an amount, such as 2.5.";
  if (value === null) return null;
  // A positive amount typed so small that it reads as 0.
  if (value === 0 && /[1-9]/u.test(text.trim().split(/[eE]/u)[0]!)) return "This amount is too small: it would be stored as 0.";
  return priceTextProblem(text);
}

/** Model names that cannot be a key of the prices object, as app settings refuse them. */
const RESERVED_MODELS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** What is wrong with a row, field by field, in words. */
export function rowProblems(row: PriceRow, rows: readonly PriceRow[]): Record<string, string> {
  const problems: Record<string, string> = {};
  const model = row.model.trim();
  if (model === "") problems.model = "Name the model.";
  else if (RESERVED_MODELS.has(model)) problems.model = "This is not a model name.";
  else if (rows.some((other) => other !== row && other.model.trim() === model)) problems.model = "This model is listed twice.";
  for (const { field } of TOKEN_FIELDS) {
    const problem = amountProblem(row.tokens[field]);
    if (problem !== null) problems[field] = problem;
  }
  if (!severalUnits(row) && row.unitField !== "") {
    const problem = amountProblem(row.unitAmount);
    if (problem !== null) problems.unit = problem === "Enter an amount, such as 2.5." ? "Enter an amount, such as 0.04." : problem;
  }
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
  // Each model is a plain own property: no name can reach the object's prototype.
  const pricing: StoredPricing = Object.create(null) as StoredPricing;
  for (const row of rows) {
    const price: StoredPrice = row.original === null ? {} : structuredClone(row.original);
    for (const { field } of TOKEN_FIELDS) {
      const value = amountOf(row.tokens[field]);
      if (value === null || value === undefined) delete price[field];
      else price[field] = value;
    }
    // Several stored unit rates stay exactly as stored.
    const storedUnit = row.original === null ? "" : shownUnit(row.original);
    if (storedUnit !== "" && storedUnit !== row.unitField) delete price[storedUnit];
    if (row.unitField !== "" && !severalUnits(row)) {
      const value = amountOf(row.unitAmount);
      if (value === null || value === undefined) delete price[row.unitField];
      else price[row.unitField] = value;
    }
    Object.defineProperty(pricing, row.model.trim(), { value: price, enumerable: true, writable: true, configurable: true });
  }
  return Object.keys(pricing).length === 0 ? null : { ...pricing };
}

/** Fields of a price whose numbers are not dollar amounts: a mode's multiplier and a token count. */
const NOT_AMOUNTS: ReadonlySet<string> = new Set(["factor", "long_context_threshold"]);

/**
 * What is wrong with the amounts in prices typed as JSON, judged on each
 * number as it was written, not as a float reads it: `1e-400` is refused, as
 * the form refuses it, though `JSON.parse` reads it as 0. Walks the text once,
 * skipping strings, and judges each number by the field it belongs to.
 * Returns null when every amount is stored exactly as written.
 */
export function jsonPriceProblem(text: string): string | null {
  let key: string | null = null;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      // A string: read it, unescaping only enough to know where it ends.
      let end = index + 1;
      let value = "";
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") {
          value += text[end + 1] ?? "";
          end += 2;
        } else value += text[end++];
      }
      index = end + 1;
      // A string followed by ':' is a key.
      let after = index;
      while (after < text.length && /\s/u.test(text[after]!)) after += 1;
      if (text[after] === ":") key = value;
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index))?.[0] ?? char;
      index += number.length;
      if (key !== null && !NOT_AMOUNTS.has(key)) {
        const problem = priceTextProblem(number);
        if (problem !== null) return `${key} ${number}: ${problem}`;
      }
      continue;
    }
    index += 1;
  }
  return null;
}
