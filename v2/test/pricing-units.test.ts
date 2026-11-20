/**
 * Step 4a's pricing groundwork: units other than tokens, rates keyed by
 * request fields, customer rates in any unit, request measures, response
 * headers, and outbound fields removed. The provider is mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { ratesFromPricing } from "../src/admin/providers.ts";
import { ModelPricingSchema } from "../src/contracts/admin.ts";
import { priceUnresolvedCharge } from "../src/ledger/corrections.ts";
import { MILLI_SCALE, rate } from "../src/money.ts";
import { billing, priceSources } from "../src/pricing/billability.ts";
import { customerPrice, keyCandidates, type ModelPrice } from "../src/pricing/prices.ts";
import { priceInServedMode, priceUsage, reportedUnits } from "../src/pricing/tokens.ts";
import { callCharge, type CallAttempt } from "../src/proxy/call-charge.ts";
import { requestBody } from "../src/proxy/serve.ts";
import { PRICE_LIST, listPrice } from "../src/pricing/prices.ts";
import { V1_PRICE_FILE, V2_PRICE_OVERLAY } from "../src/pricing/price-file.ts";
import type { ProviderDescription } from "../src/providers/operation.ts";
import { meterCases, scaledCount } from "../src/pricing/units.ts";
import { defineOperation } from "../src/providers/operation.ts";
import { openai } from "../src/providers/openai.ts";
import { attemptUsage, headerUsage } from "../src/proxy/meter.ts";
import { priceKeyValues, removeOutbound, removeOutboundForm, requestUsage } from "../src/proxy/request-fields.ts";
import { usageFromMeasures, usageMeasures } from "../src/usage/measures.ts";
import type { UsageObservation } from "../src/usage/observation.ts";
import { STANDARD_MODE, parseServiceModeName } from "../src/usage/service-modes.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";

/** Saves a price on an OpenAI connection, as the management API does. */
const save = (pricing: Parameters<typeof ratesFromPricing>[0], type = "openai") => ratesFromPricing(pricing, type);

const NONE = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true as const };
const counted = (units: UsageObservation["units"]): UsageObservation => ({ ...NONE, units });
const priced = (rates: Record<string, number>, extra: Partial<ModelPrice> = {}): ModelPrice => ({
  rates: Object.fromEntries(Object.entries(rates).map(([field, value]) => [field, rate(value)])),
  raw: {},
  ...extra,
});

const operation = (meter: Parameters<typeof defineOperation>[0]["meter"], extra: Record<string, unknown> = {}) =>
  defineOperation({ name: "test.op", match: { method: "POST", path: "v1/op" }, lifecycle: "call", transport: "http", model: { in: "body", field: "model" }, meter, ...extra });

/** Each way a meter's usage can come out, as the units in it: `~` worked out from the request, `missing` a header that was not sent. */
const ways = (op: Parameters<typeof meterCases>[0]) =>
  meterCases(op).map((way) =>
    way.map((usage) => {
      const units = [...(usage.noTokens === true ? [] : ["tokens"]), ...Object.keys(usage.units ?? {}).map((unit) => (usage.estimatedUnits?.includes(unit as never) === true ? `${unit}~` : unit))];
      return units.join("+") + (usage.reportMissing === true ? " missing" : "");
    }),
  );

describe("unit rates", () => {
  it("prices each unit by its rate, rounding up once", () => {
    // $0.30 per million characters: 1,000 characters is 300,000 nano-dollars.
    expect(priceUsage(priced({ per_million_characters: 300_000_000 }), counted({ characters: 1000 }))?.cost).toBe(300_000);
    // $0.05 per second of video, 2.5 s stored as 2,500 ms.
    expect(priceUsage(priced({ per_second: 50_000_000 }), counted({ video_seconds: scaledCount("video_seconds", 2.5) }))?.cost).toBe(125_000_000);
    // fal's 2.7083 billable units at $0.025 a unit, rounded up once.
    expect(priceUsage(priced({ per_unit: 25_000_000 }), counted({ model_units: scaledCount("model_units", 2.7083) }))?.cost).toBe(67_725_000);
    expect(priceUsage(priced({ per_credit: 100_000 }), counted({ credits: 150 * MILLI_SCALE }))?.cost).toBe(15_000_000);
    expect(priceUsage(priced({ per_request: 4_000_000 }), counted({ requests: 1 }))?.cost).toBe(4_000_000);
    // One character at the smallest rate is never free.
    expect(priceUsage(priced({ per_million_characters: 1 }), counted({ characters: 1 }))?.cost).toBe(1);
  });

  it("never bills a unit the usage does not report as $0", () => {
    expect(priceUsage(priced({ per_million_characters: 300_000_000 }), counted({ credits: 5 }))).toBeNull();
    expect(priceUsage(priced({ input: 1, output: 1 }), counted({ characters: 10 }))).toBeNull();
  });

  it("gives the unit and count it billed in its result, which the charge keeps", () => {
    expect(priceUsage(priced({ per_million_characters: 1 }), counted({ characters: 42 }))).toMatchObject({ unit: "characters", units: 42 });
    // Unpriced, the unit the usage reports, a reported one before an estimate.
    expect(reportedUnits({ ...counted({ characters: 42, credits: 7000 }), estimatedUnits: ["characters"] })).toEqual({ unit: "credits", units: 7000 });
  });

  it("knows the ways each meter's usage can come out", () => {
    // Speech: tokens (with the request's characters beside them), or plain audio billed on the characters alone.
    expect(ways(openai.operations.find((op) => op.name === "openai.speech")!)).toEqual([["tokens+characters~"], ["characters~"]]);
    expect(ways(operation({ kind: "request_count" }))).toEqual([["requests"]]);
    // A header: one way, the header present and the header missing, since one model's answers come both ways.
    expect(
      ways(operation({ kind: "response_header", header: "x-cost", unit: "credits", estimate: { measure: "characters", field: "text", unit: "characters" } })),
    ).toEqual([["credits+characters~", "characters~ missing"]]);
    // A session's provider events: tokens, or session seconds, never nothing.
    expect(ways(operation({ kind: "provider_event", adapter: "x" }, { lifecycle: "session", transport: "websocket" }))).toEqual([["tokens"], ["session_seconds"]]);
  });

  it("lets an operation bill a model only in a unit it measures", () => {
    const sources = priceSources({ type: "openai", rates: { "tts-1": { per_million_characters: 15_000_000_000 } } });
    const speech = openai.operations.find((op) => op.name === "openai.speech")!;
    const chat = openai.operations.find((op) => op.name === "openai.chat")!;
    expect(billing(speech, sources, "tts-1").problem).toBeNull();
    expect(billing(chat, sources, "tts-1").problem).toBe("wrong_unit");
  });
});

describe("price keys", () => {
  const sized = priced({ per_image: 40_000_000 }, { keyed: { size: { "1024x1024": { per_image: rate(40_000_000) }, "1792x1024": { per_image: rate(80_000_000) } } } });

  it("bills the rates the request's value names", () => {
    expect(keyCandidates(sized, { size: "1792x1024" })).toMatchObject({ estimated: false, candidates: [{ price: { rates: { per_image: 80_000_000 } } }] });
    const usage = { ...counted(undefined), images: 1, priceKeys: { size: "1792x1024" } };
    expect(priceInServedMode(sized, usage, STANDARD_MODE)).toMatchObject({ cost: 80_000_000, estimated: false });
  });

  it("bills a value it does not list at the dearest listed, as an estimate", () => {
    expect(keyCandidates(sized, { size: "512x512" })).toMatchObject({ estimated: true, candidates: [{}, {}] });
    expect(priceInServedMode(sized, { ...counted(undefined), images: 2 }, STANDARD_MODE)).toMatchObject({ cost: 160_000_000, estimated: true });
  });

  it("floors an unknown value at the model's own standard price, not the keyed one", () => {
    // $1 a second as standard; one listed value bills $1 a minute. An unknown
    // value must not bill 60 s at the per-minute value.
    const timed = priced({ per_second: 1_000_000_000 }, { keyed: { quality: { draft: { per_minute: rate(1_000_000_000) } } } });
    const usage = { ...counted({ video_seconds: 60_000 }), priceKeys: { quality: "mystery" } };
    expect(priceInServedMode(timed, usage, STANDARD_MODE)).toMatchObject({ cost: 60_000_000_000, estimated: true, unit: "video_seconds" });
  });

  it("prices each of more than 64 candidates on its own, never merging their rates", () => {
    // 100 values, each $100 per million tokens in all: merging each rate's dearest would bill $198.
    const values = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`v${i}`, { input: rate(i * 1_000_000_000), output: rate((100 - i) * 1_000_000_000) }]));
    const wide = priced({}, { keyed: { tone: values } });
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000, priceKeys: { tone: "unknown" } };
    expect(priceInServedMode(wide, usage, STANDARD_MODE)).toMatchObject({ cost: 100_000_000_000, estimated: true });
  });

  it("bills the dearest candidate on a reported measure before any on the estimate", () => {
    const keyed = priced({}, { keyed: { voice: { a: { per_credit: rate(1_000) }, b: { per_million_characters: rate(1_000_000_000_000) } } } });
    const usage = { ...counted({ credits: 5_000, characters: 100 }), estimatedUnits: ["characters" as const], priceKeys: { voice: "unknown" } };
    expect(priceInServedMode(keyed, usage, STANDARD_MODE)).toMatchObject({ unit: "credits", measured: "complete", estimated: true });
  });

  it("searches an unpriced mode with the same rule: a reported measure before any estimate, however cheap", () => {
    // Standard bills only the estimated characters, dearly; priority's own rate bills the reported credits, cheaply.
    const price = priced({ per_million_characters: 1_000_000_000_000 }, { modes: { priority: { per_credit: 0.000001 } } });
    const usage = { ...counted({ credits: 5_000, characters: 100 }), estimatedUnits: ["characters" as const] };
    const fast = parseServiceModeName("fast")!;
    // The search picks priority's reported credits; then the floor, the model's own standard charge for the same usage, wins.
    expect(priceInServedMode(price, usage, fast)).toMatchObject({ unit: "characters", measured: "estimated", estimated: true, cost: 100_000_000 });
    // Where the standard price is the cheaper, the reported credits bill.
    const cheap = priced({ per_million_characters: 1 }, { modes: { priority: { per_credit: 1 } } });
    expect(priceInServedMode(cheap, usage, fast)).toMatchObject({ unit: "credits", measured: "complete", estimated: true });
  });

  it("falls back to the model's own standard price when no candidate can bill the measure", () => {
    const keyed = priced({ per_image: 40_000_000 }, { keyed: { size: { big: { per_megapixel: rate(1) } } } });
    // Eligibility judges the same candidate list, the fallback included: an image API may bill it.
    const imagesOp = openai.operations.find((op) => op.name === "openai.images")!;
    expect(billing(imagesOp, priceSources({ type: "openai", rates: { m: { per_image: 40_000_000, by: { size: { big: { per_megapixel: 1 } } } } } }), "m").problem).toBeNull();
    expect(priceInServedMode(keyed, { ...counted(undefined), images: 2, priceKeys: { size: "huge" } }, STANDARD_MODE)).toMatchObject({
      cost: 80_000_000,
      unit: "images",
      estimated: true,
    });
  });

  it("charges a price set only per key value in the unit it bills, never unresolved", () => {
    const byOnly = priced({}, { keyed: { size: { "1024x1024": { per_image: rate(40_000_000) } } } });
    const usage = { ...counted(undefined), images: 1, priceKeys: { size: "1024x1024" } };
    expect(priceInServedMode(byOnly, usage, STANDARD_MODE)).toMatchObject({ cost: 40_000_000, unit: "images", units: 1 });
    const attempt = {
      requestId: "r", seq: 1, accountId: "acc", appId: "app",
      identity: { authMethod: "api_key", installId: null, appleAccountId: null, userId: "u", apiKeyId: "k" },
      providerType: "openai", connectionId: "c", providerSlug: "s", operation: "openai.images", model: "m",
      price: { price: byOnly, source: "customer_rate" }, reportsCost: false, requestedMode: STANDARD_MODE,
      startedAt: Date.now(), appVersion: null, clientTraceId: null,
    } as unknown as CallAttempt;
    const { charge } = callCharge(attempt, { status: "ok", httpStatus: 200, errorCode: null, usage, cut: false, latencyMs: 1 });
    expect(charge).toMatchObject({ priceSource: "customer_rate", costNano: 40_000_000, unit: "images", units: 1 });
  });

  it("reads key values from the request, with the operation's default", () => {
    const op = operation({ kind: "request_count" }, { priceKeys: [{ name: "size", from: { in: "body", field: "size" }, default: "1024x1024" }] });
    expect(priceKeyValues(op, { body: { size: "1792x1024" }, query: new URLSearchParams() })).toEqual({ size: "1792x1024" });
    expect(priceKeyValues(op, { body: {}, query: new URLSearchParams() })).toEqual({ size: "1024x1024" });
  });
});

describe("customer rates in any unit", () => {
  it("accepts a price in a unit other than tokens, and refuses one that bills nothing", () => {
    expect(ModelPricingSchema.safeParse({ per_million_characters: 0.3 }).success).toBe(true);
    expect(ModelPricingSchema.safeParse({ by: { size: { "1024x1024": { per_image: 0.04 } } } }).success).toBe(true);
    expect(ModelPricingSchema.safeParse({ input: 1 }).success).toBe(false);
    expect(ModelPricingSchema.safeParse({ input: 1, output: 2, long_input: 3 }).success).toBe(false);
    expect(ModelPricingSchema.safeParse({ input: 1, output: 2, modes: { standard: { factor: 1 } } }).success).toBe(false);
  });

  it("checks a gateway's model on save with the modes live pricing inherits for it", () => {
    // Vercel's openai/gpt-4o is priced as OpenAI's gpt-4o, whose list has fast at 1.7×: $6M per million tokens no longer fits.
    expect(() => save({ "openai/gpt-4o": ModelPricingSchema.parse({ input: 6_000_000, output: 1 }) }, "vercel")).toThrow(/too large/u);
    expect(() => save({ "openai/gpt-4o": ModelPricingSchema.parse({ input: 2, output: 8 }) }, "vercel")).not.toThrow();
  });

  it("refuses a price whose key values combine in more ways than pricing tries", () => {
    const values = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`v${i}`, { per_image: 1 }]));
    expect(() => save({ m: ModelPricingSchema.parse({ per_image: 1, by: { a: values(20), b: values(20) } }) })).toThrow(/400 ways; at most 256/u);
    expect(() => save({ m: ModelPricingSchema.parse({ per_image: 1, by: { a: values(16), b: values(16) } }) })).not.toThrow();
  });

  it("refuses on save any key value whose effective price bills nothing, as run time resolves it", () => {
    // `size`, which the images API reads: at x no operation can charge a request.
    expect(() => save({ m: ModelPricingSchema.parse({ by: { size: { x: { input: 1 }, y: { per_image: 1 } } } }) })).toThrow(/size x/u);
    // A key no operation reads stays unknown, as on a real request, so the dearest value that bills is charged.
    expect(() => save({ m: ModelPricingSchema.parse({ by: { q: { x: { input: 1 }, y: { per_image: 1 } } } }) })).not.toThrow();
    expect(() => save({ m: ModelPricingSchema.parse({ input: 1, output: 2, by: { q: { x: { per_image: 1 } } } }) })).not.toThrow();
    // A price that bills nothing at all.
    expect(() => save({ m: ModelPricingSchema.parse({ cached_input: 1 }) })).toThrow(/no rate that bills/u);
  });

  it("refuses rates that no longer fit once a mode's factor scales them, tier and region together", () => {
    expect(() => save({ m: ModelPricingSchema.parse({ input: 5_000_000, output: 1, modes: { priority: { factor: 2 } } }) })).toThrow(/too large/u);
    // Each fits alone; a tier in a region multiplies both factors.
    expect(() =>
      save({ m: ModelPricingSchema.parse({ input: 3_100_000, output: 1, modes: { priority: { factor: 2 }, eu: { factor: 1.5 } } }) }),
    ).toThrow(/too large/u);
    expect(() => save({ m: ModelPricingSchema.parse({ input: 1, output: 1, modes: { priority: { factor: 2 } } }) })).not.toThrow();
    // A key value's rate is scaled by the modes too.
    expect(() =>
      save({ m: ModelPricingSchema.parse({ input: 1, output: 1, modes: { priority: { factor: 2 } }, by: { q: { x: { input: 5_000_000, output: 1 } } } }) }),
    ).toThrow(/too large/u);
    // A tier's own rate in a region is scaled by the region's factor.
    expect(() =>
      save({ m: ModelPricingSchema.parse({ input: 1, output: 1, modes: { priority: { input: 5_000_000 }, eu: { factor: 2 } } }) }),
    ).toThrow(/too large/u);
    // An explicit pair is used as it is: the tier times the region is never priced, so it cannot overflow.
    expect(() =>
      save({
        m: ModelPricingSchema.parse({ input: 3_100_000, output: 1, modes: { priority: { factor: 2 }, eu: { factor: 1.5 }, "priority+eu": { factor: 2 } } }),
      }),
    ).not.toThrow();
  });

  it("stores each rate in nano-dollars, its modes and price keys too, and bills with them", () => {
    const stored = save({
      m: ModelPricingSchema.parse({ input: 1, output: 2, cache_write_1h: 3, modes: { flex: { factor: 0.5 }, priority: { output: 4 } } }),
      c: ModelPricingSchema.parse({ per_million_characters: 0.3, by: { voice: { premium: { per_million_characters: 0.6 } } } }),
    });
    expect(stored.m).toMatchObject({ input: 1_000_000_000, output: 2_000_000_000, cache_write_1h: 3_000_000_000, modes: { priority: { output: 4_000_000_000 } } });
    const flex = parseServiceModeName("flex")!;
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    // The customer's own mode applies: flex at half price.
    expect(priceInServedMode(customerPrice(stored, "m")!, usage, flex)).toMatchObject({ cost: 500_000_000, estimated: false });
    const premium = { ...counted({ characters: 1_000_000 }), priceKeys: { voice: "premium" } };
    expect(priceInServedMode(customerPrice(stored, "c")!, premium, STANDARD_MODE)?.cost).toBe(600_000_000);
  });
});

describe("request measures and headers", () => {
  const fields = (body: Record<string, unknown>) => ({ body, query: new URLSearchParams() });

  it("measures characters as a person counts them, and seconds and images with their defaults", () => {
    const chars = operation({ kind: "request_measure", unit: "characters", measure: "characters", field: "text" });
    expect(requestUsage(chars, fields({ text: "héllo 👋" }))).toMatchObject({ units: { characters: 7 }, estimatedUnits: ["characters"], noTokens: true });
    expect(requestUsage(chars, fields({}))).toBeNull();
    const seconds = operation({ kind: "request_measure", unit: "video_seconds", measure: "requested_seconds", field: "duration", default: 5 });
    expect(requestUsage(seconds, fields({}))).toMatchObject({ units: { video_seconds: 5000 } });
    expect(requestUsage(seconds, fields({ duration: "2.5" }))).toMatchObject({ units: { video_seconds: 2500 } });
    const images = operation({ kind: "request_measure", unit: "images", measure: "image_count", field: "n", default: 1 });
    expect(requestUsage(images, fields({ n: 3 }))).toMatchObject({ units: { images: 3 } });
    expect(requestUsage(images, fields({ n: 1.5 }))).toBeNull();
    expect(requestUsage(operation({ kind: "request_count" }), fields({}))).toMatchObject({ units: { requests: 1 } });
  });

  it("bills a response header's amount, and the request's estimate only when the header is missing", () => {
    const op = operation({ kind: "response_header", header: "character-cost", unit: "credits", estimate: { measure: "characters", field: "text", unit: "characters" } });
    const estimate = requestUsage(op, fields({ text: "hello" }));
    expect(headerUsage(new Headers({ "character-cost": "12.5" }), "character-cost", "credits")).toMatchObject({ units: { credits: 12_500 } });
    expect(attemptUsage(op, { requestUsage: estimate }, null, new Headers({ "character-cost": "12" }))).toMatchObject({ units: { credits: 12_000 } });
    const missing = attemptUsage(op, { requestUsage: estimate }, null, new Headers());
    expect(missing).toMatchObject({ units: { characters: 5 }, reportMissing: true });
    // A missing report bills as an estimate.
    expect(priceInServedMode(priced({ per_million_characters: 1_000_000 }), missing!, STANDARD_MODE)).toMatchObject({ estimated: true });
    expect(attemptUsage(op, { requestUsage: null }, null, new Headers({ "character-cost": "oops" }))).toBeNull();
  });

  it("keeps both a header's amount and the request's estimate, and bills the one the price can", () => {
    const op = operation({ kind: "response_header", header: "character-cost", unit: "credits", estimate: { measure: "characters", field: "text", unit: "characters" } });
    const both = attemptUsage(op, { requestUsage: requestUsage(op, fields({ text: "hello" })) }, null, new Headers({ "character-cost": "12" }))!;
    // A price per credit bills the reported credits, exactly.
    expect(priceInServedMode(priced({ per_credit: 1_000_000 }), both, STANDARD_MODE)).toMatchObject({ unit: "credits", units: 12_000, fromEstimate: false, estimated: false });
    // A price per character only bills the estimate, never leaving the call unresolved.
    expect(priceInServedMode(priced({ per_million_characters: 1_000_000 }), both, STANDARD_MODE)).toMatchObject({ unit: "characters", units: 5, fromEstimate: true });
    // With both, the reported measure wins.
    expect(priceInServedMode(priced({ per_credit: 1, per_million_characters: 1 }), both, STANDARD_MODE)).toMatchObject({ unit: "credits" });
  });

  it("keeps units, price keys and the request's facts in the charge's measures", () => {
    const usage = { ...counted({ characters: 9 }), estimatedUnits: ["characters" as const], reportMissing: true as const, priceKeys: { size: "1024x1024" } };
    expect(usageFromMeasures(usageMeasures(usage, STANDARD_MODE))?.usage).toMatchObject(usage);
  });
});

describe("outbound fields", () => {
  const op = operation(
    { kind: "request_count" },
    {
      outbound: {
        webhooks: [{ in: "body", field: "webhook_url" }, { in: "query", field: "fal_webhook" }, { in: "form", field: "callback" }],
        fetches: [{ in: "body", field: "options.image_url" }],
        fetchKept: [{ in: "body", field: "audio_url" }],
      },
    },
  );

  it("removes webhooks and unneeded fetch fields, and keeps the ones the operation needs", () => {
    const body = { webhook_url: "https://hook", options: { image_url: "https://img", n: 1 }, audio_url: "https://audio", text: "hi" };
    const result = removeOutbound(op, body, new URLSearchParams("fal_webhook=https%3A%2F%2Fhook&keep=1"));
    expect(body).toEqual({ options: { n: 1 }, audio_url: "https://audio", text: "hi" });
    // A field declared for a form is removed from a JSON body too.
    expect(result).toMatchObject({ bodyChanged: true, formFields: [] });
    const withForm = { callback: "https://hook", text: "hi" };
    expect(removeOutbound(op, withForm, new URLSearchParams())).toMatchObject({ bodyChanged: true });
    expect(withForm).toEqual({ text: "hi" });
    expect(result.query?.toString()).toBe("keep=1");
    // A request with none of them is sent as it came.
    expect(removeOutbound(op, { text: "hi" }, new URLSearchParams("keep=1"))).toMatchObject({ bodyChanged: false, query: null });
  });

  it("removes them from a form on every path: body and form fields alike", async () => {
    // A form names a body field the same way.
    expect(removeOutbound(op, null, new URLSearchParams()).formFields).toEqual(["webhook_url", "callback", "options.image_url"]);
    const form = new FormData();
    form.append("callback", "https://hook");
    form.append("webhook_url", "https://hook");
    form.append("prompt", "hi");
    removeOutboundForm(op, form);
    expect([...form.keys()]).toEqual(["prompt"]);
    // An operation with its model in the path still reads its form when it has outbound fields to remove.
    const pathModel = defineOperation({
      name: "test.upload", match: { method: "POST", path: "v1/{model}/upload" }, lifecycle: "call", transport: "upload",
      model: { in: "path", part: "model" }, meter: { kind: "request_count" }, outbound: { webhooks: [{ in: "form", field: "callback" }] },
    });
    const request = new Request("https://local.invalid", { method: "POST", body: form.has("callback") ? form : (form.append("callback", "x"), form) });
    const bytes = new Uint8Array(await request.arrayBuffer());
    const parsed = await requestBody(bytes, request.headers.get("content-type")!, pathModel, { serviceModes: [] } as unknown as ProviderDescription);
    expect(parsed.kind === "form" && parsed.fields.has("callback")).toBe(true);
  });
});

describe("through the proxy", () => {
  const ORIGIN = "https://gateway.test";
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    clearCaches();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup(rates: Record<string, unknown> | null, routing: Record<string, unknown>) {
    await seedAccount();
    const id = crypto.randomUUID().replaceAll("-", "");
    const slug = `openai-${id.slice(0, 6)}`;
    const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, "openai", ""], "sk-test-provider-key-5678");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO provider_connection
        (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
       VALUES (?, ?, 'openai', ?, 'openai', 'active', ?, '5678', NULL, ?, 1, 'usr_test', ?, ?)`,
    )
      .bind(id, ACCOUNT_ID, slug, blob, rates === null ? null : JSON.stringify(rates), now, now)
      .run();
    const appId = await seedRoutedApp({ type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, { providers: { [slug]: routing } });
    const { key } = await seedAppKey(appId);
    return { id, appId, slug, key };
  }

  async function speak(appId: string, slug: string, key: string, input: string, model = "tts-1") {
    fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xf3]), { headers: { "content-type": "audio/mpeg" } }));
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json" },
        body: JSON.stringify({ model, input }),
      }),
      env,
      ctx,
    );
    await response.arrayBuffer();
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
    return results;
  }

  it("bills plain-audio speech from its characters at a customer's rate per character", async () => {
    // $10 per million characters, stored as nano-dollars, in place of our list's $15.
    const { appId, slug, key } = await setup({ "tts-1": { per_million_characters: 10_000_000_000 } }, { operations: ["openai.speech"] });
    const [charge] = await speak(appId, slug, key, "a".repeat(1000));
    expect(charge).toMatchObject({ price_source: "customer_rate", measured: "estimated", unit: "characters", units: 1000, cost_nano: 10_000_000 });
  });

  it("bills plain-audio speech of a model our list prices per character, with no customer rate", async () => {
    const { appId, slug, key } = await setup(null, { operations: ["openai.speech"] });
    const [charge] = await speak(appId, slug, key, "c".repeat(1000));
    // tts-1 is $15 per million characters on OpenAI's price list.
    expect(charge).toMatchObject({ price_source: "list_rate", measured: "estimated", unit: "characters", units: 1000, cost_nano: 15_000_000 });
  });

  it("prices a character-measured charge later, once a rate exists", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A voice model our list does not price, listed by name: served, and priced later.
    const { id, appId, slug, key } = await setup(null, { operations: ["openai.speech"], models: ["house-voice"] });
    const [charge] = await speak(appId, slug, key, "b".repeat(2000), "house-voice");
    expect(charge).toMatchObject({ price_source: "unresolved", cost_nano: null, unit: "characters", units: 2000 });
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("usage_unpriced_model"));
    await env.DB.prepare("UPDATE provider_connection SET rates_json = ? WHERE id = ?")
      .bind(JSON.stringify({ "house-voice": { per_million_characters: 15_000_000_000 } }), id)
      .run();
    // The sweep writes the label its pricing result gives: characters were worked out from the request.
    expect(await priceUnresolvedCharge(env.DB, { chargeId: String(charge!.id), now: Date.now() })).toMatchObject({
      status: "priced",
      correction: { costNano: 30_000_000, unit: "characters", measured: "estimated" },
    });
  });
});

describe("review fixes", () => {
  const fields = (body: Record<string, unknown>) => ({ body, query: new URLSearchParams() });

  it("keeps v2's own prices in an overlay that a copy of v1's file never drops", () => {
    for (const [provider, entries] of Object.entries(V2_PRICE_OVERLAY)) {
      for (const model of Object.keys(entries)) {
        // Merged into the price list…
        expect(listPrice(provider, model), `${provider}/${model}`).not.toBeNull();
        // …and only v2's: once v1's file lists it, the overlay's copy is removed.
        expect(Object.hasOwn(V1_PRICE_FILE[provider] ?? {}, model), `${provider}/${model} is in v1's file`).toBe(false);
      }
    }
    expect(PRICE_LIST.get("openai")?.get("tts-1")?.rates.per_million_characters).toBe(15_000_000_000);
  });

  it("takes the units a meter's reader reports from the meter, never from its style's name", () => {
    expect(ways(openai.operations.find((op) => op.name === "openai.transcription")!)).toContainEqual(["audio_seconds"]);
    expect(ways(operation({ kind: "response_json", style: "openai-chat", units: ["audio_seconds"] }))).toEqual([["tokens"], ["audio_seconds"], ["tokens+audio_seconds"]]);
  });

  it("reads a boolean price key value, and treats one over 100 characters as unknown", () => {
    const op = operation({ kind: "request_count" }, { priceKeys: [{ name: "audio", from: { in: "body", field: "generate_audio" } }] });
    expect(priceKeyValues(op, fields({ generate_audio: true }))).toEqual({ audio: "true" });
    expect(priceKeyValues(op, fields({ generate_audio: "x".repeat(101) }))).toEqual({});
  });

  it("labels nothing estimated that a header reported or a request count counted", () => {
    const op = operation({ kind: "response_header", header: "x-chars", unit: "characters", estimate: { measure: "characters", field: "text", unit: "characters" } });
    const usage = attemptUsage(op, { requestUsage: requestUsage(op, fields({ text: "hello" })) }, null, new Headers({ "x-chars": "7" }))!;
    expect(usage.estimatedUnits).toBeUndefined();
    expect(priceInServedMode(priced({ per_million_characters: 1 }), usage, STANDARD_MODE)).toMatchObject({ units: 7, measured: "complete" });
    const counted = requestUsage(operation({ kind: "request_count" }), fields({}))!;
    expect(counted.estimatedUnits).toBeUndefined();
    expect(priceInServedMode(priced({ per_request: 1 }), counted, STANDARD_MODE)).toMatchObject({ measured: "complete" });
  });

  it("saves a header meter's price only when both the header's unit and its estimate's can be charged", () => {
    const op = operation({ kind: "response_header", header: "x-cost", unit: "credits", estimate: { measure: "characters", field: "text", unit: "characters" } });
    const sources = (rates: Record<string, number>) => priceSources({ type: "openai", rates: { m: rates } });
    // Credits only: a missing header leaves the estimate unpriced, so saving refuses it; a request it can charge is still served.
    expect(billing(op, sources({ per_credit: 1 }), "m", undefined, "save").problem).toBe("wrong_unit");
    expect(billing(op, sources({ per_credit: 1 }), "m").problem).toBeNull();
    expect(billing(op, sources({ per_credit: 1, per_million_characters: 1 }), "m", undefined, "save").problem).toBeNull();
    // A key value whose rate bills only characters still charges both ways: the estimate when the header is missing, and on its own when not.
    expect(billing(op, priceSources({ type: "openai", rates: { m: { per_credit: 1, by: { x: { a: { per_million_characters: 1 } } } } } }), "m", undefined, "save").problem).toBeNull();
  });

  it("ignores a header figure too large to count exactly, so the estimate bills", () => {
    expect(headerUsage(new Headers({ "x-cost": "1e300" }), "x-cost", "credits")).toBeNull();
  });

  it("reads a path-model form for its price keys and request measures too", async () => {
    const op = defineOperation({
      name: "test.keyed", match: { method: "POST", path: "v1/{model}/run" }, lifecycle: "call", transport: "upload",
      model: { in: "path", part: "model" }, meter: { kind: "request_count" }, priceKeys: [{ name: "size", from: { in: "form", field: "size" } }],
    });
    const form = new FormData();
    form.append("size", "large");
    const request = new Request("https://local.invalid", { method: "POST", body: form });
    const parsed = await requestBody(new Uint8Array(await request.arrayBuffer()), request.headers.get("content-type")!, op, { serviceModes: [] } as unknown as ProviderDescription);
    expect(parsed.kind === "form" && parsed.fields.get("size")).toEqual(["large"]);
  });

});

it("publishes the console's price list from the same merge the gateway prices with", async () => {
  const { PRICE_FILE, mergePriceFiles, V1_PRICE_FILE: v1, V2_PRICE_OVERLAY: overlay } = await import("../src/pricing/price-file.ts");
  expect(PRICE_FILE).toEqual(mergePriceFiles(v1, overlay));
  expect(Object.keys(PRICE_FILE.openai ?? {})).toEqual(expect.arrayContaining(["tts-1", "tts-1-hd"]));
});

describe("Astra's review", () => {
  const fields = (body: Record<string, unknown>) => ({ body, query: new URLSearchParams() });
  const imagesOp = openai.operations.find((op) => op.name === "openai.images")!;

  it("reads an image's size and quality as price keys, so a sized price bills exactly", () => {
    const keys = priceKeyValues(imagesOp, fields({ model: "m", size: "1792x1024", quality: "hd" }));
    expect(keys).toEqual({ size: "1792x1024", quality: "hd" });
    const sized = priced({}, { keyed: { size: { "1024x1024": { per_image: rate(40_000_000) }, "1792x1024": { per_image: rate(80_000_000) } } } });
    expect(priceInServedMode(sized, { ...counted(undefined), images: 1, priceKeys: { size: "1792x1024" } }, STANDARD_MODE)).toMatchObject({
      cost: 80_000_000,
      estimated: false,
    });
  });

  it("keeps the request's measure beside reported tokens, for a price in the request's unit", () => {
    const speechOp = openai.operations.find((op) => op.name === "openai.speech")!;
    const tokens = { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 };
    const usage = attemptUsage(speechOp, { requestUsage: requestUsage(speechOp, fields({ input: "hello" })) }, tokens, new Headers())!;
    expect(priceInServedMode(priced({ per_million_characters: 1_000_000_000 }), usage, STANDARD_MODE)).toMatchObject({ unit: "characters", units: 5, measured: "estimated" });
    // A token price still bills the reported tokens, exactly.
    expect(priceInServedMode(priced({ input: 1, output: 1, per_million_characters: 1 }), usage, STANDARD_MODE)).toMatchObject({ unit: "tokens", measured: "complete" });
  });

  it("counts rates a service mode supplies when judging whether an operation can bill a model", () => {
    const chat = openai.operations.find((op) => op.name === "openai.chat")!;
    const sources = priceSources({ type: "openai", rates: { m: { per_image: 1, modes: { fast: { input: 1_000_000_000, output: 1_000_000_000 } } } } });
    expect(billing(chat, sources, "m").problem).toBeNull();
    expect(billing(chat, priceSources({ type: "openai", rates: { m: { per_image: 1 } } }), "m").problem).toBe("wrong_unit");
  });
});
