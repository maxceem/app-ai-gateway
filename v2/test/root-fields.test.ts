/**
 * Root fields of a document known only by its anchored windows
 * (`src/usage/root-fields.ts`): a small JSON tokenizer, read forwards from a
 * head that starts the document and backwards from a tail that ends it.
 */
import { describe, expect, it } from "vitest";
import { anchoredRootFields } from "../src/usage/root-fields.ts";
import { readUsage, responseValues } from "../src/usage/readers.ts";

const KEYS = ["usage", "model", "service_tier", "duration"];

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
    expect(anchoredRootFields({ tail: '"service_tier":99,"model":""}' }, KEYS)).toEqual({ service_tier: 99, model: "" });
  });

  it("reads only root members, past escaped quotes and braces inside strings", () => {
    const head = String.raw`{"text":"a \"}\" { [","model":"m1","nested":{"model":"no"},"x":`;
    expect(anchoredRootFields({ head }, KEYS)).toEqual({ model: "m1" });
    const tail = String.raw`"text":"b \"}\" { [","nested":{"model":"no","usage":{"a":1}},"model":"m2"}`;
    expect(anchoredRootFields({ tail }, KEYS)).toEqual({ model: "m2" });
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

  it("reads a cut SSE event's data lines only, never a comment holding JSON (S13)", () => {
    const usage = { prompt_tokens: 7, completion_tokens: 3 };
    // The tail window starts inside the event's data line; a comment with JSON follows it.
    const event = `,"usage":${JSON.stringify(usage)}}\n: {"usage":{"prompt_tokens":999,"completion_tokens":999}}`;
    const tail = `${event}\n\ndata: [DONE]\n\n`;
    const values = responseValues({ head: 'data: {"choices":[]', tail, truncated: true }, "text/event-stream");
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
