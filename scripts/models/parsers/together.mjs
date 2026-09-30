// https://docs.together.ai/docs/serverless-models.md
//
// The table under "## Chat models", keyed by its "API model string" column.
// Prices are written escaped, as `\$1.00`.

import { ParseError, decimal, findLine, put, readTable } from "../price.mjs";

const HEADER = [
  "Organization",
  "Model name",
  "API model string",
  "Context length",
  "Input pricing (per 1M tokens)",
  "Cached input pricing (per 1M tokens)",
  "Output pricing (per 1M tokens)",
  "Quantization",
  "Function calling",
  "Structured outputs",
];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function money(text, where) {
  if (!text.startsWith("\\$")) throw new ParseError(`${where}: "${text}" is not a price`);
  return decimal(text.slice(2), where);
}

export function parseTogether(text, { wanted }) {
  const lines = text.split("\n");
  const prices = new Map();
  const heading = findLine(lines, "## Chat models", "chat models");
  for (const row of readTable(lines, heading + 1, HEADER, "chat models")) {
    const id = row[2];
    if (!MODEL_ID.test(id)) throw new ParseError(`chat models: unexpected model string "${id}"`);
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const where = `chat models, ${id}`;
    const price = { input: money(row[4], where) };
    if (row[5] !== "-") price.cached_input = money(row[5], where);
    price.output = money(row[6], where);
    put(prices, id, price);
  }
  return prices;
}
