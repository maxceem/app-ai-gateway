/**
 * One resolver: serving resolves a call (`resolveCall`), and saving runs the
 * same function over every call a route allows (`reachableCalls`), judging
 * each by one rule (`callGap`). These tests hold the rule to an independent
 * reading of the charge function, check our own price list against it, and
 * keep the work a save does bounded (Fable's design review of step 4b).
 */
import { describe, expect, it } from "vitest";
import { CHECK_PROBES, RESOLVED_CALLS, callGap, priceSources, reachableCalls, resolveCall } from "../src/pricing/billability.ts";
import { keyCandidates, PRICE_LIST, reportsCost, servedModes, type CustomerRates, type ModelPrice } from "../src/pricing/prices.ts";
import { priceInServedMode } from "../src/pricing/tokens.ts";
import { meterCases } from "../src/pricing/units.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import type { OperationDescription } from "../src/providers/operation.ts";
import { MoneyError } from "../src/money.ts";

/** A small seeded generator, so a failure names its case and repeats. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const UNIT_FIELDS = ["per_minute", "per_hour", "per_second", "per_image", "per_credit", "per_million_characters", "per_request"] as const;

/** A random stored price: some token rates, some unit rates, sometimes a key table and a mode. */
function randomRates(random: () => number): Record<string, unknown> {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const amount = () => 1_000 + Math.floor(random() * 5_000_000_000);
  const rates = (): Record<string, number> => {
    const out: Record<string, number> = {};
    if (random() < 0.5) {
      out.input = amount();
      out.output = amount();
    }
    for (const field of UNIT_FIELDS) if (random() < 0.2) out[field] = amount();
    return out;
  };
  const entry: Record<string, unknown> = rates();
  if (random() < 0.3) entry.by = { [pick(["voice", "size", "quality"])]: { a: rates(), b: rates() } };
  if (random() < 0.2) entry.modes = { flex: { factor: 0.5 } };
  return entry;
}

/** Whether every way `operation`'s answers come out is charged, at every key value and mode, read straight from the charge function. */
function chargedEveryWay(operation: OperationDescription, price: ModelPrice): boolean {
  if (reportsCost(operation)) return true;
  if (operation.modelKinds !== undefined && price.kind !== undefined && !operation.modelKinds.includes(price.kind)) return false;
  const read = new Set((operation.priceKeys ?? []).map((key) => key.name));
  for (const candidate of keyCandidates(price).candidates) {
    const keys = Object.fromEntries(Object.entries(candidate.values).filter(([name]) => read.has(name)));
    for (const mode of servedModes(price)) {
      const full = meterCases(operation).some((way) =>
        way.every((usage) => {
          try {
            return priceInServedMode(price, read.size === 0 ? usage : { ...usage, priceKeys: keys }, mode) !== null;
          } catch (error) {
            if (error instanceof MoneyError) return false;
            throw error;
          }
        }),
      );
      if (!full) return false;
    }
  }
  return true;
}

describe("resolveCall and callGap", () => {
  it("never saves a call it admits unless every way its answers come out is charged", () => {
    const random = seeded(4_242);
    let admitted = 0;
    for (let round = 0; round < 45; round += 1) {
      const stored = { m: randomRates(random) } as CustomerRates;
      for (const [type, description] of Object.entries(BUILT_IN_PROVIDERS)) {
        const sources = priceSources({ type, rates: stored });
        for (const operation of description.operations) {
          const call = resolveCall({ models: ["m"] }, undefined, sources, operation, "m");
          if (call.kind !== "admitted") continue;
          admitted += 1;
          const gap = callGap(call);
          if (gap === null && call.bill.price !== null) {
            expect(chargedEveryWay(operation, call.bill.price.price), `${type} ${operation.name} round ${round}`).toBe(true);
          }
          if (gap !== null && call.bill.price !== null) {
            expect(chargedEveryWay(operation, call.bill.price.price), `${type} ${operation.name} round ${round}`).toBe(false);
          }
        }
      }
    }
    expect(admitted).toBeGreaterThan(150);
  });

  it("refuses what serving refuses, with the same reasons", () => {
    const openai = BUILT_IN_PROVIDERS.openai!;
    const chat = openai.operations.find((op) => op.name === "openai.chat")!;
    const sources = priceSources({ type: "openai", rates: null });
    expect(resolveCall({ models: ["gpt-4o-mini"] }, undefined, sources, chat, "gpt-4o")).toMatchObject({ kind: "refused", reason: "model_not_allowed" });
    expect(resolveCall({}, undefined, sources, chat, "whisper-1")).toMatchObject({ kind: "refused", reason: "wrong_unit" });
    expect(resolveCall({}, undefined, sources, chat, "no-such-model")).toMatchObject({ kind: "refused", reason: "no_price" });
    // A listed model with no price is served, and priced later.
    expect(resolveCall({ models: ["no-such-model"] }, undefined, sources, chat, "no-such-model")).toMatchObject({ kind: "admitted" });
    // The model list judges the name the request carries; the price, the model it is sent as.
    expect(resolveCall({ models: ["house"] }, { house: "gpt-4o-mini" }, sources, chat, "house")).toMatchObject({ kind: "admitted", model: "gpt-4o-mini" });
  });
});

describe("our price list", () => {
  it("charges every way, or not at all, each operation of its kind can answer a call to a route with no model list", () => {
    const partly: string[] = [];
    for (const [type, description] of Object.entries(BUILT_IN_PROVIDERS)) {
      const sources = priceSources({ type, rates: null });
      for (const model of PRICE_LIST.get(type)?.keys() ?? []) {
        for (const operation of description.operations) {
          const call = resolveCall({}, undefined, sources, operation, model);
          if (call.kind === "admitted" && callGap(call) !== null) partly.push(`${type}/${model} on ${operation.name}`);
        }
      }
    }
    expect(partly).toEqual([]);
  });
});

describe("the work a save does", () => {
  it("grows with the number of models a route lists, not with its square", () => {
    const openai = BUILT_IN_PROVIDERS.openai!;
    const view = (rates: Record<string, unknown>) => ({ sources: priceSources({ type: "openai", rates: rates as CustomerRates }), description: openai });
    const work = (count: number): number => {
      const rates: Record<string, unknown> = {};
      const models: string[] = [];
      for (let index = 0; index < count; index += 1) {
        rates[`m${index}`] = { input: 1_000_000 + index, output: 2_000_000 + index };
        models.push(`m${index}`);
      }
      // A real allowlist: the route lists every model by name.
      const app = { routing: { providers: { main: { operations: ["openai.chat", "openai.responses"], models } } } };
      const connection = view(rates);
      const before = CHECK_PROBES.count + RESOLVED_CALLS.count;
      for (const call of reachableCalls(app, (slug) => (slug === "main" ? connection : null)).calls) callGap(call);
      return CHECK_PROBES.count + RESOLVED_CALLS.count - before;
    };
    const small = work(1_500);
    const large = work(3_000);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeLessThanOrEqual(small * 2.2);
    // A handful of resolutions and charge-function runs per model and operation, whatever the route's size.
    expect(large / (3_000 * 2)).toBeLessThan(20);
  });
});
