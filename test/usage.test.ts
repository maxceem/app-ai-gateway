import { describe, expect, it } from "vitest";
import { computeCost, extractUsageText } from "../src/core/usage";

describe("usage extraction", () => {
  it("normalizes OpenAI cached and cache-write tokens as subsets of input", () => {
    const usage = extractUsageText(
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
    const usage = extractUsageText(
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
      extractUsageText(
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
    const usage = extractUsageText(
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
    const usage = extractUsageText(
      JSON.stringify({ usage: { input_tokens: 2, output_tokens: 3 } }),
      "application/json",
      "xai",
    );
    expect(usage.inputTokens).toBe(2);
    expect(computeCost("xai", "unknown-model", usage)).toBeNull();
  });

  it("prices xAI speech-to-text from the response duration", () => {
    const usage = extractUsageText(
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
