// https://api.cerebras.ai/public/v1/models — official JSON, no key needed.
//
// `pricing.prompt` and `pricing.completion` are decimal strings in $ per token.

import { ParseError, round6, put } from "../price.mjs";

const PER_TOKEN = /^\d+(?:\.\d+)?$/u;

function perMillion(value, where) {
  if (typeof value !== "string" || !PER_TOKEN.test(value)) {
    throw new ParseError(`${where}: "${value}" is not a decimal $ per token`);
  }
  return round6(Number(value) * 1e6);
}

export function parseCerebras(text, { wanted }) {
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new ParseError(`not JSON: ${error.message}`);
  }
  if (body?.object !== "list" || !Array.isArray(body.data)) {
    throw new ParseError('expected { object: "list", data: [...] }');
  }
  const prices = new Map();
  for (const model of body.data) {
    if (typeof model?.id !== "string") throw new ParseError("a model has no id");
    if (!wanted.has(model.id)) {
      put(prices, model.id, null);
      continue;
    }
    const pricing = model.pricing;
    if (typeof pricing !== "object" || pricing === null) throw new ParseError(`${model.id}: no pricing`);
    put(prices, model.id, {
      input: perMillion(pricing.prompt, model.id),
      output: perMillion(pricing.completion, model.id),
    });
  }
  return prices;
}
