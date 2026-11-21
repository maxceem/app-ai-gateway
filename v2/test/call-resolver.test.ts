/**
 * One resolver: serving resolves a call (`resolveCall`), and saving runs the
 * same function over every call a route allows (`reachableCalls`), judging
 * each by one rule (`callGap`). These tests hold the rule to an independent
 * reading of the charge function, check our own price list against it, and
 * keep the work a save does bounded (Fable's design review of step 4b).
 */
import { describe, expect, it } from "vitest";
import { errorFacts } from "../src/core/error-facts.ts";
import {
  CHECK_PROBES,
  RESOLVED_CALLS,
  UnreadableRates,
  callGap,
  priceSources,
  reachableCalls,
  resolveAlternative,
  resolveCall,
  resolvePresetTarget,
} from "../src/pricing/billability.ts";
import { keyCandidates, PRICE_LIST, reportsCost, servedModes, type CustomerRates, type ModelPrice } from "../src/pricing/prices.ts";
import { priceInServedMode } from "../src/pricing/tokens.ts";
import { meterCases } from "../src/pricing/units.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { ProviderMatcher } from "../src/providers/matcher.ts";
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
    // Many providers declare the same operation shape (the OpenAI-compatible ones, above all). Each shape
    // is checked once per round: names and paths aside, with any code it carries, so no shape is skipped.
    const shapes = new Map<string, { type: string; operation: OperationDescription }>();
    for (const [type, description] of Object.entries(BUILT_IN_PROVIDERS)) {
      for (const operation of description.operations) {
        const { name: _name, match: _match, ...rest } = operation;
        const key = JSON.stringify(rest, (_field, value: unknown) => (typeof value === "function" ? String(value) : value));
        if (!shapes.has(key)) shapes.set(key, { type, operation });
      }
    }
    for (let round = 0; round < 45; round += 1) {
      const stored = { m: randomRates(random) } as CustomerRates;
      for (const { type, operation } of shapes.values()) {
        const sources = priceSources({ type, rates: stored });
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

describe("what serving reaches, and only that (PR #199 round 5)", () => {
  const fal = BUILT_IN_PROVIDERS.fal!;
  const falRates = priceSources({ type: "fal", rates: { "fal-ai/flux/dev": { per_unit: 50_000_000 } } as unknown as CustomerRates });
  const op = (type: string, name: string) => BUILT_IN_PROVIDERS[type]!.operations.find((one) => one.name === name)!;

  it("refuses an operation not served yet, and a priced-models path naming a model with no price, in resolveCall (F6)", () => {
    // fal's queue is served since step 6a; a live session is not yet.
    expect(resolveCall({}, undefined, falRates, op("fal", "fal.queue"), "fal-ai/flux/dev")).toMatchObject({ kind: "admitted" });
    expect(resolveCall({}, undefined, priceSources({ type: "openai", rates: null }), op("openai", "openai.realtime"), "gpt-4o-mini")).toMatchObject({
      kind: "refused",
      reason: "not_served",
    });
    expect(resolveCall({}, undefined, falRates, op("fal", "fal.run"), "fal-ai/flux/pro")).toMatchObject({ kind: "refused", reason: "unpriced_path" });
    // Even listed: the path's closed list is the priced models, whatever the app lists.
    expect(resolveCall({ models: ["fal-ai/flux/pro"] }, undefined, falRates, op("fal", "fal.run"), "fal-ai/flux/pro")).toMatchObject({ reason: "unpriced_path" });
    expect(resolveCall({}, undefined, falRates, op("fal", "fal.run"), "fal-ai/flux/dev")).toMatchObject({ kind: "admitted" });
  });

  it("enumerates each operation's own model names, judging one not served yet as if it were: a default model, a fixed one (F6, round 6 F9)", () => {
    const falApp = { routing: { providers: { main: { operations: ["fal.run", "fal.queue"] } } } };
    const falCalls = reachableCalls(falApp, () => ({ sources: falRates, description: fal })).calls;
    expect(falCalls.map((call) => `${call.operation.name} ${call.requested}`)).toEqual(["fal.run fal-ai/flux/dev", "fal.queue fal-ai/flux/dev"]);
    // Saving judges an operation as if it were served; the queue is served anyway.
    expect(resolveCall({}, undefined, falRates, op("fal", "fal.queue"), "fal-ai/flux/dev", null, { asIfServed: true })).toMatchObject({ kind: "admitted" });
    // Text to speech with no model list: a request naming no model is sent with the default one.
    const elevenlabs = BUILT_IN_PROVIDERS.elevenlabs!;
    const ttsApp = { routing: { providers: { main: { operations: ["elevenlabs.tts"] } } } };
    const ttsCalls = reachableCalls(ttsApp, () => ({ sources: priceSources({ type: "elevenlabs", rates: null }), description: elevenlabs })).calls;
    expect(ttsCalls.map((call) => call.requested)).toEqual(["eleven_multilingual_v2"]);
    // An operation with one fixed model reaches that model alone, whatever the route lists.
    const openai = BUILT_IN_PROVIDERS.openai!;
    const fixed = { ...op("openai", "openai.chat"), name: "test.fixed", model: { in: "fixed", model: "gpt-4o-mini" } } as const;
    const description = { ...openai, operations: [fixed] };
    const fixedApp = { routing: { providers: { main: { operations: ["test.fixed"], models: ["gpt-4o", "gpt-4o-mini"] } } } };
    const fixedCalls = reachableCalls(fixedApp, () => ({ sources: priceSources({ type: "openai", rates: null }), description })).calls;
    expect(fixedCalls.map((call) => call.requested)).toEqual(["gpt-4o-mini"]);
  });

  it("judges a priced-models path by the model it is sent as, after the rewrite, and sends that model (round 6 F11)", () => {
    const run = op("fal", "fal.run");
    expect(resolveCall({}, undefined, falRates, run, "flux")).toMatchObject({ kind: "refused", reason: "unpriced_path" });
    expect(resolveCall({}, { flux: "fal-ai/flux/dev" }, falRates, run, "flux")).toMatchObject({ kind: "admitted", requested: "flux", model: "fal-ai/flux/dev" });
    expect(resolveCall({}, { "fal-ai/flux/dev": "fal-ai/flux/pro" }, falRates, run, "fal-ai/flux/dev")).toMatchObject({ kind: "refused", reason: "unpriced_path", model: "fal-ai/flux/pro" });
    const matcher = new ProviderMatcher(fal);
    const match = matcher.match("POST", "run/flux");
    expect(match).toMatchObject({ kind: "operation", parts: { model: "flux" } });
    expect(matcher.upstreamFor("fal.run", { model: "fal-ai/flux/dev" })).toEqual({ host: "main", path: "/fal-ai/flux/dev" });
    expect(matcher.upstreamFor("fal.run", { model: "fal-ai//dev" })).toBeNull();
  });

  it("resolves a preset target as serving does: its operation, the streaming sibling, a fallback left out (F4)", () => {
    const gemini = BUILT_IN_PROVIDERS.gemini!;
    const sources = priceSources({ type: "gemini", rates: null });
    const target = { operation: "gemini.generate.v1beta", model: "gemini-2.5-flash" };
    expect(resolvePresetTarget(gemini, "gemini-generate", target, sources, { primary: true, streaming: false })).toMatchObject({
      kind: "admitted",
      operation: { name: "gemini.generate.v1beta" },
    });
    expect(resolvePresetTarget(gemini, "gemini-generate", target, sources, { primary: true, streaming: true })).toMatchObject({
      kind: "admitted",
      operation: { name: "gemini.stream.v1beta" },
    });
    const unpriced = { operation: "gemini.generate.v1beta", model: "no-such-model" };
    expect(resolvePresetTarget(gemini, "gemini-generate", unpriced, sources, { primary: true, streaming: false })).toMatchObject({ kind: "admitted" });
    expect(resolvePresetTarget(gemini, "gemini-generate", unpriced, sources, { primary: false, streaming: false })).toMatchObject({
      kind: "refused",
      reason: "unbillable",
    });
    expect(resolvePresetTarget(gemini, "openai-chat", target, sources, { primary: true, streaming: false })).toEqual({ kind: "refused", reason: "no_operation" });
    // Saving reaches both of a Gemini target's operations.
    const app = { routing: { providers: {} }, presets: { p: { provider: "main", ...target } } };
    const calls = reachableCalls(app, () => ({ sources, description: gemini })).calls;
    expect(calls.map((call) => call.operation.name)).toEqual(["gemini.generate.v1beta", "gemini.stream.v1beta"]);
  });

  it("resolves a model a request names besides its own under its own name, against the same list (F4)", () => {
    const chat = op("vercel", "vercel.chat");
    const sources = priceSources({ type: "vercel", rates: null });
    expect(resolveAlternative(chat, sources, "openai/gpt-4o-mini", null)).toMatchObject({ kind: "admitted", model: "openai/gpt-4o-mini" });
    expect(resolveAlternative(chat, sources, "openai/gpt-4o-mini", new Set(["house"]))).toMatchObject({ kind: "refused", reason: "model_not_allowed" });
    // A rewrite never applies: `house` is judged as `house`, which has no price, and is admitted only because it is listed.
    expect(resolveAlternative(chat, sources, "house", new Set(["house"]))).toMatchObject({ kind: "admitted", model: "house", bill: { price: null } });
    expect(resolveAlternative(chat, sources, "house", null)).toMatchObject({ kind: "refused", reason: "no_price" });
  });

  it("logs unreadable rates by their own class (F7)", () => {
    expect(errorFacts(new UnreadableRates("openai")).class).toBe("UnreadableRates");
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
