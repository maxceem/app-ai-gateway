// https://docs.x.ai/developers/pricing.md
//
// "### Text API Pricing": a long-context model has two consecutive rows,
// `(< 200k prompt tokens)` and `(≥ 200k prompt tokens)`, which give the base
// price, the long-context price and the threshold. "### Voice Pricing" prices
// speech to text per hour; sources.mjs maps grok-transcribe to that row.

import { ParseError, decimal, findLine, put, readTable } from "../price.mjs";

const TEXT_HEADER = [
  "Model",
  "Context",
  "Input / 1M tokens",
  "Cached input / 1M tokens",
  "Output / 1M tokens",
];
const VOICE_HEADER = ["Mode", "Cost"];

const MODEL_CELL = /^([a-z0-9][a-z0-9.-]*)(?: \((<|≥) (\d+)k prompt tokens\))?$/u;
const SPEECH_TO_TEXT = /^\$(\S+) \/ hr \(REST\), \$(\S+) \/ hr \(Streaming\)$/u;

function money(text, where) {
  if (!text.startsWith("$")) throw new ParseError(`${where}: "${text}" is not a price`);
  return decimal(text.slice(1), where);
}

function tokenPrices(row, where) {
  const price = { input: money(row[2], where) };
  if (row[3] !== "-") price.cached_input = money(row[3], where);
  price.output = money(row[4], where);
  return price;
}

export function parseXai(text, { wanted }) {
  const lines = text.split("\n");
  const prices = new Map();

  const textTable = findLine(lines, "### Text API Pricing", "text pricing");
  const rows = readTable(lines, textTable + 1, TEXT_HEADER, "text pricing");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const model = MODEL_CELL.exec(row[0]);
    if (!model) throw new ParseError(`text pricing: unexpected model cell "${row[0]}"`);
    const id = model[1];
    let long;
    if (model[2] === "≥") throw new ParseError(`${id}: a long-context row without its base row`);
    if (model[2] === "<") {
      long = rows[index + 1];
      const next = long ? MODEL_CELL.exec(long[0]) : null;
      if (!next || next[1] !== id || next[2] !== "≥" || next[3] !== model[3]) {
        throw new ParseError(`${id}: a base row without its long-context row`);
      }
      index += 1;
    }
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const where = `text pricing, ${id}`;
    const price = tokenPrices(row, where);
    if (long) {
      const longPrice = tokenPrices(long, where);
      price.long_context_threshold = Number(model[3]) * 1000;
      price.long_input = longPrice.input;
      if (longPrice.cached_input !== undefined) price.long_cached_input = longPrice.cached_input;
      price.long_output = longPrice.output;
    }
    put(prices, id, price);
  }

  // Voice rows are modes, not models, so they are never listed as new models.
  if (wanted.has("Speech to Text")) {
    const voice = findLine(lines, "### Voice Pricing", "voice pricing");
    const row = readTable(lines, voice + 1, VOICE_HEADER, "voice pricing").find(
      (candidate) => candidate[0] === "Speech to Text",
    );
    if (row) {
      const match = SPEECH_TO_TEXT.exec(row[1]);
      if (!match) throw new ParseError(`voice pricing: unknown speech to text price "${row[1]}"`);
      put(prices, "Speech to Text", { per_hour: decimal(match[1], "voice pricing") });
    }
  }
  return prices;
}
