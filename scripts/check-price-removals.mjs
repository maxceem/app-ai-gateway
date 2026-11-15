#!/usr/bin/env node
// Refuses a change to the price list that takes a price away.
//
//   node scripts/check-price-removals.mjs <before.json> <after.json>
//
// A model, or a service mode of a model, that the list prices is never removed
// from it: a model or mode a provider stops listing keeps its last price and is
// marked with `unlisted_since`, so an app that already uses it keeps working
// and keeps being billed exactly. Only a person removes a price, on purpose,
// and this check is what makes that a visible decision rather than something a
// price update can do by accident. Prices may change, and models and modes may
// be added; this looks only at what disappears.

import { readFileSync } from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: check-price-removals.mjs <before.json> <after.json>");
  process.exit(2);
}

const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));
const own = (object, key) => object !== null && typeof object === "object" && Object.hasOwn(object, key);

const removed = [];
for (const [provider, models] of Object.entries(before)) {
  for (const [model, entry] of Object.entries(models)) {
    if (!own(after, provider) || !own(after[provider], model)) {
      removed.push(`${provider}/${model}: the model is gone`);
      continue;
    }
    const next = after[provider][model];
    for (const mode of Object.keys(entry.modes ?? {})) {
      if (!own(next.modes, mode)) removed.push(`${provider}/${model}: service mode ${mode} is gone`);
    }
  }
}

if (removed.length > 0) {
  console.error("A price update must not remove a price. Mark a model or mode the provider stopped listing with unlisted_since instead:");
  for (const line of removed) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("No model or service mode lost its price.");
