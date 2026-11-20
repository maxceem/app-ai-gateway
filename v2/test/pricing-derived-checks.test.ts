/**
 * Saving and serving are worked out by running the one charge function
 * (`priceInServedMode`) over the usages an operation's meter can produce
 * (`meterCases`), so the three can never disagree (Fable's design review of
 * step 4a). These tests hold the three side by side.
 */
import { describe, expect, it } from "vitest";
import { rate } from "../src/money.ts";
import { billing, priceSources, savedPriceProblem } from "../src/pricing/billability.ts";
import { customerPrice, keyCandidates, servedModes, type CustomerRates } from "../src/pricing/prices.ts";
import { costAtRate, costOfRates, priceInServedMode } from "../src/pricing/tokens.ts";
import { meterCases } from "../src/pricing/units.ts";
import { elevenlabs } from "../src/providers/elevenlabs.ts";
import { defineOperation, type OperationDescription } from "../src/providers/operation.ts";
import { openai } from "../src/providers/openai.ts";
import type { UsageObservation } from "../src/usage/observation.ts";
import { STANDARD_MODE } from "../src/usage/service-modes.ts";

const tts = elevenlabs.operations.find((op) => op.name === "elevenlabs.tts")!;
const NONE = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true as const };
const headerPresent: UsageObservation = { ...NONE, units: { credits: 2_000, characters: 40 }, estimatedUnits: ["characters"] };
const headerMissing: UsageObservation = { ...NONE, units: { characters: 40 }, estimatedUnits: ["characters"], reportMissing: true };

/** The three answers for one stored price on one operation: save, serve, and whether each header case is charged. */
function threeWays(operation: OperationDescription, stored: CustomerRates) {
  const sources = priceSources({ type: "elevenlabs", rates: stored });
  const price = customerPrice(stored, "m")!;
  return {
    save: billing(operation, sources, "m", undefined, "save").problem,
    serve: billing(operation, sources, "m").problem,
    present: priceInServedMode(price, headerPresent, STANDARD_MODE) !== null,
    missing: priceInServedMode(price, headerMissing, STANDARD_MODE) !== null,
  };
}

describe("Fable's cases: save, eligibility and the charge agree", () => {
  it("a header price in credits only: served for the header, refused on save since a missing header cannot be charged", () => {
    expect(threeWays(tts, { m: { per_credit: 50_000_000 } })).toEqual({ save: "wrong_unit", serve: null, present: true, missing: false });
    // Saving the rates on the connection refuses it too, for the same reason.
    expect(savedPriceProblem({ m: { per_credit: 50_000_000 } }, "m", "elevenlabs", elevenlabs.operations)).toMatchObject({ kind: "bills_nothing" });
  });

  it("both rates, plus a key value stating only credits: every case is charged, so all three accept", () => {
    const stored = { m: { per_credit: 50_000_000, per_million_characters: 300_000_000, by: { voice: { premium: { per_credit: 90_000_000 } } } } };
    expect(threeWays(tts, stored)).toEqual({ save: null, serve: null, present: true, missing: true });
    // The premium voice with the header missing: its own price cannot bill characters, so the standard price does, as an estimate.
    expect(priceInServedMode(customerPrice(stored, "m")!, { ...headerMissing, priceKeys: { voice: "premium" } }, STANDARD_MODE)).toMatchObject({
      unit: "characters",
      estimated: true,
    });
    expect(savedPriceProblem(stored, "m", "elevenlabs", elevenlabs.operations)).toBeNull();
  });

  it("gives a session's provider events a way to be charged, in tokens or by time", () => {
    const session = defineOperation({
      name: "test.session",
      match: { method: "GET", path: "v1/realtime" },
      lifecycle: "session",
      transport: "websocket",
      model: { in: "query", name: "model" },
      meter: { kind: "provider_event", adapter: "test" },
    });
    const tokens = priceSources({ type: "openai", rates: { m: { input: 1_000_000_000, output: 2_000_000_000 } } });
    const minutes = priceSources({ type: "openai", rates: { m: { per_minute: 80_000_000 } } });
    expect(billing(session, tokens, "m", undefined, "save").problem).toBeNull();
    expect(billing(session, minutes, "m", undefined, "save").problem).toBeNull();
  });
});

describe("one cost formula", () => {
  it("costs 2.5 fal units at $0.05 the same live and in settlement", () => {
    const perUnit = rate(50_000_000);
    const live = priceInServedMode({ rates: { per_unit: perUnit }, raw: {} }, { ...NONE, units: { model_units: 2_500 } }, STANDARD_MODE);
    expect(live?.cost).toBe(125_000_000);
    expect(costAtRate("per_unit", 2_500, perUnit)).toBe(125_000_000);
  });

  it("rounds a mix of token and unit rates up once over the whole", () => {
    // A millionth of a nano-dollar plus a sixty-thousandth: 1 once over the whole, 2 if each part were rounded.
    expect(costOfRates([["input", 1, rate(1)], ["per_minute", 1, rate(1)]])).toBe(1);
    expect(costAtRate("input", 1, rate(1)) + costAtRate("per_minute", 1, rate(1))).toBe(2);
  });
});

/** A small seeded random source, so a failure can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELDS = ["input", "output", "per_image", "per_minute", "per_million_characters", "per_credit", "per_request"];
const MODES = ["flex", "priority", "eu", "priority+eu"];

const OPERATIONS: readonly OperationDescription[] = [
  ...openai.operations.filter((op) => ["openai.chat", "openai.transcription", "openai.images", "openai.speech"].includes(op.name)),
  tts,
  defineOperation({
    name: "test.count",
    match: { method: "POST", path: "v1/count" },
    lifecycle: "call",
    transport: "http",
    model: { in: "body", field: "model" },
    meter: { kind: "request_count" },
  }),
];

function randomRates(next: () => number): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const field of FIELDS) if (next() < 0.35) rates[field] = 1 + Math.floor(next() * 1_000_000_000);
  return rates;
}

function randomStored(next: () => number): CustomerRates {
  const entry: Record<string, unknown> = randomRates(next);
  if (next() < 0.4) {
    entry.modes = Object.fromEntries(MODES.filter(() => next() < 0.5).map((name) => [name, next() < 0.5 ? { factor: 0.5 + next() * 2 } : randomRates(next)]));
  }
  if (next() < 0.4) entry.by = { size: Object.fromEntries(["a", "b"].filter(() => next() < 0.7).map((value) => [value, randomRates(next)])) };
  return { m: entry };
}

/** Whether the charge prices one usage; a rate too large once scaled prices nothing. */
function charged(stored: CustomerRates, usage: UsageObservation, mode: Parameters<typeof priceInServedMode>[2]): boolean {
  try {
    return priceInServedMode(customerPrice(stored, "m")!, usage, mode) !== null;
  } catch {
    return false;
  }
}

describe("property: the checks are the charge function, run", () => {
  it("serves a model exactly when some usage its meter can produce is charged in some mode", () => {
    const next = random(4242);
    for (let round = 0; round < 400; round += 1) {
      const stored = randomStored(next);
      const price = customerPrice(stored, "m")!;
      const sources = priceSources({ type: "openai", rates: stored });
      for (const operation of OPERATIONS) {
        const expected = servedModes(price).some((mode) => meterCases(operation).flat().some((usage) => charged(stored, usage, mode)));
        expect(billing(operation, sources, "m").problem === null, `${operation.name} ${JSON.stringify(stored)}`).toBe(expected);
      }
    }
  });

  it("saves a model exactly when, for every key value and mode, some way is charged in full", () => {
    const next = random(777);
    for (let round = 0; round < 400; round += 1) {
      const stored = randomStored(next);
      const price = customerPrice(stored, "m")!;
      const sources = priceSources({ type: "openai", rates: stored });
      for (const operation of OPERATIONS) {
        const expected = keyCandidates(price).candidates.every(({ values }) =>
          servedModes(price).every((mode) => meterCases(operation).some((way) => way.every((usage) => charged(stored, { ...usage, priceKeys: values }, mode)))),
        );
        expect(billing(operation, sources, "m", undefined, "save").problem === null, `${operation.name} ${JSON.stringify(stored)}`).toBe(expected);
        // Whatever saving accepts, serving accepts too.
        if (expected) expect(billing(operation, sources, "m").problem).toBeNull();
      }
    }
  });
});
