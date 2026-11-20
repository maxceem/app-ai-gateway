/**
 * The one place that decides whether a model can be billed, and the one rule
 * for what a save judges. Each case here was once a separate patch (3a-1 S7,
 * 3a-2 S1, 3b F2, A1, A2, A3).
 */
import { describe, expect, it } from "vitest";
import { changesAgainst, type StoredEntries } from "../src/admin/apps.ts";
import type { AppConfig } from "../src/contracts/app-config.ts";
import { billing, listedModelProblem, rewriteTargetBillable } from "../src/pricing/billability.ts";
import { BUILT_IN_PROVIDERS, builtInProvider } from "../src/providers/index.ts";
import type { OperationDescription } from "../src/providers/operation.ts";

function operation(type: string, name: string): OperationDescription {
  const found = builtInProvider(type)?.operations.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no operation ${name}`);
  return found;
}

const openai = { type: "openai", rates: null };
const xai = { type: "xai", rates: null };
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
    const own = { type: "openai", rates: { "house-model": { input: 1_000, output: 2_000 } } };
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

describe("rewriteTargetBillable", () => {
  const types = Object.keys(BUILT_IN_PROVIDERS);
  const operationsOf = (type: string) => builtInProvider(type)?.operations ?? [];

  it("accepts a target with any price source on the account", () => {
    expect(rewriteTargetBillable("gpt-4o-mini", [], types, operationsOf)).toBe(true);
    expect(rewriteTargetBillable("house-model", [{ type: "openai", rates: { "house-model": { input: 1, output: 1 } } }], types, operationsOf)).toBe(true);
    expect(rewriteTargetBillable("no-such-model", [openai], types, operationsOf)).toBe(false);
  });

  it("accepts a target a cost-reporting connection could serve (3b A2)", () => {
    expect(rewriteTargetBillable("openrouter/auto", [{ type: "openrouter", rates: null }], types, operationsOf)).toBe(true);
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

  it("judges everything on create", () => {
    const changes = changesAgainst({ providers: {}, rewrites: {}, presets: {} }, config({ main: { operations: [] } }, { a: "b" }, { p: {} }));
    expect(changes.routing("main")).toBe(true);
    expect(changes.rewrite("a")).toBe(true);
    expect(changes.preset("p")).toBe(true);
  });
});
