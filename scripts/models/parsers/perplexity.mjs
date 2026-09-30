// https://docs.perplexity.ai/getting-started/pricing.md
//
// The page embeds its prices as a JSON literal, `export const PRICING = {…}`,
// for a calculator widget. Only the `"sonar"` object is read: it is cut out by
// brace matching and handed to `JSON.parse`, never evaluated. Per-request fees
// (`request`) are out of scope.

import { ParseError, put } from "../price.mjs";

const UNITS = '"sonar.input/output/citation/reasoning": "$ per 1,000,000 tokens"';
const KEY = '\n  "sonar": {';
// Every key a sonar model may carry. A new one (a cache price, a tiered
// input) could change what a token costs, so it fails the page.
const KNOWN = new Set(["id", "label", "input", "output", "request", "citation", "reasoning", "searchQueries"]);

/** The text of the object literal opening at `start`, respecting strings. */
function objectAt(text, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new ParseError('the "sonar" object never closes');
}

export function parsePerplexity(text, { wanted }) {
  if (!text.includes("export const PRICING = {")) throw new ParseError("the PRICING literal is missing");
  if (!text.includes(UNITS)) throw new ParseError("the sonar price unit changed");
  const at = text.indexOf(KEY);
  if (at === -1 || text.indexOf(KEY, at + 1) !== -1) {
    throw new ParseError('expected exactly one top-level "sonar" object');
  }

  let sonar;
  try {
    sonar = JSON.parse(objectAt(text, at + KEY.length - 1));
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError(`the "sonar" object is not JSON: ${error.message}`);
  }
  if (!Array.isArray(sonar?.models) || Object.keys(sonar).length !== 1) {
    throw new ParseError('"sonar" is not { models: [...] }');
  }

  const prices = new Map();
  for (const model of sonar.models) {
    if (typeof model?.id !== "string") throw new ParseError("a sonar model has no id");
    if (!wanted.has(model.id)) {
      put(prices, model.id, null);
      continue;
    }
    const unknown = Object.keys(model).filter((key) => !KNOWN.has(key));
    if (unknown.length > 0) throw new ParseError(`${model.id}: unknown keys ${unknown.join(", ")}`);
    if (!Number.isFinite(model.input) || !Number.isFinite(model.output)) {
      throw new ParseError(`${model.id}: input or output is not a number`);
    }
    put(prices, model.id, { input: model.input, output: model.output });
  }
  return prices;
}
