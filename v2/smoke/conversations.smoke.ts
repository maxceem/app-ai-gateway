/**
 * Conversation storage through a live v2 deployment (plan step 7a):
 *
 * - the console's capabilities say the deployment can store conversations;
 * - an app that stores them keeps a call's request and answer, under the
 *   client's trace id and the charge's own id, with its image kept as media
 *   beside it, and both can be downloaded through the management API;
 * - a storage header the gateway cannot read is refused before any call;
 * - a download names only a file of the app's own folder.
 *
 * Three calls carry over 4 MiB of text between them, so the app's log writes
 * its batch at once instead of after its five-minute wait. Each stays under
 * what one record keeps whole (256 KiB a string, 1.5 MB a record).
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_CONSOLE_URL=https://console.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * Needs a deployment with a CONVERSATIONS bucket. The provider is the mock in
 * `smoke/mock/`, so nothing is billed. Skipped when V2_MANAGEMENT_KEY,
 * V2_MOCK_URL or V2_BASE_URL is not set.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";

const base = process.env.V2_BASE_URL ?? "";
const consoleUrl = process.env.V2_CONSOLE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skip = managementKey === "" || mockUrl === "" || base === "" ? "V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_BASE_URL are needed" : false;

/** A 1×1 PNG. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** One call's text: six parts, each kept whole; three calls pass the log's 4 MiB. */
const PART = "a".repeat(240_000);
const PARTS = 6;
const CALLS = 3;

async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function download(name: string): Promise<Response> {
  return fetch(new URL(`/v2/admin/apps/${appId}/conversations/file?name=${encodeURIComponent(name)}`, base), {
    headers: { authorization: `Bearer ${managementKey}` },
  });
}

const run = Date.now().toString(36);
const slug = `smoke-conv-${run}`;
let providerId = "";
let appId = "";
let appKey = "";

before(async () => {
  if (skip !== false) return;
  const created = await admin("POST", "/v2/admin/providers", {
    type: "openai",
    name: "Smoke conversations",
    slug,
    secret: "sk-mock-smoke-key",
    baseUrl: mockUrl.endsWith("/") ? mockUrl : `${mockUrl}/`,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  providerId = created.body.provider.id;
  const app = await admin("POST", "/v2/admin/apps", {
    name: "Smoke conversations",
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["gpt-4o-mini"] } } },
      conversations: { store: true, retention_days: 1 },
    },
  });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  appId = app.body.app.id;
  appKey = app.body.api_key.key;
  assert.deepEqual(app.body.app.config.conversations, { store: true, keep: { images: true, audio: true, files: true }, retention_days: 1 });
});

after(async () => {
  if (appId !== "") await admin("DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`);
  if (providerId !== "") await admin("DELETE", `/v2/admin/providers/${providerId}`);
});

function chat(headers: Record<string, string>): Promise<Response> {
  return fetch(new URL(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": `conv-${run}`, ...headers },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          ...Array.from({ length: PARTS }, () => ({ type: "text", text: PART })),
          { type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL}` } },
        ],
      }],
    }),
  });
}

test("the console's capabilities say this deployment stores conversations", { skip: consoleUrl === "" ? "V2_CONSOLE_URL is needed" : false }, async () => {
  const response = await fetch(new URL("/v2/console/capabilities", consoleUrl));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { conversationStorage?: boolean }).conversationStorage, true);
});

test("a call is stored under its trace id, with its image as media, and both download", { skip }, async () => {
  const traceId = `smoke-trace-${run}`;
  for (let call = 1; call <= CALLS; call += 1) {
    const answer = await chat({ "x-client-trace-id": call === 1 ? traceId : `${traceId}-${call}` });
    assert.equal(answer.status, 200, await answer.clone().text());
    await answer.text();
  }

  // The capture runs after the answer; poll the listing until its batch is there.
  let record: Record<string, any> | undefined;
  for (let tries = 0; tries < 40 && record === undefined; tries += 1) {
    const listed = await admin("GET", `/v2/admin/apps/${appId}/conversations`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    for (const file of listed.body.files as { name: string; size: number }[]) {
      const batch = await download(file.name);
      assert.equal(batch.status, 200);
      assert.equal(batch.headers.get("content-disposition"), "attachment");
      const lines = gunzipSync(Buffer.from(await batch.arrayBuffer())).toString("utf8").split("\n").filter(Boolean);
      record = lines.map((line) => JSON.parse(line) as Record<string, any>).find((line) => line.trace_id === traceId);
      if (record !== undefined) break;
    }
    // real-timer: polls a live deployment until the batch lands, with a deadline.
    if (record === undefined) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert.ok(record, "the call's record was stored");
  assert.equal(record.v, 1);
  assert.equal(record.app_id, appId);
  assert.equal(record.user_id, `conv-${run}`);
  assert.equal(record.model, "gpt-4o-mini");
  assert.equal(record.status, "ok");
  assert.match(record.event_id, /^[0-9a-f]{32}:\d+$/u, "the charge's own id");
  assert.match(record.route, new RegExp(`^${slug}/`, "u"));

  const text = JSON.stringify(record);
  assert.equal(text.split(PART).length - 1, PARTS, "the request's text is kept whole");
  const sha = createHash("sha256").update(Buffer.from(PIXEL, "base64")).digest("hex");
  const media = new RegExp(`agw-media:(\\d{4}-\\d{2}-\\d{2}/media/${sha}\\.png)`, "u").exec(text);
  assert.ok(media, "the image is named as media");
  const image = await download(media[1]!);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-disposition"), "attachment");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(PIXEL, "base64"));
});

test("a storage header the gateway cannot read is refused before the call", { skip }, async () => {
  const refused = await chat({ "x-conversation-storage": "maybe" });
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "invalid_request");
});

test("a download names only a file of the app's own folder", { skip }, async () => {
  const outside = await download("../other-app/2026-11-01/010203-aaaaaaaa.jsonl.gz");
  assert.equal(outside.status, 400);
  await outside.text();
  const missing = await download("2000-01-01/000000-aaaaaaaa.jsonl.gz");
  assert.equal(missing.status, 404);
  await missing.text();
});
