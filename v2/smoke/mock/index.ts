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
 * - `POST /v1/listen`: Deepgram's transcript of 30 seconds of audio, on two
 *   channels with `multichannel=true` in the query, served by the model the
 *   query names, and in French with `detect_language=true`.
 * - `POST /fal-ai/...`: a fal image per `num_images`, with the units in
 *   `x-fal-billable-units`, or none with `mock_no_units: true`.
 *
 * Each reads the whole body, counting its bytes, and answers JSON, or a
 * stream when the body has `"stream": true` (Gemini: the streaming path). A
 * multipart form's text fields are read like a JSON body's.
 * A Chat Completions stream ends with its usage chunk only when the request
 * asks for one, as OpenAI's does. Fields only this mock reads, which the
 * gateway passes through as it passes any body field:
 *
 * - `mock_delay_ms`: wait this long before answering (at most 120 s), for a
 *   slow provider. A raw body (Deepgram's audio) names it in the query.
 * - `mock_status`: answer with this HTTP status and an OpenAI-style error.
 * - `mock_output_bytes`: make the answer's payload this many bytes (at most
 *   32 MB): the image's base64, the Responses output text (in a stream, on
 *   its closing event) or the transcript, before the usage, so a check can
 *   see a large answer metered whole.
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
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** A payload of `mock_output_bytes`, or `fallback`. */
function payload(body: Record<string, unknown>, fallback: string): string {
  const size = body.mock_output_bytes;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return fallback;
  return "QUJD".repeat(Math.ceil(Math.min(size, MAX_OUTPUT_BYTES) / 4)).slice(0, Math.min(size, MAX_OUTPUT_BYTES));
}

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

type Answer = (input: { body: Record<string, unknown>; bytes: number; model: string; stream: boolean; path: string; query: URLSearchParams }) => Response;

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

const responses: Answer = ({ body, bytes, model, stream }) => {
  const response = {
    id: "resp_mock",
    object: "response",
    model,
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: payload(body, "Hello") }] }],
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
    return Response.json({ text: payload(body, "Hello"), language: "en", duration: seconds, segments: [] });
  }
  if (byTime) return Response.json({ text: payload(body, "Hello"), usage: { type: "duration", seconds } });
  return Response.json({ text: payload(body, "Hello"), usage: { type: "tokens", input_tokens: promptTokens(bytes), output_tokens: OUTPUT_TOKENS, total_tokens: promptTokens(bytes) + OUTPUT_TOKENS } });
};

const images: Answer = ({ body, bytes, model }) => {
  const count = typeof body.n === "number" && body.n > 0 ? Math.floor(body.n) : 1;
  const data = Array.from({ length: count }, () => ({ b64_json: payload(body, "iVBORw0KGgo=") }));
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

/**
 * ElevenLabs text to speech: audio (or JSON with timestamps), with credits in
 * `character-cost`: the text's characters, halved for the flash and turbo
 * models (T2). The gateway bills the request's characters and keeps these
 * credits only as a cross-check (T27). `mock_no_cost_header` leaves the
 * header out.
 */
const elevenTts: Answer = ({ body, path }) => {
  const text = typeof body.text === "string" ? body.text : "";
  const model = typeof body.model_id === "string" ? body.model_id : "eleven_multilingual_v2";
  const half = /flash|turbo|conversational/u.test(model);
  const credits = half ? Math.round([...text].length / 2) : [...text].length;
  const headers: Record<string, string> = { "request-id": "req_mock" };
  if (body.mock_no_cost_header !== true) headers["character-cost"] = String(credits);
  if (path.endsWith("/with-timestamps")) return Response.json({ audio_base64: "VVVV", alignment: { characters: [] } }, { headers });
  return new Response(new Uint8Array(1024).fill(0x55), { headers: { ...headers, "content-type": "audio/mpeg" } });
};

/**
 * ElevenLabs speech to text: a transcript, the credits in `character-cost`,
 * and its own dollar figure (T2). The answer says whether a webhook field
 * reached it, for the smoke checks to see.
 */
const elevenStt: Answer = ({ body }) =>
  Response.json(
    { text: "Hello.", language_code: "en", audio_duration_secs: 4.7090625 },
    {
      headers: {
        "character-cost": "5",
        "fiat-cost-before-overages": "0.0005",
        "fiat-currency": typeof body.mock_fiat_currency === "string" ? body.mock_fiat_currency : "usd",
        "x-mock-webhook-received": String(body.webhook !== undefined || body.webhook_id !== undefined),
      },
    },
  );

/**
 * Deepgram prerecorded speech to text: 30 seconds of audio, on two channels
 * when the query asks for `multichannel=true`. The answer says whether a
 * callback reached it, for the smoke checks to see.
 */
const deepgramListen: Answer = ({ query }) => {
  const channels = query.get("multichannel") === "true" ? 2 : 1;
  const model = query.get("model") ?? "base";
  // With `detect_language=true`, every channel says it heard French.
  const detected = query.get("detect_language") === "true" ? { detected_language: "fr" } : {};
  return Response.json(
    {
      metadata: { request_id: "dg-mock", duration: 30, channels, models: ["mock"], model_info: { mock: { arch: model, name: `general-${model}`, version: "1" } } },
      results: { channels: Array.from({ length: channels }, () => ({ ...detected, alternatives: [{ transcript: "hello", confidence: 0.99 }] })) },
    },
    { headers: { "x-mock-callback-received": String(query.has("callback")), "x-mock-model": query.get("model") ?? "" } },
  );
};

/**
 * fal's `fal.run`: an image per `num_images`, each one megapixel, reported in
 * `x-fal-billable-units` (T15). `mock_no_units` leaves the header out.
 */
const falRun: Answer = ({ body }) => {
  const count = typeof body.num_images === "number" && Number.isSafeInteger(body.num_images) && body.num_images > 0 ? body.num_images : 1;
  const headers: Record<string, string> = { "x-fal-request-id": "fal-mock" };
  if (body.mock_no_units !== true) headers["x-fal-billable-units"] = String(count);
  return Response.json({ images: Array.from({ length: count }, (_, index) => ({ url: `https://fal.media/mock-${index}.png`, width: 1024, height: 1024 })) }, { headers });
};

/** Which answer a path gets. */
function answerFor(path: string): Answer | null {
  if (/^\/v1\/text-to-speech\/[^/]+(?:\/stream)?(?:\/with-timestamps)?$/u.test(path)) return elevenTts;
  if (path === "/v1/speech-to-text") return elevenStt;
  if (path === "/v1/listen") return deepgramListen;
  if (/^\/fal-ai\/[^/]+(?:\/[^/]+)*$/u.test(path)) return falRun;
  if (path === "/v1/chat/completions") return chat;
  if (path === "/v1/responses") return responses;
  if (path === "/v1/messages") return messages;
  if (/^\/v1beta\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/u.test(path)) return gemini;
  // Translations are reached only as a listed passthrough path (step 5), answered as a transcription.
  if (path === "/v1/audio/transcriptions" || path === "/openai/v1/audio/transcriptions" || path === "/v1/stt" || path === "/v1/audio/translations") return transcription;
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
  if (bearer !== null && bearer.startsWith("Token ")) return bearer.slice("Token ".length);
  if (bearer !== null && bearer.startsWith("Key ")) return bearer.slice("Key ".length);
  return request.headers.get("x-api-key") ?? request.headers.get("x-goog-api-key") ?? request.headers.get("xi-api-key");
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
    // A path no provider declares, for passthrough (step 5): any method,
    // answered with what came through, for the smoke checks to see. Never the key.
    if (url.pathname === "/v1/echo" || url.pathname.startsWith("/v1/echo/")) {
      const { bytes } = await readCounting(request);
      return Response.json({
        method: request.method,
        path: url.pathname,
        query: url.search,
        contentType: request.headers.get("content-type"),
        bytes,
        forwarded: [...request.headers.keys()].filter((name) => name.startsWith("x-") || name === "openai-beta").sort(),
      });
    }
    // OpenAI's live-session token path (step 5c): answers a made-up client
    // secret and echoes the JSON body it received, so the smoke checks can see
    // the window the gateway locked. Never the key.
    if (request.method === "POST" && url.pathname === "/v1/realtime/client_secrets") {
      const { text } = await readCounting(request);
      let received: unknown = null;
      try {
        received = text === null || text === "" ? null : (JSON.parse(text) as unknown);
      } catch {
        received = "unreadable";
      }
      return Response.json({ value: "ek_mock_smoke", expires_at: Math.floor(Date.now() / 1000) + 60, received });
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
    // A raw body (audio) has no fields, so it asks for the delay in the query.
    const asked = typeof body.mock_delay_ms === "number" ? body.mock_delay_ms : Number(url.searchParams.get("mock_delay_ms") ?? 0);
    const delay = Number.isFinite(asked) ? Math.min(MAX_DELAY_MS, Math.max(0, asked)) : 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (typeof body.mock_status === "number" && body.mock_status >= 400 && body.mock_status < 600) {
      return Response.json({ error: { message: "Mock error", type: "mock_error", code: "mock_error" } }, { status: body.mock_status, headers });
    }
    const model = typeof body.model === "string" ? body.model : "mock-model";
    const response = answer({ body, bytes, model, stream: body.stream === true, path: url.pathname, query: url.searchParams });
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    // Vercel AI Gateway's spend attribution, for the smoke checks to see.
    const tags = request.headers.get("ai-reporting-tags");
    if (tags !== null) response.headers.set("x-mock-reporting-tags", tags);
    return response;
  },
} satisfies ExportedHandler;

export default mock;
