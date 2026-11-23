import { PRICE_WALK_DEPTH, RESERVED_PRICE_KEY } from "@contracts/admin";
import { readPrice, readsAsWritten } from "@contracts/price-amount";

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

/** Whether a value nests deeper than any price can, found with an explicit stack, never recursing. */
function nestsTooDeep(value: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!;
    if (typeof current !== "object" || current === null) continue;
    if (depth >= PRICE_WALK_DEPTH) return true;
    for (const inner of Object.values(current)) stack.push({ value: inner, depth: depth + 1 });
  }
  return false;
}

/**
 * Whether the form can show these prices without losing anything: each entry
 * is a price object, and every rate the form shows is a number. Anything else
 * is edited as JSON only.
 */
export function formCanShow(pricing: unknown): pricing is StoredPricing | null {
  if (pricing === null) return true;
  if (!isPlainObject(pricing) || nestsTooDeep(pricing)) return false;
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

/**
 * A row's amount as typed: null for none, its value, or what is wrong with
 * it. Text left exactly as stored is never judged again, so a price saved by
 * the CLI or the API that these rules would refuse never locks the form.
 */
function amountOf(text: string, stored: unknown, example = "2.5"): { value: number | null } | { problem: string } {
  if (typeof stored === "number" && text === textOf(stored)) return { value: stored };
  if (text.trim() === "") return { value: null };
  return readPrice(text, example);
}

/** The number an amount saves, or null for none or a problem. */
const valueOf = (amount: ReturnType<typeof amountOf>): number | null => ("value" in amount ? amount.value : null);

/** The one model name the prices cannot hold: the gateway's own rule. */
const RESERVED_MODEL = RESERVED_PRICE_KEY;

/** The row's unit rate as typed, or null when it shows none (or keeps several as stored). */
function unitAmountOf(row: PriceRow): ReturnType<typeof amountOf> | null {
  if (row.unitField === "" || severalUnits(row)) return null;
  const stored = row.original !== null && shownUnit(row.original) === row.unitField ? row.original[row.unitField] : undefined;
  return amountOf(row.unitAmount, stored, "0.04");
}

/** What is wrong with a row, field by field, in words. */
export function rowProblems(row: PriceRow, rows: readonly PriceRow[]): Record<string, string> {
  const problems: Record<string, string> = {};
  const model = row.model.trim();
  if (model === "") problems.model = "Name the model.";
  else if (model === RESERVED_MODEL) problems.model = "This is not a model name.";
  else if (rows.some((other) => other !== row && other.model.trim() === model)) problems.model = "This model is listed twice.";
  const tokens = Object.fromEntries(TOKEN_FIELDS.map(({ field }) => [field, amountOf(row.tokens[field], row.original?.[field])])) as Record<
    (typeof TOKEN_FIELDS)[number]["field"],
    ReturnType<typeof amountOf>
  >;
  for (const { field } of TOKEN_FIELDS) {
    const amount = tokens[field];
    if ("problem" in amount) problems[field] = amount.problem;
  }
  const unit = unitAmountOf(row);
  if (unit !== null && "problem" in unit) problems.unit = unit.problem;
  const input = valueOf(tokens.input);
  const output = valueOf(tokens.output);
  if (!problems.input && !problems.output && (input === null) !== (output === null)) {
    problems[input === null ? "input" : "output"] = "Input and output are priced together.";
  }
  const priced = TOKEN_FIELDS.some(({ field }) => valueOf(tokens[field]) !== null) || (unit !== null && valueOf(unit) !== null);
  if (!priced && hiddenFields(row).length === 0 && !problems.unit) problems.row = "Give this model at least one rate.";
  return problems;
}

/** One row's price: the stored price, with only the fields its inputs show changed. */
function priceOf(row: PriceRow): StoredPrice {
  const price: StoredPrice = row.original === null ? {} : structuredClone(row.original);
  for (const { field } of TOKEN_FIELDS) {
    const value = valueOf(amountOf(row.tokens[field], row.original?.[field]));
    if (value === null) delete price[field];
    else price[field] = value;
  }
  // Several stored unit rates stay exactly as stored.
  const storedUnit = row.original === null ? "" : shownUnit(row.original);
  if (storedUnit !== "" && storedUnit !== row.unitField) delete price[storedUnit];
  const unit = unitAmountOf(row);
  if (unit !== null) {
    const value = valueOf(unit);
    if (value === null) delete price[row.unitField];
    else price[row.unitField] = value;
  }
  return price;
}

/**
 * The pricing the rows save as. Built with `Object.fromEntries`, which makes
 * each model an own property: no name can reach the object's prototype.
 */
export function pricingOf(rows: readonly PriceRow[]): StoredPricing | null {
  return rows.length === 0 ? null : (Object.fromEntries(rows.map((row) => [row.model.trim(), priceOf(row)])) as StoredPricing);
}

/** One number in prices typed as JSON: where it stands (keys, outermost first) and its text as written. */
interface WrittenNumber {
  path: string[];
  text: string;
}

/**
 * Reads prices typed as JSON once, as written, skipping strings: each number
 * with the keys it stands under, and the first key written twice in one
 * object, which parsing would quietly reduce to its last value.
 */
function scanJson(text: string): { numbers: WrittenNumber[]; repeated: string | null } {
  const numbers: WrittenNumber[] = [];
  // Per open object: the keys seen in it, and the key whose value is being read.
  const objects: { seen: Set<string>; key: string | null }[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "{") {
      objects.push({ seen: new Set(), key: null });
      index += 1;
    } else if (char === "}") {
      objects.pop();
      index += 1;
    } else if (char === '"') {
      // A string: find where it ends, then read it as JSON reads it, escapes included.
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      let value: string;
      try {
        value = JSON.parse(text.slice(index, end + 1)) as string;
      } catch {
        return { numbers, repeated: null };
      }
      index = end + 1;
      let after = index;
      while (after < text.length && /\s/u.test(text[after]!)) after += 1;
      const object = objects[objects.length - 1];
      // A string followed by ':' is a key of the innermost object.
      if (text[after] === ":" && object !== undefined) {
        if (object.seen.has(value)) return { numbers, repeated: value };
        object.seen.add(value);
        object.key = value;
      }
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index))?.[0] ?? char;
      index += number.length;
      numbers.push({ path: objects.map((object) => object.key ?? ""), text: number });
    } else index += 1;
  }
  return { numbers, repeated: null };
}

/** Fields of a price whose numbers are not dollar amounts: a mode's multiplier and a token count. */
const NOT_AMOUNTS: ReadonlySet<string> = new Set(["factor", "long_context_threshold"]);

/**
 * What is wrong with prices typed as JSON that parsing alone would hide,
 * judged on the text as written:
 *
 * - a key written twice in one object (a model, or a field of one price);
 * - an amount a float reads as another figure: `1e-400` is refused, as the
 *   form refuses it, though `JSON.parse` reads it as 0;
 * - a mode factor or long-context threshold whose value would change once
 *   read; they are not dollar amounts, so the dollar rule does not apply.
 *
 * A number written exactly as it is stored (`stored`, the saved prices as
 * JSON) is never judged again, so prices saved elsewhere never lock editing.
 * Returns null when there is nothing to say.
 */
export function jsonPriceProblem(text: string, stored = ""): string | null {
  const scanned = scanJson(text);
  if (scanned.repeated !== null) return `${JSON.stringify(scanned.repeated)} is written twice in one object; only the last would be kept.`;
  const kept = new Set(scanJson(stored).numbers.map((number) => JSON.stringify([number.path, number.text])));
  for (const number of scanned.numbers) {
    if (kept.has(JSON.stringify([number.path, number.text]))) continue;
    const key = number.path[number.path.length - 1] ?? "";
    if (key === "factor" && !readsAsWritten(number.text)) {
      return `factor ${number.text}: this factor would be read as ${String(Number(number.text))}. Write it with fewer digits.`;
    }
    if (key === "long_context_threshold") {
      if (!readsAsWritten(number.text)) return `long_context_threshold ${number.text}: this would be read as ${String(Number(number.text))}. Write a whole number of tokens.`;
      if (!Number.isInteger(Number(number.text))) return `long_context_threshold ${number.text}: write a whole number of tokens.`;
    }
    if (!NOT_AMOUNTS.has(key)) {
      const read = readPrice(number.text);
      if ("problem" in read) return `${key} ${number.text}: ${read.problem}`;
    }
  }
  return null;
}
