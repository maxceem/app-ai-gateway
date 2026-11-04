import { DurableObject } from "cloudflare:workers";
import { conversationRecord, type ConversationCapture } from "../conversations/record";
import { appPrefix, batchKey } from "../conversations/storage";

/** How long a record waits for its batch to fill before it is written anyway. */
export const FLUSH_INTERVAL_MS = 5 * 60_000;
/** Pending text that is written at once rather than waiting for the interval. */
export const FLUSH_CHARS = 4 * 1024 * 1024;
/** The most text one batch file takes, so a backlog drains in bounded files. */
export const MAX_BATCH_CHARS = 16 * 1024 * 1024;

/**
 * One application's conversation inbox: it takes each served request as a
 * record, keeps it in its own SQLite until a batch is due, and writes the batch
 * to R2 as one gzipped JSON-lines file.
 *
 * There is one per application, so an app's records arrive in one place and
 * leave as a few files an hour rather than one object per request, and a busy
 * app never waits on another. Nothing here is on the request path: the gateway
 * hands a capture over after the client already has its answer.
 *
 * Records are durable from the moment `append` returns, so a deploy or an
 * eviction loses nothing that was handed over; the alarm that writes them is
 * stored too. A batch is named before it is written and that name is kept
 * until its rows are gone, so a write retried after a crash overwrites the
 * same file instead of adding a second copy of the same records.
 */
export class ConversationLog extends DurableObject<Env> {
  private flushing: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS pending (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          line TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS batch (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          key TEXT NOT NULL,
          last_id INTEGER NOT NULL
        );
      `);
    });
  }

  /**
   * Takes one served request. Its media is written first, so a record never
   * names media that is not there; the record itself waits for its batch.
   */
  async append(capture: ConversationCapture): Promise<void> {
    const bucket = this.env.CONVERSATIONS;
    if (bucket === undefined) return;
    const { line, media } = await conversationRecord(capture);
    for (const item of media) {
      await bucket.put(`${appPrefix(capture.appId)}${item.name}`, item.bytes, {
        httpMetadata: { contentType: item.mime },
      });
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO pending (app_id, created_at, line) VALUES (?, ?, ?)",
      capture.appId,
      capture.createdAt,
      line,
    );
    if (this.pendingChars() >= FLUSH_CHARS) {
      await this.flush();
    } else if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }

  override async alarm(): Promise<void> {
    await this.flush();
    if (this.pendingCount() > 0) await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
  }

  /** Writes what is pending as batches until nothing is. One flush at a time. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Records waiting for their batch: for tests and diagnostics. */
  pendingCount(): number {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending").one().count;
  }

  private pendingChars(): number {
    return this.ctx.storage.sql
      .exec<{ chars: number }>("SELECT COALESCE(SUM(LENGTH(line)), 0) AS chars FROM pending")
      .one().chars;
  }

  private async drain(): Promise<void> {
    while (await this.writeBatch()) {
      // Each pass writes one bounded batch; a backlog leaves as several files.
    }
  }

  /** Writes the next batch, if there is one, and answers whether it wrote. */
  private async writeBatch(): Promise<boolean> {
    const bucket = this.env.CONVERSATIONS;
    if (bucket === undefined) return false;
    const sql = this.ctx.storage.sql;
    let batch = sql.exec<{ key: string; last_id: number }>("SELECT key, last_id FROM batch WHERE id = 1").toArray()[0];
    if (batch === undefined) {
      const first = sql
        .exec<{ id: number; app_id: string; created_at: string }>(
          "SELECT id, app_id, created_at FROM pending ORDER BY id LIMIT 1",
        )
        .toArray()[0];
      if (first === undefined) return false;
      const bounded = sql
        .exec<{ id: number }>(
          `SELECT id FROM (
             SELECT id, SUM(LENGTH(line)) OVER (ORDER BY id) AS running FROM pending
           ) WHERE running <= ? ORDER BY id DESC LIMIT 1`,
          MAX_BATCH_CHARS,
        )
        .toArray()[0];
      const lastId = bounded?.id ?? first.id;
      // Named from its earliest record, not its first to arrive: a request that
      // started before midnight can finish after one that started later, and a
      // batch must never sit under a day later than its records' media.
      const earliest = sql
        .exec<{ created_at: string }>("SELECT MIN(created_at) AS created_at FROM pending WHERE id <= ?", lastId)
        .toArray()[0]!;
      const batchId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      batch = { key: batchKey(first.app_id, earliest.created_at, batchId), last_id: lastId };
      sql.exec("INSERT INTO batch (id, key, last_id) VALUES (1, ?, ?)", batch.key, batch.last_id);
    }
    const lines = sql
      .exec<{ line: string }>("SELECT line FROM pending WHERE id <= ? ORDER BY id", batch.last_id)
      .toArray()
      .map((row) => row.line);
    if (lines.length > 0) {
      const gzipped = await new Response(
        new Blob([`${lines.join("\n")}\n`]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer();
      await bucket.put(batch.key, gzipped, {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: { records: String(lines.length) },
      });
    }
    const lastId = batch.last_id;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM pending WHERE id <= ?", lastId);
      sql.exec("DELETE FROM batch");
    });
    return true;
  }
}
