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
import { customerPrice, priceForKeys, type ModelPrice } from "../src/pricing/prices.ts";
import { billedUnits, priceInServedMode, priceUsage } from "../src/pricing/tokens.ts";
import { operationUnits, scaledCount } from "../src/pricing/units.ts";
import { defineOperation } from "../src/providers/operation.ts";
import { openai } from "../src/providers/openai.ts";
import { attemptUsage, headerUsage } from "../src/proxy/meter.ts";
import { priceKeyValues, removeOutbound, requestUsage } from "../src/proxy/request-fields.ts";
import { usageFromMeasures, usageMeasures } from "../src/usage/measures.ts";
import type { UsageObservation } from "../src/usage/observation.ts";
import { STANDARD_MODE, parseServiceModeName } from "../src/usage/service-modes.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";

const NONE = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true as const };
const counted = (units: UsageObservation["units"]): UsageObservation => ({ ...NONE, units });
const priced = (rates: Record<string, number>, extra: Partial<ModelPrice> = {}): ModelPrice => ({
  rates: Object.fromEntries(Object.entries(rates).map(([field, value]) => [field, rate(value)])),
  raw: {},
  ...extra,
});

const operation = (meter: Parameters<typeof defineOperation>[0]["meter"], extra: Record<string, unknown> = {}) =>
  defineOperation({ name: "test.op", match: { method: "POST", path: "v1/op" }, lifecycle: "call", transport: "http", model: { in: "body", field: "model" }, meter, ...extra });

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

  it("keeps the unit the price bills on the charge", () => {
    expect(billedUnits(counted({ characters: 42 }), priced({ per_million_characters: 1 }))).toEqual({ unit: "characters", units: 42 });
    expect(billedUnits(counted({ characters: 42 }), null)).toEqual({ unit: "characters", units: 42 });
  });

  it("knows the units each meter measures", () => {
    expect(operationUnits(openai.operations.find((op) => op.name === "openai.speech")!)).toEqual(["tokens", "characters"]);
    expect(operationUnits(operation({ kind: "request_count" }))).toEqual(["requests"]);
    expect(
      operationUnits(operation({ kind: "response_header", header: "x-cost", unit: "credits", estimate: { measure: "characters", field: "text", unit: "characters" } })),
    ).toEqual(["credits", "characters"]);
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
    expect(priceForKeys(sized, { size: "1792x1024" })).toMatchObject({ estimated: false, price: { rates: { per_image: 80_000_000 } } });
    const usage = { ...counted(undefined), images: 1, priceKeys: { size: "1792x1024" } };
    expect(priceInServedMode(sized, usage, STANDARD_MODE)).toMatchObject({ cost: 80_000_000, estimated: false });
  });

  it("bills a value it does not list at the dearest listed, as an estimate", () => {
    expect(priceForKeys(sized, { size: "512x512" })).toMatchObject({ estimated: true, price: { rates: { per_image: 80_000_000 } } });
    expect(priceInServedMode(sized, { ...counted(undefined), images: 2 }, STANDARD_MODE)).toMatchObject({ cost: 160_000_000, estimated: true });
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
    expect(ModelPricingSchema.safeParse({ cached_input: 1 }).success).toBe(false);
    expect(ModelPricingSchema.safeParse({ input: 1 }).success).toBe(false);
    expect(ModelPricingSchema.safeParse({ input: 1, output: 2, long_input: 3 }).success).toBe(false);
    expect(ModelPricingSchema.safeParse({ input: 1, output: 2, modes: { standard: { factor: 1 } } }).success).toBe(false);
  });

  it("stores each rate in nano-dollars, its modes and price keys too, and bills with them", () => {
    const stored = ratesFromPricing({
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
    expect(requestUsage(chars, fields({ text: "héllo 👋" }))).toMatchObject({ units: { characters: 7 }, fromRequest: true, noTokens: true });
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

  it("keeps units, price keys and the request's facts in the charge's measures", () => {
    const usage = { ...counted({ characters: 9 }), fromRequest: true as const, reportMissing: true as const, priceKeys: { size: "1024x1024" } };
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
    expect(result).toMatchObject({ bodyChanged: true, formFields: ["callback"] });
    expect(result.query?.toString()).toBe("keep=1");
    // A request with none of them is sent as it came.
    expect(removeOutbound(op, { text: "hi" }, new URLSearchParams("keep=1"))).toMatchObject({ bodyChanged: false, query: null });
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

  async function speak(appId: string, slug: string, key: string, input: string) {
    fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xf3]), { headers: { "content-type": "audio/mpeg" } }));
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json" },
        body: JSON.stringify({ model: "tts-1", input }),
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
    // $15 per million characters, stored as nano-dollars.
    const { appId, slug, key } = await setup({ "tts-1": { per_million_characters: 15_000_000_000 } }, { operations: ["openai.speech"] });
    const [charge] = await speak(appId, slug, key, "a".repeat(1000));
    expect(charge).toMatchObject({ price_source: "customer_rate", measured: "estimated", unit: "characters", units: 1000, cost_nano: 15_000_000 });
  });

  it("prices a character-measured charge later, once a rate exists", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { id, appId, slug, key } = await setup(null, { operations: ["openai.speech"], models: ["tts-1"] });
    const [charge] = await speak(appId, slug, key, "b".repeat(2000));
    expect(charge).toMatchObject({ price_source: "unresolved", cost_nano: null, unit: "characters", units: 2000 });
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("usage_unpriced_model"));
    await env.DB.prepare("UPDATE provider_connection SET rates_json = ? WHERE id = ?")
      .bind(JSON.stringify({ "tts-1": { per_million_characters: 15_000_000_000 } }), id)
      .run();
    expect(await priceUnresolvedCharge(env.DB, { chargeId: String(charge!.id), now: Date.now() })).toMatchObject({
      status: "priced",
      correction: { costNano: 30_000_000, unit: "characters" },
    });
  });
});
