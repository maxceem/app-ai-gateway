import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { database } from "../src/db";
import { app as appTable } from "../src/db/schema";
import { conversationRecord, type ConversationCapture } from "../src/conversations/record";
import { RETENTION_CURSOR, runConversationRetention } from "../src/conversations/retention";
import { QueryBudget } from "../src/core/query-budget";
import { clearIsolateCaches, seedServerApp } from "./helpers";
import { TEST_MANAGEMENT_KEY } from "./apply-migrations";

const OPERATOR = { authorization: `Bearer ${TEST_MANAGEMENT_KEY}` };
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

afterEach(() => vi.restoreAllMocks());

/** The test bucket: bound in vitest.config.ts, typed on the global `Env` by src/secrets.d.ts. */
function bucket(): R2Bucket {
  return (env as unknown as Env).CONVERSATIONS!;
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
    keep: { images: true, audio: true, files: true },
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

async function storedRecords(appId: string): Promise<Record<string, unknown>[]> {
  const listing = await bucket().list({ prefix: `conversations/${appId}/` });
  const records: Record<string, unknown>[] = [];
  for (const object of listing.objects) {
    if (!object.key.endsWith(".jsonl.gz")) continue;
    const body = await bucket().get(object.key);
    const text = await gunzip(await body!.arrayBuffer());
    for (const line of text.split("\n").filter(Boolean)) records.push(JSON.parse(line) as Record<string, unknown>);
  }
  return records;
}

async function enableStorage(appId: string, retentionDays = 180): Promise<void> {
  const row = await database(env.DB).select().from(appTable).where(eq(appTable.id, appId)).get();
  await database(env.DB)
    .update(appTable)
    .set({ config: { ...row!.config, conversations: { store: true, retention_days: retentionDays, keep: { images: true, audio: true, files: true } } } })
    .where(eq(appTable.id, appId));
  clearIsolateCaches();
}

/** Serves a request, reads it whole, and waits for its background work, such as the capture. */
async function served(input: string, init: RequestInit, bindings: Env = env): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(input, init), bindings, context);
  const bytes = await response.arrayBuffer();
  await waitOnExecutionContext(context);
  return new Response(bytes, { status: response.status, headers: response.headers });
}

function providerAnswers(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ id: "resp_1", output_text: "Logged.", usage: { input_tokens: 3, output_tokens: 2 } }));
}

function responsesRequest(appId: string, key: string, headers: Record<string, string> = {}): [string, RequestInit] {
  return [
    `https://example.test/v1/apps/${appId}/proxy/openai/v1/responses`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-end-user-id": "user-1",
        ...headers,
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [{ role: "user", content: [
          { type: "input_text", text: "200 g chicken soup" },
          { type: "input_image", image_url: `data:image/png;base64,${PIXEL}` },
        ] }],
      }),
    },
  ];
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
  it("stores a request and its response under the client's trace id", async () => {
    const key = await seedServerApp("conversation-e2e");
    await enableStorage("conversation-e2e");
    providerAnswers();
    const response = await served(...responsesRequest("conversation-e2e", key, { "x-client-trace-id": "message-42" }));
    expect(response.status).toBe(200);
    await env.CONVERSATION_LOG.getByName("conversation-e2e").flush();

    const [record] = await storedRecords("conversation-e2e");
    expect(record).toMatchObject({
      app_id: "conversation-e2e",
      user_id: "user-1",
      trace_id: "message-42",
      route: "openai/v1/responses",
      status: "ok",
      http_status: 200,
      response: { kind: "json", value: { id: "resp_1", output_text: "Logged." } },
    });
    const image = ((record!.request as { value: { input: { content: { image_url?: string }[] }[] } })
      .value.input[0]!.content[1]!.image_url)!;
    expect(image).toMatch(/^agw-media:\d{4}-\d{2}-\d{2}\/media\/[0-9a-f]{64}\.png$/);

    // The usage event carries the same trace id and the same event id.
    const events = await served(
      "https://example.test/v1/admin/apps/conversation-e2e/events?trace=message-42",
      { headers: OPERATOR },
    );
    const listed = await events.json() as { events: { client_trace_id: string }[] };
    expect(listed.events).toHaveLength(1);
    expect(listed.events[0]!.client_trace_id).toBe("message-42");
    const row = await env.DB.prepare("SELECT event_id FROM app_usage_event WHERE client_trace_id = ?")
      .bind("message-42").first<{ event_id: string }>();
    expect(row!.event_id).toBe(record!.event_id);

    // Listed and downloaded through the management API.
    const files = await (await served(
      "https://example.test/v1/admin/apps/conversation-e2e/conversations",
      { headers: OPERATOR },
    )).json() as { files: { name: string; records: number }[]; next_cursor: string | null };
    expect(files.files).toHaveLength(1);
    expect(files.files[0]!.records).toBe(1);
    expect(files.next_cursor).toBeNull();
    const context = createExecutionContext();
    const download = await app.fetch(
      new Request(`https://example.test/v1/admin/apps/conversation-e2e/conversations/file?name=${encodeURIComponent(files.files[0]!.name)}`, { headers: OPERATOR }),
      env,
      context,
    );
    expect(download.headers.get("content-type")).toBe("application/gzip");
    expect(JSON.parse((await gunzip(await download.arrayBuffer())).trim()).trace_id).toBe("message-42");
    const imageDownload = await app.fetch(
      new Request(`https://example.test/v1/admin/apps/conversation-e2e/conversations/file?name=${encodeURIComponent(image.slice("agw-media:".length))}`, { headers: OPERATOR }),
      env,
      createExecutionContext(),
    );
    expect(imageDownload.status).toBe(200);
    expect(imageDownload.headers.get("content-type")).toBe("image/png");
    expect(imageDownload.headers.get("content-disposition")).toBe("attachment");
    await imageDownload.arrayBuffer();
    await waitOnExecutionContext(context);

    // A name outside the two shapes the store writes is refused.
    const traversal = await served(
      "https://example.test/v1/admin/apps/conversation-e2e/conversations/file?name=..%2Fother%2Fx.jsonl.gz",
      { headers: OPERATOR },
    );
    expect(traversal.status).toBe(400);
  });

  it("stores nothing for an opted-out request, or for an app that does not store", async () => {
    const key = await seedServerApp("conversation-optout");
    await enableStorage("conversation-optout");
    providerAnswers();
    const optedOut = await served(...responsesRequest("conversation-optout", key, { "x-conversation-storage": "off" }));
    expect(optedOut.status).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName("conversation-optout").pendingCount()).toBe(0);

    const plainKey = await seedServerApp("conversation-off");
    const plain = await served(...responsesRequest("conversation-off", plainKey, { "x-client-trace-id": "m-1" }));
    expect(plain.status).toBe(200);
    expect(await env.CONVERSATION_LOG.getByName("conversation-off").pendingCount()).toBe(0);
  });

  it("refuses a malformed trace id or storage header", async () => {
    const key = await seedServerApp("conversation-headers");
    providerAnswers();
    const refused: Record<string, string>[] = [
      { "x-client-trace-id": "has space" },
      { "x-client-trace-id": "a".repeat(129) },
      { "x-conversation-storage": "on" },
    ];
    for (const headers of refused) {
      const response = await served(...responsesRequest("conversation-headers", key, headers));
      expect(response.status).toBe(400);
    }
  });

  it("refuses to turn storage on where the deployment has no bucket", async () => {
    await seedServerApp("conversation-unbound");
    const withoutBucket = new Proxy(env, {
      get: (target, property, receiver) => property === "CONVERSATIONS" ? undefined : Reflect.get(target, property, receiver),
    });
    const current = await (await served("https://example.test/v1/admin/apps/conversation-unbound", { headers: OPERATOR }))
      .json() as { app: { name: string; config: Record<string, unknown>; revision: number } };
    const update = await served(
      "https://example.test/v1/admin/apps/conversation-unbound",
      {
        method: "PUT",
        headers: { ...OPERATOR, "content-type": "application/json" },
        body: JSON.stringify({
          name: current.app.name,
          revision: current.app.revision,
          config: { ...current.app.config, conversations: { store: true } },
        }),
      },
      withoutBucket,
    );
    expect(update.status).toBe(400);
    expect(await update.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("conversation retention", () => {
  it("deletes days past an app's retention, and everything of an app that is gone", async () => {
    await seedServerApp("conversation-retained");
    await enableStorage("conversation-retained", 30);
    const store = bucket();
    const today = new Date().toISOString().slice(0, 10);
    await store.put("conversations/conversation-retained/2020-01-01/000000-aaaaaaaa.jsonl.gz", "old");
    await store.put(`conversations/conversation-retained/${today}/000000-bbbbbbbb.jsonl.gz`, "new");
    await store.put(`conversations/conversation-retained/2020-01-01/media/${"c".repeat(64)}.png`, "old image");
    await store.put(`conversations/conversation-retained/${today}/media/${"c".repeat(64)}.png`, "image");
    await store.put("conversations/conversation-deleted-app/2020-01-01/000000-dddddddd.jsonl.gz", "orphan");

    // Other tests in this file may have left batches of their own behind, so
    // only the keys seeded here are asserted.
    const result = await runConversationRetention(store, env.DB, Date.now(), new QueryBudget(500));
    expect(result.deletedObjects).toBeGreaterThanOrEqual(2);
    expect(result.removedApps).toBeGreaterThanOrEqual(1);
    const left = (await store.list({ prefix: "conversations/" })).objects.map((object) => object.key);
    expect(left).toContain(`conversations/conversation-retained/${today}/media/${"c".repeat(64)}.png`);
    expect(left).not.toContain(`conversations/conversation-retained/2020-01-01/media/${"c".repeat(64)}.png`);
    expect(left).toContain(`conversations/conversation-retained/${today}/000000-bbbbbbbb.jsonl.gz`);
    expect(left).not.toContain("conversations/conversation-retained/2020-01-01/000000-aaaaaaaa.jsonl.gz");
    expect(left.some((key) => key.startsWith("conversations/conversation-deleted-app/"))).toBe(false);
  });

  it("stops when the night's allowance runs out", async () => {
    const store = bucket();
    await store.put("conversations/conversation-budget-gone/2020-01-01/000000-eeeeeeee.jsonl.gz", "orphan");
    const budget = new QueryBudget(2);
    await expect(runConversationRetention(store, budget.database(env.DB), Date.now(), budget)).resolves.toBeDefined();
    expect(budget.remaining).toBeLessThanOrEqual(1);
    expect((await store.list({ prefix: "conversations/conversation-budget-gone/" })).objects).toHaveLength(1);
  });

  it("starts each night after the app the last one finished", async () => {
    const store = bucket();
    await store.put("conversations/cursor-a/2020-01-01/000000-aaaaaaaa.jsonl.gz", "orphan");
    await store.put("conversations/cursor-b/2020-01-01/000000-bbbbbbbb.jsonl.gz", "orphan");
    await store.put(RETENTION_CURSOR, "conversations/cursor-a/");
    // The cursor read, the apps' retention, the list of apps, one app's list
    // and delete, and the cursor write.
    const budget = new QueryBudget(6);
    await runConversationRetention(store, budget.database(env.DB), Date.now(), budget);
    expect((await store.list({ prefix: "conversations/cursor-b/" })).objects).toHaveLength(0);
    expect((await store.list({ prefix: "conversations/cursor-a/" })).objects).toHaveLength(1);
    expect(await (await store.get(RETENTION_CURSOR))!.text()).toBe("conversations/cursor-b/");
  });
});
