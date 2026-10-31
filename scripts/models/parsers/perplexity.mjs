// https://docs.perplexity.ai/docs/agent-api/models.md
//
// The Agent API's rate card, one tab per model family. Each tab opens with a
// line like `> [tab] Perplexity` and its content is quoted, so it runs until
// the first unquoted line. Only the "Perplexity" tab is read: the others are
// third-party models Perplexity resells, some under the same `perplexity/`
// prefix, and this provider type names Perplexity as the author of every model
// it serves.
// Prices are plain decimals in $ per 1M tokens.
//
// Sonar Chat Completions support ended on September 27, 2026, and its prices
// left the pricing page with it. The Agent API names its models with a
// `perplexity/` prefix, so `perplexity/sonar` is not the old `sonar`.

import { ParseError, decimal, findLine, put, readTable } from "../price.mjs";

const HEADER = ["Model", "Input (\\$/1M)", "Output (\\$/1M)", "Cache read (\\$/1M)", "Service tiers", "Docs"];
const MODEL_ID = /^`(perplexity\/[A-Za-z0-9][A-Za-z0-9._-]*)`$/u;
// An em dash is an empty cell: no cache read price, or no tier but the
// default. `flex` and `priority` multiply the listed rates by 0.5 and 2 for
// whoever asks for them, which a single catalog price cannot express, so a
// model that gains one fails the page.
const NONE = "—";
// A tab also ends where the next one opens without a blank line between.
const TAB = /^>\s*\[tab\]/u;

export function parsePerplexity(text, { wanted }) {
  const lines = text.split("\n");
  const tab = findLine(lines, "> [tab] Perplexity", "Perplexity section");
  let end = lines.findIndex((line, index) => index > tab && (!line.trim().startsWith(">") || TAB.test(line.trim())));
  if (end === -1) end = lines.length;
  const section = lines.slice(tab + 1, end).map((line) => line.trim().replace(/^>\s?/u, ""));
  const table = section.findIndex((line) => line.trim().startsWith("|"));
  if (table === -1) throw new ParseError("Perplexity section: the table is missing");

  const prices = new Map();
  for (const row of readTable(section, table, HEADER, "Perplexity section")) {
    const id = MODEL_ID.exec(row[0])?.[1];
    if (!id) throw new ParseError(`Perplexity section: unexpected model "${row[0]}"`);
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const where = `Perplexity section, ${id}`;
    if (row[4] !== NONE) throw new ParseError(`${where}: service tiers "${row[4]}"`);
    const price = { input: decimal(row[1], where) };
    if (row[3] !== NONE) price.cached_input = decimal(row[3], where);
    price.output = decimal(row[2], where);
    put(prices, id, price);
  }
  return prices;
}
