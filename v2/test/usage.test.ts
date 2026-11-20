/**
 * Usage readers, provider cost reports and token pricing, ported from v1's
 * `usage.test.ts`, `token-variants.test.ts` and `service-modes.test.ts`.
 * Expected costs are worked out from the shipped price list at test time, so
 * a routine price update never fails a test of the arithmetic.
 */
import { describe, expect, it } from "vitest";
import { priceUnitsSum, rate, type RateNanoPerMillion } from "../src/money.ts";
import { customerPrice, listPrice, priceInMode, resolvePrice, type ModelPrice } from "../src/pricing/prices.ts";
import { priceInServedMode, priceTokens } from "../src/pricing/tokens.ts";
import { anthropic } from "../src/providers/anthropic.ts";
import { bytedance, mistral } from "../src/providers/compatible.ts";
import { gemini } from "../src/providers/gemini.ts";
import { openai } from "../src/providers/openai.ts";
import { requestedServiceMode, servedServiceMode } from "../src/proxy/meter.ts";
import { usageFromMeasures, usageMeasures } from "../src/usage/measures.ts";
import type { UsageObservation } from "../src/usage/observation.ts";
import { readBody, withHeaderVariants, type BodyReaderOptions } from "../src/usage/readers.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { STANDARD_MODE } from "../src/usage/service-modes.ts";
import type { ApiStyle } from "../src/providers/operation.ts";

function read(text: string, contentType: string, style: ApiStyle, counted?: BodyReaderOptions["counted"]): UsageObservation {
  const usage = readBody(text, contentType, style, counted === undefined ? {} : { counted }).usage;
  expect(usage).not.toBeNull();
  return usage!;
}

function sse(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function listed(provider: string, model: string): ModelPrice {
  const price = listPrice(provider, model);
  expect(price, `${provider}/${model} is on the price list`).not.toBeNull();
  return price!;
}

function cost(parts: readonly (readonly [number, RateNanoPerMillion | undefined])[]): number {
  return priceUnitsSum(parts.map(([units, value]) => [units, value!] as const));
}

describe("usage readers", () => {
  it("reads a Chat Completions stream's served tier from any chunk, and two different ones as unknown", () => {
    const shed = read(
      sse([
        { choices: [{ delta: { content: "Hi" } }], service_tier: "default" },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ]),
      "text/event-stream",
      "openai-chat",
    );
    expect(shed.reportedModes).toEqual({ service_tier: "default" });
    expect(servedServiceMode(openai, undefined, { tier: "fast", region: "global" }, shed, new Headers()).mode).toEqual(STANDARD_MODE);
    const mixed = read(
      sse([
        { choices: [], service_tier: "priority" },
        { choices: [], service_tier: "flex", usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ]),
      "text/event-stream",
      "openai-chat",
    );
    expect(mixed.reportedModes).toEqual({ service_tier: "(other)" });
    // Flagged here; pricing bills any doubt at standard at least (`priceInServedMode`).
    expect(servedServiceMode(openai, undefined, { tier: "flex", region: "global" }, mixed, new Headers())).toMatchObject({
      mode: { tier: "flex" },
      unknown: { field: "service_tier" },
    });
  });

  it("normalizes OpenAI cached and cache-write tokens as subsets of input", () => {
    const usage = read(
      `event: response.completed\n${sse([
        { type: "response.completed", response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 }, output_tokens: 20 } } },
      ])}`,
      "text/event-stream",
      "openai-responses",
    );
    expect(usage).toEqual({ inputTokens: 50, cachedInputTokens: 40, cacheWriteTokens: 10, outputTokens: 20 });
    const luna = listed("openai", "gpt-5.6-luna");
    expect(priceTokens(luna, usage)?.cost).toBe(
      cost([
        [50, luna.rates.input],
        [40, luna.rates.cached_input],
        [10, luna.rates.cache_write],
        [20, luna.rates.output],
      ]),
    );
  });

  it("merges an Anthropic stream's input from message_start with the output of its last delta", () => {
    const usage = read(
      sse([
        { type: "message_start", message: { usage: { input_tokens: 60, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 1 } } },
        { type: "content_block_delta", delta: { text: "hi" } },
        { type: "message_delta", usage: { output_tokens: 20 } },
        { type: "message_stop" },
      ]),
      "text/event-stream",
      "anthropic-messages",
    );
    expect(usage).toEqual({ inputTokens: 60, cachedInputTokens: 30, cacheWriteTokens: 10, outputTokens: 20 });
  });

  it("reads Gemini's cached prompt tokens as a subset, and thinking as output", () => {
    expect(
      read(
        JSON.stringify([{ candidates: [] }, { usageMetadata: { promptTokenCount: 90, cachedContentTokenCount: 25, candidatesTokenCount: 15 } }]),
        "application/json",
        "gemini-generate",
      ),
    ).toEqual({ inputTokens: 65, cachedInputTokens: 25, cacheWriteTokens: 0, outputTokens: 15 });
    expect(
      read(JSON.stringify({ usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 30 } }), "application/json", "gemini-generate"),
    ).toEqual({ inputTokens: 40, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 40, modalityTokens: { output: { unknown: 10 } } });
  });

  it("bills generated Gemini image tokens at the image rate, and a text model's at its output rate", () => {
    const usage = read(
      JSON.stringify({
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 1130,
          thoughtsTokenCount: 50,
          candidatesTokensDetails: [
            { modality: "TEXT", tokenCount: 10 },
            { modality: "IMAGE", tokenCount: 1120 },
          ],
        },
      }),
      "application/json",
      "gemini-generate",
    );
    expect(usage.modalityTokens).toEqual({ output: { image: 1120 } });
    const banana = listed("gemini", "gemini-nano-banana-2.1");
    expect(priceTokens(banana, usage)?.cost).toBe(
      cost([
        [12, banana.rates.input],
        [60, banana.rates.output],
        [1120, banana.rates.image_output],
      ]),
    );
    const flash = listed("gemini", "gemini-3.5-flash");
    expect(priceTokens(flash, usage)?.cost).toBe(cost([[12, flash.rates.input], [1180, flash.rates.output]]));
  });

  it("bills output an image model did not break down at its image rate, never the text rate", () => {
    const usage = read(JSON.stringify({ usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1120 } }), "application/json", "gemini-generate");
    const banana = listed("gemini", "gemini-nano-banana-2.1");
    expect(priceTokens(banana, usage)?.cost).toBe(cost([[12, banana.rates.input], [1120, banana.rates.image_output]]));
  });

  it("reads the input modalities a provider declares it always counts", () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { audio_tokens: 30 } } });
    const usage = read(body, "application/json", "openai-chat", bytedance.countedInputModalities);
    expect(usage.modalityTokens).toEqual({ input: { audio: 30 } });
    const seed = listed("bytedance", "seed-2-0-lite-260428");
    expect(priceTokens(seed, usage)?.cost).toBe(cost([[30, seed.rates.audio_input], [70, seed.rates.input], [5, seed.rates.output]]));
    // Without the declaration, a usage that names no split is not taken to have one.
    expect(read(body, "application/json", "openai-chat").modalityTokens).toBeUndefined();
  });

  it("refuses a count that is not a whole number, in every shape", () => {
    const usage = (value: unknown, style: ApiStyle) => readBody(JSON.stringify(value), "application/json", style).usage;
    expect(usage({ usage: { prompt_tokens: 1.5, completion_tokens: 1 } }, "openai-chat")).toBeNull();
    expect(usage({ usage: { input_tokens: 2, output_tokens: 1.5 } }, "anthropic-messages")).toBeNull();
    expect(usage({ usageMetadata: { promptTokenCount: 2.5 } }, "gemini-generate")).toBeNull();
  });

  it("reports no usage for a body that carries none it can price", () => {
    const usage = (value: unknown) => readBody(JSON.stringify(value), "application/json", "openai-chat").usage;
    expect(usage({ usage: { billed_units: { input_tokens: 5 } } })).toBeNull();
    expect(usage({ choices: [] })).toBeNull();
    expect(readBody(sse([{ type: "message_stop" }]), "text/event-stream", "anthropic-messages").usage).toBeNull();
    // A reported zero is a measured zero, not an unreadable answer.
    expect(usage({ usage: { prompt_tokens: 0, completion_tokens: 0 } })).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
  });

  it("reads a large JSON answer's usage and served tier at its end", () => {
    const body = `{"id":"resp_1","object":"response","output":["${"padding".repeat(200_000)}"],"service_tier":"flex","usage":{"input_tokens":7,"output_tokens":3}}`;
    const usage = readBody(body, "application/json", "openai-responses").usage;
    expect(usage).toMatchObject({ inputTokens: 7, outputTokens: 3, reportedModes: { service_tier: "flex" } });
  });

  it("reads a long Anthropic stream's input tokens at its start and output tokens at its end", () => {
    const middle = Array.from({ length: 5_000 }, () => ({ type: "content_block_delta", delta: { text: "x".repeat(100) } }));
    const body = sse([
      { type: "message_start", message: { usage: { input_tokens: 500, output_tokens: 1 } } },
      ...middle,
      { type: "message_delta", usage: { output_tokens: 250 } },
      { type: "message_stop" },
    ]);
    expect(readBody(body, "text/event-stream", "anthropic-messages").usage).toMatchObject({ inputTokens: 500, outputTokens: 250 });
  });
});

describe("a Gemini prompt partly from the cache", () => {
  const price = (rates: Record<string, number>): ModelPrice => ({ rates: rates as ModelPrice["rates"], raw: {} });

  it("takes cached image tokens out of the uncached split, a deliberate change from v1", () => {
    const usage = read(
      JSON.stringify({
        usageMetadata: {
          promptTokenCount: 1000,
          cachedContentTokenCount: 900,
          candidatesTokenCount: 1,
          promptTokensDetails: [
            { modality: "TEXT", tokenCount: 100 },
            { modality: "IMAGE", tokenCount: 900 },
          ],
          cacheTokensDetails: [{ modality: "IMAGE", tokenCount: 900 }],
        },
      }),
      "application/json",
      "gemini-generate",
    );
    expect(usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 900, modalityTokens: { input: { image: 0 } } });
    const rates = price({ input: 1000, cached_input: 100, image_input: 5000, output: 2000 });
    // The 100 uncached tokens are text; the 900 cached ones bill at the cached rate.
    expect(priceTokens(rates, usage)?.cost).toBe(cost([[100, rate(1000)], [900, rate(100)], [1, rate(2000)]]));
  });

  it("bills cached audio at the cached audio rate", () => {
    const usage = read(
      JSON.stringify({
        usageMetadata: {
          promptTokenCount: 1000,
          cachedContentTokenCount: 600,
          candidatesTokenCount: 0,
          promptTokensDetails: [
            { modality: "TEXT", tokenCount: 200 },
            { modality: "AUDIO", tokenCount: 800 },
          ],
          cacheTokensDetails: [
            { modality: "TEXT", tokenCount: 100 },
            { modality: "AUDIO", tokenCount: 500 },
          ],
        },
      }),
      "application/json",
      "gemini-generate",
    );
    expect(usage.tokenVariants).toEqual({ cached_input: { audio: 500 } });
    const rates = price({ input: 1000, cached_input: 100, audio_input: 3000, cached_input_audio: 300, output: 2000 });
    // Uncached: 100 text and 300 audio. Cached: 100 text and 500 audio.
    expect(priceTokens(rates, usage)?.cost).toBe(
      cost([
        [300, rate(3000)],
        [100, rate(1000)],
        [500, rate(300)],
        [100, rate(100)],
      ]),
    );
  });
});

describe("the end of a stream", () => {
  const streamClosed = (text: string, style: ApiStyle) => readBody(text, "text/event-stream", style).closed;

  it("closes only on a whole closing frame", () => {
    // A cut payload is not a closing event, even if it names one.
    expect(streamClosed('data: {"type":"response.completed","response":{"usage":\n\n', "openai-responses")).toBe(false);
    // A closing event named only by its event line counts, when its data is whole.
    expect(streamClosed('event: response.completed\ndata: {"response":{}}\n\n', "openai-responses")).toBe(true);
    // A comment after the closing event changes nothing.
    expect(streamClosed("data: [DONE]\n\n: keep-alive\n\n", "openai-chat")).toBe(true);
    expect(streamClosed('event: message_stop\ndata: {"type":"message_stop"}\n\n', "anthropic-messages")).toBe(true);
    // A frame still arriving is not one.
    expect(streamClosed("data: [DONE]", "openai-chat")).toBe(false);
    // A comment that reads like [DONE] is never data.
    expect(streamClosed('data: {"x":1}\n\n: data: [DONE]\n\n', "openai-chat")).toBe(false);
    expect(streamClosed('data: {"x":"y"}\n\ndata: [DONE]\n\n', "openai-chat")).toBe(true);
    // Some services send [DONE] after a Responses or Messages stream's own closing event.
    expect(streamClosed('data: {"type":"response.completed","response":{}}\n\ndata: [DONE]\n\n', "openai-responses")).toBe(true);
    expect(streamClosed('data: {"type":"message_stop"}\n\ndata: [DONE]\n\n', "anthropic-messages")).toBe(true);
    expect(streamClosed("data: [DONE]\n\n", "anthropic-messages")).toBe(false);
    // Gemini's stream has no closing event.
    expect(streamClosed("data: {}\n\n", "gemini-generate")).toBeNull();
  });
});

describe("token variants", () => {
  it("bills Anthropic's one-hour cache write at its own rate, and the rest at the default write rate", () => {
    const usage = read(
      JSON.stringify({
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 60, ephemeral_5m_input_tokens: 40 }, output_tokens: 5 },
      }),
      "application/json",
      "anthropic-messages",
    );
    expect(usage.tokenVariants).toEqual({ cache_write: { "1h": 60 } });
    const sonnet = listed("anthropic", "claude-sonnet-5");
    const priced = priceTokens(sonnet, usage)!;
    expect(priced.cost).toBe(
      cost([
        [10, sonnet.rates.input],
        [60, sonnet.rates.cache_write_1h],
        [40, sonnet.rates.cache_write],
        [5, sonnet.rates.output],
      ]),
    );
    expect(priced.rates.cache_write_1h).toBe(sonnet.rates.cache_write_1h);
  });

  it("bills OpenAI's 12-hour cache write at its own rate", () => {
    const usage = read(
      JSON.stringify({
        usage: { input_tokens: 100, input_tokens_details: { cache_write_tokens: 50, cache_write_tokens_details: { ttl_12h_tokens: 20 } }, output_tokens: 1 },
      }),
      "application/json",
      "openai-responses",
    );
    const astra = listed("openai", "gpt-6.2-astra-law");
    expect(priceTokens(astra, usage)?.cost).toBe(
      cost([
        [50, astra.rates.input],
        [20, astra.rates.cache_write_12h],
        [30, astra.rates.cache_write],
        [1, astra.rates.output],
      ]),
    );
  });

  it("reads Kimi's one-hour share from a header of an answer that does not stream, and never from a stream's", () => {
    const usage = read(
      JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 50 } } }),
      "application/json",
      "openai-chat",
    );
    const headers = new Headers({ "msh-usage-cache-write-tokens-1h": "30" });
    const kimi = BUILT_IN_PROVIDERS.moonshot!.operations.find((operation) => operation.name === "moonshot.chat")!.meter;
    const reported = kimi.kind === "response_json" ? (kimi.usageHeaders ?? []) : [];
    expect(withHeaderVariants(usage, headers, "application/json", reported).tokenVariants).toEqual({ cache_write: { "1h": 30 } });
    expect(withHeaderVariants(usage, headers, "text/event-stream", reported).tokenVariants).toBeUndefined();
    // An operation that names no such header reads none.
    expect(withHeaderVariants(usage, headers, "application/json", []).tokenVariants).toBeUndefined();
  });

  it("keeps modalities and variants in a charge's measures, so it can be priced again exactly", () => {
    const usage: UsageObservation = {
      inputTokens: 70,
      cachedInputTokens: 30,
      cacheWriteTokens: 0,
      outputTokens: 5,
      modalityTokens: { input: { audio: 40 } },
      tokenVariants: { cached_input: { audio: 10 } },
    };
    const measures = usageMeasures(usage, { tier: "flex", region: "global" });
    expect(measures.service_mode).toBe("flex");
    expect(usageFromMeasures(measures)).toEqual({ usage, mode: { tier: "flex", region: "global" }, doubt: false });
    expect(usageFromMeasures(usageMeasures(usage, STANDARD_MODE, ["service_mode"]))).toMatchObject({ doubt: true });
    // Every estimate reason is kept apart from the mode's own marker, and read back as an estimate.
    const served = usageMeasures(usage, STANDARD_MODE, ["served_model", "measure_worked_out"]);
    expect(served).toMatchObject({ estimate_reasons: "served_model,measure_worked_out" });
    expect(served.service_mode_unknown).toBeUndefined();
    expect(usageFromMeasures(served)).toMatchObject({ doubt: true });
    // A row from before the reasons were kept still reads its mode's marker.
    expect(usageFromMeasures({ ...measures, service_mode_unknown: 1 })).toMatchObject({ doubt: true });
    const seed = listed("bytedance", "seed-2-0-lite-260428");
    expect(priceTokens(seed, usageFromMeasures(measures)!.usage)?.cost).toBe(priceTokens(seed, usage)?.cost);
  });
});

describe("provider cost reports", () => {
  const readProviderCost = (events: string, providerCost: NonNullable<BodyReaderOptions["providerCost"]>) =>
    readBody(events, "text/event-stream", "openai-chat", { providerCost }).providerCostUsd;
  const values = (...events: unknown[]) => sse(events);

  it("reads OpenRouter's cost from a stream's last chunk, adding the upstream's charge on a BYOK request", () => {
    expect(readProviderCost(values({ choices: [] }, { choices: [], usage: { cost: 0.0012 } }), "openrouter")).toBe(0.0012);
    expect(readProviderCost(values({ usage: { cost: 0.05, cost_details: { upstream_inference_cost: 1 } } }), "openrouter")).toBe(1.05);
    // A zero is a real report: free models exist. A negative one is not a charge.
    expect(readProviderCost(values({ usage: { cost: 0 } }), "openrouter")).toBe(0);
    expect(readProviderCost(values({ usage: { cost: -1 } }), "openrouter")).toBeNull();
    expect(readProviderCost(values({ usage: { prompt_tokens: 1 } }), "openrouter")).toBeNull();
  });

  it("reads xAI's ticks at the root and under a closing Responses event", () => {
    expect(readProviderCost(values({ usage: { cost_in_usd_ticks: 25_000_000 } }), "xai")).toBe(0.0025);
    expect(readProviderCost(values({ type: "response.completed", response: { usage: { cost_in_usd_ticks: 10_000_000_000 } } }), "xai")).toBe(1);
    expect(readProviderCost(values({ usage: { cost_in_usd_ticks: -5 } }), "xai")).toBeNull();
  });
});

describe("service modes", () => {
  const usage: UsageObservation = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };

  it("reads the mode a request asks for with the provider's own table, and the region its base URL serves", () => {
    expect(requestedServiceMode(openai, undefined, null, { service_tier: "priority" })).toEqual({ mode: { tier: "fast", region: "global" } });
    expect(requestedServiceMode(anthropic, undefined, null, { speed: "fast", inference_geo: "us" })).toEqual({ mode: { tier: "fast", region: "us" } });
    // A request that asked for no region: real answers report "not_available" (T27).
    expect(servedServiceMode(anthropic, undefined, STANDARD_MODE, { reportedModes: { speed: "standard", service_tier: "standard", inference_geo: "not_available" } } as never, new Headers())).toEqual({ mode: STANDARD_MODE });
    // A request that asked for the US: the answer does not say where it was served, so the US rate stands, flagged.
    const us = { tier: "standard", region: "us" } as const;
    expect(servedServiceMode(anthropic, undefined, us, { reportedModes: { speed: "standard", inference_geo: "not_available" } } as never, new Headers())).toEqual({
      mode: us,
      unknown: { field: "inference_geo", value: "not_available" },
    });
    expect(requestedServiceMode(gemini, undefined, null, { serviceTier: "flex" })).toEqual({ mode: { tier: "flex", region: "global" } });
    expect(requestedServiceMode(mistral, undefined, "https://api.eu.mistral.ai/", {})).toEqual({ mode: { tier: "standard", region: "eu" } });
    // A value the table does not know leaves the tier at standard, and is reported.
    expect(requestedServiceMode(openai, undefined, null, { service_tier: "turbo" })).toEqual({
      mode: STANDARD_MODE,
      unknown: { field: "service_tier", value: "turbo" },
    });
  });

  it("never bills an estimate below standard, whatever the reason for it (one rule, in pricing)", () => {
    const price = listPrice("gemini", "gemini-4-neon")!;
    const tokens = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 };
    const flex = { tier: "flex", region: "global" } as const;
    const sure = priceInServedMode(price, tokens, flex)!;
    const standard = priceInServedMode(price, tokens, STANDARD_MODE)!;
    expect(sure.cost).toBeLessThan(standard.cost);
    // Any doubt (a tier it does not know, a served model it cannot tell) bills at standard at least, as an estimate.
    expect(priceInServedMode(price, tokens, flex, true)).toMatchObject({ cost: standard.cost, estimated: true });
    const priority = priceInServedMode(price, tokens, { tier: "priority", region: "global" }, true)!;
    expect(priority.cost).toBeGreaterThan(standard.cost);
    expect(priority.estimated).toBe(true);
  });

  it("floors an estimate from any path: a tier priced but a region not (3c S4)", () => {
    const price = listPrice("openai", "gpt-6-sol")!;
    const tokens = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 };
    const standard = priceInServedMode(price, tokens, STANDARD_MODE)!;
    // Flex is priced, the EU region is not: an estimate, never below standard.
    expect(priceInServedMode(price, tokens, { tier: "flex", region: "eu" })).toMatchObject({ estimated: true });
    expect(priceInServedMode(price, tokens, { tier: "flex", region: "eu" })!.cost).toBeGreaterThanOrEqual(standard.cost);
  });

  it("reads a large answer's root fields raw: a numeric tier is present but unknown (3c S10)", () => {
    const body = `{"model":"gpt-5.6-luna","service_tier":99,"choices":[{"message":{"content":"${"a".repeat(2_000_000)}"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`;
    const usage = readBody(body, "application/json", "openai-chat").usage!;
    const flex = { tier: "flex", region: "global" } as const;
    expect(servedServiceMode(openai, undefined, flex, usage, new Headers()).unknown).toBeDefined();
  });

  it("believes the mode the response says served the request", () => {
    const fast = { tier: "fast", region: "global" } as const;
    // OpenAI sheds fast traffic to `default`, and bills it as standard.
    expect(servedServiceMode(openai, undefined, fast, { ...usage, reportedModes: { service_tier: "default" } }, new Headers()).mode).toEqual(STANDARD_MODE);
    // Sources that disagree, or one the table does not know, are flagged; pricing gives them the standard floor.
    const flex = { tier: "flex", region: "global" } as const;
    const unknownHeader = servedServiceMode(gemini, undefined, flex, { ...usage, reportedModes: { serviceTier: "flex" } }, new Headers({ "x-gemini-service-tier": "turbo" }));
    expect(unknownHeader.mode).toEqual(flex);
    expect(unknownHeader.unknown).toBeDefined();
    // A tier value that is not a usable string counts as one the table does not know.
    const numeric = read(JSON.stringify({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, serviceTier: 99 } }), "application/json", "gemini-generate");
    const odd = servedServiceMode(gemini, undefined, flex, numeric, new Headers({ "x-gemini-service-tier": "flex" }));
    expect(odd.mode).toEqual(flex);
    expect(odd.unknown).toBeDefined();
    const disagree = servedServiceMode(gemini, undefined, flex, { ...usage, reportedModes: { serviceTier: "flex" } }, new Headers({ "x-gemini-service-tier": "priority" }));
    expect(disagree.mode.tier).toBe("priority");
    expect(disagree.unknown).toBeDefined();
    // Anthropic's `speed` and `service_tier` answer different questions, so they never disagree.
    const both = servedServiceMode(anthropic, undefined, fast, { ...usage, reportedModes: { speed: "fast", service_tier: "standard" } }, new Headers());
    expect(both).toEqual({ mode: fast });
    // Gemini says it in a header too.
    const priority = { tier: "priority", region: "global" } as const;
    expect(servedServiceMode(gemini, undefined, priority, usage, new Headers({ "x-gemini-service-tier": "standard" })).mode).toEqual(STANDARD_MODE);
  });

  it("prices a mode the model lists, by its factor", () => {
    const luna = listed("openai", "gpt-5.6-luna");
    const flex = priceInServedMode(luna, usage, { tier: "flex", region: "global" })!;
    expect(flex.estimated).toBe(false);
    expect(flex.cost).toBe(priceTokens(priceInMode(luna, { tier: "flex", region: "global" })!, usage)!.cost);
    expect(flex.cost).toBeLessThan(priceTokens(luna, usage)!.cost);
  });

  it("estimates a mode the model has no price in: a cheaper tier at standard, a dearer one at the dearest priced tier", () => {
    const sonnet = listed("anthropic", "claude-sonnet-5");
    const standard = priceTokens(sonnet, usage)!.cost;
    expect(priceInServedMode(sonnet, usage, { tier: "flex", region: "global" })).toMatchObject({ cost: standard, estimated: true });
    const luna = listed("openai", "gpt-5.6-luna");
    const fast = priceTokens(priceInMode(luna, { tier: "fast", region: "global" })!, usage)!.cost;
    expect(priceInServedMode(luna, usage, { tier: "ultrafast", region: "global" })).toMatchObject({ cost: fast, estimated: true });
    // A tier in a region composes from the two factors: never below standard.
    const mythos = listed("anthropic", "claude-mythos-5-2");
    const both = priceInServedMode(mythos, usage, { tier: "fast", region: "us" })!;
    expect(both.estimated).toBe(false);
    expect(both.cost).toBeGreaterThan(priceTokens(priceInMode(mythos, { tier: "fast", region: "global" })!, usage)!.cost);
  });

  it("applies the list's mode factors to a customer's own rates", () => {
    const luna = listed("openai", "gpt-5.6-luna");
    const own = customerPrice({ "gpt-5.6-luna": { input: 1_000_000_000, output: 2_000_000_000 } }, "gpt-5.6-luna", luna)!;
    const flex = priceInMode(own, { tier: "flex", region: "global" })!;
    expect(flex.rates.input).toBe(rate(500_000_000));
    expect(resolvePrice("openai", "gpt-5.6-luna", { "gpt-5.6-luna": { input: 1, output: 1 } })?.source).toBe("customer_rate");
  });
});
