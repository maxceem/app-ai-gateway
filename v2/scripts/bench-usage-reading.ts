/**
 * How much CPU reading a response's usage costs, as it streams past
 * (`responseReader` in `src/proxy/meter.ts`). Not a test: a figure to set
 * `READ_BUDGET` from, and to check a change to the reader against. It
 * runs `bodyReader` with a streaming decoder, as `responseReader` does.
 *
 *   node --experimental-strip-types scripts/bench-usage-reading.ts
 *
 * Each body is fed in 64 KiB pieces (or one event a piece, as a stream that
 * flushes each token arrives), and the CPU time of the reading alone is
 * reported (best of several runs).
 */
import type { ApiStyle } from "../src/providers/operation.ts";
import { bodyReader } from "../src/usage/readers.ts";

const MB = 1024 * 1024;
const PIECE = 64 * 1024;

function floats(bytes: number): string {
  const values: string[] = [];
  let length = 0;
  for (let index = 0; length < bytes; index += 1) {
    const value = (Math.sin(index) * 0.1).toFixed(8);
    values.push(value);
    length += value.length + 1;
  }
  return `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[${values.join(",")}]}],"model":"text-embedding-3-small","usage":{"prompt_tokens":8,"total_tokens":8}}`;
}

function base64Image(bytes: number): string {
  return `{"created":1,"data":[{"b64_json":"${"QUJDRA".repeat(Math.ceil(bytes / 6)).slice(0, bytes)}"}],"usage":{"input_tokens":50,"output_tokens":4160}}`;
}

function chatStream(events: number): string {
  const chunk = (content: string) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "gpt-4o-mini", service_tier: "default", choices: [{ index: 0, delta: { content } }] })}\n\n`;
  const parts: string[] = [];
  for (let index = 0; index < events; index += 1) parts.push(chunk(`token ${index} `));
  parts.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: events } })}\n\n`, "data: [DONE]\n\n");
  return parts.join("");
}

/** 10 MB of dense JSON: a chat answer with log probabilities for every token. */
function logprobs(bytes: number): string {
  const tokens: string[] = [];
  let length = 0;
  for (let index = 0; length < bytes; index += 1) {
    const entry = JSON.stringify({
      token: `t${index}`,
      logprob: -0.0123,
      bytes: [116, 49],
      top_logprobs: [
        { token: "a", logprob: -1.5, bytes: [97] },
        { token: "b", logprob: -2.25, bytes: [98] },
      ],
    });
    tokens.push(entry);
    length += entry.length + 1;
  }
  return `{"id":"c","object":"chat.completion","model":"gpt-4o-mini","choices":[{"index":0,"message":{"role":"assistant","content":"x"},"logprobs":{"content":[${tokens.join(",")}]}}],"usage":{"prompt_tokens":10,"completion_tokens":20}}`;
}

function cpuMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const start = process.cpuUsage();
    run();
    const used = process.cpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

const cases: { name: string; body: string; contentType: string; style: ApiStyle; perEvent?: boolean }[] = [
  { name: "20 MB float array (embeddings)", body: floats(20 * MB), contentType: "application/json", style: "openai-embeddings" },
  { name: "20 MB base64 image", body: base64Image(20 * MB), contentType: "application/json", style: "openai-images" },
  { name: "10 MB dense JSON (logprobs)", body: logprobs(10 * MB), contentType: "application/json", style: "openai-chat" },
  { name: "chat stream, 20,000 events", body: chatStream(20_000), contentType: "text/event-stream", style: "openai-chat" },
  { name: "chat stream, 20,000 events, one per piece", body: chatStream(20_000), contentType: "text/event-stream", style: "openai-chat", perEvent: true },
];

for (const { name, body, contentType, style, perEvent } of cases) {
  const bytes = new TextEncoder().encode(body);
  const pieces: Uint8Array[] = [];
  if (perEvent === true) for (const event of body.split(/(?<=\n\n)/u)) pieces.push(new TextEncoder().encode(event));
  else for (let at = 0; at < bytes.length; at += PIECE) pieces.push(bytes.subarray(at, at + PIECE));
  let usage: unknown = null;
  const ms = cpuMs(() => {
    const reader = bodyReader(contentType, style);
    const decoder = new TextDecoder();
    for (const piece of pieces) reader.push(decoder.decode(piece, { stream: true }));
    reader.push(decoder.decode());
    usage = reader.end().usage;
  });
  const megabytes = bytes.length / MB;
  console.log(`${name}: ${megabytes.toFixed(1)} MB, ${ms.toFixed(1)} ms CPU, ${(megabytes / (ms / 1000)).toFixed(0)} MB/s, usage read: ${usage !== null}`);
}
