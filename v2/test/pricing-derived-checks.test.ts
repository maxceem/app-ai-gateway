/**
 * Saving and serving are worked out by running the one charge function
 * (`priceInServedMode`) over the usages an operation's meter can produce
 * (`meterCases`), so the three can never disagree (Fable's design review of
 * step 4a). These tests hold the three side by side.
 */
import { describe, expect, it } from "vitest";
import { priceUnits, priceUnitsMixed, priceUnitsPer, priceUnitsSum, rate } from "../src/money.ts";
import { billing, CHECK_PROBES, priceSources, savedPriceProblem } from "../src/pricing/billability.ts";
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
        // A request carries only the keys the operation reads; the rest stay unknown.
        const read = (operation.priceKeys ?? []).map((key) => key.name);
        const keysFor = (values: Readonly<Record<string, string>>) =>
          read.length === 0 ? undefined : Object.fromEntries(Object.entries(values).filter(([name]) => read.includes(name)));
        const expected = keyCandidates(price).candidates.every(({ values }) =>
          servedModes(price).every((mode) =>
            meterCases(operation).some((way) => way.every((usage) => charged(stored, { ...usage, priceKeys: keysFor(values) }, mode))),
          ),
        );
        expect(billing(operation, sources, "m", undefined, "save").problem === null, `${operation.name} ${JSON.stringify(stored)}`).toBe(expected);
        // Whatever saving accepts, serving accepts too.
        if (expected) expect(billing(operation, sources, "m").problem).toBeNull();
      }
    }
  });
});

describe("Sol's review of the derived checks", () => {
  const chat = openai.operations.find((op) => op.name === "openai.chat")!;
  const images = openai.operations.find((op) => op.name === "openai.images")!;
  const MINUTE: UsageObservation = { ...NONE, units: { audio_seconds: 3_600_000 } };

  it("probes with one stored unit, so a rate valid for one real unit never overflows a probe", () => {
    // $10,000 per image: one image fits, a thousand would not.
    const sources = priceSources({ type: "openai", rates: { m: { per_image: 10_000_000_000_000 } } });
    expect(billing(images, sources, "m").problem).toBeNull();
    expect(billing(images, sources, "m", undefined, "save").problem).toBeNull();
  });

  it("gives an operation only the key values it reads on save, leaving the rest unknown as serving does", () => {
    // Chat reads no size: a chat request is charged at the size whose rates bill tokens.
    const sources = priceSources({ type: "openai", rates: { m: { by: { size: { big: { per_image: 1 }, small: { input: 1, output: 1 } } } } } });
    expect(billing(chat, sources, "m", undefined, "save").problem).toBeNull();
  });

  it("skips a candidate whose cost is too large to store, and the others still compete", () => {
    // Voice a's rate cannot be stored for an hour; voice b's can, and bills.
    const price = customerPrice({ m: { by: { voice: { a: { per_minute: 9_000_000_000_000_000 }, b: { per_second: 1 } } } } }, "m")!;
    expect(priceInServedMode(price, MINUTE, STANDARD_MODE)).toMatchObject({ rates: { per_second: 1 }, cost: 3_600 });
  });

  it("compares candidates exactly, so a tie after rounding never picks the cheaper rate", () => {
    // One millisecond: 1.2 nano at a, 1.9 nano at b; both round to 2, and b is dearer.
    const price = customerPrice({ m: { by: { voice: { a: { per_minute: 72_000 }, b: { per_minute: 114_000 } } } } }, "m")!;
    expect(priceInServedMode(price, { ...NONE, units: { audio_seconds: 1 } }, STANDARD_MODE)).toMatchObject({ rates: { per_minute: 114_000 }, cost: 2 });
  });

  it("covers tokens and a reported unit together, where the reported unit bills first", () => {
    const transcription = openai.operations.find((op) => op.name === "openai.transcription")!;
    expect(meterCases(transcription).flat()).toContainEqual(expect.objectContaining({ inputTokens: 1, units: { audio_seconds: 1_000 } }));
    // A model priced both ways bills the duration it reported, not its tokens.
    const price = customerPrice({ m: { input: 1_000_000_000, output: 1_000_000_000, per_minute: 6_000_000 } }, "m")!;
    const both: UsageObservation = { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, units: { audio_seconds: 60_000 } };
    expect(priceInServedMode(price, both, STANDARD_MODE)).toMatchObject({ unit: "audio_seconds", cost: 6_000_000 });
  });

  it("leaves a charge unresolved when its standard-price floor cannot be stored, never billing below it", () => {
    // An unknown voice bills at a's $1 per second as an estimate; the floor, the model's own per-minute price, is too large to store.
    const price = customerPrice({ m: { per_minute: 9_000_000_000_000_000, by: { voice: { a: { per_second: 1 } } } } }, "m")!;
    expect(priceInServedMode(price, MINUTE, STANDARD_MODE)).toBeNull();
  });

  it("rounds only the chosen price, once, from its exact cost", () => {
    const price = customerPrice({ m: { by: { voice: { a: { per_minute: 72_000 }, b: { per_minute: 114_000 } } } } }, "m")!;
    const chosen = priceInServedMode(price, { ...NONE, units: { audio_seconds: 1 } }, STANDARD_MODE)!;
    expect(chosen.exact).toEqual({ numerator: 114_000n, denominator: 60_000n });
    expect(chosen.cost).toBe(2);
  });

  it("rounds tokens with the one rounding code", () => {
    const next = random(99);
    for (let round = 0; round < 200; round += 1) {
      const parts = Array.from({ length: 1 + Math.floor(next() * 4) }, () => [Math.floor(next() * 1_000_000), rate(Math.floor(next() * 1_000_000_000))] as const);
      expect(priceUnitsSum(parts)).toBe(priceUnitsMixed(parts.map(([units, value]) => [units, value, 1_000_000] as const)));
    }
  });
});

describe("Fable's review of the derived checks", () => {
  const chat = openai.operations.find((op) => op.name === "openai.chat")!;
  const NO = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

  it("checks each key combination an operation can tell apart once, however many there are", () => {
    // 256 combinations of two keys chat never reads: chat sees one request shape, so it is checked once per mode.
    const values = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`v${i}`, { input: 1_000_000_000, output: 1_000_000_000 }]));
    const sources = priceSources({ type: "openai", rates: { m: { input: 1, output: 1, by: { a: values, b: values } } } });
    const before = CHECK_PROBES.count;
    expect(billing(chat, sources, "m", undefined, "save").problem).toBeNull();
    // One mode (standard), one way, one usage: one run of the charge function, not 256.
    expect(CHECK_PROBES.count - before).toBe(1);
  });

  it("refuses a whole candidate when one of its unit rates cannot be stored, never falling to a cheaper exact price", () => {
    const price = customerPrice({ m: { input: 1, output: 1, per_minute: 9_000_000_000_000_000 } }, "m")!;
    const usage: UsageObservation = { ...NO, inputTokens: 100, outputTokens: 10, units: { audio_seconds: 3_600_000 } };
    expect(priceInServedMode(price, usage, STANDARD_MODE)).toBeNull();
  });

  it("floors an estimate at the standard price's own charge for the usage, whatever unit the estimate billed", () => {
    // An unknown quality bills one image at a nano-dollar; the model's own price bills the same answer's tokens at more.
    const price = customerPrice({ m: { input: 1_000_000_000, output: 1_000_000_000, by: { quality: { a: { per_image: 1 } } } } }, "m")!;
    const usage: UsageObservation = { ...NO, inputTokens: 1_000, outputTokens: 100, units: { images: 1 } };
    expect(priceInServedMode(price, usage, STANDARD_MODE)).toMatchObject({ unit: "tokens", cost: 1_100_000, estimated: true });
  });

  it("leaves a charge unresolved when the floor cannot be stored, as a candidate that cannot is skipped", () => {
    const price = customerPrice({ m: { input: 1, output: 1, per_minute: 9_000_000_000_000_000, by: { quality: { a: { per_second: 1 } } } } }, "m")!;
    expect(priceInServedMode(price, { ...NO, noTokens: true, units: { audio_seconds: 3_600_000 } }, STANDARD_MODE)).toBeNull();
  });

  it("probes a fractional unit with one whole unit", () => {
    const transcription = openai.operations.find((op) => op.name === "openai.transcription")!;
    expect(meterCases(transcription).flat()).toContainEqual(expect.objectContaining({ noTokens: true, units: { audio_seconds: 1_000 } }));
  });

  it("prices every money helper through the one rounding code", () => {
    const next = random(5);
    for (let round = 0; round < 200; round += 1) {
      const units = Math.floor(next() * 10_000_000);
      const value = rate(Math.floor(next() * 1_000_000_000));
      const per = 1 + Math.floor(next() * 3_600_000);
      expect(priceUnits(units, value)).toBe(priceUnitsMixed([[units, value, 1_000_000]]));
      expect(priceUnitsPer(units, value, per)).toBe(priceUnitsMixed([[units, value, per]]));
    }
  });

  it("refuses a price with no rate at all on a connection type with no operations", () => {
    expect(savedPriceProblem({ m: {} }, "m", "custom", [])).toMatchObject({ kind: "bills_nothing" });
    expect(savedPriceProblem({ m: { input: 1, output: 1 } }, "m", "custom", [])).toBeNull();
  });
});

describe("Fable's second round on the derived checks", () => {
  // 1 credit reported by the provider, and a billion characters worked out from the request.
  const usage: UsageObservation = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    noTokens: true,
    units: { credits: 1_000, characters: 1_000_000_000 },
    estimatedUnits: ["characters"],
  };

  it("never prices an estimate that cannot win, so its oversized rate cannot void the reported measure", () => {
    const price = customerPrice({ m: { per_credit: 5, per_million_characters: 9_000_000_000_000_000 } }, "m")!;
    expect(priceInServedMode(price, usage, STANDARD_MODE)).toMatchObject({ unit: "credits", cost: 5, estimated: false });
  });

  it("keeps a key candidate that bills a reported measure, however large its estimate's rate", () => {
    // An unknown voice: a bills the reported credit at 5, b at 1; a's character rate could never be stored, but is never billed.
    const price = customerPrice({ m: { by: { voice: { a: { per_credit: 5, per_million_characters: 9_000_000_000_000_000 }, b: { per_credit: 1 } } } } }, "m")!;
    expect(priceInServedMode(price, usage, STANDARD_MODE)).toMatchObject({ unit: "credits", rates: { per_credit: 5 }, cost: 5 });
  });

  it("never bills an estimate below the standard price on the unit it billed, even where the standard price's own choice is cheaper", () => {
    // An unknown voice a bills the estimated characters cheaply; the standard price prefers the reported credit at 1 nano,
    // but its own character rate, on the unit a billed, is a dollar per million.
    const price = customerPrice({ m: { per_credit: 1, per_million_characters: 1_000_000_000, by: { voice: { a: { per_million_characters: 10 } } } } }, "m")!;
    const estimateOnly: UsageObservation = { ...usage, units: { credits: 1_000, characters: 1_000_000 } };
    // a has no credit rate, so it bills characters (10 nano); base on characters is 1,000,000,000 nano, its own choice 1 nano.
    expect(priceInServedMode(price, estimateOnly, STANDARD_MODE)).toMatchObject({ unit: "characters", cost: 1_000_000_000, estimated: true });
  });
});
