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

    // A batch holds one UTC day's records, named from the earliest, whatever order they arrived in (Sol round 1).
    const late = `log-${crypto.randomUUID().slice(0, 8)}`;
    const lateLog = env.CONVERSATION_LOG.getByName(late);
    await lateLog.append(capture({ appId: late, eventId: "after", createdAt: "2026-11-02T00:00:01.000Z" }));
    await lateLog.append(capture({ appId: late, eventId: "before", createdAt: "2026-11-01T23:59:59.000Z" }));
    await lateLog.append(capture({ appId: late, eventId: "earlier", createdAt: "2026-11-01T23:58:00.000Z" }));
    await lateLog.flush();
    const lateKeys = (await bucket().list({ prefix: `conversations/${late}/` })).objects.map((object) => object.key).sort();
    expect(lateKeys).toEqual([
      expect.stringMatching(new RegExp(`^conversations/${late}/2026-11-01/235800-`)),
      expect.stringMatching(new RegExp(`^conversations/${late}/2026-11-02/000001-`)),
    ]);
    const byKey = async (key: string) => (await gunzip(await (await bucket().get(key))!.arrayBuffer())).split("\n").filter(Boolean).map((line) => JSON.parse(line).event_id);
    expect(await byKey(lateKeys[0]!)).toEqual(["before", "earlier"]);
    expect(await byKey(lateKeys[1]!)).toEqual(["after"]);

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
    await env.CONVERSATION_LOG.getByName(appId).flush();
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
    await env.CONVERSATION_LOG.getByName(appId).flush();
    const [record] = await storedRecords(appId);
    expect(JSON.stringify(record)).not.toContain(token);
    expect(record!.request).toMatchObject({ kind: "json", value: { omitted: "credential" } });
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

  it("keeps a record past midnight that an old batch named for the day before holds (Sol round 1)", async () => {
    const { appId } = await storingApp({ store: true, retention_days: 1 });
    const store = bucket();
    const now = Date.parse("2026-11-22T04:00:00.000Z");
    // Written by an older version, or copied from v1: one batch for both sides of midnight.
    const mixed = [
      JSON.stringify({ v: 1, event_id: "before-midnight", created_at: "2026-11-20T23:59:00.000Z" }),
      JSON.stringify({ v: 1, event_id: "after-midnight", created_at: "2026-11-21T00:01:00.000Z" }),
    ].join("\n") + "\n";
    const gzipped = await new Response(new Blob([mixed]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    await store.put(`conversations/${appId}/2026-11-20/235900-abcdef0123456789.jsonl.gz`, gzipped);

    await runConversationRetention(store, env.DB, now, new CallBudget(500));
    const keys = (await store.list({ prefix: `conversations/${appId}/` })).objects.map((object) => object.key);
    expect(keys.some((key) => key.includes("/2026-11-20/"))).toBe(false);
    const kept = keys.filter((key) => key.includes("/2026-11-21/"));
    expect(kept).toHaveLength(1);
    const lines = (await gunzip(await (await store.get(kept[0]!))!.arrayBuffer())).split("\n").filter(Boolean);
    expect(lines.map((line) => JSON.parse(line).event_id)).toEqual(["after-midnight"]);
  });

  it("deletes a busy day of one-day batches in bulk, unread, within the run's allowance (Sol round 2)", async () => {
    const { appId } = await storingApp({ store: true, retention_days: 1 });
    const store = bucket();
    const now = Date.parse("2026-11-22T04:00:00.000Z");
    const keys = Array.from({ length: 150 }, (_, index) => `conversations/${appId}/2026-11-20/${String(index).padStart(6, "0")}-${index.toString(16).padStart(16, "0")}day.jsonl.gz`);
    await Promise.all(keys.map((key) => store.put(key, "unread")));
    const reads = vi.spyOn(store, "get");
    let runs = 0;
    while ((await store.list({ prefix: `conversations/${appId}/2026-11-20/` })).objects.length > 0 && runs < 5) {
      await runConversationRetention(store, env.DB, now, new CallBudget(500));
      runs += 1;
    }
    expect((await store.list({ prefix: `conversations/${appId}/2026-11-20/` })).objects).toHaveLength(0);
    expect(runs).toBe(1);
    // Only the cursor was read, never a batch.
    expect(reads.mock.calls.every(([key]) => key === RETENTION_CURSOR)).toBe(true);
  });

  it("works through a busy day of older batches across runs, each batch read once (Sol round 2)", async () => {
    const { appId } = await storingApp({ store: true, retention_days: 1 });
    const store = bucket();
    const now = Date.parse("2026-11-22T04:00:00.000Z");
    const line = JSON.stringify({ v: 1, event_id: "e", created_at: "2026-11-20T10:00:00.000Z" }) + "\n";
    const gzipped = await new Response(new Blob([line]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    for (let index = 0; index < 30; index += 1) {
      await store.put(`conversations/${appId}/2026-11-20/${String(index).padStart(6, "0")}-${index.toString(16).padStart(16, "0")}.jsonl.gz`, gzipped);
    }
    const reads = vi.spyOn(store, "get");
    let runs = 0;
    while ((await store.list({ prefix: `conversations/${appId}/2026-11-20/` })).objects.length > 0 && runs < 10) {
      await runConversationRetention(store, env.DB, now, new CallBudget(15));
      runs += 1;
    }
    expect((await store.list({ prefix: `conversations/${appId}/2026-11-20/` })).objects).toHaveLength(0);
    expect(runs).toBeGreaterThan(1);
    const batchReads = reads.mock.calls.filter(([key]) => key !== RETENTION_CURSOR);
    expect(batchReads).toHaveLength(30);
  });

  it("keeps an older batch it could not read, and tries again later (Sol round 2)", async () => {
    const { appId } = await storingApp({ store: true, retention_days: 1 });
    const store = bucket();
    const now = Date.parse("2026-11-22T04:00:00.000Z");
    const kept = `conversations/${appId}/2026-11-20/235900-abcdef0123456789.jsonl.gz`;
    await store.put(kept, "not gzip: a read that fails");
    await store.put(`conversations/${appId}/2026-11-20/000000-0123456789abcdefday.jsonl.gz`, "unread");
    await runConversationRetention(store, env.DB, now, new CallBudget(500));
    const left = (await store.list({ prefix: `conversations/${appId}/2026-11-20/` })).objects.map((object) => object.key);
    expect(left).toEqual([kept]);
    // A week past the folder's expiry, it is given up on.
    await runConversationRetention(store, env.DB, now + 8 * 86_400_000, new CallBudget(500));
    expect((await store.list({ prefix: `conversations/${appId}/2026-11-20/` })).objects).toHaveLength(0);
  });

  it("starts the next run after an app it ran out in, so the apps after it progress (Sol round 2)", async () => {
    const store = bucket();
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    for (let index = 0; index < 20; index += 1) {
      await store.put(`conversations/busy-a/2020-01-01/${String(index).padStart(6, "0")}-aaaaaaaaaaaaaaa${index.toString(16)}.jsonl.gz`, "orphan");
    }
    await store.put("conversations/busy-b/2020-01-01/000000-bbbbbbbb.jsonl.gz", "orphan");
    // Enough for the cursor, the app list and one app's list, not its delete.
    await runConversationRetention(store, env.DB, Date.now(), new CallBudget(3));
    expect(await (await store.get(RETENTION_CURSOR))!.text()).toBe("conversations/busy-a/");
    await runConversationRetention(store, env.DB, Date.now(), new CallBudget(5));
    expect((await store.list({ prefix: "conversations/busy-b/" })).objects).toHaveLength(0);
  });

  it("works through more app folders than one run can list, a page at a time (Sol round 1)", async () => {
    const store = bucket();
    // Leave only these folders, so the run's pages are predictable.
    for (const object of (await store.list({ prefix: "conversations/" })).objects) await store.delete(object.key);
    const apps = ["page-a", "page-b", "page-c", "page-d", "page-e", "page-f"];
    for (const app of apps) await store.put(`conversations/${app}/2020-01-01/000000-aaaaaaaa.jsonl.gz`, "orphan");
    const left = async () => (await store.list({ prefix: "conversations/page-" })).objects.length;
    // One page of two folders per list: each run reads the cursor, lists a page, deletes two apps, then saves where it stopped.
    let runs = 0;
    while ((await left()) > 0 && runs < 10) {
      await runConversationRetention(store, env.DB, Date.now(), new CallBudget(7), 2);
      runs += 1;
    }
    expect(await left()).toBe(0);
    expect(runs).toBeGreaterThan(1);
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
