// https://docs.perplexity.ai/docs/agent-api/models.md
//
// The Agent API's rate card, one tab per model family. Only the "Perplexity"
// tab is read: the other tabs are third-party models Perplexity resells, and
// this provider type names Perplexity as the author of every model it serves.
// Prices are plain decimals in $ per 1M tokens.
//
// Sonar Chat Completions support ended on September 27, 2026, and its prices
// left the pricing page with it. The Agent API names its models with a
// `perplexity/` prefix, so `perplexity/sonar` is not the old `sonar`.

import { ParseError, decimal, findLine, findNextLine, put, readTable } from "../price.mjs";

const HEADER = ["Model", "Input (\\$/1M)", "Output (\\$/1M)", "Cache read (\\$/1M)", "Service tiers", "Docs"];
const MODEL_ID = /^`(perplexity\/[A-Za-z0-9][A-Za-z0-9._-]*)`$/u;
// An em dash is an empty cell: no cache read price, or no tier but the
// default. `flex` and `priority` multiply the listed rates by 0.5 and 2 for
// whoever asks for them, which a single catalog price cannot express, so a
// model that gains one fails the page.
const NONE = "—";

export function parsePerplexity(text, { wanted }) {
  const lines = text.split("\n");
  const tab = findLine(lines, '<Tab title="Perplexity">', "Perplexity tab");
  const end = findNextLine(lines, "</Tab>", "Perplexity tab", tab);
  const table = lines.findIndex((line, index) => index > tab && index < end && line.trim().startsWith("|"));
  if (table === -1) throw new ParseError("Perplexity tab: the table is missing");

  const prices = new Map();
  for (const row of readTable(lines, table, HEADER, "Perplexity tab")) {
    const id = MODEL_ID.exec(row[0])?.[1];
    if (!id) throw new ParseError(`Perplexity tab: unexpected model "${row[0]}"`);
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const where = `Perplexity tab, ${id}`;
    if (row[4] !== NONE) throw new ParseError(`${where}: service tiers "${row[4]}"`);
    const price = { input: decimal(row[1], where) };
    if (row[3] !== NONE) price.cached_input = decimal(row[3], where);
    price.output = decimal(row[2], where);
    put(prices, id, price);
  }
  return prices;
}
