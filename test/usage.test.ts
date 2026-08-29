import { describe, expect, it } from "vitest";
import { computeCost, extractUsageText } from "../src/core/usage";
import type { ProviderType } from "../src/core/types";

/** Extraction that a shape is expected to recognise; `null` fails the test here. */
function extracted(text: string, contentType: string, provider: ProviderType) {
  const usage = extractUsageText(text, contentType, provider);
  expect(usage).not.toBeNull();
  return usage!;
}

describe("usage extraction", () => {
  it("normalizes OpenAI cached and cache-write tokens as subsets of input", () => {
    const usage = extracted(
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
            output_tokens: 20,
          },
        },
      })}\n\n`,
      "text/event-stream",
      "openai",
    );
    expect(usage).toEqual({
      inputTokens: 50,
      cachedInputTokens: 40,
      cacheWriteTokens: 10,
      outputTokens: 20,
    });
    expect(computeCost("openai", "gpt-5.6-luna", usage)).toBeCloseTo(0.0000373, 8);
  });

  it("normalizes Anthropic cache fields as separate token buckets across stream events", () => {
    const usage = extracted(
      [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 60,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 10,
              output_tokens: 0,
            },
          },
        })}`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 20 },
        })}`,
      ].join("\n\n") + "\n\n",
      "text/event-stream",
      "anthropic",
    );
    expect(usage).toEqual({
      inputTokens: 60,
      cachedInputTokens: 30,
      cacheWriteTokens: 10,
      outputTokens: 20,
    });
    expect(computeCost("anthropic", "claude-sonnet-5", usage)).toBeCloseTo(0.000351, 8);
  });

  it("normalizes Gemini cached prompt tokens as a subset", () => {
    expect(
      extracted(
        JSON.stringify([
          { candidates: [{ content: {} }] },
          {
            usageMetadata: {
              promptTokenCount: 90,
              cachedContentTokenCount: 25,
              candidatesTokenCount: 15,
            },
          },
        ]),
        "application/json",
        "gemini",
      ),
    ).toEqual({
      inputTokens: 65,
      cachedInputTokens: 25,
      cacheWriteTokens: 0,
      outputTokens: 15,
    });
  });

  it("extracts OpenAI-style usage from a streamed Gemini compatibility response", () => {
    const usage = extracted(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}`,
        `data: ${JSON.stringify({
          usage: {
            prompt_tokens: 120,
            prompt_tokens_details: { cached_tokens: 30 },
            completion_tokens: 12,
          },
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
      "text/event-stream",
      "gemini",
    );
    expect(usage).toEqual({
      inputTokens: 90,
      cachedInputTokens: 30,
      cacheWriteTokens: 0,
      outputTokens: 12,
    });
  });

  it("returns null cost for an unknown model without failing usage extraction", () => {
    const usage = extracted(
      JSON.stringify({ usage: { input_tokens: 2, output_tokens: 3 } }),
      "application/json",
      "xai",
    );
    expect(usage.inputTokens).toBe(2);
    expect(computeCost("xai", "unknown-model", usage)).toBeNull();
  });

  it("prices xAI speech-to-text from the response duration", () => {
    const usage = extracted(
      JSON.stringify({ text: "hello", duration: 90 }),
      "application/json",
      "xai",
    );
    expect(computeCost("xai", "grok-transcribe", usage)).toBeCloseTo(0.0025, 8);
  });

  it("uses provider-specific and long-context rates", () => {
    const usage = {
      inputTokens: 200_001,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
    };
    expect(computeCost("xai", "grok-4.5", usage)).toBeCloseTo(0.801204, 8);
    expect(computeCost("openai", "grok-4.5", usage)).toBeNull();
  });

  it("reports malformed data to the caller so background bookkeeping can contain it", () => {
    expect(() => extractUsageText("not-json", "application/json", "openai")).toThrow();
  });
});

/**
 * One representative response per shape the pipeline claims to support. Every
 * new provider inherits these shapes, so a regression that quietly stops reading
 * one of them is a silent spend-limit bypass rather than a visible failure.
 */
const RECOGNISED_SHAPES: {
  name: string;
  provider: ProviderType;
  contentType: string;
  body: string;
  expected: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number };
  audioSeconds?: number;
}[] = [
  {
    name: "OpenAI Responses JSON",
    provider: "openai",
    contentType: "application/json",
    body: JSON.stringify({
      id: "resp_1",
      usage: { input_tokens: 30, output_tokens: 7 },
    }),
    expected: { inputTokens: 30, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 7 },
  },
  {
    name: "OpenAI Chat Completions JSON",
    provider: "openai",
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 41, completion_tokens: 9 },
    }),
    expected: { inputTokens: 41, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 9 },
  },
  {
    name: "OpenAI Responses SSE",
    provider: "openai",
    contentType: "text/event-stream",
    body: `event: response.completed\ndata: ${JSON.stringify({
      response: { usage: { input_tokens: 12, output_tokens: 4 } },
    })}\n\n`,
    expected: { inputTokens: 12, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 4 },
  },
  {
    name: "Anthropic Messages JSON",
    provider: "anthropic",
    contentType: "application/json",
    body: JSON.stringify({
      type: "message",
      usage: {
        input_tokens: 55,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 3,
        output_tokens: 17,
      },
    }),
    expected: { inputTokens: 55, cachedInputTokens: 11, cacheWriteTokens: 3, outputTokens: 17 },
  },
  {
    name: "Anthropic SSE across merged events",
    provider: "anthropic",
    contentType: "text/event-stream",
    body:
      [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 21, output_tokens: 1 } },
        })}`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 33 },
        })}`,
      ].join("\n\n") + "\n\n",
    expected: { inputTokens: 21, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 33 },
  },
  {
    name: "Gemini native JSON",
    provider: "gemini",
    contentType: "application/json",
    body: JSON.stringify({
      candidates: [{ content: {} }],
      usageMetadata: { promptTokenCount: 64, candidatesTokenCount: 8 },
    }),
    expected: { inputTokens: 64, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 8 },
  },
  {
    name: "Gemini native SSE",
    provider: "gemini",
    contentType: "text/event-stream",
    body:
      [
        `data: ${JSON.stringify({ candidates: [{ content: {} }] })}`,
        `data: ${JSON.stringify({
          usageMetadata: { promptTokenCount: 70, cachedContentTokenCount: 20, candidatesTokenCount: 5 },
        })}`,
        "",
      ].join("\n\n"),
    expected: { inputTokens: 50, cachedInputTokens: 20, cacheWriteTokens: 0, outputTokens: 5 },
  },
  {
    name: "audio transcription duration",
    provider: "openai",
    contentType: "application/json",
    body: JSON.stringify({ text: "hello", duration: 42 }),
    expected: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    audioSeconds: 42,
  },
];

describe("recognised usage shapes", () => {
  for (const shape of RECOGNISED_SHAPES) {
    it(`reads billable usage from ${shape.name}`, () => {
      const usage = extracted(shape.body, shape.contentType, shape.provider);
      expect(usage).toEqual(
        shape.audioSeconds === undefined
          ? shape.expected
          : { ...shape.expected, audioSeconds: shape.audioSeconds },
      );
      // Nothing here may meter as free: every fixture reports either tokens or
      // a duration, and both are priced.
      const metered = shape.audioSeconds ?? usage.inputTokens + usage.cachedInputTokens
        + usage.cacheWriteTokens + usage.outputTokens;
      expect(metered).toBeGreaterThan(0);
    });
  }
});

describe("unrecognised usage shapes", () => {
  it("reports no usage for a Cohere-style billed_units object", () => {
    // The worked example from the provider-expansion review: proxying works,
    // `usage.billed_units` is invisible here, and the request would bill $0.
    expect(
      extractUsageText(
        JSON.stringify({
          text: "hello",
          usage: { billed_units: { input_tokens: 120, output_tokens: 30 } },
        }),
        "application/json",
        "openai",
      ),
    ).toBeNull();
  });

  it("reports no usage for a successful response that carries none", () => {
    expect(
      extractUsageText(
        JSON.stringify({ id: "resp_1", output: [{ type: "message" }] }),
        "application/json",
        "openai",
      ),
    ).toBeNull();
  });

  it("reports no usage for a stream that never emitted a usage event", () => {
    expect(
      extractUsageText(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`,
        "text/event-stream",
        "openai",
      ),
    ).toBeNull();
  });

  it("reports no usage for Anthropic events that never carried a usage object", () => {
    expect(
      extractUsageText(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: {} })}\n\n`,
        "text/event-stream",
        "anthropic",
      ),
    ).toBeNull();
  });

  it("separates a reported zero from an unreadable response", () => {
    // A genuinely free call reports zeros, and that stays a measurement.
    expect(
      extractUsageText(
        JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }),
        "application/json",
        "openai",
      ),
    ).toEqual({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  });
});
