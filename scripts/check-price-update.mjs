#!/usr/bin/env node
// Refuses a price update that could break what already works.
//
//   node scripts/check-price-update.mjs <before.json> <after.json>
//
// The price list only ever gains prices and moves them; it never takes away
// what an app already relies on. For every model the list prices before the
// update, this fails when the update:
//
//   - removes the model, or one of its service modes: a model or mode the
//     provider stops listing keeps its last price and is marked
//     `unlisted_since` instead, so an app that uses it keeps working;
//   - changes the model's `kind`, which would turn away the custom endpoints
//     that serve it;
//   - changes or removes its `release_date`, which is set once, when the
//     model is added (a person corrects one by hand, past this check);
//   - changes how it is billed (per token, per minute, per hour, per image);
//   - drops one of its rates, which would bill those tokens at another rate;
//   - moves a rate, in the standard mode or any service mode, by more than
//     MAX_FACTOR, or to or from $0. A tier in a region that no entry names is
//     checked too, at the tier's rates times the region's factor, as it is
//     billed.
//
// The prices bot applies the same rules itself and holds anything else for a
// person; this is the independent check on its output. A legitimate change
// they would refuse — a provider billing a model as another one from a given
// day — is merged deliberately, past this check.
//
// Plain JavaScript with no imports from the repository, so it runs on any
// Node without a build, reading the update's price list only as data.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** How far an update may move a rate before it needs a person. */
export const MAX_FACTOR = 3;

const UNITS = ["per_minute", "per_hour", "per_image"];
const TIERS = new Set(["flex", "priority", "fast", "ultrafast"]);
const NOT_RATES = new Set(["long_context_threshold", "factor"]);

const own = (object, key) => object !== null && typeof object === "object" && Object.hasOwn(object, key);

/** How an entry is billed: by one of the time or image units, else per token. */
function unit(entry) {
  return UNITS.find((field) => entry[field] !== undefined) ?? "token";
}

/** The entry's own rates, by field. */
function rates(entry) {
  return Object.fromEntries(
    Object.entries(entry).filter(([field, value]) => typeof value === "number" && !NOT_RATES.has(field)),
  );
}

/**
 * What one mode bills for each rate: the mode's own rate where it states one,
 * else the entry's rate times the mode's factor. Only the mode's own entry,
 * as the gateway reads a mode on its own.
 */
function modeRates(entry, name) {
  const mode = entry.modes[name];
  const factor = typeof mode.factor === "number" ? mode.factor : 1;
  const result = {};
  for (const [field, value] of Object.entries(rates(entry))) result[field] = value * factor;
  for (const [field, value] of Object.entries(rates(mode))) result[field] = value;
  return result;
}

/**
 * What a mode bills for each rate, the way the gateway prices it: the mode's
 * own entry where there is one, else a tier in a region at the tier's rates
 * times the region's factor. `undefined` where the entry prices neither.
 */
function billedRates(entry, name) {
  if (own(entry.modes, name)) return modeRates(entry, name);
  const [tier, region] = name.split("+");
  if (region === undefined || !own(entry.modes, tier) || !own(entry.modes, region)) return undefined;
  const factor = typeof entry.modes[region].factor === "number" ? entry.modes[region].factor : 1;
  return Object.fromEntries(Object.entries(modeRates(entry, tier)).map(([field, value]) => [field, value * factor]));
}

/** Why moving a rate from `from` to `to` needs a person, if it does. */
function moved(from, to) {
  if (from === to) return null;
  // A derived rate carries float noise, such as 19.799999999999997.
  const dollars = (value) => `$${Number(value.toPrecision(12))}`;
  if (from === 0 || to === 0) return `${dollars(from)} → ${dollars(to)}`;
  const ratio = to / from;
  return ratio > MAX_FACTOR || ratio < 1 / MAX_FACTOR ? `${dollars(from)} → ${dollars(to)}, more than ${MAX_FACTOR}x` : null;
}

/** Every reason the update `after` could break what `before` priced; empty when there is none. */
export function priceUpdateProblems(before, after) {
  const problems = [];
  for (const [provider, models] of Object.entries(before)) {
    for (const [model, entry] of Object.entries(models)) {
      const where = `${provider}/${model}`;
      if (!own(after, provider) || !own(after[provider], model)) {
        problems.push(`${where}: the model is gone`);
        continue;
      }
      const next = after[provider][model];
      if (entry.kind !== next.kind) problems.push(`${where}: kind ${entry.kind} → ${next.kind}`);
      if (entry.release_date !== undefined && entry.release_date !== next.release_date) {
        problems.push(`${where}: release_date ${entry.release_date} → ${next.release_date ?? "gone"}`);
      }
      if (unit(entry) !== unit(next)) {
        problems.push(`${where}: billed ${unit(entry)} → ${unit(next)}`);
        continue;
      }
      const ours = rates(entry);
      const theirs = rates(next);
      for (const [field, value] of Object.entries(ours)) {
        if (theirs[field] === undefined) {
          problems.push(`${where}: ${field} is gone`);
          continue;
        }
        const problem = moved(value, theirs[field]);
        if (problem) problems.push(`${where}: ${field} ${problem}`);
      }
      const listed = Object.keys(entry.modes ?? {});
      const tiers = listed.filter((name) => TIERS.has(name));
      const regions = listed.filter((name) => !TIERS.has(name) && !name.includes("+"));
      const pairs = tiers.flatMap((tier) => regions.map((region) => `${tier}+${region}`))
        .filter((name) => !listed.includes(name));
      for (const name of [...listed, ...pairs]) {
        if (listed.includes(name) && !own(next.modes, name)) {
          problems.push(`${where}: service mode ${name} is gone`);
          continue;
        }
        const was = billedRates(entry, name);
        const is = billedRates(next, name);
        if (!was || !is) continue;
        for (const [field, value] of Object.entries(was)) {
          if (is[field] === undefined) {
            // A rate the standard price dropped is reported above already.
            if (ours[field] === undefined) problems.push(`${where}: ${name} ${field} is gone`);
            continue;
          }
          const problem = moved(value, is[field]);
          if (problem) problems.push(`${where}: ${name} ${field} ${problem}`);
        }
      }
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error("usage: check-price-update.mjs <before.json> <after.json>");
    process.exit(2);
  }
  const problems = priceUpdateProblems(
    JSON.parse(readFileSync(beforePath, "utf8")),
    JSON.parse(readFileSync(afterPath, "utf8")),
  );
  if (problems.length > 0) {
    console.error("This price update could break what already works, so it needs a person:");
    for (const line of problems) console.error(`  - ${line}`);
    console.error(
      "A model or mode the provider stopped listing keeps its last price, marked unlisted_since. "
        + "A change a person has confirmed, such as a provider billing a model as another one, is merged past this check.",
    );
    process.exit(1);
  }
  console.log("Nothing that worked before this price update breaks.");
}
