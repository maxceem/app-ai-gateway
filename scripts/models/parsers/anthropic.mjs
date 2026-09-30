// https://platform.claude.com/docs/en/about-claude/pricing.md
//
// The first table under "## Model pricing". Rows are display names, so
// "Claude Opus 4.5" is read as `claude-opus-4-5`. The 1h cache-write column is
// not read: the catalog prices the default 5-minute write.

import { ParseError, decimal, findLine, put, readTable } from "../price.mjs";

const HEADER = [
  "Model",
  "Base input tokens",
  "5m cache writes",
  "1h cache writes",
  "Cache hits and refreshes",
  "Output tokens",
];

// An optional trailing parenthetical link, like "([limited availability](…))".
const MODEL_CELL = /^(Claude [A-Z][a-z]+ \d+(?:\.\d+)?)(?: \(\[[^\]]+\]\([^)\s]+\)\))?$/u;
const PRICE_CELL = /^\$(\S+) \/ MTok$/u;
const FOOTNOTE = /<sup>\d+<\/sup>/gu;

export function modelId(displayName) {
  return displayName.toLowerCase().replaceAll(" ", "-").replaceAll(".", "-");
}

function price(text, where) {
  const match = PRICE_CELL.exec(text.replace(FOOTNOTE, ""));
  if (!match) throw new ParseError(`${where}: "${text}" is not a "$N / MTok" price`);
  return decimal(match[1], where);
}

export function parseAnthropic(text, { wanted }) {
  const lines = text.split("\n");
  const prices = new Map();
  const heading = findLine(lines, "## Model pricing", "model pricing");
  // A sentence introduces the table; skip it, but only it.
  let start = heading + 1;
  while (lines[start]?.trim() === "") start += 1;
  if (!lines[start]?.trim().startsWith("|")) start += 1;

  for (const row of readTable(lines, start, HEADER, "model pricing")) {
    const model = MODEL_CELL.exec(row[0].replace(FOOTNOTE, ""));
    if (!model) throw new ParseError(`model pricing: unexpected model cell "${row[0]}"`);
    const id = modelId(model[1]);
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const where = `model pricing, ${id}`;
    put(prices, id, {
      input: price(row[1], where),
      cached_input: price(row[4], where),
      cache_write: price(row[2], where),
      output: price(row[5], where),
    });
  }
  return prices;
}
