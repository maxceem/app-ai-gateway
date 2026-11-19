/**
 * A tiny OpenAI-compatible provider for smoke checks and load tests of the
 * v2 gateway. It costs nothing and holds nothing.
 *
 * `POST /v1/chat/completions` reads the whole body, counting its bytes, and
 * answers with chat-completions usage: JSON, or a stream when the body has
 * `"stream": true` (with the final usage chunk when it asks for one).
 * Fields only this mock reads, which the gateway passes through as it passes
 * any body field:
 *
 * - `mock_delay_ms`: wait this long before answering (at most 120 s), for a
 *   slow provider.
 * - `mock_status`: answer with this HTTP status and an OpenAI-style error.
 *
 * Every answer carries `x-mock-received-bytes`, the bytes it read. A body
 * that is not JSON is still counted and answered.
 */
const MAX_DELAY_MS = 120_000;

function usageFor(bytes: number) {
  return { prompt_tokens: Math.max(1, Math.ceil(bytes / 4)), completion_tokens: 5, total_tokens: Math.max(1, Math.ceil(bytes / 4)) + 5 };
}

async function readCounting(request: Request): Promise<{ bytes: number; text: string | null }> {
  if (request.body === null) return { bytes: 0, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return { bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(joined) };
  } catch {
    return { bytes, text: null };
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (!(request.headers.get("authorization") ?? "").startsWith("Bearer ")) {
      return Response.json({ error: { message: "Missing key", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return Response.json({ error: { message: "Not found", type: "invalid_request_error" } }, { status: 404 });
    }
    const { bytes, text } = await readCounting(request);
    let body: Record<string, unknown> = {};
    try {
      const parsed = text === null ? null : (JSON.parse(text) as unknown);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // Counted and answered all the same.
    }
    const headers = { "x-mock-received-bytes": String(bytes) };
    const delay = typeof body.mock_delay_ms === "number" ? Math.min(MAX_DELAY_MS, Math.max(0, body.mock_delay_ms)) : 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (typeof body.mock_status === "number" && body.mock_status >= 400 && body.mock_status < 600) {
      return Response.json(
        { error: { message: "Mock error", type: "mock_error", code: "mock_error" } },
        { status: body.mock_status, headers },
      );
    }
    const model = typeof body.model === "string" ? body.model : "mock-model";
    const usage = usageFor(bytes);
    if (body.stream === true) {
      const options = body.stream_options as { include_usage?: unknown } | undefined;
      const events = [
        { id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] },
        { id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ...(options?.include_usage === true ? [{ id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [], usage }] : []),
      ];
      const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(text, { headers: { ...headers, "content-type": "text/event-stream" } });
    }
    return Response.json(
      {
        id: "chatcmpl-mock",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
        usage,
        mock_received_bytes: bytes,
      },
      { headers },
    );
  },
} satisfies ExportedHandler;
