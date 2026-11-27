/**
 * A tiny provider for smoke checks and load tests of the v2 gateway. It costs
 * nothing and holds nothing. It answers each text API style the gateway
 * serves, with that style's usage:
 *
 * - `POST /v1/chat/completions`, and `/orchestrator/v1/chat/completions` as
 *   Perplexity's Orchestrator API: Chat Completions. Its usage also carries
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
 * - `GET /v1/listen` as a WebSocket: Deepgram's live stream (step 10a). Its
 *   answer names the request in `dg-request-id`. Each binary frame is heard as
 *   16 kHz 16-bit mono audio and answered with a `Results` frame of its
 *   length; `CloseStream` gets the closing `Metadata`, then a close. A
 *   `mock_usd` in the query is the dollar figure its request record reports.
 * - `GET /v1/projects` and `GET /v1/projects/mock-project/requests/{id}`:
 *   Deepgram's project, and its record of a stream, completed, with the
 *   stream's `mock_usd` as its dollar figure (0.001 without one).
 * - `GET /v1/text-to-speech/{voice}/stream-input` as a WebSocket: ElevenLabs'
 *   streaming text to speech (step 10a). Each text frame with text gets an
 *   audio frame; `{"text": ""}` gets the final frame, then a close.
 * - `POST /fal-ai/...`: a fal image per `num_images`, with the units in
 *   `x-fal-billable-units`, or none with `mock_no_units: true`.
 * - `POST /queue/fal-ai/...`, then `GET .../requests/<id>/status`,
 *   `GET .../requests/<id>` and `PUT .../requests/<id>/cancel`: fal's queue,
 *   stateless; `mock_fail: true` makes the job fail with 422 and `0` units,
 *   `mock_cancelled: true` answers its result as a job cancelled while
 *   queued (499, `client_cancelled`), and `mock_video: true` answers one
 *   `video` with no units header, as `ltx-video` does.
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
 * - `service_tier`: exactly `flex` sets `x-mock-service-tier: flex`, so a check
 *   sees the mode arrived, and Chat Completions then reports half the prompt
 *   as cached tokens. Nothing else from it is echoed.
 * - `mock_slow_stream: true` (a Chat Completions stream): one chunk every
 *   250 ms for 30 s. The mock logs `mock_stream_cancelled` with the chunks
 *   sent if the gateway closes the connection first, and
 *   `mock_stream_finished` otherwise, with `mock_tag` (letters, digits and
 *   `-`, at most 64), so a check reading the mock's logs sees whether a
 *   client's hang-up reached the provider.
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
 * Every answer also carries two marks, so a check can judge what the gateway
 * sent without the mock ever echoing a key:
 *
 * - `x-mock-key`: each provider key header that came in, with a fixed label
 *   for its exact value, or `missing`. Only the public fixture keys in
 *   `FIXTURE_KEYS` get a label of their own, with the scheme for
 *   `authorization` (`authorization:bearer fixture-openai`,
 *   `x-api-key:fixture-anthropic`); any other value is `unexpected`. So the
 *   wrong key, the right key in the wrong header or with the wrong scheme is
 *   seen (v1's key check), and nothing about any other value is given away.
 * - `x-mock-client-credentials`: where a client's credential (an `agw_` key or
 *   a signed token) came in: request header names, `url` and `body`, or
 *   `none`. The gateway must never hand one to a provider.
 *
 * `GET /jwks/<base64url JSON>` answers the public key the path carries as a
 * JWKS, with no provider key: a smoke check makes a key pair of its own and
 * names this URL as its test issuer's JWKS, so nothing secret is stored.
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

const SLOW_CHUNKS = 120;
const SLOW_CHUNK_MS = 250;

/** A Chat Completions stream that takes 30 s, and logs whether it was cut off (`mock_slow_stream`). */
function slowStream(body: Record<string, unknown>, model: string): Response {
  const tag = typeof body.mock_tag === "string" && /^[A-Za-z0-9-]{1,64}$/u.test(body.mock_tag) ? body.mock_tag : "untagged";
  const encoder = new TextEncoder();
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent > 0) await new Promise((resolve) => setTimeout(resolve, SLOW_CHUNK_MS));
      if (sent === SLOW_CHUNKS) {
        controller.enqueue(encoder.encode(events([{ id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }], true)));
        console.log(JSON.stringify({ event: "mock_stream_finished", tag, chunks: sent }));
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(encoder.encode(events([{ id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "." } }] }])));
    },
    cancel() {
      console.log(JSON.stringify({ event: "mock_stream_cancelled", tag, chunks: sent }));
    },
  });
  return new Response(stream, { headers: SSE });
}

const chat: Answer = ({ body, bytes, model, stream }) => {
  if (stream && body.mock_slow_stream === true) return slowStream(body, model);
  const prompt = promptTokens(bytes);
  // A flex request reports half its prompt as cached, as OpenAI does inside
  // `prompt_tokens`, so a check can see cached usage priced and recorded.
  const cached = body.service_tier === "flex" ? Math.floor(prompt / 2) : 0;
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: OUTPUT_TOKENS,
    total_tokens: prompt + OUTPUT_TOKENS,
    cost: prompt / 1_000_000,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
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

/**
 * fal's queue (steps 6a and 6b), stateless: what the job will answer is
 * written into its request id, `mock-<images>-<s|f|n|c|v>-<random>` (succeed,
 * fail with 422 and `0` units, succeed with no units header, cancelled while
 * queued, one video with no units header). Reached under the connection's
 * base URL at `queue/`, as the gateway sends a non-main host there.
 */
const falQueueSubmit: Answer = ({ body, path }) => {
  const count = typeof body.num_images === "number" && Number.isSafeInteger(body.num_images) && body.num_images > 0 ? body.num_images : 1;
  const outcome =
    body.mock_fail === true ? "f" : body.mock_cancelled === true ? "c" : body.mock_video === true ? "v" : body.mock_no_units === true ? "n" : "s";
  const requestId = `mock-${count}-${outcome}-${crypto.randomUUID().slice(0, 8)}`;
  const model = path.replace(/^\/queue\//u, "").split("/").slice(0, 2).join("/");
  // fal's own links, as fal sends them: the gateway replaces them with its own.
  const base = `https://queue.fal.run/${model}/requests/${requestId}`;
  return Response.json({ request_id: requestId, status: "IN_QUEUE", status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel` });
};

const FAL_QUEUE_STATUS = /^\/queue\/[^/]+\/[^/]+\/requests\/(mock-[0-9]+-[sfncv]-[0-9a-f]+)\/status$/u;
const FAL_QUEUE_RESULT = /^\/queue\/[^/]+\/[^/]+\/requests\/(mock-([0-9]+)-([sfncv])-[0-9a-f]+)$/u;
const FAL_QUEUE_CANCEL = /^\/queue\/[^/]+\/[^/]+\/requests\/mock-[0-9]+-[sfncv]-[0-9a-f]+\/cancel$/u;

/** A queue job's status or result, from what its request id says. Null for another path. */
function falQueueFollowUp(request: Request, url: URL): Response | null {
  // fal answers a cancel 202, whatever the job then does (T15).
  if (request.method === "PUT" && FAL_QUEUE_CANCEL.test(url.pathname)) return Response.json({ status: "CANCELLATION_REQUESTED" }, { status: 202 });
  if (request.method !== "GET") return null;
  const status = FAL_QUEUE_STATUS.exec(url.pathname);
  if (status !== null) return Response.json({ status: "COMPLETED", request_id: status[1], response_url: `https://queue.fal.run${url.pathname.replace(/^\/queue/u, "").replace(/\/status$/u, "")}` });
  const result = FAL_QUEUE_RESULT.exec(url.pathname);
  if (result === null) return null;
  const count = Number(result[2]);
  if (result[3] === "f") return Response.json({ detail: [{ msg: "mock failure" }] }, { status: 422, headers: { "x-fal-billable-units": "0" } });
  if (result[3] === "c") return Response.json({ detail: "Request cancelled by the client." }, { status: 499, headers: { "x-fal-error-type": "client_cancelled" } });
  if (result[3] === "v") return Response.json({ video: { url: "https://fal.media/mock.mp4" } });
  const headers: Record<string, string> = {};
  if (result[3] === "s") headers["x-fal-billable-units"] = String(count);
  return Response.json({ images: Array.from({ length: count }, (_, index) => ({ url: `https://fal.media/mock-${index}.png` })) }, { headers });
}

/** Which answer a path gets. */
function answerFor(path: string): Answer | null {
  if (/^\/queue\/fal-ai\/[^/]+(?:\/[^/]+)*$/u.test(path) && !path.includes("/requests/")) return falQueueSubmit;
  if (/^\/v1\/text-to-speech\/[^/]+(?:\/stream)?(?:\/with-timestamps)?$/u.test(path)) return elevenTts;
  if (path === "/v1/speech-to-text") return elevenStt;
  if (path === "/v1/listen") return deepgramListen;
  if (/^\/fal-ai\/[^/]+(?:\/[^/]+)*$/u.test(path)) return falRun;
  // Perplexity's Orchestrator API, where maker/model ids go.
  if (path === "/v1/chat/completions" || path === "/orchestrator/v1/chat/completions") return chat;
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

/** The public fields of a JWK, the only ones a JWKS may carry. */
const PUBLIC_JWK_FIELDS = ["kty", "crv", "x", "y", "n", "e", "kid", "alg", "use"] as const;

/** The JWKS a `/jwks/<base64url JSON>` path names: its key's public fields alone, or null when it names none. */
export function jwksFromPath(path: string): { keys: Record<string, string>[] } | null {
  const encoded = /^\/jwks\/([A-Za-z0-9_-]{1,4096})$/u.exec(path)?.[1];
  if (encoded === undefined) return null;
  try {
    const parsed = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
    const key: Record<string, string> = {};
    for (const field of PUBLIC_JWK_FIELDS) if (typeof parsed[field] === "string") key[field] = parsed[field] as string;
    return typeof key.kty === "string" ? { keys: [key] } : null;
  } catch {
    return null;
  }
}

/** A client's credential: an `agw_` key, or a signed token (three base64url parts, the first `eyJ`). */
const CLIENT_CREDENTIAL = /agw_|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/u;

/** The names of the request headers that hold a client's credential, sorted. */
export function clientCredentialHeaders(headers: Headers): string[] {
  return [...headers.entries()].filter(([, value]) => CLIENT_CREDENTIAL.test(value)).map(([name]) => name).sort();
}

/** A URL's text as sent, and its path segments and query names and values decoded. */
function urlTexts(raw: string): string[] {
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const url = new URL(raw);
  const texts = [raw, ...url.pathname.split("/").map(decode)];
  // URLSearchParams decodes both names and values (`+` as a space too).
  for (const [name, value] of url.searchParams) texts.push(name, value);
  return texts;
}

/** Where a request carried a client's credential: header names, then `url` and `body`. */
export function clientCredentialPlaces(request: Request, body: ArrayBuffer | null): string[] {
  const places = clientCredentialHeaders(request.headers);
  if (urlTexts(request.url).some((text) => CLIENT_CREDENTIAL.test(text))) places.push("url");
  if (body !== null && CLIENT_CREDENTIAL.test(new TextDecoder().decode(body))) places.push("body");
  return places;
}

/** The headers a provider key comes in. */
const KEY_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "xi-api-key"] as const;

/**
 * The public test keys the smoke checks give their connections, and the label
 * each is reported as. Public on purpose: they are in this repository.
 */
export const FIXTURE_KEYS: ReadonlyMap<string, string> = new Map([
  ["sk-mock-smoke-key", "fixture-smoke"],
  ["sk-mock-smoke-openai", "fixture-openai"],
  ["sk-mock-smoke-anthropic", "fixture-anthropic"],
  ["sk-mock-smoke-gemini", "fixture-gemini"],
  ["sk-mock-smoke-openrouter", "fixture-openrouter"],
]);

/** The label for one key header's exact value: the scheme and fixture label, or `unexpected`. */
export function keyLabel(name: string, value: string): string {
  if (name !== "authorization") return FIXTURE_KEYS.get(value) ?? "unexpected";
  const parts = /^(Bearer|Token|Key) (.+)$/u.exec(value);
  const label = parts === null ? undefined : FIXTURE_KEYS.get(parts[2]!);
  return label === undefined ? "unexpected" : `${parts![1]!.toLowerCase()} ${label}`;
}

/** `x-mock-key`: each key header that came in, with its label, or `missing`. */
export function keyMarks(headers: Headers): string {
  const marks: string[] = [];
  for (const name of KEY_HEADERS) {
    const value = headers.get(name);
    if (value !== null) marks.push(`${name}:${keyLabel(name, value)}`);
  }
  return marks.length === 0 ? "missing" : marks.join(",");
}

const mock = {
  async fetch(request: Request): Promise<Response> {
    // The body is read once here, to look for a client's credential in it, and handed on whole.
    const body = request.body === null ? null : await request.arrayBuffer();
    const forwarded = body === null ? request : new Request(request, { body });
    const leaked = clientCredentialPlaces(request, body);
    const keys = keyMarks(request.headers);
    const response = await answer(forwarded);
    // A WebSocket upgrade or an opaque answer keeps its own headers.
    if (response.status === 101) return response;
    const marked = new Response(response.body, response);
    marked.headers.set("x-mock-client-credentials", leaked.length === 0 ? "none" : leaked.join(","));
    marked.headers.set("x-mock-key", keys);
    return marked;
  },
} satisfies ExportedHandler;

async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (url.pathname.endsWith("/v1/realtime") && request.headers.get("upgrade")?.toLowerCase() === "websocket") return realtimeSession();
  if (url.pathname.endsWith("BidiGenerateContent") && request.headers.get("upgrade")?.toLowerCase() === "websocket") return geminiLiveSession();
  if (url.pathname.endsWith("/v1/live/sessions") && request.headers.get("upgrade")?.toLowerCase() === "websocket") return gptLiveSession();
  if (/\/v1\/text-to-speech\/[^/]+\/stream-input$/u.test(url.pathname) && request.headers.get("upgrade")?.toLowerCase() === "websocket") return elevenLabsStream();
  if (url.pathname.endsWith("/v1/listen") && request.headers.get("upgrade")?.toLowerCase() === "websocket") return deepgramStream(url);
  if (request.method === "GET") {
    const jwks = jwksFromPath(url.pathname);
    if (jwks !== null) return Response.json(jwks, { headers: { "cache-control": "no-store" } });
  }
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
    // Answered directly: the outer `mock.fetch` already read the body once and sets the marks
    // from the request as the gateway sent it.
    const response = await answer(forwarded);
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
  // Deepgram's project and its record of a stream (step 10a): completed, with the dollar figure the
  // stream's `mock_usd` named, which its request id carries.
  if (request.method === "GET" && url.pathname === "/v1/projects") return Response.json({ projects: [{ project_id: MOCK_PROJECT, name: "Mock" }] });
  const record = /^\/v1\/projects\/mock-project\/requests\/([^/]+)$/u.exec(url.pathname);
  if (request.method === "GET" && record !== null) {
    const id = decodeURIComponent(record[1]!);
    const usd = Number(/^mock_usd_([0-9.]{1,12})_/u.exec(id)?.[1] ?? "0.001");
    // Wrapped in `request`, as Deepgram's reference shows.
    return Response.json({
      request: {
        request_id: id,
        project_uuid: MOCK_PROJECT,
        created: new Date().toISOString(),
        path: "/v1/listen",
        response: { code: 101, completed: new Date().toISOString(), details: { usd: Number.isFinite(usd) ? usd : 0.001, duration: 1, channels: 1 } },
      },
    });
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
  const followUp = falQueueFollowUp(request, url);
  if (followUp !== null) return followUp;
  const reply = request.method === "POST" ? answerFor(url.pathname) : null;
  if (reply === null) return Response.json({ error: { message: "Not found", type: "invalid_request_error" } }, { status: 404 });
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
  const response = reply({ body, bytes, model, stream: body.stream === true, path: url.pathname, query: url.searchParams });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  // The service mode the request asked for, so a check can see it reached the provider.
  if (body.service_tier === "flex") response.headers.set("x-mock-service-tier", "flex");
  // Vercel AI Gateway's spend attribution, for the smoke checks to see.
  const tags = request.headers.get("ai-reporting-tags");
  if (tags !== null) response.headers.set("x-mock-reporting-tags", tags);
  return response;
}

export default mock;

/**
 * A stand-in for a provider's live session (step 9a, frame forwarding and
 * T12): it sends `session.created` at once and echoes every frame. Two of its
 * own messages drive load tests:
 * - `{"type":"mock.stream","seconds":N}` streams N seconds of "audio" at a real
 *   rate: 20 frames a second of about 3.2 KB each, like 24 kHz PCM16 in base64;
 * - `{"type":"mock.big"}` sends one large frame with `type` at its end, the
 *   shape of an ElevenLabs audio event (plan, T12).
 *
 * And two give the relay's `mock` adapter usage to count (step 9a part 2):
 * - `{"type":"mock.turn","event_id":…,"usage":{…},"repeat":N}` answers one
 *   usage event, `{"type":"mock.usage","event_id":…,"usage":{…}}`, sent N
 *   times (default once) the way a provider may repeat an event;
 * - `mock.stream` with `"usageEvery":K` also sends a usage event of 100 input
 *   and 20 output tokens after every K-th frame, to load the journal.
 *
 * And one answer shaped like OpenAI's, for the relay's closing wait (step 9a
 * part 3): `{"type":"mock.answer","event_id":…,"usage":{…},"seconds":N}`
 * sends `response.created`, audio for N seconds, then the usage event and
 * `response.done`.
 *
 * Since OpenAI's own adapter reads this session (step 9e), each usage event is
 * followed by a `response.done` carrying the same usage the way OpenAI does,
 * in `response.usage`, keyed by the event id: sent as many times as the event,
 * so a repeat is skipped by that id. And one more:
 * `{"type":"mock.transcribe","event_id":…,"usage":{…},"model":M}` says the
 * session transcribes with M (`session.updated`), commits an audio item, then
 * sends its transcription with that usage.
 */
/**
 * Gemini Live (step 9d), its JSON in binary frames as Gemini sends it: a
 * `setup` gets `setupComplete` and a resumable handle; a text turn gets one
 * audio chunk, then `turnComplete` with its usage (60 text and 40 audio
 * tokens in, 20 audio tokens out), then a fresh handle, as Gemini sends one
 * after each `turnComplete` (T19). The text "goaway" gets a `goAway` with 11 s
 * left first, so the relay swaps to a new connection with that handle.
 */
function geminiLiveSession(): Response {
  const [client, server] = Object.values(new WebSocketPair());
  if (client === undefined || server === undefined) throw new Error("no WebSocket pair");
  server.binaryType = "arraybuffer";
  server.accept();
  const send = (message: unknown) => server.send(new TextEncoder().encode(JSON.stringify(message)));
  const usage = {
    promptTokenCount: 100,
    responseTokenCount: 20,
    totalTokenCount: 120,
    promptTokensDetails: [
      { modality: "TEXT", tokenCount: 60 },
      { modality: "AUDIO", tokenCount: 40 },
    ],
    responseTokensDetails: [{ modality: "AUDIO", tokenCount: 20 }],
  };
  server.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer));
    let message: { setup?: unknown; clientContent?: { turns?: { parts?: { text?: string }[] }[] } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (message.setup !== undefined) {
      send({ setupComplete: {} });
      send({ sessionResumptionUpdate: { newHandle: crypto.randomUUID(), resumable: true } });
      return;
    }
    const said = message.clientContent?.turns?.[0]?.parts?.[0]?.text;
    if (said === undefined) return;
    if (said === "goaway") send({ goAway: { timeLeft: "11s" } });
    send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }], role: "model" } } });
    send({ serverContent: { turnComplete: true }, usageMetadata: usage });
    send({ sessionResumptionUpdate: { newHandle: crypto.randomUUID(), resumable: true } });
  });
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * GPT-Live (step 9g), shaped as T21 saw it: its own events put `event_id` before `type`.
 * - `session.start` gets `session.started`, echoing the session it was given (so a test sees the
 *   model the relay set), and a `session.usage.updated` of 2 seconds.
 * - `response.create` runs one backend call on the session's backend model: a `response.event` whose
 *   nested `response.completed` carries 781 input tokens (90 cached, 1 written) and 57 output.
 * - `session.close` gets `session.closed` with 3 seconds, then the socket closes.
 */
function gptLiveSession(): Response {
  const [client, server] = Object.values(new WebSocketPair());
  if (client === undefined || server === undefined) throw new Error("no WebSocket pair");
  server.accept();
  let session: Record<string, unknown> = {};
  let backendCalls = 0;
  const send = (type: string, rest: Record<string, unknown>) => server.send(JSON.stringify({ event_id: `event_${crypto.randomUUID()}`, type, ...rest }));
  server.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: { type?: string; session?: Record<string, unknown> };
    try {
      message = JSON.parse(event.data) as typeof message;
    } catch {
      return;
    }
    if (message.type === "session.start") {
      session = { id: `live_${crypto.randomUUID()}`, ...message.session, status: "active" };
      send("session.started", { session });
      send("session.usage.updated", { usage: { seconds: 2 } });
    } else if (message.type === "response.create") {
      backendCalls += 1;
      const delegation = session.delegation as { responses?: { model?: string } } | undefined;
      const response = {
        id: `resp_mock_${String(backendCalls)}`,
        model: delegation?.responses?.model ?? "gpt-6-luna",
        status: "completed",
        usage: { input_tokens: 781, input_tokens_details: { cached_tokens: 90, cache_write_tokens: 1 }, output_tokens: 57, output_tokens_details: { reasoning_tokens: 43 }, total_tokens: 838 },
      };
      send("response.event", { delegation_id: `item_${String(backendCalls)}`, event: { type: "response.completed", sequence_number: 1, response } });
    } else if (message.type === "session.close") {
      send("session.closed", { reason: "close_requested", session, usage: { seconds: 3 } });
      server.close(1000, "closed");
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}

/** Deepgram's project, as the mock's key sees it. */
const MOCK_PROJECT = "mock-project";

/** Deepgram's live stream (step 10a): `Results` for each audio frame, `Metadata` at `CloseStream`. */
function deepgramStream(url: URL): Response {
  const [client, server] = Object.values(new WebSocketPair());
  if (client === undefined || server === undefined) throw new Error("no WebSocket pair");
  server.binaryType = "arraybuffer";
  server.accept();
  const usd = /^[0-9.]{1,12}$/u.test(url.searchParams.get("mock_usd") ?? "") ? url.searchParams.get("mock_usd")! : null;
  const requestId = `${usd === null ? "mock" : `mock_usd_${usd}`}_${crypto.randomUUID()}`;
  // 16 kHz, 16-bit, mono: 32,000 bytes a second.
  let heard = 0;
  server.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data !== "string") {
      const start = heard / 32_000;
      heard += (data as ArrayBuffer).byteLength;
      const duration = (data as ArrayBuffer).byteLength / 32_000;
      server.send(
        JSON.stringify({ type: "Results", channel_index: [0, 1], duration, start, is_final: true, speech_final: false, channel: { alternatives: [{ transcript: "", confidence: 1, words: [] }] }, metadata: { request_id: requestId } }),
      );
      return;
    }
    if (data.includes('"CloseStream"')) {
      server.send(JSON.stringify({ type: "Metadata", request_id: requestId, created: new Date().toISOString(), duration: heard / 32_000, channels: 1 }));
      server.close(1000, "");
    }
  });
  return new Response(null, { status: 101, webSocket: client, headers: { "dg-request-id": requestId } });
}

/** ElevenLabs' streaming text to speech (step 10a): audio for each text, the final frame at the closing `""`. */
function elevenLabsStream(): Response {
  const [client, server] = Object.values(new WebSocketPair());
  if (client === undefined || server === undefined) throw new Error("no WebSocket pair");
  server.accept();
  server.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let text: unknown;
    try {
      text = (JSON.parse(event.data) as { text?: unknown }).text;
    } catch {
      return;
    }
    if (text === "") {
      server.send(JSON.stringify({ audio: null, isFinal: true }));
      server.close(1000, "");
    } else if (typeof text === "string" && text.trim() !== "") {
      server.send(JSON.stringify({ audio: "AAAA", isFinal: null, normalizedAlignment: null }));
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}

function realtimeSession(): Response {
  const [client, server] = Object.values(new WebSocketPair());
  if (client === undefined || server === undefined) throw new Error("no WebSocket pair");
  // Binary frames as bytes, so an echo sends back what came.
  server.binaryType = "arraybuffer";
  server.accept();
  server.send(JSON.stringify({ type: "session.created" }));
  const audio = "A".repeat(3_200);
  server.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data === "string" && data.startsWith('{"type":"mock.')) {
      const message = JSON.parse(data) as { type: string; seconds?: number; usageEvery?: number; event_id?: unknown; usage?: unknown; repeat?: number; model?: unknown };
      if (message.type === "mock.answer") {
        const frames = Math.max(1, Math.min(20 * 60, Math.round((message.seconds ?? 1) * 20)));
        server.send(JSON.stringify({ type: "response.created", response: { id: message.event_id } }));
        let sent = 0;
        const timer = setInterval(() => {
          try {
            if (sent < frames) {
              server.send(JSON.stringify({ type: "response.output_audio.delta", response_id: message.event_id, n: sent, delta: audio }));
              sent += 1;
              return;
            }
            clearInterval(timer);
            server.send(JSON.stringify({ type: "mock.usage", event_id: message.event_id, usage: message.usage }));
            server.send(JSON.stringify({ type: "response.done", event_id: `done-${String(message.event_id)}`, response: { id: message.event_id, usage: message.usage } }));
          } catch {
            clearInterval(timer);
          }
        }, 50);
        server.addEventListener("close", () => clearInterval(timer));
      } else if (message.type === "mock.turn") {
        const usage = JSON.stringify({ type: "mock.usage", event_id: message.event_id, usage: message.usage });
        const done = JSON.stringify({ type: "response.done", event_id: `done-${String(message.event_id)}`, response: { id: message.event_id, usage: message.usage } });
        const times = Math.max(1, Math.min(5, message.repeat ?? 1));
        for (let i = 0; i < times; i += 1) server.send(usage);
        for (let i = 0; i < times; i += 1) server.send(done);
      } else if (message.type === "mock.transcribe") {
        const model = typeof message.model === "string" ? message.model : "gpt-4o-transcribe";
        server.send(JSON.stringify({ type: "session.updated", event_id: "mock-session", session: { type: "realtime", audio: { input: { transcription: { model } } } } }));
        // OpenAI commits the audio item first: its transcription comes after, under the model of that moment.
        server.send(JSON.stringify({ type: "input_audio_buffer.committed", event_id: "mock-commit", item_id: "mock-item" }));
        server.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", event_id: message.event_id, item_id: "mock-item", transcript: "", usage: message.usage }));
      } else if (message.type === "mock.big") {
        server.send(`{"audio_base_64":"${"B".repeat(512 * 1024)}","isFinal":false,"type":"audio"}`);
      } else if (message.type === "mock.stream") {
        const frames = Math.max(0, Math.min(20 * 600, Math.round((message.seconds ?? 1) * 20)));
        const usageEvery = Math.max(0, Math.round(message.usageEvery ?? 0));
        const stream = crypto.randomUUID().slice(0, 8);
        let sent = 0;
        const timer = setInterval(() => {
          try {
            server.send(JSON.stringify({ type: "response.output_audio.delta", n: sent, at: Date.now(), delta: audio }));
          } catch {
            clearInterval(timer);
            return;
          }
          sent += 1;
          if (usageEvery > 0 && sent % usageEvery === 0) {
            server.send(JSON.stringify({ type: "mock.usage", event_id: `${stream}-${sent}`, usage: { input_tokens: 100, output_tokens: 20 } }));
          }
          if (sent >= frames) {
            clearInterval(timer);
            server.send(JSON.stringify({ type: "mock.stream.done", frames: sent }));
          }
        }, 50);
        server.addEventListener("close", () => clearInterval(timer));
      }
      return;
    }
    server.send(data);
  });
  return new Response(null, { status: 101, webSocket: client });
}
