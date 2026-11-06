import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { conversationsCommand } from "../src/conversations.ts";
import { stubContext, hasCode } from "./helpers.ts";

const IMAGE = `2026-11-01/media/${"a".repeat(64)}.png`;

test("app conversations downloads each listed batch once, and the images they name", async () => {
  const output = await mkdtemp(join(tmpdir(), "agw-conversations-"));
  try {
    const batch = gzipSync(`${JSON.stringify({ request: { value: { image_url: `agw-media:${IMAGE}` } } })}\n`);
    const downloads: string[] = [];
    const ctx = stubContext({
      call: async (name: string, options: { query: { cursor?: string } }) => {
        assert.equal(name, "listAppConversations");
        return options.query.cursor
          ? { data: { app_id: "app-1", files: [{ name: "2026-11-02/101500-bbbbbbbb.jsonl.gz", size: batch.byteLength, records: 1, uploaded_at: "" }], next_cursor: null } }
          : { data: { app_id: "app-1", files: [{ name: "2026-11-01/090000-aaaaaaaa.jsonl.gz", size: batch.byteLength, records: 1, uploaded_at: "" }], next_cursor: "page-2" } };
      },
      client: {
        download: async (_name: string, options: { query: { name: string } }) => {
          downloads.push(options.query.name);
          return options.query.name === IMAGE ? new Uint8Array([1, 2, 3]) : new Uint8Array(batch);
        },
      },
    });

    const first = await conversationsCommand(ctx, "app-1", { from: "2026-11-01", to: "2026-11-02", output, media: true });
    assert.equal(first.files, 2);
    assert.equal(first.downloaded, 2);
    assert.equal(first.media, 1);
    assert.deepEqual(downloads, ["2026-11-01/090000-aaaaaaaa.jsonl.gz", "2026-11-02/101500-bbbbbbbb.jsonl.gz", IMAGE]);
    assert.deepEqual([...await readFile(join(output, IMAGE))], [1, 2, 3]);

    // A second run finds everything in place and fetches nothing.
    const again = await conversationsCommand(ctx, "app-1", { from: "2026-11-01", to: "2026-11-02", output, media: true });
    assert.equal(again.downloaded, 0);
    assert.equal(again.media, 0);
    assert.equal(downloads.length, 3);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("app conversations refuses a range that ends before it starts", async () => {
  await assert.rejects(
    conversationsCommand(stubContext({}), "app-1", { from: "2026-11-02", to: "2026-11-01", output: tmpdir() }),
    hasCode("invalid_input"),
  );
});

test("app conversations refuses a listed name that leads outside the export folder", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agw-conversations-"));
  const output = join(parent, "exports", "app-1");
  try {
    const ctx = stubContext({
      call: async () => ({ data: { app_id: "app-1", files: [{ name: "../../escaped", size: 1, records: 1, uploaded_at: "" }], next_cursor: null } }),
      client: { download: async () => new Uint8Array([1, 2, 3]) },
    });
    await assert.rejects(conversationsCommand(ctx, "app-1", { to: "2026-11-02", output }), hasCode("invalid_response"));
    await assert.rejects(readFile(join(parent, "escaped")), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
