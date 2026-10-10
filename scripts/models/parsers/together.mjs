// https://docs.together.ai/docs/serverless-models.md
//
// The table under "## Chat models", keyed by its "API model string" column.
// Prices are written escaped, as `\$1.00`.
//
// The table under "## Image models" is read for discovery only. Every row is
// billed per `image` (the upstream provider's own charge, which the page
// itself calls an estimate) or per `megapixel` (scaled by steps above the
// default), and the catalog has no such unit, so a model asked for by name
// fails with the unit it is billed in rather than being given a token price.

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

const IMAGE_HEADER = ["Organization", "Model name", "Model string for API", "Unit", "Price", "Output per \\$1"];
const IMAGE_UNITS = { "`image`": "per image", "`megapixel`": "per megapixel" };

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
    if (!/^[A-Za-z0-9][A-Za-z0-9 .&'-]{0,99}$/u.test(row[0])) throw new ParseError(`${where}: unsupported organization name`);
    const price = { input: money(row[4], where) };
    if (row[5] !== "-") price.cached_input = money(row[5], where);
    price.output = money(row[6], where);
    price.author = row[0];
    put(prices, id, price);
  }

  // A paragraph and a note sit between the heading and its table.
  const images = findLine(lines, "## Image models", "image models");
  const table = lines.findIndex((line, index) => index > images && /^(?:\||## )/u.test(line.trim()));
  if (table === -1 || !lines[table].trim().startsWith("|")) throw new ParseError("image models: the table is missing");
  for (const row of readTable(lines, table, IMAGE_HEADER, "image models")) {
    const id = row[2];
    if (!MODEL_ID.test(id)) throw new ParseError(`image models: unexpected model string "${id}"`);
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const unit = IMAGE_UNITS[row[3]];
    if (!unit) throw new ParseError(`image models, ${id}: unknown billing unit ${row[3]}`);
    throw new ParseError(`image models, ${id}: billed ${unit}, which the catalog cannot price`);
  }
  return prices;
}
