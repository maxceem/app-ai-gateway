/**
 * The one place that decides whether a model can be billed, and the one rule
 * for what a save judges. Each case here was once a separate patch (3a-1 S7,
 * 3a-2 S1, 3b F2, A1, A2, A3).
 */
import { describe, expect, it } from "vitest";
import { changesAgainst, type StoredEntries } from "../src/admin/apps.ts";
import type { AppConfig } from "../src/contracts/app-config.ts";
import { billing, listedModelProblem, priceSources, rewriteTargetBillable, type PriceSources } from "../src/pricing/billability.ts";
import type { CustomerRates } from "../src/pricing/prices.ts";
import { BUILT_IN_PROVIDERS, builtInProvider } from "../src/providers/index.ts";
import type { OperationDescription } from "../src/providers/operation.ts";

function operation(type: string, name: string): OperationDescription {
  const found = builtInProvider(type)?.operations.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no operation ${name}`);
  return found;
}

const openai = priceSources({ type: "openai", rates: null });
const xai = priceSources({ type: "xai", rates: null });
const chat = operation("openai", "openai.chat");
const transcription = operation("openai", "openai.transcription");
const xaiChat = operation("xai", "xai.chat");
const xaiMessages = operation("xai", "xai.messages");

describe("billing", () => {
  it("bills a model at its price when the price is in a unit the operation measures", () => {
    const bill = billing(chat, openai, "gpt-4o-mini");
    expect(bill.problem).toBeNull();
    expect(bill.price?.source).toBe("list_rate");
  });

  it("says why when it cannot: no price, or a price in another unit", () => {
    expect(billing(chat, openai, "no-such-model").problem).toBe("no_price");
    expect(billing(chat, openai, "whisper-1").problem).toBe("wrong_unit");
    expect(billing(transcription, openai, "whisper-1").problem).toBeNull();
  });

  it("prefers the connection's own rate", () => {
    const own = priceSources({ type: "openai", rates_json: JSON.stringify({ "house-model": { input: 1_000, output: 2_000 } }) });
    expect(billing(chat, own, "house-model").price?.source).toBe("customer_rate");
  });

  it("bills any model an operation that reports its own cost serves", () => {
    const bill = billing(xaiChat, xai, "no-such-model");
    expect(bill).toEqual({ price: null, reportsCost: true, problem: null });
  });

  it("needs a price in a service mode asked about, unless the provider reports the cost (3b A3)", () => {
    expect(billing(chat, openai, "gpt-4o-mini", { tier: "priority", region: "global" }).problem).toBe("no_mode_price");
    expect(billing(chat, openai, "gpt-4o-mini", { tier: "fast", region: "global" }).problem).toBeNull();
    expect(billing(chat, openai, "gpt-4o-mini", { tier: "standard", region: "global" }).problem).toBeNull();
    expect(billing(xaiChat, xai, "grok-4.6", { tier: "priority", region: "global" }).problem).toBeNull();
  });
});

describe("listedModelProblem", () => {
  it("lets a priced model be listed when one enabled operation can bill it (3a-2 S1)", () => {
    expect(listedModelProblem([chat, transcription], openai, "whisper-1")).toBeNull();
    expect(listedModelProblem([chat, transcription], openai, "gpt-4o-mini")).toBeNull();
    expect(listedModelProblem([chat], openai, "whisper-1")).toEqual({});
  });

  it("needs an unpriced model to be billable on every enabled operation (3a-1 S7)", () => {
    expect(listedModelProblem([xaiChat], xai, "no-such-model")).toBeNull();
    expect(listedModelProblem([xaiChat, xaiMessages], xai, "no-such-model")).toEqual({ operation: "xai.messages" });
  });

  it("allows anything when no operation is enabled", () => {
    expect(listedModelProblem([], openai, "no-such-model")).toBeNull();
  });
});

/** A connection's price sources with rates read by `rates`, listed as its own type. */
function sources(type: string, rates: () => CustomerRates | null): PriceSources {
  return { type, rates, listedAs: (model) => ({ type, model }) };
}

describe("rewriteTargetBillable", () => {
  const types = Object.keys(BUILT_IN_PROVIDERS);
  const operationsOf = (type: string) => builtInProvider(type)?.operations ?? [];

  it("accepts a target with any price source on the account", () => {
    expect(rewriteTargetBillable("gpt-4o-mini", [], types, operationsOf)).toBe(true);
    expect(rewriteTargetBillable("house-model", [sources("openai", () => ({ "house-model": { input: 1, output: 1 } }))], types, operationsOf)).toBe(true);
    expect(rewriteTargetBillable("no-such-model", [sources("openai", () => null)], types, operationsOf)).toBe(false);
  });

  it("never reads a connection's rates when the catalog alone allows the target", () => {
    const unreadable = sources("openai", () => { throw new SyntaxError("bad rates"); });
    expect(rewriteTargetBillable("gpt-4o-mini", [unreadable], types, operationsOf)).toBe(true);
  });

  it("never reads a cost-reporting connection's rates: its provider bills the target itself", () => {
    let called = 0;
    const unreadable = sources("openrouter", () => { called += 1; throw new SyntaxError("bad rates"); });
    expect(rewriteTargetBillable("not-in-any-catalog", [unreadable], types, operationsOf)).toBe(true);
    expect(called).toBe(0);
  });

  it("accepts a target a cost-reporting connection could serve (3b A2)", () => {
    expect(rewriteTargetBillable("openrouter/auto", [sources("openrouter", () => null)], types, operationsOf)).toBe(true);
  });
});

describe("changesAgainst", () => {
  const config = (routing: Record<string, unknown>, rewrites?: Record<string, string>, presets?: Record<string, unknown>) =>
    ({ routing: { providers: routing, ...(rewrites ? { model_rewrites: rewrites } : {}) }, ...(presets ? { presets } : {}) }) as unknown as AppConfig;
  const stored: StoredEntries = {
    providers: { main: { operations: ["openai.chat"], models: ["house"] } },
    rewrites: { house: "gpt-4o-mini" },
    presets: { quick: { provider: "main", operation: "openai.chat", model: "gpt-4o-mini" } },
  };

  it("judges nothing that is stored unchanged, so a price gone since never blocks a rename (3b F2, A1)", () => {
    const changes = changesAgainst(stored, config(
      { main: { models: ["house"], operations: ["openai.chat"] } },
      { house: "gpt-4o-mini" },
      { quick: { model: "gpt-4o-mini", operation: "openai.chat", provider: "main" } },
    ));
    expect(changes.routing("main")).toBe(false);
    expect(changes.rewrite("house")).toBe(false);
    expect(changes.preset("quick")).toBe(false);
  });

  it("judges what is new or changed", () => {
    const changes = changesAgainst(stored, config(
      { main: { operations: ["openai.chat"], models: ["house", "other"] }, extra: { operations: ["openai.chat"] } },
      { house: "gpt-4.1" },
    ));
    expect(changes.routing("main")).toBe(true);
    expect(changes.routing("extra")).toBe(true);
    expect(changes.rewrite("house")).toBe(true);
    expect(changes.rewrite("other")).toBe(false);
  });

  it("compares a route once, however many models it lists", () => {
    let reads = 0;
    const route = { operations: ["openai.chat"], get models() { reads += 1; return ["house"]; } };
    const changes = changesAgainst({ providers: { main: route }, rewrites: {}, presets: {} }, config({ main: { operations: ["openai.chat"], models: ["house"] } }));
    for (let index = 0; index < 5; index += 1) expect(changes.routing("main")).toBe(false);
    expect(reads).toBe(1);
  });

  it("calls a new entry changed without comparing it, however deep it is", () => {
    let deep: unknown = [];
    for (let level = 0; level < 4_000; level += 1) deep = [deep];
    const changes = changesAgainst({ providers: {}, rewrites: {}, presets: {} }, config({}, undefined, { fresh: { params: { nested: deep } } }));
    expect(changes.preset("fresh")).toBe(true);
  });

  it("judges everything on create", () => {
    const changes = changesAgainst({ providers: {}, rewrites: {}, presets: {} }, config({ main: { operations: [] } }, { a: "b" }, { p: {} }));
    expect(changes.routing("main")).toBe(true);
    expect(changes.rewrite("a")).toBe(true);
    expect(changes.preset("p")).toBe(true);
  });
});

describe("one place decides", () => {
  // Every source file, as text, read when the test is built.
  const sources = (import.meta as ImportMeta & {
    glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>;
  }).glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
  const DECIDERS = ["resolvePrice", "pricesOperation", "reportsCost", "listPrice", "priceInMode", "customerPrice", "PRICE_LIST"];
  const ALLOWED = new Set(["../src/pricing/billability.ts", "../src/pricing/tokens.ts", "../src/pricing/prices.ts"]);

  it("no file but billability.ts reads the price list or a connection's rates to decide billing", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (ALLOWED.has(file)) continue;
      for (const statement of text.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s+from\s+"[^"]*pricing\/prices\.ts"/gu)) {
        const names = statement[1]!.split(",").map((name) => name.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0]!);
        for (const name of names) if (DECIDERS.includes(name)) offenders.push(`${file}: ${name}`);
      }
      if (/import\s+\*\s+as\s+\w+\s+from\s+"[^"]*pricing\/prices\.ts"/u.test(text)) offenders.push(`${file}: namespace import`);
    }
    expect(sources["../src/pricing/billability.ts"]).toBeDefined();
    expect(offenders).toEqual([]);
  });

  it("reads a connection's rates once, and only when asked", () => {
    let reads = 0;
    const row = { type: "openai", get rates_json() { reads += 1; return JSON.stringify({ "house-model": { input: 1, output: 1 } }); } };
    const lazy = priceSources(row);
    expect(reads).toBe(0);
    expect(lazy.rates()).toEqual({ "house-model": { input: 1, output: 1 } });
    expect(lazy.rates()).toEqual({ "house-model": { input: 1, output: 1 } });
    expect(reads).toBe(1);
    expect(() => priceSources({ type: "openai", rates_json: "{not json" }).rates()).toThrow(SyntaxError);
  });
});
