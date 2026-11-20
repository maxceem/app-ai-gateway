/**
 * Reading usage as a response streams past (`src/usage/frames.ts`,
 * `src/usage/skim.ts`, `bodyReader` in `src/usage/readers.ts`).
 *
 * Every bug the earlier kept-window reading had (steps 3a and 3c) is a
 * fixture here, and each is read with the body split at every point, or at
 * many points for a large one: the reading must never depend on where the
 * pieces fell.
 */
import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import type { ApiStyle } from "../src/providers/operation.ts";
import { responseReader } from "../src/proxy/meter.ts";
import { observeBody } from "../src/proxy/observe.ts";
import { bodyReader, readBody, type BodyReaderOptions, type BodyReading } from "../src/usage/readers.ts";

const SSE = "text/event-stream";
const JSON_BODY = "application/json";

function sse(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** Split points: every point of a short text; for a long one, 150 spread evenly plus every point of its last 300 characters. */
function splitPoints(text: string): number[] {
  if (text.length <= 600) return Array.from({ length: text.length - 1 }, (_, index) => index + 1);
  const points = new Set<number>();
  for (let step = 1; step < 150; step += 1) points.add(Math.floor((text.length * step) / 150));
  for (let at = Math.max(1, text.length - 300); at < text.length; at += 1) points.add(at);
  for (let at = 1; at < 300; at += 1) points.add(at);
  return [...points];
}

/** The reading of `text`, checked to be the same wherever it is split, in two pieces and in many. */
function read(text: string, contentType: string, style: ApiStyle, options: BodyReaderOptions = {}): BodyReading {
  const whole = readBody(text, contentType, style, options);
  const want = JSON.stringify(whole);
  for (const at of splitPoints(text)) {
    const reader = bodyReader(contentType, style, options);
    reader.push(text.slice(0, at));
    reader.push(text.slice(at));
    const got = reader.end();
    if (JSON.stringify(got) !== want) expect({ at, got }).toEqual({ at, got: whole });
  }
  if (text.length <= 600) {
    const reader = bodyReader(contentType, style, options);
    for (const character of text) reader.push(character);
    expect(reader.end()).toEqual(whole);
  }
  return whole;
}

describe("a body is read whole, whatever its size and wherever it was split", () => {
  it("never takes a usage nested in the content for the answer's own (3c S10)", () => {
    const text = "a".repeat(2_000);
    const nested = `{"text":"${text}","nested":{"usage":{"prompt_tokens":9,"completion_tokens":9}}`;
    expect(read(nested, JSON_BODY, "openai-chat").usage).toBeNull();
    expect(read(`${nested}}`, JSON_BODY, "openai-chat").usage).toBeNull();
    const rooted = `{"text":"${text}","usage":{"prompt_tokens":10,"completion_tokens":2}}`;
    expect(read(rooted, JSON_BODY, "openai-chat").usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });

  it("reads only an event's data lines, never a comment, whatever it holds (3c S13)", () => {
    const body =
      'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":7,"completion_tokens":3},\n: comment","usage":{"prompt_tokens":999,"completion_tokens":999},\ndata: "model":"m"}\n\ndata: [DONE]\n\n';
    const reading = read(body, SSE, "openai-chat");
    expect(reading.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(reading.closed).toBe(true);
  });

  it("reads a cut event's values that were whole, and nothing that was not", () => {
    const started = 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1},"text":"ab';
    expect(read(started, SSE, "openai-chat").usage).toMatchObject({ inputTokens: 3, outputTokens: 1 });
    const unended = 'data: {"text":"x","nested":{"usage":{"prompt_tokens":9,"completion_tokens":9}}';
    expect(read(unended, SSE, "openai-chat").usage).toBeNull();
  });

  it("counts a number only once it is whole, wherever the body was split (3c S11)", () => {
    const body = `{"duration":42e2,"text":"${"a".repeat(1_000)}"}`;
    expect(read(body, JSON_BODY, "openai-transcription").usage).toMatchObject({ audioSeconds: 4200 });
  });

  it("keeps a tier that is present but not a usable string, as an unknown one (3c S12)", () => {
    const body = JSON.stringify({ service_tier: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(read(body, JSON_BODY, "openai-chat").usage?.reportedModes).toEqual({ service_tier: "(other)" });
  });

  it("is never fooled by an escaped quote inside a key (3c F2)", () => {
    const body = '{"a\\"usage\\":{\\"prompt_tokens\\":1},\\"b":{"duration":{}},"x":1}';
    expect(read(body, JSON_BODY, "openai-transcription").usage).toBeNull();
  });

  it("reads a large image stream's final event (3c F1)", () => {
    const body = sse([
      { type: "image_generation.partial_image", b64_json: "AA" },
      { type: "image_generation.completed", b64_json: "QUJD".repeat(500_000), usage: { input_tokens: 50, output_tokens: 4160, total_tokens: 4210 } },
    ]);
    const usage = read(body, SSE, "openai-images").usage;
    expect(usage).toMatchObject({ outputTokens: 4160 });
    expect(usage?.finalEventUnread).toBeUndefined();
  });

  it("reads Responses' usage under `response`, after a large output (3c F1)", () => {
    const body = sse([
      { type: "response.created", response: { id: "r", usage: null } },
      {
        type: "response.completed",
        response: { id: "r", output: [{ type: "image_generation_call", result: "QUJD".repeat(500_000) }], usage: { input_tokens: 12, output_tokens: 7 } },
        sequence_number: 9,
      },
    ]);
    const reading = read(body, SSE, "openai-responses");
    expect(reading.usage).toMatchObject({ inputTokens: 12, outputTokens: 7 });
    expect(reading.closed).toBe(true);
  });

  it("reads Gemini's last chunk, and never books an earlier chunk's usage as exact when the last one was cut (3c F1)", () => {
    const earlier = sse([{ candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 } }]);
    const last = sse([
      { candidates: [{ content: { parts: [{ inlineData: { data: "QUJD".repeat(500_000) } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290 } },
    ]);
    expect(read(earlier + last, SSE, "gemini-generate").usage).toMatchObject({ outputTokens: 1290 });
    const lost = read(earlier + last.slice(0, 1_000_000), SSE, "gemini-generate").usage;
    expect(lost).toMatchObject({ outputTokens: 1, finalEventUnread: true });
  });

  it("reads a streamed transcription's large final event", () => {
    const body = sse([
      { type: "transcript.text.delta", delta: "x" },
      { type: "transcript.text.done", text: "a".repeat(2_000_000), usage: { type: "tokens", input_tokens: 40, output_tokens: 10, total_tokens: 50 } },
    ]);
    expect(read(body, SSE, "openai-transcription").usage).toMatchObject({ inputTokens: 40, outputTokens: 10 });
  });

  it("reads a large image answer whose usage comes first (3a A1), never a usage echoed in its content", () => {
    const body = `{"usage":{"input_tokens":50,"output_tokens":4160},"data":[{"b64_json":"${"QUJD".repeat(500_000)}","revised":{"usage":{"input_tokens":1,"output_tokens":1}}}]}`;
    expect(read(body, JSON_BODY, "openai-images").usage).toMatchObject({ inputTokens: 50, outputTokens: 4160 });
  });

  it("reads Gemini's root usage, never one inside a function call's arguments (3a A1)", () => {
    const body = JSON.stringify({
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 },
      candidates: [{ content: { parts: [{ text: "a".repeat(2_000_000) }, { functionCall: { name: "f", args: { usage: {} } } }] } }],
    });
    expect(read(body, JSON_BODY, "gemini-generate").usage).toMatchObject({ inputTokens: 120, outputTokens: 40 });
  });

  it("closes a stream only on a whole closing frame (3a S2, S3)", () => {
    expect(read('data: {"type":"response.completed","response":{"usage":\n\n', SSE, "openai-responses").closed).toBe(false);
    expect(read('event: response.completed\ndata: {"response":{}}\n\n', SSE, "openai-responses").closed).toBe(true);
    expect(read("data: [DONE]\n\n: keep-alive\n\n", SSE, "openai-chat").closed).toBe(true);
    expect(read("data: [DONE]", SSE, "openai-chat").closed).toBe(false);
    expect(read('data: {"x":1}\n\n: data: [DONE]\n\n', SSE, "openai-chat").closed).toBe(false);
    expect(read('data: {"type":"message_stop"}\r\n\r\ndata: [DONE]\r\n\r\n', SSE, "anthropic-messages").closed).toBe(true);
  });

  it("reads lines that end with a carriage return and a line feed, split anywhere", () => {
    const body = 'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const reading = read(body, SSE, "openai-chat");
    expect(reading.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    expect(reading.closed).toBe(true);
  });

  it("reads a Gemini answer sent as a JSON array of chunks", () => {
    const body = JSON.stringify([
      { candidates: [], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } },
      { candidates: [], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 } },
    ]);
    expect(read(body, JSON_BODY, "gemini-generate").usage).toMatchObject({ inputTokens: 5, outputTokens: 9 });
  });

  it("reads OpenRouter's cost from a stream's last chunk", () => {
    const body = sse([{ choices: [] }, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0012 } }]);
    expect(read(body, SSE, "openai-chat", { providerCost: "openrouter" }).providerCostUsd).toBe(0.0012);
  });
});

describe("how an answer ended is judged once, for the whole reading (Sol round 1)", () => {
  const usage = { prompt_tokens: 4, completion_tokens: 2 };

  it("ends a line at a carriage return, a line feed, or both, even split across pieces (S1)", () => {
    for (const ending of ["\r", "\n", "\r\n"]) {
      const body = `data: ${JSON.stringify({ usage })}${ending}${ending}data: [DONE]${ending}${ending}`;
      const reading = read(body, SSE, "openai-chat");
      expect(reading.usage, JSON.stringify(ending)).toMatchObject({ inputTokens: 4, outputTokens: 2 });
      expect(reading.usage?.finalEventUnread).toBeUndefined();
      expect(reading.closed).toBe(true);
    }
  });

  it("counts every event against the limit, scalar ones and a last one cut at the end included (S2)", () => {
    const scalars = `data: 1\n\ndata: "x"\n\ndata: ${JSON.stringify({ usage })}\n\n`;
    expect(readBody(scalars, SSE, "openai-chat", { maxEvents: 2 }).stopped).toBe(true);
    expect(readBody(scalars, SSE, "openai-chat", { maxEvents: 3 }).stopped).toBe(false);
    const cutLast = `data: 1\n\ndata: 2\n\ndata: ${JSON.stringify({ usage })}`;
    expect(readBody(cutLast, SSE, "openai-chat", { maxEvents: 2 }).stopped).toBe(true);
    const chunks = JSON.stringify([{ usageMetadata: { promptTokenCount: 1 } }, { usageMetadata: { promptTokenCount: 2 } }, { usageMetadata: { promptTokenCount: 3 } }]);
    expect(readBody(chunks, JSON_BODY, "gemini-generate", { maxEvents: 2 }).stopped).toBe(true);
  });

  it("bills a count read from an answer that did not end whole as an estimate, for every style (S3)", () => {
    const chunks = [
      { candidates: [], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } },
      { candidates: [], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 } },
    ];
    // A Gemini array stream that ended mid-array: the earlier chunk's count is not exact.
    const array = JSON.stringify(chunks);
    expect(read(array.slice(0, array.length - 1), JSON_BODY, "gemini-generate").usage).toMatchObject({ outputTokens: 9, finalEventUnread: true });
    expect(read(array.slice(0, array.indexOf("},{") + 1), JSON_BODY, "gemini-generate").usage).toMatchObject({ outputTokens: 1, finalEventUnread: true });
    expect(read(array, JSON_BODY, "gemini-generate").usage?.finalEventUnread).toBeUndefined();
    // A stream with no closing event is whole only when it was read to its real end.
    const reader = bodyReader(SSE, "gemini-generate");
    reader.push(sse(chunks.slice(0, 1)));
    expect(reader.end(false).usage).toMatchObject({ outputTokens: 1, finalEventUnread: true });
    // A stream with a closing event is whole once it came, and not before.
    expect(read(sse([{ usage }]), SSE, "openai-chat").usage).toMatchObject({ finalEventUnread: true });
  });

  it("never books an earlier count as exact when a later usage was too large to keep (S4)", () => {
    const huge = { ...usage, completion_tokens: 7, padding: "a".repeat(70_000) };
    const body = sse([{ usage }, { usage: huge }]) + "data: [DONE]\n\n";
    const reading = readBody(body, SSE, "openai-chat");
    expect(reading.overflow).toBe(true);
    expect(reading.usage).toMatchObject({ outputTokens: 2, finalEventUnread: true });
  });

  it("closes a stream only on a closing event whose data is valid JSON, named by its type or its event (S6)", () => {
    expect(read('event: message_stop\ndata: {"type":"message_stop","x":tru}\n\n', SSE, "anthropic-messages").closed).toBe(false);
    expect(read('event: message_stop\ndata: {"x":[1,}\n\n', SSE, "anthropic-messages").closed).toBe(false);
    expect(read('event: message_stop\ndata: {"x":[1]}\n\n', SSE, "anthropic-messages").closed).toBe(true);
  });

  it("keeps a carriage return pending across an empty piece (round 2, S1)", () => {
    const reader = bodyReader(SSE, "openai-chat");
    for (const piece of ['data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\r', "", '\ndata: {"model":"m"}\r\n\r\ndata: [DONE]\r\n\r\n']) reader.push(piece);
    // One event with two data lines, which together are not JSON: never two events.
    expect(reader.end()).toEqual(readBody('data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\r\ndata: {"model":"m"}\r\n\r\ndata: [DONE]\r\n\r\n', SSE, "openai-chat"));
  });

  it("counts a JSON array's scalar elements before reading anything (round 2, S2)", () => {
    const reading = readBody('[1,2,{"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":1}}]', JSON_BODY, "gemini-generate", { maxEvents: 1 });
    expect(reading.stopped).toBe(true);
    expect(reading.usage).toBeNull();
  });

  it("never lets [DONE] clear a cut earlier event (round 2, S3)", () => {
    const body = 'data: {"usage":{"prompt_tokens":4,"completion_tokens":2},"text":"nev\n\ndata: [DONE]\n\n';
    expect(readBody(body, SSE, "openai-chat").usage).toMatchObject({ outputTokens: 2, finalEventUnread: true });
  });

  it("never closes on a large closing event whose brackets do not match (round 2, S6)", () => {
    const body = `event: message_stop\ndata: {"type":"message_stop","pad":"${"a".repeat(70_000)}","x":[1}}\n\n`;
    expect(readBody(body, SSE, "anthropic-messages").closed).toBe(false);
  });

  it("reads `[DONE]` with space before it, as before (S8)", () => {
    expect(read(`data: ${JSON.stringify({ usage })}\n\ndata:   [DONE]\n\n`, SSE, "openai-chat").closed).toBe(true);
  });
});

describe("the response reader", () => {
  const openai = BUILT_IN_PROVIDERS.openai!;
  const chat = openai.operations.find((operation) => operation.name === "openai.chat")!;

  it("decodes a body split inside its UTF-8 characters", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: "ünïcødé ✓ 🧪", model: "gpt-✓", usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    for (let at = 1; at < bytes.length; at += 1) {
      const reader = responseReader(JSON_BODY, openai, chat, {})!;
      reader.push(bytes.slice(0, at));
      reader.push(bytes.slice(at));
      expect(reader.finish(new Headers(), true).usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    }
  });

  it("stops reading past its budget: the call is unresolved and logged, never failed", () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reader = responseReader(JSON_BODY, openai, chat, { app: "app_budget" }, { bytes: 16, documents: 10 })!;
    reader.push(new TextEncoder().encode('{"usage":{"prompt_tokens":3,"completion_tokens":2}}'));
    expect(reader.finish(new Headers(), true).usage).toBeNull();
    const events = responseReader(SSE, openai, chat, { app: "app_budget" }, { bytes: 1024 * 1024, documents: 2 })!;
    events.push(new TextEncoder().encode(sse([{ choices: [] }, { choices: [] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }])));
    expect(events.finish(new Headers(), true).usage).toBeNull();
    expect(warnings.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("usage_read_budget_exceeded"));
    warnings.mockRestore();
  });

  it("never lets a failing reader touch the answer", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("one "));
        controller.enqueue(new TextEncoder().encode("two"));
        controller.close();
      },
    });
    const { stream, observed } = observeBody(source, {
      onChunk: () => {
        throw new Error("reader broke");
      },
    });
    expect(await new Response(stream).text()).toBe("one two");
    expect(await observed).toMatchObject({ totalBytes: 7, clientAborted: false, upstreamFailed: false });
  });
});
