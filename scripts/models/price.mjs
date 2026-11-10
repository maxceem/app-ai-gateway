// The one price shape every source is read into, and the helpers the parsers
// share. A `Price` uses the field names of `src/usage/models.json`, in $ per 1M
// tokens (or per minute / per hour of audio), plus two things the catalog never
// stores:
//
//   upcoming  [{ date, field, value }] — a dated change a page announces; the
//             same field's own value is the rate billed until then
//   unpriced  a reason the page lists the model without a public price
//
// Nothing here fetches anything; a parser gets the page as a string.
//
// The rate names and their fallbacks are the gateway's own, from
// src/shared/token-rates.ts, so the sync can never compare prices by rules the
// billing does not use.

import { TOKEN_RATE_FIELDS, VARIANTS, bucketRates, variantRate } from "../../src/shared/token-rates.ts";

/** Every per-token price field the catalog may carry, in the order they are reported. */
export const PRICE_FIELDS = TOKEN_RATE_FIELDS;

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

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_DAY_YEAR = /^([A-Z][a-z]+)\.? (\d{1,2}), (\d{4})$/u;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/u;
const US_SHORT = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/u;

function month(name, where) {
  // "Oct", "Sept" and "October" all name the same month.
  const index = MONTHS.findIndex((full) => full === name || (name.length >= 3 && full.startsWith(name)));
  if (index === -1) throw new ParseError(`${where}: "${name}" is not a month`);
  return index;
}

/**
 * A calendar date as `YYYY-MM-DD`. Accepts "October 23, 2026", "Oct 1, 2026",
 * "2026-09-24" and "09/14/26" (month first), and refuses a date that does
 * not exist, such as February 30.
 */
export function parseDate(raw, where) {
  // Some pages write ISO dates with non-breaking hyphens (U+2011).
  const text = raw.replace(/[\u2010\u2011]/gu, "-");
  let year;
  let monthIndex;
  let day;
  let match;
  if ((match = MONTH_DAY_YEAR.exec(text))) {
    [year, monthIndex, day] = [Number(match[3]), month(match[1], where), Number(match[2])];
  } else if ((match = ISO.exec(text))) {
    [year, monthIndex, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  } else if ((match = US_SHORT.exec(text))) {
    [year, monthIndex, day] = [2000 + Number(match[3]), Number(match[1]) - 1, Number(match[2])];
  } else {
    throw new ParseError(`${where}: "${text}" is not a date`);
  }
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) {
    throw new ParseError(`${where}: "${text}" is not a date`);
  }
  return date.toISOString().slice(0, 10);
}

/**
 * What `computeCost` in `src/usage/pricing.ts` would actually charge for each
 * token kind, so two sources are compared on what they bill rather than on
 * which fields they happen to spell out. The bucket and variant fallbacks are
 * the ones it bills with.
 */
export function effectivePrice(price) {
  const effective = {};
  const add = (prefix, rates, longContext) => {
    for (const [bucket, rate] of Object.entries(rates)) effective[prefix + bucket] = round6(rate);
    for (const variant of VARIANTS) {
      effective[prefix + variant.field] = round6(variantRate(price, variant, longContext, rates[variant.bucket]));
    }
  };
  add("", bucketRates(price, false), false);
  // A modality priced apart bills at its own rate, any other at text's.
  effective.image_input = round6(price.image_input ?? price.input);
  effective.audio_input = round6(price.audio_input ?? price.input);
  effective.video_input = round6(price.video_input ?? price.input);
  effective.image_output = round6(price.image_output ?? price.output);
  if (price.long_context_threshold !== undefined) add("long_", bucketRates(price, true), true);
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

/**
 * Every pipe table on the page, as `{ line, header, rows }`, for pages that
 * hold many tables of the same shape (deprecation histories). A caller reads
 * the ones whose header it recognises and checks their width itself.
 */
export function findTables(lines, where) {
  const tables = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("|") || (index > 0 && lines[index - 1].trim().startsWith("|"))) continue;
    const separator = lines[index + 1].trim();
    if (!/^\|(\s*:?-+:?\s*\|)+$/u.test(separator)) continue;
    const header = splitRow(line, where);
    const rows = [];
    let row = index + 2;
    for (; row < lines.length && lines[row].trim().startsWith("|"); row += 1) {
      rows.push(splitRow(lines[row], where));
    }
    tables.push({ line: index, header, rows });
    index = row - 1;
  }
  return tables;
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

const MARKDOC_TABLE = "{% table %}";
const MARKDOC_TABLE_END = "{% /table %}";
const MARKDOC_ROW_BREAK = "---";
const MARKDOC_CELL = /^\*(?: |$)/u;

/**
 * A Markdoc cell's text as a pipe table would have carried it: an empty
 * `{% sup /%}` dropped, a footnote mark `{% sup %}*{% /sup %}` kept as `^*^`.
 * Any other tag stays, so a reader that does not expect it fails.
 */
function markdocCell(parts) {
  return parts
    .join(" ")
    .replaceAll("{% sup /%}", "")
    .replace(/\{% sup %\}([^{}]*)\{% \/sup %\}/gu, "^$1^")
    .trim();
}

/**
 * Reads the Markdoc table whose `{% table %}` tag is the line at `start`, as
 * `{ header, rows, end }`, `end` being the line of its `{% /table %}`. Rows are
 * separated by `---`; each cell is a `* ` item at the table's indentation, and
 * the lines under it are joined to it with a space. The first row is the
 * header, and every row must have its width.
 */
export function readMarkdocTable(lines, start, where) {
  if (lines[start]?.trim() !== MARKDOC_TABLE) throw new ParseError(`${where}: the table is missing`);
  const rows = [];
  let row = [];
  let cell;
  let indent;
  const endRow = () => {
    if (cell) row.push(markdocCell(cell));
    if (row.length === 0) throw new ParseError(`${where}: the table has an empty row`);
    rows.push(row);
    row = [];
    cell = undefined;
  };
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === MARKDOC_TABLE_END) {
      endRow();
      const [header, ...body] = rows;
      if (body.length === 0) throw new ParseError(`${where}: the table has no rows`);
      for (const found of body) {
        if (found.length !== header.length) {
          throw new ParseError(`${where}: a row has ${found.length} cells, the header has ${header.length}`);
        }
      }
      return { header, rows: body, end: index };
    }
    if (trimmed === MARKDOC_TABLE) throw new ParseError(`${where}: a table inside a table`);
    if (trimmed === "") continue;
    if (trimmed === MARKDOC_ROW_BREAK) {
      endRow();
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (MARKDOC_CELL.test(trimmed) && (indent === undefined || lineIndent === indent)) {
      indent ??= lineIndent;
      if (cell) row.push(markdocCell(cell));
      cell = [trimmed.slice(1).trim()];
      continue;
    }
    if (!cell) throw new ParseError(`${where}: "${trimmed.slice(0, 80)}" is outside any table cell`);
    cell.push(trimmed);
  }
  throw new ParseError(`${where}: the table is not closed`);
}

/** Every Markdoc table on the page, as `{ line, header, rows }`, like `findTables`. */
export function findMarkdocTables(lines, where) {
  const tables = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== MARKDOC_TABLE) continue;
    const { header, rows, end } = readMarkdocTable(lines, index, where);
    tables.push({ line: index, header, rows });
    index = end;
  }
  return tables;
}
