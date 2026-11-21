/**
 * Step 7a: conversation storage, carried over from v1 onto v2's call pipeline
 * (plan D13, section 4.3). The record format and the log are v1's, so these
 * record and log tests are v1's own, ported. The provider is mocked at
 * `fetch`; no test waits on a real timer.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { conversationRecord, type ConversationCapture } from "../src/conversations/record.ts";
import { CallBudget, RETENTION_CURSOR, runConversationRetention } from "../src/conversations/retention.ts";
import { planIncludes } from "../src/billing/access.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { storedPassthrough } from "../src/providers/passthrough.ts";
import { ACCOUNT_ID, clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedAccount, seedAppKey, seedManagementKey } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const ORIGIN = "https://gateway.test";
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const KEEP_ALL = { images: true, audio: true, files: true };

let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
  clearCaches();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => vi.restoreAllMocks());

/** The test bucket, bound in vitest.config.ts. */
function bucket(): R2Bucket {
  return (env as unknown as { CONVERSATIONS: R2Bucket }).CONVERSATIONS;
}

const encoder = new TextEncoder();

function capture(overrides: Partial<ConversationCapture> = {}): ConversationCapture {
  return {
    eventId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    appId: "conversation-unit",
    userId: "user-1",
    installId: null,
    appVersion: "1.0",
    clientTraceId: "message-1",
    endpointSlug: null,
    route: "openai/v1/responses",
    provider: "openai",
    model: "gpt-5.6-sol",
    status: "ok",
    httpStatus: 200,
    latencyMs: 12,
    keep: KEEP_ALL,
    request: { contentType: "application/json", bytes: encoder.encode('{"input":"hi"}'), totalBytes: 14 },
    response: {
      contentType: "application/json",
      bytes: encoder.encode('{"id":"resp_1"}'),
      totalBytes: 15,
      aborted: false,
    },
    ...overrides,
  };
}

async function gunzip(bytes: ArrayBuffer): Promise<string> {
  return new Response(new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"))).text();
}

async function storedRecords(appId: string): Promise<Record<string, any>[]> {
  const listing = await bucket().list({ prefix: `conversations/${appId}/` });
  const records: Record<string, any>[] = [];
  for (const object of listing.objects) {
    if (!object.key.endsWith(".jsonl.gz")) continue;
    const body = await bucket().get(object.key);
    const text = await gunzip(await body!.arrayBuffer());
    for (const line of text.split("\n").filter(Boolean)) records.push(JSON.parse(line) as Record<string, any>);
  }
  return records;
}

/** An OpenAI connection with its own slug. */
async function connection(type = "openai"): Promise<string> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `${type}-${id.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, type, ""], "sk-test-provider-key-5678");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, '5678', NULL, NULL, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, type, slug, type, blob, now, now)
    .run();
  return slug;
}

/** An app with this config (authentication added), and an app key for it. */
async function appWith(config: Record<string, unknown>): Promise<{ appId: string; key: string }> {
  await seedAccount();
  const appId = `app_conv_${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO app(id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)",
  )
    .bind(appId, ACCOUNT_ID, appId, JSON.stringify({ authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, ...config }), now, now)
    .run();
  const { key } = await seedAppKey(appId);
  return { appId, key };
}

/** An app that stores its conversations, routed to a new OpenAI connection's responses and chat. */
async function storingApp(conversations: Record<string, unknown> = { store: true }, extra: Record<string, unknown> = {}) {
  const slug = await connection();
  const { appId, key } = await appWith({
    routing: { providers: { [slug]: { operations: ["openai.responses", "openai.chat"], models: ["gpt-4o-mini"] } } },
    conversations,
    ...extra,
  });
  return { slug, appId, key };
}

async function call(path: string, init: RequestInit, bindings: Env = env): Promise<{ response: Response; text: string }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init), bindings, ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text };
}

function responsesRequest(key: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "user-1", ...headers },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [{ role: "user", content: [
        { type: "input_text", text: "200 g chicken soup" },
        { type: "input_image", image_url: `data:image/png;base64,${PIXEL}` },
      ] }],
    }),
  };
}

function providerAnswers(): void {
  fetchSpy.mockImplementation(async () =>
    Response.json({ id: "resp_1", output_text: "Logged.", usage: { input_tokens: 3, output_tokens: 2 } }));
}

async function chargeIds(appId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT id FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all<{ id: string }>();
  return results.map((row) => row.id);
}

describe("conversation records", () => {
  it("keeps every kind of media beside the record, once each", async () => {
    const body = JSON.stringify({
      input: [
        { type: "input_text", text: "lunch" },
        { type: "input_image", image_url: `data:image/png;base64,${PIXEL}` },
        { type: "input_image", image_url: `data:image/png;base64,${PIXEL}` },
        { type: "input_audio", input_audio: { data: "UklGRiQAAABXQVZF", format: "wav" } },
        { type: "input_file", file_data: "data:application/pdf;base64,JVBERi0xLjQ=" },
      ],
      contents: [{ parts: [{ inlineData: { mimeType: "audio/ogg", data: "T2dnUwACAAAA" } }] }],
    });
    const { line, media } = await conversationRecord(capture({
      request: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: body.length },
    }));
    const record = JSON.parse(line) as {
      request: { kind: string; value: { input: Record<string, unknown>[]; contents: { parts: { inlineData: { data: string } }[] }[] } };
    };
    expect(record.request.kind).toBe("json");
    expect(media.map((item) => item.name.replace(/[0-9a-f]{64}/, "<sha>"))).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}\/media\/<sha>\.png$/),
      expect.stringMatching(/\/media\/<sha>\.wav$/),
      expect.stringMatching(/\/media\/<sha>\.pdf$/),
      expect.stringMatching(/\/media\/<sha>\.ogg$/),
    ]);
    const input = record.request.value.input;
    expect(input[0]).toEqual({ type: "input_text", text: "lunch" });
    expect(input[1]!.image_url).toBe(`agw-media:${media[0]!.name}`);
    expect(input[2]!.image_url).toBe(`agw-media:${media[0]!.name}`);
    expect((input[3]!.input_audio as { data: string }).data).toBe(`agw-media:${media[1]!.name}`);
    expect(input[4]!.file_data).toBe(`agw-media:${media[2]!.name}`);
    expect(record.request.value.contents[0]!.parts[0]!.inlineData.data).toBe(`agw-media:${media[3]!.name}`);
  });

  it("records the kinds of media an app leaves out by their type and size", async () => {
    const body = JSON.stringify({
      input: [
        { type: "input_image", image_url: `data:image/png;base64,${PIXEL}` },
        { type: "input_audio", input_audio: { data: "UklGRiQAAABXQVZF", format: "wav" } },
      ],
      contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: "UklGRiQAAABXQVZF" } }] }],
    });
    const { line, media } = await conversationRecord(capture({
      keep: { images: true, audio: false, files: true },
      request: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: body.length },
    }));
    expect(media).toHaveLength(1);
    expect(line).not.toContain("UklGRiQAAABXQVZF");
    expect(line).toContain("agw-omitted:audio/wav;12");
  });

  it("treats Anthropic's sources as attachments, plain-text documents included", async () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQ=" } },
        { type: "document", source: { type: "text", media_type: "text/plain", data: "a menu" } },
      ] }],
    });
    const anthropic = (keep: { images: boolean; audio: boolean; files: boolean }) => conversationRecord(capture({
      keep,
      request: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: body.length },
    }));

    const kept = await anthropic({ images: true, audio: true, files: true });
    expect(kept.media.map((item) => item.mime)).toEqual(["image/png", "application/pdf", "text/plain"]);
    expect(kept.media[2]!.name).toMatch(/\.txt$/);
    expect(new TextDecoder().decode(kept.media[2]!.bytes)).toBe("a menu");
    const left = await anthropic({ images: false, audio: true, files: false });
    expect(left.media).toHaveLength(0);
    expect(left.line).not.toContain(PIXEL);
    expect(left.line).not.toContain("a menu");
    expect(left.line).toContain("agw-omitted:image/png;");
    expect(left.line).toContain("agw-omitted:application/pdf;8");
    expect(left.line).toContain("agw-omitted:text/plain;6");
  });

  it("keeps Anthropic custom-content documents as attachments, and tool calls whatever their shape", async () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [
          { type: "document", title: "Menu", source: { type: "content", content: [{ type: "text", text: "soup 200 g" }] } },
        ] },
        { role: "assistant", content: [
          { type: "tool_use", id: "t1", name: "save", input: { type: "text", media_type: "text/plain", data: "two eggs" } },
        ] },
      ],
    });
    const record = async (files: boolean) => (await conversationRecord(capture({
      keep: { images: true, audio: true, files },
      request: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: body.length },
    }))).line;

    const kept = await record(true);
    expect(kept).toContain('"text":"soup 200 g"');
    const left = await record(false);
    expect(left).not.toContain("soup 200 g");
    expect(left).toContain('"title":"Menu"');
    expect(left).toContain('"text":"agw-omitted:text/plain;10"');
    // A tool call is the conversation, whatever its arguments look like.
    for (const line of [kept, left]) expect(line).toContain('"data":"two eggs"');
  });

  it("records left-out media by its exact size, and audio of no stated format as audio", async () => {
    // `YQ==` is one byte; a chat reply's audio does not repeat its format.
    const body = JSON.stringify({ choices: [{ message: { audio: { id: "audio_1", data: "YQ==" } } }] });
    const reply = (audio: boolean) => conversationRecord(capture({
      keep: { images: true, audio, files: true },
      response: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: body.length, aborted: false },
    }));

    expect((await reply(false)).line).toContain('"data":"agw-omitted:audio;1"');
    const kept = await reply(true);
    expect(kept.media).toHaveLength(1);
    expect(kept.media[0]!.name).toMatch(/\/media\/[0-9a-f]{64}\.bin$/);
    expect(kept.media[0]!.mime).toBe("application/octet-stream");
  });

  it("keeps a transcription's fields and its recording, or the recording's size alone", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(64)], "voice.wav", { type: "audio/wav" }));
    form.set("language", "en");
    const request = new Request("https://example.test", { method: "POST", body: form });
    const bytes = new Uint8Array(await request.arrayBuffer());
    const transcription = (keep: { images: boolean; audio: boolean; files: boolean }) => conversationRecord(capture({
      keep,
      request: { contentType: request.headers.get("content-type")!, bytes, totalBytes: bytes.byteLength },
      response: { contentType: "application/json", bytes: encoder.encode('{"text":"two eggs"}'), totalBytes: 19, aborted: false },
    }));

    const kept = await transcription({ images: true, audio: true, files: true });
    const record = JSON.parse(kept.line) as {
      request: { kind: string; fields: Record<string, unknown> };
      response: { value: { text: string } };
    };
    expect(kept.media).toHaveLength(1);
    expect(record.request.kind).toBe("form");
    expect(record.request.fields.language).toBe("en");
    expect(record.request.fields.file).toEqual({
      file: "voice.wav", type: "audio/wav", bytes: 64, content: `agw-media:${kept.media[0]!.name}`,
    });
    expect(record.response.value.text).toBe("two eggs");

    const left = await transcription({ images: true, audio: false, files: true });
    expect(left.media).toHaveLength(0);
    expect((JSON.parse(left.line) as { request: { fields: { file: { content: string } } } }).request.fields.file.content)
      .toBe("agw-omitted:audio/wav;64");
  });

  it("records a body it could not capture by its size", async () => {
    const { line } = await conversationRecord(capture({
      response: { contentType: "application/json", bytes: null, totalBytes: 9_000_000, aborted: false },
    }));
    expect(JSON.parse(line).response).toEqual({
      kind: "omitted",
      content_type: "application/json",
      reason: "too_large",
      bytes: 9_000_000,
    });
  });

  it("keeps a streamed answer's pieces of audio as they came, or their size alone", async () => {
    const stream = [
      `data: ${JSON.stringify({ type: "response.output_audio.delta", delta: "UklGRiQAAABXQVZF" })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "Two eggs" })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: "UklGRiQAAABXQVZF" } } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const streamed = async (audio: boolean) => {
      const { line, media } = await conversationRecord(capture({
        keep: { images: true, audio, files: true },
        response: { contentType: "text/event-stream", bytes: encoder.encode(stream), totalBytes: stream.length, aborted: false },
      }));
      expect(media).toHaveLength(0);
      return (JSON.parse(line) as { response: { text: string } }).response.text;
    };

    const kept = await streamed(true);
    expect(kept.match(/UklGRiQAAABXQVZF/g)).toHaveLength(2);
    const left = await streamed(false);
    expect(left).not.toContain("UklGRiQAAABXQVZF");
    expect(left).toContain("agw-omitted:audio;");
    for (const text of [kept, left]) {
      expect(text).toContain("Two eggs");
      expect(text).toContain("data: [DONE]");
    }
  });

  it("keeps a spoken reply as media", async () => {
    const speech = new Uint8Array([1, 2, 3, 4]);
    const { line, media } = await conversationRecord(capture({
      response: { contentType: "audio/mpeg", bytes: speech, totalBytes: 4, aborted: false },
    }));
    expect(media[0]!.name).toMatch(/\/media\/[0-9a-f]{64}\.mp3$/);
    expect(JSON.parse(line).response).toEqual({
      kind: "media", content_type: "audio/mpeg", bytes: 4, content: `agw-media:${media[0]!.name}`,
    });
  });

  it("keeps a record within the log's row size counted in bytes, not characters", async () => {
    const text = "食".repeat(200_000);
    const body = JSON.stringify({ input: [text, text, text, text] });
    const { line } = await conversationRecord(capture({
      request: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: encoder.encode(body).byteLength },
    }));
    expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(1_500_000);
    expect(JSON.parse(line).request.reason).toBe("too_large");
  });
});

describe("ConversationLog", () => {
  it("holds records until a batch is written, then writes them as one gzipped file", async () => {
    const appId = `log-${crypto.randomUUID().slice(0, 8)}`;
    const log = env.CONVERSATION_LOG.getByName(appId);
    await log.append(capture({ appId, eventId: "event-1" }));
    await log.append(capture({ appId, eventId: "event-2" }));
    expect(await log.pendingCount()).toBe(2);
    expect(await storedRecords(appId)).toEqual([]);

    // The alarm the first append set is what writes the batch.
    expect(await runDurableObjectAlarm(log)).toBe(true);
    expect(await log.pendingCount()).toBe(0);
    const listing = await bucket().list({ prefix: `conversations/${appId}/` });
    expect(listing.objects).toHaveLength(1);
    expect(listing.objects[0]!.key).toMatch(
      new RegExp(`^conversations/${appId}/\\d{4}-\\d{2}-\\d{2}/\\d{6}-[a-f0-9]{16}\\.jsonl\\.gz$`),
    );
    expect((await storedRecords(appId)).map((record) => record.event_id)).toEqual(["event-1", "event-2"]);

    // A batch is named from its earliest record, whatever order they arrived in.
    const late = `log-${crypto.randomUUID().slice(0, 8)}`;
    const lateLog = env.CONVERSATION_LOG.getByName(late);
    await lateLog.append(capture({ appId: late, createdAt: "2026-11-02T00:00:01.000Z" }));
    await lateLog.append(capture({ appId: late, createdAt: "2026-11-01T23:59:59.000Z" }));
    await lateLog.flush();
    const lateKeys = (await bucket().list({ prefix: `conversations/${late}/` })).objects.map((object) => object.key);
    expect(lateKeys).toEqual([expect.stringMatching(new RegExp(`^conversations/${late}/2026-11-01/235959-`))]);

    // Nothing pending writes nothing.
    await log.flush();
    expect((await bucket().list({ prefix: `conversations/${appId}/` })).objects).toHaveLength(1);
  });
});

describe("conversation storage through the gateway", () => {
  it("stores a call's request and response under the client's trace id, with the charge's own id", async () => {
    const { slug, appId, key } = await storingApp();
    providerAnswers();
    const { response, text } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key, { "x-client-trace-id": "message-42" }));
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ output_text: "Logged." });
    await env.CONVERSATION_LOG.getByName(appId).flush();

    const [record] = await storedRecords(appId);
    expect(record).toMatchObject({
      app_id: appId,
      user_id: "user-1",
      trace_id: "message-42",
      route: `${slug}/v1/responses`,
      provider: "openai",
      model: "gpt-4o-mini",
      status: "ok",
      http_status: 200,
      response: { kind: "json", value: { id: "resp_1", output_text: "Logged." } },
    });
    const image = record!.request.value.input[0].content[1].image_url as string;
    expect(image).toMatch(/^agw-media:\d{4}-\d{2}-\d{2}\/media\/[0-9a-f]{64}\.png$/);
    // The stored conversation and its charge name each other.
    expect(await chargeIds(appId)).toEqual([record!.event_id]);
  });

  it("stores a streamed answer whole, as the app received it", async () => {
    const { slug, appId, key } = await storingApp();
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Two " } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "eggs" } }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    fetchSpy.mockImplementation(async () => new Response(events, { headers: { "content-type": "text/event-stream" } }));
    const { response, text } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "user-1" },
      body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "breakfast" }] }),
    });
    expect(response.status).toBe(200);
    expect(text).toContain("eggs");
    await env.CONVERSATION_LOG.getByName(appId).flush();
    const [record] = await storedRecords(appId);
    expect(record!.response.kind).toBe("text");
    expect(record!.response.text).toContain('"content":"eggs"');
    expect(record!.response.text).toContain("data: [DONE]");
    // As the provider received it: the gateway asked for usage in the stream.
    expect(record!.request.value).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("stores a preset's call as the provider received it, naming the preset", async () => {
    const slug = await connection();
    const { appId, key } = await appWith({
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
      presets: { meal: { provider: slug, operation: "openai.chat", model: "gpt-4o-mini", params: { temperature: 0 } } },
      conversations: { store: true },
    });
    fetchSpy.mockImplementation(async () =>
      Response.json({ id: "c1", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    const { response } = await call(`/v2/apps/${appId}/presets/meal`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "user-1" },
      body: JSON.stringify({ messages: [{ role: "user", content: "two eggs" }], temperature: 1 }),
    });
    expect(response.status).toBe(200);
    await env.CONVERSATION_LOG.getByName(appId).flush();
    const [record] = await storedRecords(appId);
    expect(record).toMatchObject({ endpoint: "meal", model: "gpt-4o-mini" });
    expect(record!.request.value).toMatchObject({ model: "gpt-4o-mini", temperature: 0 });
  });

  it("stores nothing for an opted-out request, or for an app that does not store", async () => {
    const { slug, appId, key } = await storingApp();
    providerAnswers();
    const optedOut = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key, { "x-conversation-storage": "off" }));
    expect(optedOut.response.status).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName(appId).pendingCount()).toBe(0);

    const plain = await storingApp({ store: false });
    const served = await call(`/v2/apps/${plain.appId}/proxy/${plain.slug}/v1/responses`, responsesRequest(plain.key));
    expect(served.response.status).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName(plain.appId).pendingCount()).toBe(0);
  });

  it("refuses a storage header it cannot read", async () => {
    const { slug, appId, key } = await storingApp();
    providerAnswers();
    const { response, text } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key, { "x-conversation-storage": "on" }));
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "invalid_request" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still answers, and charges, when storing the conversation fails", async () => {
    const { slug, appId, key } = await storingApp();
    providerAnswers();
    const broken = new Proxy(env, {
      get: (target, property, receiver) =>
        property === "CONVERSATION_LOG"
          ? { getByName: () => ({ append: () => Promise.reject(new Error("log is down")) }) }
          : Reflect.get(target, property, receiver),
    });
    const { response, text } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key), broken);
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ output_text: "Logged." });
    expect(await chargeIds(appId)).toHaveLength(1);
    expect(await storedRecords(appId)).toEqual([]);
  });

  it("stores model calls alone: never a passthrough path", async () => {
    const slug = await connection();
    await env.DB.prepare("UPDATE provider_connection SET passthrough_json = ? WHERE slug = ?")
      .bind(storedPassthrough([{ method: "GET", path: "v1/files/{file_id}" }]), slug)
      .run();
    const { appId, key } = await appWith({
      routing: { providers: { [slug]: { operations: ["passthrough"] } } },
      conversations: { store: true },
    });
    fetchSpy.mockImplementation(async () => Response.json({ id: "file-1", filename: "menu.pdf" }));
    const { response, text } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/files/file-1`, {
      headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1" },
    });
    expect(response.status, text).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName(appId).pendingCount()).toBe(0);
  });
});

describe("turning conversation storage on", () => {
  async function save(config: Record<string, unknown>, bindings: Env = env): Promise<{ status: number; body: Record<string, any> }> {
    const key = await seedManagementKey();
    const { response, text } = await call("/v2/admin/apps", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ name: `conv-${crypto.randomUUID().slice(0, 6)}`, config: { authentication: { type: "api_key", end_user: { source: "none" } }, ...config } }),
    }, bindings);
    return { status: response.status, body: JSON.parse(text) as Record<string, any> };
  }

  it("keeps the setting, and writes it only when it differs from the defaults", async () => {
    const stored = await save({ conversations: { store: true, retention_days: 30, keep: { audio: false } } });
    expect(stored.status).toBe(201);
    const { app } = stored.body as { app: { id: string; config: Record<string, any> } };
    expect(app.config.conversations).toEqual({ store: true, retention_days: 30, keep: { images: true, audio: false, files: true } });

    const off = await save({ conversations: { store: false } });
    const { app: plain } = off.body as { app: { id: string; config: Record<string, unknown> } };
    expect(plain.config).not.toHaveProperty("conversations");
    const row = await env.DB.prepare("SELECT config_json FROM app WHERE id = ?").bind(plain.id).first<{ config_json: string }>();
    expect(row!.config_json).not.toContain("conversations");
  });

  it("refuses to turn storage on where the deployment has no bucket", async () => {
    const withoutBucket = new Proxy(env, {
      get: (target, property, receiver) => (property === "CONVERSATIONS" ? undefined : Reflect.get(target, property, receiver)),
    });
    const refused = await save({ conversations: { store: true } }, withoutBucket);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("needs a plan that includes it; with no list, a plan includes everything", () => {
    const plan = (limits: unknown) => ({ state: "billed" as const, plan: { planKey: "p", planName: "P", isDefault: false, limits }, subscription: null });
    expect(planIncludes({ state: "self_hosted" }, "conversationStorage")).toBe(true);
    expect(planIncludes({ state: "unavailable" }, "conversationStorage")).toBe(false);
    expect(planIncludes(plan(undefined), "conversationStorage")).toBe(true);
    expect(planIncludes(plan({ maxApps: 3 }), "conversationStorage")).toBe(true);
    expect(planIncludes(plan({ includes: ["conversationStorage"] }), "conversationStorage")).toBe(true);
    expect(planIncludes(plan({ includes: [] }), "conversationStorage")).toBe(false);
    expect(() => planIncludes(plan({ includes: "all" }), "conversationStorage")).toThrow(/invalid/);
  });
});

describe("reading stored conversations", () => {
  async function get(path: string, bindings: Env = env): Promise<{ response: Response; bytes: ArrayBuffer }> {
    const key = await seedManagementKey({ grant: "read" });
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${key}` } }), bindings, ctx);
    const bytes = await response.arrayBuffer();
    await waitOnExecutionContext(ctx);
    return { response, bytes };
  }
  const json = (bytes: ArrayBuffer) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;

  async function storedFiles(): Promise<string> {
    const { appId } = await appWith({});
    const put = (name: string, body: string, contentType: string, records?: number) =>
      bucket().put(`conversations/${appId}/${name}`, body, {
        httpMetadata: { contentType },
        ...(records === undefined ? {} : { customMetadata: { records: String(records) } }),
      });
    await put("2026-11-01/010203-aaaaaaaa.jsonl.gz", "one", "application/gzip", 3);
    await put("2026-11-01/media/" + "a".repeat(64) + ".png", "pixel", "image/png");
    await put("2026-11-02/010203-bbbbbbbb.jsonl.gz", "two", "application/gzip", 1);
    await put("2026-11-03/010203-cccccccc.jsonl.gz", "three", "application/gzip", 2);
    return appId;
  }

  it("lists an app's batches in a range of days, without its media", async () => {
    const appId = await storedFiles();
    const all = json((await get(`/v2/admin/apps/${appId}/conversations?to=2026-11-30`)).bytes);
    expect(all.files.map((file: { name: string }) => file.name)).toEqual([
      "2026-11-01/010203-aaaaaaaa.jsonl.gz",
      "2026-11-02/010203-bbbbbbbb.jsonl.gz",
      "2026-11-03/010203-cccccccc.jsonl.gz",
    ]);
    expect(all.files[0]).toMatchObject({ size: 3, records: 3 });
    expect(all.next_cursor).toBeNull();

    const middle = json((await get(`/v2/admin/apps/${appId}/conversations?from=2026-11-02&to=2026-11-02`)).bytes);
    expect(middle.files.map((file: { name: string }) => file.name)).toEqual(["2026-11-02/010203-bbbbbbbb.jsonl.gz"]);
  });

  it("downloads a batch or media as an attachment, as it is stored", async () => {
    const appId = await storedFiles();
    const batch = await get(`/v2/admin/apps/${appId}/conversations/file?name=${encodeURIComponent("2026-11-01/010203-aaaaaaaa.jsonl.gz")}`);
    expect(batch.response.status).toBe(200);
    expect(new TextDecoder().decode(batch.bytes)).toBe("one");
    expect(batch.response.headers.get("content-type")).toBe("application/gzip");
    expect(batch.response.headers.get("content-disposition")).toBe("attachment");
    expect(batch.response.headers.get("x-content-type-options")).toBe("nosniff");

    const media = await get(`/v2/admin/apps/${appId}/conversations/file?name=${encodeURIComponent(`2026-11-01/media/${"a".repeat(64)}.png`)}`);
    expect(media.response.status).toBe(200);
    expect(media.response.headers.get("content-disposition")).toBe("attachment");
  });

  it("names only files of the app's own folder, and only the caller's own apps", async () => {
    const appId = await storedFiles();
    const outside = await get(`/v2/admin/apps/${appId}/conversations/file?name=${encodeURIComponent("../other/2026-11-01/010203-aaaaaaaa.jsonl.gz")}`);
    expect(outside.response.status).toBe(400);
    const missing = await get(`/v2/admin/apps/${appId}/conversations/file?name=${encodeURIComponent("2026-11-09/010203-dddddddd.jsonl.gz")}`);
    expect(missing.response.status).toBe(404);

    const now = Date.now();
    const otherAccount = `org_${crypto.randomUUID().slice(0, 8)}`;
    const otherApp = `app_other_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Other', 'usr_test', ?, ?)")
        .bind(otherAccount, new Date(now).toISOString(), new Date(now).toISOString()),
      env.DB.prepare("INSERT INTO app(id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, '{}', 1, 'active', ?, ?)")
        .bind(otherApp, otherAccount, otherApp, now, now),
    ]);
    await bucket().put(`conversations/${otherApp}/2026-11-01/010203-aaaaaaaa.jsonl.gz`, "theirs");
    const list = await get(`/v2/admin/apps/${otherApp}/conversations`);
    expect(list.response.status).toBe(404);
    const file = await get(`/v2/admin/apps/${otherApp}/conversations/file?name=${encodeURIComponent("2026-11-01/010203-aaaaaaaa.jsonl.gz")}`);
    expect(file.response.status).toBe(404);
    expect(json(file.bytes)).toMatchObject({ error: { code: "app_not_found" } });
  });

  it("lists nothing where the deployment has no bucket", async () => {
    const appId = await storedFiles();
    const withoutBucket = new Proxy(env, {
      get: (target, property, receiver) => (property === "CONVERSATIONS" ? undefined : Reflect.get(target, property, receiver)),
    });
    const listed = await get(`/v2/admin/apps/${appId}/conversations`, withoutBucket);
    expect(json(listed.bytes)).toEqual({ app_id: appId, files: [], next_cursor: null });
  });
});

describe("conversation retention", () => {
  it("deletes days past an app's retention, and everything of an app that is gone", async () => {
    const { appId } = await storingApp({ store: true, retention_days: 30 });
    const store = bucket();
    const today = new Date().toISOString().slice(0, 10);
    await store.put(`conversations/${appId}/2020-01-01/000000-aaaaaaaa.jsonl.gz`, "old");
    await store.put(`conversations/${appId}/${today}/000000-bbbbbbbb.jsonl.gz`, "new");
    await store.put(`conversations/${appId}/2020-01-01/media/${"c".repeat(64)}.png`, "old image");
    await store.put(`conversations/${appId}/${today}/media/${"c".repeat(64)}.png`, "image");
    await store.put("conversations/conversation-deleted-app/2020-01-01/000000-dddddddd.jsonl.gz", "orphan");

    // Other tests in this file may have left batches of their own, so only these keys are asserted.
    const result = await runConversationRetention(store, env.DB, Date.now(), new CallBudget(500));
    expect(result.deletedObjects).toBeGreaterThanOrEqual(2);
    expect(result.removedApps).toBeGreaterThanOrEqual(1);
    const left = (await store.list({ prefix: "conversations/" })).objects.map((object) => object.key);
    expect(left).toContain(`conversations/${appId}/${today}/media/${"c".repeat(64)}.png`);
    expect(left).not.toContain(`conversations/${appId}/2020-01-01/media/${"c".repeat(64)}.png`);
    expect(left).toContain(`conversations/${appId}/${today}/000000-bbbbbbbb.jsonl.gz`);
    expect(left).not.toContain(`conversations/${appId}/2020-01-01/000000-aaaaaaaa.jsonl.gz`);
    expect(left.some((key) => key.startsWith("conversations/conversation-deleted-app/"))).toBe(false);
  });

  it("stops when the run's allowance runs out", async () => {
    const store = bucket();
    await store.put("conversations/conversation-budget-gone/2020-01-01/000000-eeeeeeee.jsonl.gz", "orphan");
    const budget = new CallBudget(2);
    await expect(runConversationRetention(store, env.DB, Date.now(), budget)).resolves.toBeDefined();
    expect(budget.remaining).toBeLessThanOrEqual(1);
    expect((await store.list({ prefix: "conversations/conversation-budget-gone/" })).objects).toHaveLength(1);
  });

  it("starts each run after the app the last one finished", async () => {
    const store = bucket();
    await store.put("conversations/cursor-a/2020-01-01/000000-aaaaaaaa.jsonl.gz", "orphan");
    await store.put("conversations/cursor-b/2020-01-01/000000-bbbbbbbb.jsonl.gz", "orphan");
    await store.put(RETENTION_CURSOR, "conversations/cursor-a/");
    // The cursor read, the list of apps, one app's list and delete, and the cursor write.
    const budget = new CallBudget(5);
    await runConversationRetention(store, env.DB, Date.now(), budget);
    expect((await store.list({ prefix: "conversations/cursor-b/" })).objects).toHaveLength(0);
    expect((await store.list({ prefix: "conversations/cursor-a/" })).objects).toHaveLength(1);
    expect(await (await store.get(RETENTION_CURSOR))!.text()).toBe("conversations/cursor-b/");
  });
});
