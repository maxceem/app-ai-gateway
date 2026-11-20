/**
 * Root fields of a document known only by its anchored windows
 * (`src/usage/root-fields.ts`): a small JSON tokenizer, read forwards from a
 * head that starts the document and backwards from a tail that ends it.
 */
import { describe, expect, it, vi } from "vitest";
import { listPrice } from "../src/pricing/prices.ts";
import { callCharge } from "../src/proxy/call-charge.ts";
import { STANDARD_MODE } from "../src/usage/service-modes.ts";
import { anchoredRootFields } from "../src/usage/root-fields.ts";
import { readUsage, responseValues } from "../src/usage/readers.ts";

const KEYS = [["usage"], ["model"], ["service_tier"], ["duration"]];

describe("anchored root fields", () => {
  it("counts a head scalar only when something follows it inside the window (S11)", () => {
    // `4` may be the start of `42`: the window ends right after it.
    expect(anchoredRootFields({ head: '{"duration":4' }, KEYS)).toBeNull();
    expect(anchoredRootFields({ head: '{"duration":42,"text":"…' }, KEYS)).toEqual({ duration: 42 });
    expect(anchoredRootFields({ head: '{"service_tier":nul' }, KEYS)).toBeNull();
    // Followed by something, but not a JSON delimiter: it may still be part of a longer number (round 6 S11).
    expect(anchoredRootFields({ head: '{"duration":42e' }, KEYS)).toBeNull();
    expect(anchoredRootFields({ head: '{"duration":42 ,"x":' }, KEYS)).toEqual({ duration: 42 });
  });

  it("returns any whole value raw, an empty array included (S12)", () => {
    expect(anchoredRootFields({ head: '{"service_tier":[],"model":"m","x":' }, KEYS)).toEqual({ service_tier: [], model: "m" });
    expect(anchoredRootFields({ tail: '0,"service_tier":99,"model":""}' }, KEYS)).toEqual({ service_tier: 99, model: "" });
  });

  it("reads only root members, past escaped quotes and braces inside strings", () => {
    const head = String.raw`{"text":"a \"}\" { [","model":"m1","nested":{"model":"no"},"x":`;
    expect(anchoredRootFields({ head }, KEYS)).toEqual({ model: "m1" });
    const tail = String.raw`"text":"b \"}\" { [","nested":{"model":"no","usage":{"a":1}},"model":"m2"}`;
    expect(anchoredRootFields({ tail }, KEYS)).toEqual({ model: "m2" });
  });

  it("never trusts a quote at a tail's first character: a backslash before the window could escape it (F2)", () => {
    expect(anchoredRootFields({ tail: '"model":"m"}' }, KEYS)).toBeNull();
    expect(anchoredRootFields({ tail: ' "model":"m"}' }, KEYS)).toEqual({ model: "m" });
  });

  it("stops at a string cut by a window, never guessing past it", () => {
    expect(anchoredRootFields({ head: '{"model":"abc' }, KEYS)).toBeNull();
    // The tail starts inside a string: everything after it is still read.
    expect(anchoredRootFields({ tail: 'def","model":"m3"}' }, KEYS)).toEqual({ model: "m3" });
  });

  it("takes each field from the tail, else the head", () => {
    expect(anchoredRootFields({ head: '{"model":"head","duration":42,"t":"', tail: '","model":"tail"}' }, KEYS)).toEqual({
      model: "tail",
      duration: 42,
    });
  });
});

describe("anchors in responses", () => {
  it("gives no tail fields for a body that was cut, whose end is not the root's (S10)", () => {
    const head = `{"text":"${"a".repeat(32)}`;
    // Ends with a nested object's braces: read as the root's end, its `usage` would look like the root's.
    const tail = `${"a".repeat(32)}","nested":{"usage":{"prompt_tokens":9,"completion_tokens":9}}`;
    const cut = { head, tail, truncated: true, clientAborted: true, upstreamFailed: false, totalBytes: 0 };
    expect(readUsage(responseValues(cut, "application/json"), "openai-chat")).toBeNull();
    const whole = { head, tail: `${tail}}`, truncated: true };
    expect(readUsage(responseValues(whole, "application/json"), "openai-chat")).toBeNull();
    const rooted = { head, tail: `${"a".repeat(32)}","usage":{"prompt_tokens":10,"completion_tokens":2}}`, truncated: true };
    expect(readUsage(responseValues(rooted, "application/json"), "openai-chat")).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });

  it("drops a cut SSE event's partial first line, of unknown kind, and reads only whole data lines (S13)", () => {
    // One event's data spans two data lines, with a comment between them. The
    // head window ends inside the comment; the tail window starts inside it.
    const head = 'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":7,"completion_tokens":3},\n: commen';
    const tail = 't","usage":{"prompt_tokens":999,"completion_tokens":999},\ndata: "model":"m"}\n\ndata: [DONE]\n\n';
    const values = responseValues({ head, tail, truncated: true }, "text/event-stream");
    expect(readUsage(values, "openai-chat")).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it("reads an SSE event cut at its end by its start alone", () => {
    // The last event of the head window, cut: its start is known, its end is not.
    const started = 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1},"text":"ab';
    expect(readUsage(responseValues({ head: started, tail: "", truncated: false }, "text/event-stream"), "openai-chat")).toMatchObject({
      inputTokens: 3,
      outputTokens: 1,
    });
    // An unended event whose data stops after a nested object: never read as if it ended there.
    const unended = 'data: {"text":"x","nested":{"usage":{"prompt_tokens":9,"completion_tokens":9}}';
    expect(readUsage(responseValues({ head: unended, tail: "", truncated: false }, "text/event-stream"), "openai-chat")).toBeNull();
  });
});

describe("final events larger than the kept tail (F1)", () => {
  const big = "A".repeat(64);

  it("reads an image stream's final event from its end", () => {
    const head = 'data: {"type":"image_generation.partial_image","b64_json":"AA"}\n\n';
    const tail = `${big}","usage":{"input_tokens":50,"output_tokens":4160,"total_tokens":4210}}\n\n`;
    const usage = readUsage(responseValues({ head, tail, truncated: true }, "text/event-stream"), "openai-images");
    expect(usage).toMatchObject({ outputTokens: 4160 });
    expect(usage?.finalEventUnread).toBeUndefined();
  });

  it("reads Responses' usage under `response`, inside the event's last large member", () => {
    const head = 'data: {"type":"response.created","response":{"id":"r"}}\n\n';
    const tail = `${big}"}],"usage":{"input_tokens":12,"output_tokens":7,"total_tokens":19}},"sequence_number":9}\n\n`;
    expect(readUsage(responseValues({ head, tail, truncated: true }, "text/event-stream"), "openai-responses")).toMatchObject({
      inputTokens: 12,
      outputTokens: 7,
    });
  });

  it("reads Gemini's last chunk, and never books an earlier chunk's usage as exact when the last one is lost", () => {
    const earlier = 'data: {"candidates":[],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}\n\n';
    const last = `${big}"}}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1290,"totalTokenCount":1300}}\n\n`;
    expect(readUsage(responseValues({ head: earlier, tail: last, truncated: true }, "text/event-stream"), "gemini-generate")).toMatchObject({
      outputTokens: 1290,
    });
    // The final event never ended: its usage is lost, and the earlier one is only an estimate.
    const lost = readUsage(responseValues({ head: earlier, tail: big, truncated: true }, "text/event-stream"), "gemini-generate");
    expect(lost).toMatchObject({ outputTokens: 1, finalEventUnread: true });
  });

  it("reads a streamed transcription's large final event from its end", () => {
    const head = 'data: {"type":"transcript.text.delta","delta":"x"}\n\n';
    const tail = `${big}","usage":{"type":"tokens","input_tokens":40,"output_tokens":10,"total_tokens":50}}\n\n`;
    expect(readUsage(responseValues({ head, tail, truncated: true }, "text/event-stream"), "openai-transcription")).toMatchObject({
      inputTokens: 40,
      outputTokens: 10,
    });
  });

  it("bills a charge whose final event was lost as an estimate, and logs it", () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const usage = { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, finalEventUnread: true as const };
    const entry = callCharge(
      {
        requestId: "req_lost_final",
        seq: 1,
        accountId: "acc",
        appId: "app_lost",
        identity: { appId: "app_lost", userId: null, credentialType: "api_key", authMethod: "api_key", installId: null, appleAccountId: null },
        providerType: "gemini",
        connectionId: "conn",
        providerSlug: "gemini",
        operation: "gemini.stream.v1beta",
        model: "gemini-4-neon",
        price: { price: listPrice("gemini", "gemini-4-neon")!, source: "list_rate" },
        reportsCost: false,
        requestedMode: STANDARD_MODE,
        startedAt: Date.now(),
        appVersion: null,
        clientTraceId: null,
      },
      { status: "ok", httpStatus: 200, errorCode: null, usage, cut: false, latencyMs: 5 },
    );
    expect(entry.charge.priceIsEstimate).toBe(true);
    expect(warnings.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("usage_final_event_unread"));
    warnings.mockRestore();
  });
});
