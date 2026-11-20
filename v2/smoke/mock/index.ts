/**
 * A tiny provider for smoke checks and load tests of the v2 gateway. It costs
 * nothing and holds nothing. It answers each text API style the gateway
 * serves, with that style's usage:
 *
 * - `POST /v1/chat/completions`: Chat Completions. Its usage also carries
 *   `cost`, as OpenRouter's does: $1 per million prompt tokens, so a
 *   connection that reads a provider's own cost can be checked against it.
 * - `POST /v1/responses`: the Responses API.
 * - `POST /v1/messages`: Anthropic's Messages API.
 * - `POST /v1beta/models/{model}:generateContent` and
 *   `:streamGenerateContent`: Gemini.
 * - `POST /v1/audio/transcriptions`, `/openai/v1/audio/transcriptions` and
 *   `/v1/stt`: transcription, a multipart upload (or JSON). `whisper*` and
 *   `grok*` models answer with a duration (`usage.seconds`, or `duration`
 *   for `verbose_json` and `v1/stt`); others with tokens. The duration is
 *   the form's `mock_seconds`, else 30.
 * - `POST /v1/images/generations`, `/v1/images/edits` and
 *   `/images/generations`: images. `seedream*` models report
 *   `generated_images` (the form's or body's `n`, else 1); others tokens.
 * - `POST /v1/embeddings` and `/embeddings/multimodal`: embeddings, with
 *   input tokens only. `POST /v1beta/models/{model}:embedContent`: Gemini's.
 * - `POST /v1/audio/speech`: audio bytes, or, with `stream_format: "sse"`,
 *   events ending with usage.
 *
 * Each reads the whole body, counting its bytes, and answers JSON, or a
 * stream when the body has `"stream": true` (Gemini: the streaming path). A
 * multipart form's text fields are read like a JSON body's.
 * A Chat Completions stream ends with its usage chunk only when the request
 * asks for one, as OpenAI's does. Fields only this mock reads, which the
 * gateway passes through as it passes any body field:
 *
 * - `mock_delay_ms`: wait this long before answering (at most 120 s), for a
 *   slow provider.
 * - `mock_status`: answer with this HTTP status and an OpenAI-style error.
 *
 * A path that starts with `/fail-{status}/`, such as `/fail-503/v1/chat/completions`,
 * is answered with that status and an OpenAI-style error, after its body is
 * read. A connection whose base URL ends in `/fail-503/` therefore always
 * fails, so a fallback chain can be checked through a live gateway.
 *
 * Every answer carries `x-mock-received-bytes`, the bytes it read. A body
 * that is not JSON is still counted and answered. Any key is accepted, in any
 * of the providers' key headers.
 *
 * `GET /v1/models` answers an empty model list, the call a key test sends.
 * The key `sk-mock-rejected` is refused there with 401, so a smoke check can
 * see a rejected key.
 */
const MAX_DELAY_MS = 120_000;

function promptTokens(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 4));
}

const OUTPUT_TOKENS = 5;

async function readCounting(request: Request): Promise<{ bytes: number; text: string | null; form: Record<string, unknown> | null }> {
  if (request.body === null) return { bytes: 0, text: "", form: null };
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
  const type = request.headers.get("content-type") ?? "";
  if (type.toLowerCase().startsWith("multipart/form-data")) {
    try {
      const form = await new Request("https://mock.invalid", { method: "POST", headers: { "content-type": type }, body: joined }).formData();
      const fields: Record<string, unknown> = {};
      form.forEach((value, name) => {
        if (typeof value === "string" && !(name in fields)) fields[name] = /^\d+(\.\d+)?$/u.test(value) && name !== "model" ? Number(value) : value;
      });
      return { bytes, text: null, form: fields };
    } catch {
      return { bytes, text: null, form: null };
    }
  }
  try {
    return { bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(joined), form: null };
  } catch {
    return { bytes, text: null, form: null };
  }
}

function events(list: readonly unknown[], done = false): string {
  return list.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
}

type Answer = (input: { body: Record<string, unknown>; bytes: number; model: string; stream: boolean; path: string }) => Response;

const SSE = { "content-type": "text/event-stream" };

const chat: Answer = ({ body, bytes, model, stream }) => {
  const usage = { prompt_tokens: promptTokens(bytes), completion_tokens: OUTPUT_TOKENS, total_tokens: promptTokens(bytes) + OUTPUT_TOKENS, cost: promptTokens(bytes) / 1_000_000 };
  if (stream) {
    const options = body.stream_options as { include_usage?: unknown } | undefined;
    const chunks = [
      { id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] },
      { id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ...(options?.include_usage === true ? [{ id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [], usage }] : []),
    ];
    return new Response(events(chunks, true), { headers: SSE });
  }
  return Response.json({
    id: "chatcmpl-mock",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    usage,
    mock_received_bytes: bytes,
  });
};

const responses: Answer = ({ bytes, model, stream }) => {
  const response = {
    id: "resp_mock",
    object: "response",
    model,
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] }],
    usage: { input_tokens: promptTokens(bytes), output_tokens: OUTPUT_TOKENS, total_tokens: promptTokens(bytes) + OUTPUT_TOKENS },
  };
  if (!stream) return Response.json(response);
  return new Response(
    events([
      { type: "response.created", response: { ...response, status: "in_progress", usage: null } },
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.completed", response },
    ]),
    { headers: SSE },
  );
};

const messages: Answer = ({ bytes, model, stream }) => {
  if (!stream) {
    return Response.json({
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "Hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: promptTokens(bytes), output_tokens: OUTPUT_TOKENS },
    });
  }
  return new Response(
    events([
      { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model, content: [], usage: { input_tokens: promptTokens(bytes), output_tokens: 1 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: OUTPUT_TOKENS } },
      { type: "message_stop" },
    ]),
    { headers: SSE },
  );
};

const gemini: Answer = ({ bytes, path }) => {
  const usageMetadata = { promptTokenCount: promptTokens(bytes), candidatesTokenCount: OUTPUT_TOKENS, totalTokenCount: promptTokens(bytes) + OUTPUT_TOKENS };
  const last = { candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }], usageMetadata };
  if (!path.endsWith(":streamGenerateContent")) return Response.json(last);
  return new Response(events([{ candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] }, last]), { headers: SSE });
};

const transcription: Answer = ({ body, bytes, model, path }) => {
  const seconds = typeof body.mock_seconds === "number" ? body.mock_seconds : 30;
  const byTime = model.startsWith("whisper") || model.startsWith("grok");
  if (path === "/v1/stt" || body.response_format === "verbose_json") {
    return Response.json({ text: "Hello", language: "en", duration: seconds, segments: [] });
  }
  if (byTime) return Response.json({ text: "Hello", usage: { type: "duration", seconds } });
  return Response.json({ text: "Hello", usage: { type: "tokens", input_tokens: promptTokens(bytes), output_tokens: OUTPUT_TOKENS, total_tokens: promptTokens(bytes) + OUTPUT_TOKENS } });
};

const images: Answer = ({ body, bytes, model }) => {
  const count = typeof body.n === "number" && body.n > 0 ? Math.floor(body.n) : 1;
  const data = Array.from({ length: count }, () => ({ b64_json: "iVBORw0KGgo=" }));
  if (model.startsWith("seedream")) return Response.json({ model, data, usage: { generated_images: count, output_tokens: 16384, total_tokens: 16384 } });
  const input = promptTokens(bytes);
  return Response.json({
    created: 0,
    data,
    usage: { input_tokens: input, output_tokens: 1056 * count, total_tokens: input + 1056 * count, input_tokens_details: { text_tokens: input, image_tokens: 0 } },
  });
};

const embeddings: Answer = ({ bytes, model }) =>
  Response.json({ object: "list", model, data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: promptTokens(bytes), total_tokens: promptTokens(bytes) } });

const geminiEmbed: Answer = ({ bytes }) => Response.json({ embedding: { values: [0.1, 0.2] }, usageMetadata: { promptTokenCount: promptTokens(bytes), totalTokenCount: promptTokens(bytes) } });

const speech: Answer = ({ body, bytes }) => {
  if (body.stream_format !== "sse") return new Response(new Uint8Array(1024).fill(0x55), { headers: { "content-type": "audio/mpeg" } });
  return new Response(
    events([
      { type: "speech.audio.delta", audio: "VVVV" },
      { type: "speech.audio.done", usage: { input_tokens: promptTokens(bytes), output_tokens: 100, total_tokens: promptTokens(bytes) + 100 } },
    ]),
    { headers: SSE },
  );
};

/** Which answer a path gets. */
function answerFor(path: string): Answer | null {
  if (path === "/v1/chat/completions") return chat;
  if (path === "/v1/responses") return responses;
  if (path === "/v1/messages") return messages;
  if (/^\/v1beta\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/u.test(path)) return gemini;
  if (path === "/v1/audio/transcriptions" || path === "/openai/v1/audio/transcriptions" || path === "/v1/stt") return transcription;
  if (path === "/v1/images/generations" || path === "/v1/images/edits" || path === "/images/generations") return images;
  if (path === "/v1/embeddings" || path === "/embeddings/multimodal") return embeddings;
  if (/^\/v1(?:beta)?\/models\/[^/]+:embedContent$/u.test(path)) return geminiEmbed;
  if (path === "/v1/audio/speech") return speech;
  return null;
}

/** The key, in whichever header the provider type sends it. */
function keyOf(request: Request): string | null {
  const bearer = request.headers.get("authorization");
  if (bearer !== null && bearer.startsWith("Bearer ")) return bearer.slice("Bearer ".length);
  return request.headers.get("x-api-key") ?? request.headers.get("x-goog-api-key");
}

/**
 * Cloudflare AI Gateway's URL space, for a test deployment whose
 * build points Cloudflare AI Gateway here (`__TEST_CLOUDFLARE_AI_GATEWAY_ORIGIN__`): `/v1/<account>/<gateway>/<provider>/<path>`.
 * OpenAI's name there stands for its `v1/` prefix, as on Cloudflare.
 */
const CLOUDFLARE_PATH = /^\/v1\/([^/]+)\/([^/]+)\/(openai|anthropic|grok|google-ai-studio|perplexity-ai)\/(.*)$/u;

const mock = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // Through the stand-in for Cloudflare AI Gateway: its token is needed, the
    // provider's key is not (Cloudflare can use the keys it stores). The
    // answer says what came through, for the smoke checks to see.
    const cloudflare = CLOUDFLARE_PATH.exec(url.pathname);
    if (cloudflare !== null) {
      if (!(request.headers.get("cf-aig-authorization") ?? "").startsWith("Bearer ")) {
        return Response.json({ error: { message: "Missing Cloudflare token", code: "unauthorized" } }, { status: 401 });
      }
      const [, , , provider, rest] = cloudflare;
      const path = provider === "openai" ? `/v1/${rest}` : `/${rest}`;
      const forwarded = new Request(new URL(`${path}${url.search}`, url), request);
      if (keyOf(forwarded) === null) forwarded.headers.set("authorization", "Bearer cloudflare-stored-key");
      const response = await mock.fetch(forwarded);
      const answered = new Response(response.body, response);
      answered.headers.set("x-mock-via-cloudflare", provider!);
      answered.headers.set("x-mock-cf-metadata", request.headers.get("cf-aig-metadata") ?? "");
      return answered;
    }
    const key = keyOf(request);
    if (key === null || key === "") {
      return Response.json({ error: { message: "Missing key", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      if (key === "sk-mock-rejected") {
        return Response.json({ error: { message: "Incorrect API key", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
      }
      return Response.json({ object: "list", data: [] });
    }
    const failing = /^\/fail-([45]\d\d)(\/.*)$/u.exec(url.pathname);
    if (failing !== null && request.method === "POST") {
      const { bytes } = await readCounting(request);
      return Response.json(
        { error: { message: "Mock failure", type: "mock_error", code: "mock_failure" } },
        { status: Number(failing[1]), headers: { "x-mock-received-bytes": String(bytes) } },
      );
    }
    const answer = request.method === "POST" ? answerFor(url.pathname) : null;
    if (answer === null) return Response.json({ error: { message: "Not found", type: "invalid_request_error" } }, { status: 404 });
    const { bytes, text, form } = await readCounting(request);
    let body: Record<string, unknown> = form ?? {};
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
      return Response.json({ error: { message: "Mock error", type: "mock_error", code: "mock_error" } }, { status: body.mock_status, headers });
    }
    const model = typeof body.model === "string" ? body.model : "mock-model";
    const response = answer({ body, bytes, model, stream: body.stream === true, path: url.pathname });
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    // Vercel AI Gateway's spend attribution, for the smoke checks to see.
    const tags = request.headers.get("ai-reporting-tags");
    if (tags !== null) response.headers.set("x-mock-reporting-tags", tags);
    return response;
  },
} satisfies ExportedHandler;

export default mock;
