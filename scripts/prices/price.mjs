// The one price shape every source is read into, and the helpers the parsers
// share. A `Price` uses the field names of `src/usage/prices.json`, in $ per 1M
// tokens (or per minute / per hour of audio), plus two things the catalog never
// stores:
//
//   upcoming  [{ date, field, value }] — a dated change a page announces
//   unpriced  a reason the page lists the model without a public price
//
// Nothing here fetches anything; a parser gets the page as a string.

/** Every price field the catalog may carry, in the order they are reported. */
export const PRICE_FIELDS = [
  "input",
  "cached_input",
  "cache_write",
  "output",
  "long_input",
  "long_cached_input",
  "long_cache_write",
  "long_output",
];

export const AUDIO_FIELDS = ["per_minute", "per_hour"];

/** A page that is not exactly what its parser was written against. */
export class ParseError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ParseError";
  }
}

/** Rounds away float noise such as `0.39999999999999997`. */
export function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

const DECIMAL = /^\d+(?:\.\d+)?$/u;

/** A decimal written by a person, never `1e-7`, `.5` or `1,000`. */
export function decimal(text, where) {
  if (!DECIMAL.test(text)) throw new ParseError(`${where}: "${text}" is not a plain decimal`);
  return Number(text);
}

/**
 * What `computeCost` in `src/usage/pricing.ts` would actually charge for each
 * token kind, so two sources are compared on what they bill rather than on
 * which fields they happen to spell out. Keep the fallbacks in step with it.
 */
export function effectivePrice(price) {
  const effective = {
    input: round6(price.input),
    output: round6(price.output),
    cached_input: round6(price.cached_input ?? price.input),
    cache_write: round6(price.cache_write ?? price.input),
  };
  if (price.long_context_threshold !== undefined) {
    const longInput = price.long_input ?? price.input;
    effective.long_input = round6(longInput);
    effective.long_output = round6(price.long_output ?? price.output);
    effective.long_cached_input = round6(price.long_cached_input ?? price.cached_input ?? longInput);
    effective.long_cache_write = round6(price.long_cache_write ?? price.cache_write ?? longInput);
  }
  return effective;
}

/** Whether two token prices bill the same for every kind of token. */
export function samePrice(a, b) {
  if (a.long_context_threshold !== b.long_context_threshold) return false;
  const left = effectivePrice(a);
  const right = effectivePrice(b);
  return PRICE_FIELDS.every((field) => left[field] === right[field]);
}

/** Whether two parsed prices say exactly the same thing, field for field. */
function identical(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Records one model's price. The same model twice with different prices in
 * the table being read means the parser cannot know which one bills, so the
 * whole page fails; twice with the same price is harmless.
 */
export function put(prices, id, price) {
  if (prices.has(id)) {
    const existing = prices.get(id);
    if (existing === null) {
      prices.set(id, price);
      return;
    }
    if (price !== null && !identical(existing, price)) {
      throw new ParseError(`${id} appears twice with different prices`);
    }
    return;
  }
  prices.set(id, price);
}

// Markdown pipe tables ------------------------------------------------------

/** Splits `| a | b \| c |` on the pipes that are not escaped. */
function splitRow(line, where) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.length < 2) {
    throw new ParseError(`${where}: "${line.slice(0, 80)}" is not a table row`);
  }
  const cells = [];
  let current = "";
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "\\|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

const SEPARATOR_CELL = /^:?-+:?$/u;

/**
 * Reads the pipe table that starts at the first non-blank line at or after
 * `start`, and checks its header against `header` cell for cell. Every body
 * row must have the header's width.
 */
export function readTable(lines, start, header, where) {
  let index = start;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  if (index >= lines.length) throw new ParseError(`${where}: the table is missing`);
  const found = splitRow(lines[index], where);
  if (found.length !== header.length || found.some((cell, i) => cell !== header[i])) {
    throw new ParseError(
      `${where}: the table header changed, expected "${header.join(" | ")}", found "${found.join(" | ")}"`,
    );
  }
  const separator = splitRow(lines[index + 1] ?? "", where);
  if (separator.length !== header.length || !separator.every((cell) => SEPARATOR_CELL.test(cell))) {
    throw new ParseError(`${where}: the table has no separator row under its header`);
  }
  const rows = [];
  for (index += 2; index < lines.length && lines[index].trim().startsWith("|"); index += 1) {
    const row = splitRow(lines[index], where);
    if (row.length !== header.length) {
      throw new ParseError(`${where}: a row has ${row.length} cells, the header has ${header.length}`);
    }
    rows.push(row);
  }
  if (rows.length === 0) throw new ParseError(`${where}: the table has no rows`);
  return rows;
}

/** The index of the one line equal to `text`, failing when there is none or several. */
export function findLine(lines, text, where, from = 0) {
  let found = -1;
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index].trim() !== text) continue;
    if (found !== -1) throw new ParseError(`${where}: "${text}" appears more than once`);
    found = index;
  }
  if (found === -1) throw new ParseError(`${where}: "${text}" is missing`);
  return found;
}

/**
 * The index of the first line after `from` equal to `text`. For anchors that
 * repeat on a page, where the first one after a unique landmark is meant.
 */
export function findNextLine(lines, text, where, from) {
  for (let index = from + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === text) return index;
  }
  throw new ParseError(`${where}: "${text}" is missing`);
}
