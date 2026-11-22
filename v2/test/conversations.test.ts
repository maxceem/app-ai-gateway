/**
 * Step 7a: conversation storage, carried over from v1 onto v2's call pipeline
 * (plan D13, section 4.3). The record format and the log are v1's, so these
 * record and log tests are v1's own, ported. The provider is mocked at
 * `fetch`; no test waits on a real timer.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { conversationRecord, type CaptureHints, type ConversationCapture } from "../src/conversations/record.ts";
import { RETENTION_CURSOR, RETENTION_D1_QUERIES, runConversationRetention } from "../src/conversations/retention.ts";
import { conversationReadBudget } from "../src/maintenance/nightly.ts";
import { QueryBudget } from "../src/core/query-budget.ts";
import { appFolderName, appPrefix } from "../src/conversations/storage.ts";
import type { ConversationLog } from "../src/do/ConversationLog.ts";
import { planIncludes } from "../src/billing/access.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { storedPassthrough } from "../src/providers/passthrough.ts";
import { issueGatewayToken } from "../src/client-auth/gateway-token.ts";
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

/** A capture for the recorder; what an operation declares may be given flat, as `hints`' fields. */
function capture(given: Partial<ConversationCapture> & CaptureHints = {}): ConversationCapture {
  const { audio, rawAudioRequest, rawAudioResponse, audioFormFields, imageFormFields, responseJsonLines, ...overrides } = given;
  const hints: CaptureHints = {
    ...(audio !== undefined ? { audio } : {}),
    ...(rawAudioRequest !== undefined ? { rawAudioRequest } : {}),
    ...(rawAudioResponse !== undefined ? { rawAudioResponse } : {}),
    ...(audioFormFields !== undefined ? { audioFormFields } : {}),
    ...(imageFormFields !== undefined ? { imageFormFields } : {}),
    ...(responseJsonLines !== undefined ? { responseJsonLines } : {}),
  };
  return {
    hints,
    eventId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    accountId: ACCOUNT_ID,
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
  const listing = await bucket().list({ prefix: `${appPrefix(ACCOUNT_ID, appId)}` });
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

  it("treats the Responses API's generated images as images, by their declared format (Sol round 10)", async () => {
    const body = JSON.stringify({
      output: [{ type: "image_generation_call", id: "ig_1", status: "completed", output_format: "webp", result: PIXEL }],
    });
    const stream = `data: ${JSON.stringify({ type: "response.image_generation_call.partial_image", output_format: "jpeg", partial_image_b64: PIXEL })}\n\n`;
    const reply = (images: boolean, text: string, contentType: string) => conversationRecord(capture({
      keep: { images, audio: true, files: true },
      response: { contentType, bytes: encoder.encode(text), totalBytes: text.length, aborted: false },
    }));

    // Kept, the image is named by its own bytes (PIXEL is a PNG), not by the declared format.
    const kept = await reply(true, body, "application/json");
    expect(kept.media.map((item) => item.mime)).toEqual(["image/png"]);
    const left = await reply(false, body, "application/json");
    expect(left.media).toHaveLength(0);
    expect(left.line).not.toContain(PIXEL);
    expect(left.line).toContain("agw-omitted:image/webp;");
    const streamed = await reply(false, stream, "text/event-stream");
    expect(streamed.media).toHaveLength(0);
    expect(streamed.line).not.toContain(PIXEL);
    expect(streamed.line).toContain("agw-omitted:image/jpeg;");
  });

  it("names a generated image by its own bytes: a JPEG in b64_json is a JPEG (Astra round 2)", async () => {
    // The first bytes of a JPEG file (SOI, APP0, "JFIF").
    const jpeg = "/9j/4AAQSkZJRg==";
    const body = JSON.stringify({ created: 1, data: [{ b64_json: jpeg }] });
    const { media, line } = await conversationRecord(capture({
      keep: { images: true, audio: true, files: true },
      response: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: body.length, aborted: false },
    }));
    expect(media.map((item) => item.mime)).toEqual(["image/jpeg"]);
    expect(media[0]!.name).toMatch(/\.jpg$/);
    expect(line).toContain(`agw-media:${media[0]!.name}`);
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

  it("keeps an Anthropic custom-content document written as one string as an attachment (Astra round 3)", async () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: [
        { type: "document", title: "Menu", source: { type: "content", content: "soup 200 g" } },
      ] }],
    });
    const record = async (files: boolean) => (await conversationRecord(capture({
      keep: { images: true, audio: true, files },
      request: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: body.length },
    }))).line;

    expect(await record(true)).toContain('"content":"soup 200 g"');
    const left = await record(false);
    expect(left).not.toContain("soup 200 g");
    expect(left).toContain('"title":"Menu"');
    expect(left).toContain('"content":"agw-omitted:text/plain;10"');
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

  it("leaves out an operation's declared base64 audio, in JSON and in streamed lines, where audio is not kept (Sol round 1)", async () => {
    const audio = { fields: ["audio_base64"], mime: "audio/mpeg" };
    const noAudio = { images: true, audio: false, files: true };
    const whole = JSON.stringify({ audio_base64: "SUQzBAAAAAAA", alignment: { characters: ["h", "i"] } });
    const one = await conversationRecord(capture({
      keep: noAudio,
      audio,
      response: { contentType: "application/json", bytes: encoder.encode(whole), totalBytes: whole.length, aborted: false },
    }));
    expect(one.line).not.toContain("SUQzBAAAAAAA");
    expect(JSON.parse(one.line).response.value).toMatchObject({ audio_base64: expect.stringMatching(/^agw-omitted:audio\/mpeg;/), alignment: { characters: ["h", "i"] } });

    const lines = [whole, JSON.stringify({ audio_base64: "SUQzBAAAAAAB", alignment: null })].join("\n");
    const streamed = await conversationRecord(capture({
      keep: noAudio,
      audio,
      response: { contentType: "application/json", bytes: encoder.encode(lines), totalBytes: lines.length, aborted: false },
    }));
    expect(streamed.line).not.toContain("SUQzBAAAAAA");
    expect(JSON.parse(streamed.line).response).toMatchObject({ kind: "json", value: [{ alignment: { characters: ["h", "i"] } }, { alignment: null }] });

    // Where audio is kept, it is stored as media.
    const kept = await conversationRecord(capture({
      audio,
      response: { contentType: "application/json", bytes: encoder.encode(whole), totalBytes: whole.length, aborted: false },
    }));
    expect(kept.media).toHaveLength(1);
  });

  it("reads newline-delimited JSON before treating a body as a file, so its audio is left out (Sol round 2)", async () => {
    const audio = { fields: ["audio_base64"], mime: "audio/mpeg" };
    const noAudio = { images: true, audio: false, files: true };
    const lines = [
      JSON.stringify({ audio_base64: "SUQzBAAAAAAA", alignment: { characters: ["h"] } }),
      JSON.stringify({ audio_base64: "SUQzBAAAAAAB", alignment: null }),
    ].join("\n");
    const record = await conversationRecord(capture({
      keep: noAudio,
      audio,
      response: { contentType: "application/x-ndjson", bytes: encoder.encode(lines), totalBytes: lines.length, aborted: false },
    }));
    expect(record.media).toHaveLength(0);
    expect(record.line).not.toContain("SUQzBAAAAAA");
    expect(JSON.parse(record.line).response).toMatchObject({ kind: "json", value: [{ alignment: { characters: ["h"] } }, { alignment: null }] });
    // One line is still lines.
    const single = await conversationRecord(capture({
      keep: noAudio,
      audio,
      response: { contentType: "application/x-ndjson", bytes: encoder.encode(lines.split("\n")[0]!), totalBytes: 10, aborted: false },
    }));
    expect(single.line).not.toContain("SUQzBAAAAAAA");
  });

  it("treats an operation's raw upload as audio, whatever type it was sent as (Sol round 2)", async () => {
    const upload = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
    const request = { contentType: "application/octet-stream", bytes: upload, totalBytes: upload.byteLength };
    const left = await conversationRecord(capture({ keep: { images: true, audio: false, files: true }, rawAudioRequest: true, request }));
    expect(left.media).toHaveLength(0);
    expect(JSON.parse(left.line).request).toMatchObject({ kind: "media", content: "agw-omitted:audio;8" });
    // Where audio is kept, it is stored as media.
    const kept = await conversationRecord(capture({ rawAudioRequest: true, request }));
    expect(kept.media).toHaveLength(1);
    // Without the declaration, the same bytes are a file.
    const file = await conversationRecord(capture({ keep: { images: true, audio: false, files: true }, request }));
    expect(file.media).toHaveLength(1);
  });

  it("treats a declared raw upload as audio even when it is sent as text (Sol round 6)", async () => {
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
    const request = { contentType: "text/plain", bytes: pcm, totalBytes: pcm.byteLength };
    const left = await conversationRecord(capture({ keep: { images: true, audio: false, files: true }, rawAudioRequest: true, request }));
    expect(left.media).toHaveLength(0);
    expect(JSON.parse(left.line).request).toMatchObject({ kind: "media", content: "agw-omitted:audio;8" });
    // A JSON body of the same operation (Deepgram's `{"url":…}`) stays JSON.
    const json = await conversationRecord(capture({
      keep: { images: true, audio: false, files: true },
      rawAudioRequest: true,
      request: { contentType: "application/json", bytes: encoder.encode('{"url":"https://example.com/a.wav"}'), totalBytes: 35 },
    }));
    expect(JSON.parse(json.line).request).toMatchObject({ kind: "json", value: { url: "https://example.com/a.wav" } });
  });

  it("treats a declared binary speech answer as audio, whatever its type (Sol round 6)", async () => {
    const pcm = new Uint8Array([9, 8, 7, 6, 5, 4]);
    const response = { contentType: "application/octet-stream", bytes: pcm, totalBytes: pcm.byteLength, aborted: false };
    const noAudio = { images: true, audio: false, files: true };
    const left = await conversationRecord(capture({ keep: noAudio, rawAudioResponse: true, response }));
    expect(left.media).toHaveLength(0);
    expect(JSON.parse(left.line).response).toMatchObject({ kind: "media", content: "agw-omitted:audio;6" });
    // Without the declaration, the same bytes would be kept as a file.
    const file = await conversationRecord(capture({ keep: noAudio, response }));
    expect(file.media).toHaveLength(1);
    // A JSON answer of the same operation, such as its events or an error, is not audio.
    const error = await conversationRecord(capture({
      keep: noAudio,
      rawAudioResponse: true,
      response: { contentType: "application/json", bytes: encoder.encode('{"error":"bad"}'), totalBytes: 15, aborted: false },
    }));
    expect(JSON.parse(error.line).response).toMatchObject({ kind: "json", value: { error: "bad" } });
  });

  it("keeps a broken-off speech answer as audio: its format follows the HTTP status, not the record's (Astra round 4)", async () => {
    // A 200 speech answer the provider broke off: the record says provider_error,
    // but the part that arrived is still the declared recording, so audio off drops it.
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const noAudio = { images: true, audio: false, files: true };
    const broken = await conversationRecord(capture({
      keep: noAudio,
      rawAudioResponse: true,
      status: "provider_error",
      httpStatus: 200,
      response: { contentType: "application/octet-stream", bytes: pcm, totalBytes: pcm.byteLength, aborted: false },
    }));
    expect(broken.media).toHaveLength(0);
    expect(JSON.parse(broken.line)).toMatchObject({ status: "provider_error", http_status: 200, response: { kind: "media", content: "agw-omitted:audio;4" } });
    // An error status is still one JSON document, never a recording.
    const error = await conversationRecord(capture({
      keep: noAudio,
      rawAudioResponse: true,
      status: "provider_error",
      httpStatus: 422,
      response: { contentType: "application/octet-stream", bytes: encoder.encode('{"error":"bad"}'), totalBytes: 15, aborted: false },
    }));
    expect(JSON.parse(error.line).response).toMatchObject({ kind: "json", value: { error: "bad" } });
  });

  it("stores ElevenLabs' timestamped audio with the type its output_format names (Sol round 6)", async () => {
    const { storedAudioType } = await import("../src/providers/operation.ts");
    const { elevenlabs } = await import("../src/providers/elevenlabs.ts");
    const operation = elevenlabs.operations.find((op) => op.name === "elevenlabs.tts_timestamps")!;
    const spec = operation.storedAudio!;
    expect(storedAudioType(spec, "output_format=pcm_16000")).toBe("audio/pcm");
    expect(storedAudioType(spec, "?output_format=mp3_44100_128")).toBe("audio/mpeg");
    expect(storedAudioType(spec, "output_format=opus_48000_64")).toBe("audio/opus");
    // No format named: ElevenLabs' default, MP3.
    expect(storedAudioType(spec, "")).toBe("audio/mpeg");
    const { media } = await conversationRecord(capture({
      audio: { fields: [...spec.fields], mime: storedAudioType(spec, "output_format=pcm_16000") },
      response: {
        contentType: "application/json",
        bytes: encoder.encode(JSON.stringify({ audio_base64: "AAEAAgADAAQ=", alignment: null })),
        totalBytes: 40,
        aborted: false,
      },
    }));
    expect(media).toHaveLength(1);
    expect(media[0]!.mime).toBe("audio/pcm");
    expect(media[0]!.name.endsWith(".pcm")).toBe(true);
  });

  it("notes an unreadable streamed event by its size where any media is kept out (Sol round 1)", async () => {
    const stream = ["data: {\"type\":\"response.output_audio.delta\",\"delta\":\"UklGRiQAAABX", "", "data: [DONE]", ""].join("\n");
    const record = async (keep: { images: boolean; audio: boolean; files: boolean }) => (JSON.parse((await conversationRecord(capture({
      keep,
      response: { contentType: "text/event-stream", bytes: encoder.encode(stream), totalBytes: stream.length, aborted: false },
    }))).line) as { response: { text: string } }).response.text;
    const filtered = await record({ images: true, audio: false, files: true });
    expect(filtered).not.toContain("UklGRiQAAABX");
    expect(filtered).toContain("agw-omitted:unreadable;");
    expect(filtered).toContain("data: [DONE]");
    expect(await record(KEEP_ALL)).toContain("UklGRiQAAABX");
  });

  it("reads a media type by its base type, so one with parameters is still audio (Fable round 2)", async () => {
    const noAudio = { images: true, audio: false, files: true };
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "UklGRiQAAABXQVZF" } }] } }] });
    const gemini = await conversationRecord(capture({
      keep: noAudio,
      response: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: body.length, aborted: false },
    }));
    expect(gemini.media).toHaveLength(0);
    expect(gemini.line).not.toContain("UklGRiQAAABXQVZF");
    expect(gemini.line).toContain("agw-omitted:audio/l16;12");

    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new File([new Uint8Array([26, 69, 223, 163])], "clip.webm", { type: "audio/webm;codecs=opus" }));
    const sent = new Request("https://example.test", { method: "POST", body: form });
    const bytes = new Uint8Array(await sent.arrayBuffer());
    const request = { contentType: sent.headers.get("content-type")!, bytes, totalBytes: bytes.byteLength };
    const left = await conversationRecord(capture({ keep: noAudio, request }));
    expect(left.media).toHaveLength(0);
    const kept = await conversationRecord(capture({ keep: { images: false, audio: true, files: false }, request }));
    expect(kept.media).toHaveLength(1);
    expect(kept.media[0]!.mime).toBe("audio/webm");
  });

  it("treats a declared audio upload field as audio, whatever its file was named or typed (Sol round 3)", async () => {
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], "recording.mp4", { type: "application/octet-stream" }));
    const sent = new Request("https://example.test", { method: "POST", body: form });
    const bytes = new Uint8Array(await sent.arrayBuffer());
    const request = { contentType: sent.headers.get("content-type")!, bytes, totalBytes: bytes.byteLength };
    const noAudio = { images: true, audio: false, files: true };
    const left = await conversationRecord(capture({ keep: noAudio, audioFormFields: ["file"], request }));
    expect(left.media).toHaveLength(0);
    expect(JSON.parse(left.line).request.fields.file).toMatchObject({ file: "recording.mp4", content: "agw-omitted:audio;8" });
    // Without the declaration, the same upload is a file, kept as files are.
    const file = await conversationRecord(capture({ keep: noAudio, request }));
    expect(file.media).toHaveLength(1);
  });

  it("treats a declared image upload field as an image, whatever its file was named or typed (Astra round 1)", async () => {
    const png = Uint8Array.from(atob(PIXEL), (char) => char.charCodeAt(0));
    const form = new FormData();
    form.append("model", "gpt-image-1");
    form.append("image", new File([png], "blob", { type: "application/octet-stream" }));
    const sent = new Request("https://example.test", { method: "POST", body: form });
    const bytes = new Uint8Array(await sent.arrayBuffer());
    const request = { contentType: sent.headers.get("content-type")!, bytes, totalBytes: bytes.byteLength };
    const imagesOnly = { images: true, audio: true, files: false };
    const kept = await conversationRecord(capture({ keep: imagesOnly, imageFormFields: ["image", "image[]", "mask"], request }));
    expect(kept.media).toHaveLength(1);
    expect(JSON.parse(kept.line).request.fields.image).toMatchObject({ file: "blob", type: "image/png" });
    // The reverse: an app that keeps no images leaves it out, even with files kept.
    const left = await conversationRecord(capture({
      keep: { images: false, audio: true, files: true },
      imageFormFields: ["image", "image[]", "mask"],
      request,
    }));
    expect(left.media).toHaveLength(0);
  });

  it("keeps a tool call's mimeType and data as they are: only inlineData is Gemini media (Astra round 1)", async () => {
    const body = JSON.stringify({
      messages: [{ role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "save", input: { mimeType: "text/plain", data: "hello, world!" } },
      ] }],
      contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: PIXEL } }] }],
    });
    const record = await conversationRecord(capture({
      keep: { images: true, audio: true, files: true },
      request: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: body.length },
    }));
    expect(record.line).toContain('"data":"hello, world!"');
    // Gemini's own inlineData is still kept as media.
    expect(record.media).toHaveLength(1);
  });

  it("joins an event's data lines before reading it, so a multi-line text event is kept (Sol round 3)", async () => {
    const stream = ["data: {\"type\":\"text\",", "data: \"text\":\"Hello\"}", "", "data: [DONE]", ""].join("\n");
    const kept = (JSON.parse((await conversationRecord(capture({
      keep: { images: true, audio: false, files: true },
      response: { contentType: "text/event-stream", bytes: encoder.encode(stream), totalBytes: stream.length, aborted: false },
    }))).line) as { response: { text: string } }).response.text;
    expect(kept).toContain('"text":"Hello"');
    expect(kept).not.toContain("agw-omitted");
    expect(kept).toContain("data: [DONE]");
  });

  it("keeps the complete lines of a newline-delimited stream cut short, and notes the cut one (Sol round 3)", async () => {
    const audio = { fields: ["audio_base64"], mime: "audio/mpeg" };
    const lines = [
      JSON.stringify({ audio_base64: "SUQzBAAAAAAA", alignment: { characters: ["h"] } }),
      JSON.stringify({ audio_base64: "SUQzBAAAAAAB", alignment: { characters: ["i"] } }),
      '{"audio_base64":"SUQzBAAA',
    ].join("\n");
    const record = await conversationRecord(capture({
      keep: { images: true, audio: false, files: true },
      audio,
      response: { contentType: "application/x-ndjson", bytes: encoder.encode(lines), totalBytes: lines.length, aborted: true },
    }));
    expect(record.line).not.toContain("SUQzBAAA");
    const value = JSON.parse(record.line).response.value as unknown[];
    expect(value.slice(0, 2)).toMatchObject([{ alignment: { characters: ["h"] } }, { alignment: { characters: ["i"] } }]);
    expect(value[2]).toMatch(/^agw-omitted:unreadable;\d+$/);
  });

  it("treats a declared stream audio field as audio, such as OpenAI speech's `audio` (Sol round 4)", async () => {
    // The mock's own speech stream.
    const stream = ['data: {"type":"speech.audio.delta","audio":"VVVV"}', "", 'data: {"type":"speech.audio.done"}', "", ""].join("\n");
    const response = { contentType: "text/event-stream", bytes: encoder.encode(stream), totalBytes: stream.length, aborted: false };
    const audio = { fields: ["audio"], mime: "audio/mpeg" };
    const left = await conversationRecord(capture({ keep: { images: true, audio: false, files: true }, audio, response }));
    expect(left.line).not.toContain("VVVV");
    expect(left.media).toHaveLength(0);
    // Where audio is kept, a streamed piece stays in its event, as other streamed audio does.
    const kept = await conversationRecord(capture({ audio, response }));
    expect(kept.line).toContain("VVVV");
  });

  it("keeps the blank line that ends each complete stream event (Sol round 4)", async () => {
    const stored = async (stream: string) => (JSON.parse((await conversationRecord(capture({
      response: { contentType: "text/event-stream", bytes: encoder.encode(stream), totalBytes: stream.length, aborted: false },
    }))).line) as { response: { text: string } }).response.text;
    expect(await stored('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n')).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
    // A stream cut off inside its last event ends without one.
    expect(await stored('data: {"a":1}\n\ndata: [DO')).toBe('data: {"a":1}\n\ndata: [DO');
  });

  it("counts an event complete only when a blank line ends it, not a single final line break (Sol round 5)", async () => {
    const stored = async (stream: string) => (JSON.parse((await conversationRecord(capture({
      response: { contentType: "text/event-stream", bytes: encoder.encode(stream), totalBytes: stream.length, aborted: true },
    }))).line) as { response: { text: string } }).response.text;
    expect(await stored('data: {"a":1}\n')).toBe('data: {"a":1}');
    expect(await stored('data: {"a":1}\r\n')).toBe('data: {"a":1}');
    expect(await stored('data: {"a":1}\n\ndata: {"b":2}\n')).toBe('data: {"a":1}\n\ndata: {"b":2}');
    expect(await stored('data: {"a":1}\n\n')).toBe('data: {"a":1}\n\n');
  });

  it("reads a declared newline-delimited answer a line at a time even when sent as JSON, and always notes a cut line (Sol round 4)", async () => {
    const audio = { fields: ["audio_base64"], mime: "audio/mpeg" };
    const lines = [JSON.stringify({ audio_base64: "SUQzBAAAAAAA", alignment: { characters: ["h"] } }), '{"audio_base64":"SUQz'].join("\n");
    for (const contentType of ["application/json", "application/x-ndjson"]) {
      for (const keep of [KEEP_ALL, { images: true, audio: false, files: true }]) {
        const record = await conversationRecord(capture({
          keep,
          audio,
          responseJsonLines: true,
          response: { contentType, bytes: encoder.encode(lines), totalBytes: lines.length, aborted: true },
        }));
        const value = JSON.parse(record.line).response.value as unknown[];
        expect(value[0]).toMatchObject({ alignment: { characters: ["h"] } });
        expect(value[1]).toMatch(/^agw-omitted:unreadable;\d+$/);
      }
    }
  });

  it("stores a declared newline-delimited answer's JSON error as one document (Sol round 7)", async () => {
    const error = JSON.stringify({ detail: { status: "invalid_voice", message: "Voice not found" } }, null, 2);
    const record = await conversationRecord(capture({
      status: "provider_error",
      httpStatus: 422,
      responseJsonLines: true,
      response: { contentType: "application/json", bytes: encoder.encode(error), totalBytes: error.length, aborted: false },
    }));
    expect(record.line).not.toContain("agw-omitted:unreadable");
    expect(JSON.parse(record.line).response.value).toEqual({ detail: { status: "invalid_voice", message: "Voice not found" } });
  });

  it("stores a JSON error sent as application/x-ndjson as one document (Sol round 8)", async () => {
    const error = JSON.stringify({ detail: { status: "invalid_voice", message: "Voice not found" } }, null, 2);
    const record = await conversationRecord(capture({
      status: "provider_error",
      httpStatus: 422,
      response: { contentType: "application/x-ndjson", bytes: encoder.encode(error), totalBytes: error.length, aborted: false },
    }));
    expect(record.line).not.toContain("agw-omitted:unreadable");
    expect(JSON.parse(record.line).response.value).toEqual({ detail: { status: "invalid_voice", message: "Voice not found" } });
  });

  it("keeps a __proto__ key in a stored JSON body and form (Sol round 8)", async () => {
    const body = '{"metadata":{"__proto__":"saved","plain":1}}';
    const json = await conversationRecord(capture({
      request: { contentType: "application/json", bytes: encoder.encode(body), totalBytes: body.length },
    }));
    const stored = JSON.parse(json.line).request.value;
    expect(Object.hasOwn(stored.metadata, "__proto__")).toBe(true);
    expect(stored.metadata.__proto__).toBe("saved");
    expect(stored.metadata.plain).toBe(1);

    const form = new FormData();
    form.append("__proto__", "saved");
    form.append("model", "whisper-1");
    const encoded = new Response(form);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const formRecord = await conversationRecord(capture({
      request: { contentType: encoded.headers.get("content-type")!, bytes, totalBytes: bytes.byteLength },
    }));
    const fields = JSON.parse(formRecord.line).request.fields;
    expect(Object.hasOwn(fields, "__proto__")).toBe(true);
    expect(fields.__proto__).toBe("saved");
  });

  it("reads a declared newline-delimited answer by line even when labelled text/plain (Sol round 5)", async () => {
    const audio = { fields: ["audio_base64"], mime: "audio/mpeg" };
    const lines = [JSON.stringify({ audio_base64: "SUQzBAAAAAAA", alignment: { characters: ["h"] } }), '{"audio_base64":"SUQz'].join("\n");
    const record = await conversationRecord(capture({
      keep: { images: true, audio: false, files: true },
      audio,
      responseJsonLines: true,
      response: { contentType: "text/plain; charset=utf-8", bytes: encoder.encode(lines), totalBytes: lines.length, aborted: true },
    }));
    expect(record.line).not.toContain("SUQzBAAAAAAA");
    const value = JSON.parse(record.line).response.value as unknown[];
    expect(value[0]).toMatchObject({ alignment: { characters: ["h"] } });
    expect(value[1]).toMatch(/^agw-omitted:unreadable;\d+$/);
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
    const log = env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId));
    await log.append(capture({ appId, eventId: "event-1" }));
    await log.append(capture({ appId, eventId: "event-2" }));
    expect(await log.pendingCount()).toBe(2);
    expect(await storedRecords(appId)).toEqual([]);

    // The alarm the first append set is what writes the batch.
    expect(await runDurableObjectAlarm(log)).toBe(true);
    expect(await log.pendingCount()).toBe(0);
    const listing = await bucket().list({ prefix: `${appPrefix(ACCOUNT_ID, appId)}` });
    expect(listing.objects).toHaveLength(1);
    expect(listing.objects[0]!.key).toMatch(
      new RegExp(`^conversations/${ACCOUNT_ID}~${appId}/\\d{4}-\\d{2}-\\d{2}/\\d{6}-[a-f0-9]{16}\\.jsonl\\.gz$`),
    );
    expect((await storedRecords(appId)).map((record) => record.event_id)).toEqual(["event-1", "event-2"]);

    // A batch holds one UTC day's records, named from the earliest, whatever order they arrived in (Sol round 1).
    const late = `log-${crypto.randomUUID().slice(0, 8)}`;
    const lateLog = env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, late));
    await lateLog.append(capture({ appId: late, eventId: "after", createdAt: "2026-11-02T00:00:01.000Z" }));
    await lateLog.append(capture({ appId: late, eventId: "before", createdAt: "2026-11-01T23:59:59.000Z" }));
    await lateLog.append(capture({ appId: late, eventId: "earlier", createdAt: "2026-11-01T23:58:00.000Z" }));
    await lateLog.flush();
    const lateKeys = (await bucket().list({ prefix: `${appPrefix(ACCOUNT_ID, late)}` })).objects.map((object) => object.key).sort();
    expect(lateKeys).toEqual([
      expect.stringMatching(new RegExp(`^conversations/${ACCOUNT_ID}~${late}/2026-11-01/235800-`)),
      expect.stringMatching(new RegExp(`^conversations/${ACCOUNT_ID}~${late}/2026-11-02/000001-`)),
    ]);
    const byKey = async (key: string) => (await gunzip(await (await bucket().get(key))!.arrayBuffer())).split("\n").filter(Boolean).map((line) => JSON.parse(line).event_id);
    expect(await byKey(lateKeys[0]!)).toEqual(["before", "earlier"]);
    expect(await byKey(lateKeys[1]!)).toEqual(["after"]);

    // Nothing pending writes nothing.
    await log.flush();
    expect((await bucket().list({ prefix: `${appPrefix(ACCOUNT_ID, appId)}` })).objects).toHaveLength(1);
  });
});

describe("ConversationLog clears leftover batch rows (Fable round 2)", () => {
  it("names a new batch even when rows of an older one were left behind", async () => {
    const appId = `log-${crypto.randomUUID().slice(0, 8)}`;
    const log = env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId));
    await log.append(capture({ appId, eventId: "left" }));
    // An older instance's chosen rows, with no named batch: the state a deploy can leave.
    await runInDurableObject(log, (_instance, state) => {
      const id = state.storage.sql.exec<{ id: number }>("SELECT id FROM pending").toArray()[0]!.id;
      state.storage.sql.exec("INSERT INTO batch_row (pending_id) VALUES (?)", id);
    });
    await log.flush();
    expect(await log.pendingCount()).toBe(0);
    expect((await storedRecords(appId)).map((record) => record.event_id)).toEqual(["left"]);
  });
});

describe("ConversationLog retries a failed write (Sol round 8)", () => {
  it("keeps retrying with a growing wait, at most an hour, and stops counting once a write succeeds", async () => {
    const { retryDelay, FLUSH_INTERVAL_MS, MAX_RETRY_MS } = await import("../src/do/ConversationLog.ts");
    expect(retryDelay(1)).toBe(FLUSH_INTERVAL_MS);
    expect(retryDelay(2)).toBe(FLUSH_INTERVAL_MS * 2);
    expect(retryDelay(30)).toBe(MAX_RETRY_MS);

    const appId = `log-${crypto.randomUUID().slice(0, 8)}`;
    const log = env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId));
    await log.append(capture({ appId, eventId: "held" }));
    let failing = true;
    await runInDurableObject(log, (object) => {
      const instance = object as unknown as ConversationLog;
      const real = instance.flush.bind(instance);
      instance.flush = () => (failing ? Promise.reject(new Error("R2 is down")) : real());
    });
    for (const failures of [1, 2]) {
      const before = Date.now();
      expect(await runDurableObjectAlarm(log)).toBe(true);
      const next = await runInDurableObject(log, (_instance, state) => state.storage.getAlarm());
      // The alarm is set again, so the held record is not left waiting for another call.
      expect(next).not.toBeNull();
      expect(next! - before).toBeGreaterThanOrEqual(retryDelay(failures) - 1000);
      expect(await log.pendingCount()).toBe(1);
    }
    failing = false;
    expect(await runDurableObjectAlarm(log)).toBe(true);
    expect(await log.pendingCount()).toBe(0);
    expect(await runInDurableObject(log, (_instance, state) => state.storage.get("flush_failures"))).toBeUndefined();
  });
});

describe("conversation storage through the gateway", () => {
  it("stores a call's request and response under the client's trace id, with the charge's own id", async () => {
    const { slug, appId, key } = await storingApp();
    providerAnswers();
    const { response, text } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key, { "x-client-trace-id": "message-42" }));
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ output_text: "Logged." });
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();

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

  it("files a stream that ends after midnight under the day it started, as its charge is (Sol round 3)", async () => {
    const { slug, appId, key } = await storingApp();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-21T23:59:00.000Z"));
      fetchSpy.mockImplementation(async () => {
        // The answer ends two minutes later, after midnight.
        vi.setSystemTime(new Date("2026-11-22T00:01:00.000Z"));
        return Response.json({ id: "resp_1", output_text: "Logged.", usage: { input_tokens: 3, output_tokens: 2 } });
      });
      const { response } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key));
      expect(response.status).toBe(200);
      await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    } finally {
      vi.useRealTimers();
    }
    const [record] = await storedRecords(appId);
    expect(record!.created_at.slice(0, 10)).toBe("2026-11-21");
    const keys = (await bucket().list({ prefix: `${appPrefix(ACCOUNT_ID, appId)}` })).objects.map((object) => object.key);
    expect(keys.filter((key) => key.endsWith(".jsonl.gz")).every((key) => key.includes("/2026-11-21/"))).toBe(true);
    const charge = await env.DB.prepare("SELECT usage_day FROM charge WHERE id = ?").bind(record!.event_id).first<{ usage_day: string }>();
    expect(charge!.usage_day).toBe("2026-11-21");
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
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    expect(record!.response.kind).toBe("text");
    expect(record!.response.text).toContain('"content":"eggs"');
    expect(record!.response.text).toContain("data: [DONE]");
    // As the provider received it: the gateway asked for usage in the stream.
    expect(record!.request.value).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("stores a stream the provider broke off after a good status as a provider error (Astra round 3)", async () => {
    const { slug, appId, key } = await storingApp();
    const first = `data: ${JSON.stringify({ choices: [{ delta: { content: "Two " } }] })}\n\n`;
    fetchSpy.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
        controller.error(new Error("provider connection reset"));
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "user-1" },
      body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "breakfast" }] }),
    }), env, ctx);
    expect(response.status).toBe(200);
    await response.text().catch(() => "");
    await waitOnExecutionContext(ctx);
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    expect(record).toMatchObject({ status: "provider_error", http_status: 200, client_aborted: false });
  });

  it("stores a stream that ended without its closing event as a provider error, as the meter decides (Astra round 4)", async () => {
    const { slug, appId, key } = await storingApp();
    // One delta, then a clean end with no `[DONE]`: the meter calls this cut short.
    const first = `data: ${JSON.stringify({ choices: [{ delta: { content: "Two " } }] })}\n\n`;
    fetchSpy.mockImplementation(async () => new Response(first, { headers: { "content-type": "text/event-stream" } }));
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "user-1" },
      body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "breakfast" }] }),
    }), env, ctx);
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    expect(record).toMatchObject({ status: "provider_error", http_status: 200, client_aborted: false });
    // The charge took the same decision.
    const charge = await env.DB.prepare("SELECT status FROM charge WHERE id = ?").bind(record!.event_id).first<{ status: string }>();
    expect(charge!.status).toBe("network_error");
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
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    expect(record).toMatchObject({ endpoint: "meal", model: "gpt-4o-mini" });
    expect(record!.request.value).toMatchObject({ model: "gpt-4o-mini", temperature: 0 });
  });

  it("stores nothing for an opted-out request, or for an app that does not store", async () => {
    const { slug, appId, key } = await storingApp();
    providerAnswers();
    const optedOut = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key, { "x-conversation-storage": "off" }));
    expect(optedOut.response.status).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).pendingCount()).toBe(0);

    const plain = await storingApp({ store: false });
    const served = await call(`/v2/apps/${plain.appId}/proxy/${plain.slug}/v1/responses`, responsesRequest(plain.key));
    expect(served.response.status).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, plain.appId)).pendingCount()).toBe(0);
  });

  it("stores nothing once storage is turned off, even through an isolate that cached the app with it on (Sol round 5)", async () => {
    const { slug, appId, key } = await storingApp();
    providerAnswers();
    // The first call warms this isolate's app cache with storage on.
    await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key));
    const before = await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).pendingCount();
    // Another isolate saves storage off: this one's cache still says on.
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, '$.conversations.store', json('false')) WHERE id = ?").bind(appId).run();
    const served = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key));
    expect(served.response.status).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).pendingCount()).toBe(before);
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

  it("never stores a body that echoes a credential the call carried (Sol round 1)", async () => {
    const { slug, appId, key } = await storingApp();
    // An upstream error that repeats the auth header it got, and the app's own key.
    fetchSpy.mockImplementation(async (_url, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ error: { message: `bad header: ${auth}` } }, { status: 401 });
    });
    const { response } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, {
      ...responsesRequest(key),
      body: JSON.stringify({ model: "gpt-4o-mini", input: `my key is ${key}` }),
    });
    expect(response.status).toBe(401);
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    const stored = JSON.stringify(record);
    expect(stored).not.toContain("sk-test-provider-key-5678");
    expect(stored).not.toContain(key);
    expect(record!.response).toMatchObject({ kind: "json", value: { omitted: "credential" } });
    expect(record!.request).toMatchObject({ kind: "json", value: { omitted: "credential" } });
  });

  it("never stores the verified credential, whatever header carried it (Sol round 2)", async () => {
    const slug = await connection();
    // The issuer's token header is the end-user header name: a credential in a header the
    // gateway otherwise reads identity from, and never sends upstream.
    const { appId } = await appWith({
      authentication: {
        type: "api_key",
        end_user: {
          source: "issuer",
          issuer: {
            jwks_url: "https://issuer.test/jwks.json",
            issuer: "https://issuer.test/",
            audience: "aud",
            user_id_claim: "sub",
            required_claims: [],
            max_token_lifetime_seconds: 3600,
            token_header: "x-end-user-id",
          },
        },
      },
      routing: { providers: { [slug]: { operations: ["openai.responses"], models: ["gpt-4o-mini"] } } },
      conversations: { store: true },
    });
    const appKey = await seedAppKey(appId);
    const { token } = await issueGatewayToken(env.JWT_SECRET, { appId, userId: "person-1", authMethod: "api_key", apiKeyId: appKey.id });
    providerAnswers();
    const { response } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, {
      method: "POST",
      headers: { "x-end-user-id": token, "x-app-version": "1.0", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", input: `my token is ${token}` }),
    });
    expect(response.status).toBe(200);
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    expect(JSON.stringify(record)).not.toContain(token);
    expect(record!.request).toMatchObject({ kind: "json", value: { omitted: "credential" } });
  });

  it("never stores a second token in a configured token header named like an identity header (Astra round 2)", async () => {
    const slug = await connection();
    const { appId } = await appWith({
      authentication: {
        type: "api_key",
        end_user: {
          source: "issuer",
          issuer: {
            jwks_url: "https://issuer.test/jwks.json",
            issuer: "https://issuer.test/",
            audience: "aud",
            user_id_claim: "sub",
            required_claims: [],
            max_token_lifetime_seconds: 3600,
            token_header: "x-end-user-id",
          },
        },
      },
      routing: { providers: { [slug]: { operations: ["openai.responses"], models: ["gpt-4o-mini"] } } },
      conversations: { store: true },
    });
    const appKey = await seedAppKey(appId);
    const { token } = await issueGatewayToken(env.JWT_SECRET, { appId, userId: "person-1", authMethod: "api_key", apiKeyId: appKey.id });
    const other = "second-token-value-0042-abcdef";
    providerAnswers();
    // Authorization carries the verified token; the configured token header carries another one.
    const { response } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-end-user-id": other, "x-app-version": "1.0", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", input: `the other token is ${other}` }),
    });
    expect(response.status).toBe(200);
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    expect(JSON.stringify(record)).not.toContain(other);
    expect(record!.request).toMatchObject({ kind: "json", value: { omitted: "credential" } });
  });

  it("never stores a provider key the client sent in another key header (Astra round 1)", async () => {
    await seedAccount();
    const slug = await connection("anthropic");
    const { appId, key } = await appWith({
      routing: { providers: { [slug]: { operations: ["anthropic.messages"], models: ["claude-sonnet-5"] } } },
      conversations: { store: true },
    });
    const clientKey = "sk-ant-client-held-key-0042";
    fetchSpy.mockImplementation(async () =>
      Response.json({ id: "msg_1", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 2 } }));
    // The app authenticates with Authorization; an SDK also sends its own key in x-api-key.
    const { response } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-api-key": clientKey, "content-type": "application/json", "x-end-user-id": "user-1" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, messages: [{ role: "user", content: `my key is ${clientKey}` }] }),
    });
    expect(response.status).toBe(200);
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    expect(JSON.stringify(record)).not.toContain(clientKey);
    expect(record!.request).toMatchObject({ kind: "json", value: { omitted: "credential" } });
  });

  it("leaves out a stored field that holds the app key, such as a trace id (Sol round 9)", async () => {
    const { slug, appId, key } = await storingApp();
    providerAnswers();
    const { response } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key, { "x-client-trace-id": key }));
    expect(response.status).toBe(200);
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    expect(JSON.stringify(record)).not.toContain(key);
    expect(record!.trace_id).toBeNull();
  });

  it("leaves out a content type that holds a credential, even with an empty body (Sol round 10)", async () => {
    const { slug, appId, key } = await storingApp();
    // The provider echoes its key in a content type parameter, with nothing in the body.
    fetchSpy.mockImplementation(async () =>
      new Response("", { status: 400, headers: { "content-type": "application/json; key=sk-test-provider-key-5678" } }));
    const { response } = await call(
      `/v2/apps/${appId}/proxy/${slug}/v1/responses`,
      responsesRequest(key, { "content-type": `application/json; echo=${key}` }),
    );
    expect(response.status).toBe(400);
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    const stored = JSON.stringify(record);
    expect(stored).not.toContain("sk-test-provider-key-5678");
    expect(stored).not.toContain(key);
  });

  it("stores an end-user id sent in the app's own header, which is not a credential (Fable round 1)", async () => {
    const { slug, appId, key } = await storingApp({ store: true }, {
      authentication: { type: "api_key", end_user: { source: "header", header: "X-User-Id" } },
    });
    providerAnswers();
    const { response } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-user-id": "user_12345678" },
      body: JSON.stringify({ model: "gpt-4o-mini", input: "hi", user: "user_12345678" }),
    });
    expect(response.status).toBe(200);
    await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).flush();
    const [record] = await storedRecords(appId);
    expect(record!.user_id).toBe("user_12345678");
    expect(record!.request).toMatchObject({ kind: "json", value: { user: "user_12345678" } });
  });

  it("ends the app's answer before the stored copy of it is put together (Sol round 1)", async () => {
    const { slug, appId, key } = await storingApp();
    providerAnswers();
    const observe = await import("../src/proxy/observe.ts");
    const order: string[] = [];
    const join = vi.spyOn(observe, "wholeBody").mockImplementation((pieces) => {
      order.push("assembled");
      let size = 0;
      for (const piece of pieces) size += piece.byteLength;
      const joined = new Uint8Array(size);
      let at = 0;
      for (const piece of pieces) {
        joined.set(piece, at);
        at += piece.byteLength;
      }
      return joined;
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key)), env, ctx);
    const reader = response.body!.getReader();
    while (!(await reader.read()).done);
    order.push("client-eof");
    await waitOnExecutionContext(ctx);
    expect(join).toHaveBeenCalled();
    expect(order[0]).toBe("client-eof");
  });

  it("keeps the answer's pieces by reference, so the app's reads are not held up by copying (Sol round 2)", async () => {
    const { observeBody } = await import("../src/proxy/observe.ts");
    const first = new TextEncoder().encode("Two ");
    const second = new TextEncoder().encode("eggs");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });
    const { stream, observed } = observeBody(source, { keepWhole: 1024 });
    const reader = stream.getReader();
    const got: Uint8Array[] = [];
    for (let read = await reader.read(); !read.done; read = await reader.read()) got.push(read.value);
    const body = await observed;
    expect(got).toEqual([first, second]);
    expect(body.whole![0]).toBe(got[0]);
    expect(body.whole![1]).toBe(got[1]);
  });

  it("schedules the stored conversation apart from the charge, after it (Sol round 2)", async () => {
    const { slug, appId, key } = await storingApp();
    providerAnswers();
    const ledger = await import("../src/ledger/write.ts");
    const capture = await import("../src/conversations/capture.ts");
    const order: string[] = [];
    const realRecord = ledger.recordLedgerEntry;
    vi.spyOn(ledger, "recordLedgerEntry").mockImplementation((...args) => {
      order.push("charge");
      return realRecord(...args);
    });
    // A capture that never ends must not hold the charge.
    vi.spyOn(capture, "captureConversation").mockImplementation(() => {
      order.push("capture");
      return new Promise<void>(() => undefined);
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/responses`, responsesRequest(key)), env, ctx);
    await response.text();
    // The never-ending capture is the only work left: wait on the charge alone.
    await vi.waitFor(async () => expect(await chargeIds(appId)).toHaveLength(1));
    expect(order).toEqual(["charge", "capture"]);
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
    expect(await env.CONVERSATION_LOG.getByName(appFolderName(ACCOUNT_ID, appId)).pendingCount()).toBe(0);
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

  it("validates a draft and an edit the way saving judges them (Sol round 1)", async () => {
    const withoutBucket = new Proxy(env, {
      get: (target, property, receiver) => (property === "CONVERSATIONS" ? undefined : Reflect.get(target, property, receiver)),
    });
    const key = await seedManagementKey();
    const config = { authentication: { type: "api_key", end_user: { source: "none" } }, conversations: { store: true } };
    const draft = await call("/v2/admin/app-drafts/validate", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "draft", config }),
    }, withoutBucket);
    expect(draft.response.status).toBe(400);

    const stored = await save({});
    const appId = (stored.body as { app: { id: string } }).app.id;
    const edit = await call(`/v2/admin/apps/${appId}/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "edit", config }),
    }, withoutBucket);
    expect(edit.response.status).toBe(400);
  });

  it("refuses a reserved app that stores conversations where this deployment cannot (Sol round 2)", async () => {
    const withoutBucket = new Proxy(env, {
      get: (target, property, receiver) => (property === "CONVERSATIONS" ? undefined : Reflect.get(target, property, receiver)),
    });
    const key = await seedManagementKey();
    const config = { authentication: { type: "api_key", end_user: { source: "none" } }, conversations: { store: true } };
    const reserved = await call("/v2/admin/reserved/apps", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "agent app", config }),
    }, withoutBucket);
    expect(reserved.response.status).toBe(400);
    expect(JSON.parse(reserved.text)).toMatchObject({ error: { code: "invalid_request" } });
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
  async function get(
    path: string,
    bindings: Env = env,
    role: "owner" | "admin" | "member" = "owner",
  ): Promise<{ response: Response; bytes: ArrayBuffer }> {
    const key = await seedManagementKey({ grant: "read", role });
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
      bucket().put(`${appPrefix(ACCOUNT_ID, appId)}${name}`, body, {
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
    await bucket().put(`${appPrefix(otherAccount, otherApp)}2026-11-01/010203-aaaaaaaa.jsonl.gz`, "theirs");
    const list = await get(`/v2/admin/apps/${otherApp}/conversations`);
    expect(list.response.status).toBe(404);
    const file = await get(`/v2/admin/apps/${otherApp}/conversations/file?name=${encodeURIComponent("2026-11-01/010203-aaaaaaaa.jsonl.gz")}`);
    expect(file.response.status).toBe(404);
    expect(json(file.bytes)).toMatchObject({ error: { code: "app_not_found" } });
  });

  it("never shows another account's history to an app that reuses its id (Sol round 10)", async () => {
    await seedAccount();
    const now = Date.now();
    const formerAccount = `org_${crypto.randomUUID().slice(0, 8)}`;
    const reused = `app-reused-${crypto.randomUUID().slice(0, 8)}`;
    // The former account's app is gone; its records are still in the bucket, under its own folder.
    await env.DB.prepare("INSERT INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Former', 'usr_test', ?, ?)")
      .bind(formerAccount, new Date(now).toISOString(), new Date(now).toISOString())
      .run();
    await bucket().put(`${appPrefix(formerAccount, reused)}2026-11-01/010203-aaaaaaaa.jsonl.gz`, "theirs");
    await bucket().put(`${appPrefix(formerAccount, reused)}2026-11-01/media/${"a".repeat(64)}.png`, "their image");
    // This account now has an app with the same id.
    await env.DB.prepare("INSERT INTO app(id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, '{}', 1, 'active', ?, ?)")
      .bind(reused, ACCOUNT_ID, reused, now, now)
      .run();
    const list = await get(`/v2/admin/apps/${reused}/conversations?to=2026-11-30`);
    expect(list.response.status).toBe(200);
    expect(json(list.bytes)).toEqual({ app_id: reused, files: [], next_cursor: null });
    for (const name of ["2026-11-01/010203-aaaaaaaa.jsonl.gz", `2026-11-01/media/${"a".repeat(64)}.png`]) {
      const file = await get(`/v2/admin/apps/${reused}/conversations/file?name=${encodeURIComponent(name)}`);
      expect(file.response.status).toBe(404);
    }
    // A folder written before folders named their account is never served either.
    await bucket().put(`conversations/${reused}/2026-11-01/010203-bbbbbbbb.jsonl.gz`, "legacy");
    const again = await get(`/v2/admin/apps/${reused}/conversations?to=2026-11-30`);
    expect(json(again.bytes)).toEqual({ app_id: reused, files: [], next_cursor: null });
  });

  it("lets owners and admins read stored conversations, and refuses a member, as v1 did", async () => {
    const appId = await storedFiles();
    const file = `/v2/admin/apps/${appId}/conversations/file?name=${encodeURIComponent("2026-11-01/010203-aaaaaaaa.jsonl.gz")}`;
    for (const role of ["owner", "admin"] as const) {
      expect((await get(`/v2/admin/apps/${appId}/conversations?to=2026-11-30`, env, role)).response.status).toBe(200);
      expect((await get(file, env, role)).response.status).toBe(200);
    }
    const list = await get(`/v2/admin/apps/${appId}/conversations?to=2026-11-30`, env, "member");
    expect(list.response.status).toBe(403);
    expect(json(list.bytes)).toMatchObject({ error: { code: "forbidden" } });
    expect((await get(file, env, "member")).response.status).toBe(403);
  });

  it("answers a member's request for a missing app with 404, as v1 did, before the role check (Sol round 9)", async () => {
    const missing = await get(`/v2/admin/apps/app_missing_${crypto.randomUUID().slice(0, 8)}/conversations`, env, "member");
    expect(missing.response.status).toBe(404);
    expect(json(missing.bytes)).toMatchObject({ error: { code: "app_not_found" } });
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
    await store.put(`${appPrefix(ACCOUNT_ID, appId)}2020-01-01/000000-aaaaaaaa.jsonl.gz`, "old");
    await store.put(`${appPrefix(ACCOUNT_ID, appId)}${today}/000000-bbbbbbbb.jsonl.gz`, "new");
    await store.put(`${appPrefix(ACCOUNT_ID, appId)}2020-01-01/media/${"c".repeat(64)}.png`, "old image");
    await store.put(`${appPrefix(ACCOUNT_ID, appId)}${today}/media/${"c".repeat(64)}.png`, "image");
    await store.put(`${appPrefix(ACCOUNT_ID, "conversation-deleted-app")}2020-01-01/000000-dddddddd.jsonl.gz`, "orphan");

    // Other tests in this file may have left batches of their own, so only these keys are asserted.
    const result = await runConversationRetention(store, env.DB, Date.now(), new QueryBudget(500));
    expect(result.deletedObjects).toBeGreaterThanOrEqual(2);
    expect(result.removedApps).toBeGreaterThanOrEqual(1);
    const left = (await store.list({ prefix: "conversations/" })).objects.map((object) => object.key);
    expect(left).toContain(`${appPrefix(ACCOUNT_ID, appId)}${today}/media/${"c".repeat(64)}.png`);
    expect(left).not.toContain(`${appPrefix(ACCOUNT_ID, appId)}2020-01-01/media/${"c".repeat(64)}.png`);
    expect(left).toContain(`${appPrefix(ACCOUNT_ID, appId)}${today}/000000-bbbbbbbb.jsonl.gz`);
    expect(left).not.toContain(`${appPrefix(ACCOUNT_ID, appId)}2020-01-01/000000-aaaaaaaa.jsonl.gz`);
    expect(left.some((key) => key.startsWith(appPrefix(ACCOUNT_ID, "conversation-deleted-app")))).toBe(false);
  });

  it("keeps the records of an app made while the sweep runs, and of one it cannot look up (Sol round 9)", async () => {
    const store = bucket();
    const late = "conversation-late-app";
    const unreadable = "conversation-unreadable-app";
    await store.put(`${appPrefix(ACCOUNT_ID, late)}2020-01-01/000000-aaaaaaaa.jsonl.gz`, "made late");
    await store.put(`${appPrefix(ACCOUNT_ID, unreadable)}2020-01-01/000000-bbbbbbbb.jsonl.gz`, "lookup fails");
    // The sweep's first read sees neither app; looked up again before deleting, one now exists
    // and the other cannot be read.
    const db = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...values: unknown[]) {
            bound = values;
            return this;
          },
          async all() {
            return { results: [] };
          },
          async first() {
            if (!sql.includes("FROM app WHERE id = ?")) return null;
            if (bound[0] === unreadable) throw new Error("D1 unavailable");
            return bound[0] === late ? { present: 1, config_json: "{}" } : null;
          },
        };
      },
    } as unknown as D1Database;

    await runConversationRetention(store, db, Date.now(), new QueryBudget(500));
    const left = (await store.list({ prefix: `conversations/${ACCOUNT_ID}~conversation-` })).objects.map((object) => object.key);
    expect(left).toContain(`${appPrefix(ACCOUNT_ID, late)}2020-01-01/000000-aaaaaaaa.jsonl.gz`);
    expect(left).toContain(`${appPrefix(ACCOUNT_ID, unreadable)}2020-01-01/000000-bbbbbbbb.jsonl.gz`);
  });

  it("deletes a whole expired day folder in bulk, unread, across runs within each run's allowance (Sol round 3)", async () => {
    const { appId } = await storingApp({ store: true, retention_days: 1 });
    const store = bucket();
    // Leave only this app's folder, so each run's allowance goes to it.
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const now = Date.parse("2026-11-22T04:00:00.000Z");
    const expired = Array.from({ length: 150 }, (_, index) => `${appPrefix(ACCOUNT_ID, appId)}2026-11-20/${String(index).padStart(6, "0")}-${index.toString(16).padStart(16, "0")}.jsonl.gz`);
    await Promise.all(expired.map((key) => store.put(key, "unread")));
    // Still inside one day's retention on Nov 22: never touched.
    const kept = [`${appPrefix(ACCOUNT_ID, appId)}2026-11-21/235900-0123456789abcdef.jsonl.gz`, `${appPrefix(ACCOUNT_ID, appId)}2026-11-21/media/${"d".repeat(64)}.png`];
    await Promise.all(kept.map((key) => store.put(key, "kept")));
    const reads = vi.spyOn(store, "get");
    let runs = 0;
    while ((await store.list({ prefix: `${appPrefix(ACCOUNT_ID, appId)}2026-11-20/` })).objects.length > 0 && runs < 10) {
      // Pages of 50 keys. A run that reaches the app pays for the cursor read, the app list, the day list,
      // one page's list and delete, and the cursor write. A run that ran out in it leaves the cursor after it;
      // the next run finds no app after it, goes round to the first app, and comes back to it in the same run.
      await runConversationRetention(store, env.DB, now, new QueryBudget(7), 50);
      runs += 1;
    }
    expect((await store.list({ prefix: `${appPrefix(ACCOUNT_ID, appId)}2026-11-20/` })).objects).toHaveLength(0);
    expect(runs).toBe(3);
    // Only the cursor was read, never a batch.
    expect(reads.mock.calls.every(([key]) => key === RETENTION_CURSOR)).toBe(true);
    const left = (await store.list({ prefix: `${appPrefix(ACCOUNT_ID, appId)}` })).objects.map((object) => object.key).sort();
    expect(left).toEqual([...kept].sort());
  });

  it("reads the retention again before deleting a folder, so a retention raised mid-sweep keeps it (Sol round 4)", async () => {
    const { appId } = await storingApp({ store: true, retention_days: 1 });
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const now = Date.parse("2026-11-22T04:00:00.000Z");
    const key = `${appPrefix(ACCOUNT_ID, appId)}2026-11-20/000000-0123456789abcdef.jsonl.gz`;
    await store.put(key, "inside the new window");
    // The owner raises retention to 30 days after the sweep read the settings and while it lists the app's days.
    const list = store.list.bind(store);
    const listed = vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (options?.prefix === `${appPrefix(ACCOUNT_ID, appId)}` && options.delimiter === "/") {
        await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, '$.conversations.retention_days', 30) WHERE id = ?").bind(appId).run();
      }
      return list(options);
    });
    try {
      await runConversationRetention(store, env.DB, now, new QueryBudget(50));
    } finally {
      listed.mockRestore();
    }
    expect(await store.head(key)).not.toBeNull();
  });

  it("reads the retention again after each page is listed, right before deleting it (Sol round 5)", async () => {
    const { appId } = await storingApp({ store: true, retention_days: 1 });
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const now = Date.parse("2026-11-22T04:00:00.000Z");
    const key = `${appPrefix(ACCOUNT_ID, appId)}2026-11-20/000000-0123456789abcdef.jsonl.gz`;
    await store.put(key, "inside the new window");
    // The owner raises retention to 30 days while R2 lists the day folder's objects.
    const list = store.list.bind(store);
    const listed = vi.spyOn(store, "list").mockImplementation(async (options) => {
      const page = await list(options);
      if (options?.prefix === `${appPrefix(ACCOUNT_ID, appId)}2026-11-20/` && options.delimiter === undefined) {
        await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, '$.conversations.retention_days', 30) WHERE id = ?").bind(appId).run();
      }
      return page;
    });
    try {
      await runConversationRetention(store, env.DB, now, new QueryBudget(50));
    } finally {
      listed.mockRestore();
    }
    expect(await store.head(key)).not.toBeNull();
  });

  it("starts the next run after an app it ran out in, so the apps after it progress (Sol round 2)", async () => {
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    for (let index = 0; index < 20; index += 1) {
      await store.put(`${appPrefix(ACCOUNT_ID, "busy-a")}2020-01-01/${String(index).padStart(6, "0")}-aaaaaaaaaaaaaaa${index.toString(16)}.jsonl.gz`, "orphan");
    }
    await store.put(`${appPrefix(ACCOUNT_ID, "busy-b")}2020-01-01/000000-bbbbbbbb.jsonl.gz`, "orphan");
    // Five keys a page. Enough for the cursor, the app list and one page of the busy app, listed and deleted,
    // then not the next page's delete.
    await runConversationRetention(store, env.DB, Date.now(), new QueryBudget(6), 5);
    expect((await store.list({ prefix: appPrefix(ACCOUNT_ID, "busy-a") })).objects).toHaveLength(15);
    expect(await (await store.get(RETENTION_CURSOR))!.text()).toBe(appPrefix(ACCOUNT_ID, "busy-a"));
    await runConversationRetention(store, env.DB, Date.now(), new QueryBudget(6), 5);
    expect((await store.list({ prefix: appPrefix(ACCOUNT_ID, "busy-b") })).objects).toHaveLength(0);
  });

  it("starts the next run with an app it ran out in before deleting anything there (Sol 7b-2 round 3)", async () => {
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    await store.put(`${appPrefix(ACCOUNT_ID, "unseen-a")}2020-01-01/000000-aaaaaaaa.jsonl.gz`, "orphan");
    // Enough for the cursor, the app list and the app's list, not its delete: the place does not move.
    await runConversationRetention(store, env.DB, Date.now(), new QueryBudget(3));
    expect(await store.get(RETENTION_CURSOR)).toBeNull();
    await runConversationRetention(store, env.DB, Date.now(), new QueryBudget(5));
    expect((await store.list({ prefix: appPrefix(ACCOUNT_ID, "unseen-a") })).objects).toHaveLength(0);
  });

  it("works through more app folders than one run can list, a page at a time (Sol round 1)", async () => {
    const store = bucket();
    // Leave only these folders, so the run's pages are predictable.
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const apps = ["page-a", "page-b", "page-c", "page-d", "page-e", "page-f"];
    for (const app of apps) await store.put(`${appPrefix(ACCOUNT_ID, app)}2020-01-01/000000-aaaaaaaa.jsonl.gz`, "orphan");
    const left = async () => (await store.list({ prefix: `conversations/${ACCOUNT_ID}~page-` })).objects.length;
    // One page of two folders per list: each run reads the cursor, lists a page, deletes two apps, then saves where it stopped.
    let runs = 0;
    while ((await left()) > 0 && runs < 10) {
      await runConversationRetention(store, env.DB, Date.now(), new QueryBudget(7), 2);
      runs += 1;
    }
    expect(await left()).toBe(0);
    expect(runs).toBeGreaterThan(1);
  });

  it("stops, keeps what it has not deleted, and resumes later when its D1 queries run out before its R2 calls (Sol 7b-2 round 2)", async () => {
    const { appId } = await storingApp({ store: true, retention_days: 1 });
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const now = Date.parse("2026-11-22T04:00:00.000Z");
    const days = Array.from({ length: 8 }, (_, index) => `2026-11-${String(10 + index).padStart(2, "0")}`);
    for (const day of days) await store.put(`${appPrefix(ACCOUNT_ID, appId)}${day}/000000-0123456789abcdef.jsonl.gz`, "expired");
    const kept = `${appPrefix(ACCOUNT_ID, appId)}2026-11-21/000000-0123456789abcdef.jsonl.gz`;
    await store.put(kept, "kept");
    const expiredLeft = async () =>
      (await store.list({ prefix: appPrefix(ACCOUNT_ID, appId) })).objects.filter((object) => object.key !== kept).length;

    // Four D1 queries: the retention of every app, then one look before each of three pages.
    const reads = new QueryBudget(4);
    const r2 = new QueryBudget(500);
    await runConversationRetention(store, env.DB, now, r2, 1_000, reads);
    expect(reads.remaining).toBe(0);
    expect(r2.remaining).toBeGreaterThan(400);
    expect(await expiredLeft()).toBe(days.length - 3);
    expect(await store.head(kept)).not.toBeNull();

    // A run whose only D1 query is the first read deletes nothing, not even the folder of an app
    // that is gone: with no query left to look it up, it is never taken for gone.
    const orphan = `${appPrefix(ACCOUNT_ID, "app-gone-unread")}2020-01-01/000000-aaaaaaaa.jsonl.gz`;
    await store.put(orphan, "orphan");
    await store.delete(RETENTION_CURSOR);
    await runConversationRetention(store, env.DB, now, new QueryBudget(500), 1_000, new QueryBudget(1));
    expect(await store.head(orphan)).not.toBeNull();
    expect(await expiredLeft()).toBe(days.length - 3);

    // Later runs go on until every expired day is gone, and the day inside the window stays.
    let runs = 0;
    while ((await expiredLeft()) > 0 && runs < 10) {
      await runConversationRetention(store, env.DB, now, new QueryBudget(500), 1_000, new QueryBudget(4));
      runs += 1;
    }
    expect(await expiredLeft()).toBe(0);
    expect(await store.head(kept)).not.toBeNull();
  });

  it("never moves its place past an app it ran out of D1 queries before looking at (Sol 7b-2 round 3)", async () => {
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const now = Date.parse("2026-11-22T04:00:00.000Z");
    const apps = [(await storingApp({ store: true, retention_days: 1 })).appId, (await storingApp({ store: true, retention_days: 1 })).appId];
    const [first, second] = apps.map((appId) => appPrefix(ACCOUNT_ID, appId)).sort() as [string, string];
    const expire = async (prefix: string, days: string[]) => {
      for (const day of days) await store.put(`${prefix}${day}/000000-0123456789abcdef.jsonl.gz`, "expired");
    };
    const left = async (prefix: string) => (await store.list({ prefix })).objects.length;
    await expire(first, ["2026-11-10", "2026-11-11"]);
    await expire(second, ["2026-11-10"]);

    // Three D1 queries: the retention of every app, then one look before each of the first app's two days.
    // The second app's first look is refused.
    await runConversationRetention(store, env.DB, now, new QueryBudget(500), 1_000, new QueryBudget(3));
    expect(await left(first)).toBe(0);
    expect(await left(second)).toBe(1);
    // The place is kept after the first app, not after the second, which was never looked at.
    expect(await (await store.get(RETENTION_CURSOR))?.text()).toBe(first);

    // The first app has as much again by the next night; the next run still starts with the second.
    await expire(first, ["2026-11-12", "2026-11-13"]);
    await runConversationRetention(store, env.DB, now, new QueryBudget(500), 1_000, new QueryBudget(3));
    expect(await left(second)).toBe(0);
    // Then it went round to the first app in the same run, and ran out there after one of its two days:
    // the next run starts after it, goes round, and comes back to it.
    expect(await left(first)).toBe(1);
    expect(await (await store.get(RETENTION_CURSOR))?.text()).toBe(first);
    await runConversationRetention(store, env.DB, now, new QueryBudget(500), 1_000, new QueryBudget(3));
    expect(await left(first)).toBe(0);
  });

  it("lists an app's days only up to the first one it keeps, so an app with many kept days never holds up the next (Sol 7b-2 round 4)", async () => {
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const now = Date.parse("2026-11-22T04:00:00.000Z");
    const apps = [(await storingApp({ store: true, retention_days: 30 })).appId, (await storingApp({ store: true, retention_days: 30 })).appId];
    const [first, second] = apps.map((appId) => appPrefix(ACCOUNT_ID, appId)).sort() as [string, string];
    // The first app has eight days, all inside its 30 days; the second has one expired file.
    const keptDays = Array.from({ length: 8 }, (_, index) => `2026-11-${String(14 + index).padStart(2, "0")}`);
    for (const day of keptDays) {
      await store.put(`${first}${day}/000000-0123456789abcdef.jsonl.gz`, "kept");
    }
    const expired = `${second}2026-09-01/000000-0123456789abcdef.jsonl.gz`;
    await store.put(expired, "expired");

    // Seven R2 calls a run, one folder per page: listing all eight of the first app's days
    // would spend every call before anything is deleted, run after run, and the place
    // would never move past it.
    let runs = 0;
    while ((await store.head(expired)) !== null && runs < 4) {
      await runConversationRetention(store, env.DB, now, new QueryBudget(7), 1);
      runs += 1;
    }
    expect(await store.head(expired)).toBeNull();
    expect(runs).toBeLessThanOrEqual(2);
    expect((await store.list({ prefix: first })).objects).toHaveLength(keptDays.length);
  });

  /** The warnings logged from here on, by their code. */
  function warnings(): { message: string; ranOutOf?: string }[] {
    const entries: { message: string; ranOutOf?: string }[] = [];
    vi.spyOn(console, "warn").mockImplementation((entry: unknown) => {
      entries.push(JSON.parse(String(entry)) as { message: string; ranOutOf?: string });
    });
    return entries;
  }

  /** Apps with a one-day retention, written straight to D1, their folders sorted. */
  async function oneDayApps(count: number): Promise<string[]> {
    const tag = crypto.randomUUID().slice(0, 8);
    const ids = Array.from({ length: count }, (_, index) => `app_wrap_${tag}_${String(index).padStart(2, "0")}`);
    const at = Date.now();
    await env.DB.batch(
      ids.map((id) =>
        env.DB
          .prepare("INSERT INTO app (id, account_id, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(id, ACCOUNT_ID, id, JSON.stringify({ conversations: { store: true, retention_days: 1 } }), at, at),
      ),
    );
    return ids.map((id) => appPrefix(ACCOUNT_ID, id)).sort();
  }

  it("goes round every app in one run at the default allowances: 40 apps with one expired page each (Sol 7b-2 round 5)", async () => {
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const now = Date.parse("2026-11-22T03:17:00.000Z");
    const folders = await oneDayApps(40);
    for (const folder of folders) {
      await store.put(`${folder}2026-11-10/000000-0123456789abcdef.jsonl.gz`, "expired");
      await store.put(`${folder}2026-11-21/000000-0123456789abcdef.jsonl.gz`, "kept");
    }
    // The last run stopped halfway down the list.
    await store.put(RETENTION_CURSOR, folders[19]!);
    const logged = warnings();
    const reads = conversationReadBudget(env);
    expect(reads.limit - reads.spent).toBe(RETENTION_D1_QUERIES);
    await runConversationRetention(store, env.DB, now, undefined, undefined, reads);
    // Every app's expired page is gone in the one run, and every kept day stays.
    const left = (await store.list({ prefix: "conversations/" })).objects.map((object) => object.key);
    expect(left.filter((key) => key.includes("/2026-11-10/"))).toEqual([]);
    expect(left.filter((key) => key.includes("/2026-11-21/"))).toHaveLength(folders.length);
    // One read of every app's retention, then one look before each app's page.
    expect(reads.remaining).toBe(RETENTION_D1_QUERIES - 1 - folders.length);
    expect(logged.map((entry) => entry.message)).not.toContain("conversation_retention_incomplete");
  });

  it("goes on from the first app after the end of the listing, and stops at the app it began after (Sol 7b-2 round 5)", async () => {
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const now = Date.parse("2026-11-22T03:17:00.000Z");
    const [a, b, c] = (await oneDayApps(3)) as [string, string, string];
    for (const folder of [a, b, c]) {
      await store.put(`${folder}2026-11-10/000000-0123456789abcdef.jsonl.gz`, "expired");
      await store.put(`${folder}2026-11-21/000000-0123456789abcdef.jsonl.gz`, "kept");
    }
    await store.put(RETENTION_CURSOR, b);
    const lists = vi.spyOn(store, "list");
    await runConversationRetention(store, env.DB, now);
    // C's days were listed once: coming round again, the run stopped at the first app after B.
    expect(lists.mock.calls.filter(([options]) => options?.prefix === c)).toHaveLength(1);
    // C after the cursor, then A and B from the first app: every expired day in one run, every kept one stays.
    for (const folder of [a, b, c]) {
      expect((await store.list({ prefix: folder })).objects.map((object) => object.key)).toEqual([`${folder}2026-11-21/000000-0123456789abcdef.jsonl.gz`]);
    }
    // It went all the way round, so the next run starts after B again.
    expect(await (await store.get(RETENTION_CURSOR))?.text()).toBe(b);
  });

  it("takes its D1 queries from MAINTENANCE_QUERY_BUDGET, after the hourly clean-up (Sol 7b-2 round 5)", () => {
    expect(conversationReadBudget(env).remaining).toBe(RETENTION_D1_QUERIES);
    // A deployment on the Paid plan that raises the setting, as text or as a number, gets more.
    expect(conversationReadBudget({ ...env, MAINTENANCE_QUERY_BUDGET: "200" } as Env).remaining).toBe(200 - 50 + RETENTION_D1_QUERIES);
    expect(conversationReadBudget({ ...env, MAINTENANCE_QUERY_BUDGET: 200 } as unknown as Env).remaining).toBe(200 - 50 + RETENTION_D1_QUERIES);
  });

  it("warns when it runs out before every app had its turn, and not when it goes all the way round (Sol 7b-2 round 5)", async () => {
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const orphan = `${appPrefix(ACCOUNT_ID, "warn-gone")}2020-01-01/000000-aaaaaaaa.jsonl.gz`;
    await store.put(orphan, "orphan");
    const logged = warnings();
    // Its only D1 query reads the apps' retention: none is left to look at the gone app.
    await runConversationRetention(store, env.DB, Date.now(), new QueryBudget(500), 1_000, new QueryBudget(1));
    expect(await store.head(orphan)).not.toBeNull();
    expect(logged).toEqual([expect.objectContaining({ message: "conversation_retention_incomplete", ranOutOf: "d1_queries" })]);
    logged.length = 0;
    await runConversationRetention(store, env.DB, Date.now());
    expect(await store.head(orphan)).toBeNull();
    expect(logged).toEqual([]);
  });

  it("names the allowance that refused, not whichever is empty (Sol 7b-2 round 6)", async () => {
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const orphan = `${appPrefix(ACCOUNT_ID, "warn-gone-r2")}2020-01-01/000000-aaaaaaaa.jsonl.gz`;
    await store.put(orphan, "orphan");
    const logged = warnings();
    // Two D1 queries: the apps' retention, then the look at the gone app, which spends the last.
    // Four R2 calls: the cursor, one kept back to write it, the app listing and the page listing;
    // none is left for the delete, so it is the R2 allowance that refuses.
    const reads = new QueryBudget(2);
    await runConversationRetention(store, env.DB, Date.now(), new QueryBudget(4), 1_000, reads);
    expect(reads.remaining).toBe(0);
    expect(await store.head(orphan)).not.toBeNull();
    expect(logged).toEqual([expect.objectContaining({ message: "conversation_retention_incomplete", ranOutOf: "r2_calls" })]);
  });

  it("stops when the run's allowance runs out", async () => {
    const store = bucket();
    await store.put(`${appPrefix(ACCOUNT_ID, "conversation-budget-gone")}2020-01-01/000000-eeeeeeee.jsonl.gz`, "orphan");
    const budget = new QueryBudget(2);
    await expect(runConversationRetention(store, env.DB, Date.now(), budget)).resolves.toBeDefined();
    expect(budget.remaining).toBeLessThanOrEqual(1);
    expect((await store.list({ prefix: appPrefix(ACCOUNT_ID, "conversation-budget-gone") })).objects).toHaveLength(1);
  });

  it("starts each run after the app the last one finished, and from the first app once the listing ends", async () => {
    const store = bucket();
    await store.put(`${appPrefix(ACCOUNT_ID, "cursor-a")}2020-01-01/000000-aaaaaaaa.jsonl.gz`, "orphan");
    await store.put(`${appPrefix(ACCOUNT_ID, "cursor-b")}2020-01-01/000000-bbbbbbbb.jsonl.gz`, "orphan");
    await store.put(RETENTION_CURSOR, appPrefix(ACCOUNT_ID, "cursor-a"));
    // The cursor read, the list of apps, one app's list and delete, and the cursor write.
    const budget = new QueryBudget(5);
    await runConversationRetention(store, env.DB, Date.now(), budget);
    expect((await store.list({ prefix: appPrefix(ACCOUNT_ID, "cursor-b") })).objects).toHaveLength(0);
    expect((await store.list({ prefix: appPrefix(ACCOUNT_ID, "cursor-a") })).objects).toHaveLength(1);
    // The pass reached the end of the listing: the cursor is cleared, so the next run starts from the first app.
    expect(await store.get(RETENTION_CURSOR)).toBeNull();
  });
});

describe("media types a body names (Fable round 1)", () => {
  it("stores media whose data URL names an odd type as plain bytes, never with that type", async () => {
    const odd = await conversationRecord(capture({
      request: {
        contentType: "application/json",
        bytes: encoder.encode(JSON.stringify({ input: `data:image/png\nx;base64,${PIXEL}` })),
        totalBytes: 0,
      },
    }));
    expect(odd.media).toHaveLength(1);
    expect(odd.media[0]!.mime).toBe("application/octet-stream");
    expect(odd.media[0]!.name).toMatch(/\.bin$/);
    const plain = await conversationRecord(capture({
      request: { contentType: "application/json", bytes: encoder.encode(JSON.stringify({ input: `data:image/png;base64,${PIXEL}` })), totalBytes: 0 },
    }));
    expect(plain.media[0]!.mime).toBe("image/png");
  });
});

