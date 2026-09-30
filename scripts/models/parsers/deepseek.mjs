// https://api-docs.deepseek.com/quick_start/pricing
//
// Server-rendered HTML with one transposed table: a column per model and, in
// its PRICING block, an OFF-PEAK and a PEAK row per token kind. The catalog
// bills the PEAK price, the higher of the two, so a request is never
// under-counted whenever it ran.

import { ParseError, decimal, put } from "../price.mjs";

const KINDS = {
  "1M INPUT TOKENS (CACHE HIT)": "cached_input",
  "1M INPUT TOKENS (CACHE MISS)": "input",
  "1M OUTPUT TOKENS": "output",
};
const PRICE = /^\$(\S+)$/u;

function cellText(html) {
  return html
    .replace(/<sup>[\s\S]*?<\/sup>/gu, "")
    .replace(/<br\s*\/?>/gu, " ")
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function rowsOf(table) {
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/gu)].map((row) =>
    [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gu)].map((cell) => cellText(cell[1])),
  );
}

export function parseDeepseek(text, { wanted }) {
  const tables = [...text.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gu)]
    .map((match) => rowsOf(match[1]))
    .filter((rows) => rows[0]?.[0] === "MODEL");
  if (tables.length !== 1) throw new ParseError(`found ${tables.length} model tables, expected one`);
  const rows = tables[0];
  const models = rows[0].slice(1);
  if (models.length === 0 || !models.every((id) => /^[a-z0-9][a-z0-9.-]*$/u.test(id))) {
    throw new ParseError(`unexpected model header "${rows[0].join(" | ")}"`);
  }

  const start = rows.findIndex((row) => row[0] === "PRICING");
  if (start === -1) throw new ParseError('the "PRICING" block is missing');
  // PRICING's first row also carries the block label; the rest do not.
  const block = [rows[start].slice(1), ...rows.slice(start + 1, start + 6)];
  const peak = {};
  for (let index = 0; index < 6; index += 2) {
    const offPeak = block[index];
    const peakRow = block[index + 1];
    const field = KINDS[offPeak?.[0]];
    if (field === undefined) throw new ParseError(`unexpected pricing row "${offPeak?.join(" | ")}"`);
    if (peak[field] !== undefined) throw new ParseError(`two "${offPeak[0]}" rows`);
    if (offPeak[1] !== "OFF-PEAK" || peakRow?.[0] !== "PEAK") {
      throw new ParseError(`"${offPeak[0]}" is not an OFF-PEAK row followed by a PEAK row`);
    }
    const values = peakRow.slice(1);
    if (values.length !== models.length || offPeak.length - 2 !== models.length) {
      throw new ParseError(`"${offPeak[0]}" does not have one price per model`);
    }
    peak[field] = values;
  }
  if (Object.keys(peak).length !== 3) throw new ParseError("the PRICING block is incomplete");

  const prices = new Map();
  for (const [column, id] of models.entries()) {
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const price = {};
    for (const field of ["input", "cached_input", "output"]) {
      const match = PRICE.exec(peak[field][column]);
      if (!match) throw new ParseError(`${id}: "${peak[field][column]}" is not a price`);
      price[field] = decimal(match[1], id);
    }
    put(prices, id, price);
  }
  return prices;
}
