import { DurableObject } from "cloudflare:workers";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { conversationRecord, type ConversationCapture } from "../conversations/record.ts";
import { appPrefix, batchKey, conversationsBucket, recordDay } from "../conversations/storage.ts";

/** How long a record waits for its batch to fill before it is written anyway. */
export const FLUSH_INTERVAL_MS = 5 * 60_000;
/** The longest wait between retries while R2 refuses writes: saved records reach R2 within it once R2 recovers. */
export const MAX_RETRY_MS = 60 * 60_000;
const FAILURES_KEY = "flush_failures";
/** Pending text that is written at once rather than waiting for the interval. */
export const FLUSH_CHARS = 4 * 1024 * 1024;
/** The most text one batch file takes, so a backlog drains in bounded files. */
export const MAX_BATCH_CHARS = 16 * 1024 * 1024;

/**
 * One application's conversation inbox (ported from v1): it takes each served request as a
 * record, keeps it in its own SQLite until a batch is due, and writes the batch
 * to R2 as one gzipped JSON-lines file.
 *
 * There is one per application of one account (named by `appFolderName`, so an app id used again by
 * another account gets its own log), so an app's records arrive in one place and
 * leave as a few files an hour rather than one object per request, and a busy
 * app never waits on another. Nothing here is on the request path: the gateway
 * hands a capture over after the client already has its answer.
 *
 * Records are durable from the moment `append` returns, so a deploy or an
 * eviction loses nothing that was handed over; the alarm that writes them is
 * stored too. A batch is named before it is written and that name is kept
 * until its rows are gone, so a write retried after a crash overwrites the
 * same file instead of adding a second copy of the same records.
 *
 * A batch holds the records of one UTC day only, the day of the folder it is
 * written under. So retention, which deletes whole days, never deletes a record
 * still inside its window, and a day's listing names every record of that day.
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
          account_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          line TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS batch_file (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          key TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS batch_row (
          pending_id INTEGER PRIMARY KEY
        );
      `);
    });
  }

  /**
   * Takes one served request. Its media is written first, so a record never
   * names media that is not there; the record itself waits for its batch.
   */
  async append(capture: ConversationCapture): Promise<void> {
    const bucket = conversationsBucket(this.env);
    if (bucket === null) return;
    const { line, media } = await conversationRecord(capture);
    for (const item of media) {
      await bucket.put(`${appPrefix(capture.accountId, capture.appId)}${item.name}`, item.bytes, {
        httpMetadata: { contentType: item.mime },
      });
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO pending (app_id, account_id, created_at, line) VALUES (?, ?, ?, ?)",
      capture.appId,
      capture.accountId,
      capture.createdAt,
      line,
    );
    if (this.pendingChars() >= FLUSH_CHARS) {
      await this.flush();
    } else if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Writes what is pending. A failed write never ends the retries: the next
   * alarm is set with a backoff that doubles up to `MAX_RETRY_MS`, so saved
   * records reach R2 once it recovers, without waiting for another call.
   */
  override async alarm(): Promise<void> {
    try {
      await this.flush();
      await this.ctx.storage.delete(FAILURES_KEY);
      if (this.pendingCount() > 0) await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    } catch (error) {
      const failures = ((await this.ctx.storage.get<number>(FAILURES_KEY)) ?? 0) + 1;
      await this.ctx.storage.put(FAILURES_KEY, failures);
      const delay = retryDelay(failures);
      log("warn", "conversation_flush_failed", { pending: this.pendingCount(), failures, retryInMs: delay, error: errorFacts(error) });
      await this.ctx.storage.setAlarm(Date.now() + delay);
    }
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

  /**
   * The rows of the next batch: the earliest UTC day's records, in arrival
   * order, up to `MAX_BATCH_CHARS`. Null where nothing is pending.
   */
  private nextBatch(): { ids: number[]; earliest: string; appId: string; accountId: string } | null {
    const rows = this.ctx.storage.sql
      .exec<{ id: number; app_id: string; account_id: string; created_at: string; chars: number }>(
        "SELECT id, app_id, account_id, created_at, LENGTH(line) AS chars FROM pending ORDER BY id",
      )
      .toArray();
    if (rows.length === 0) return null;
    let day: string | null = null;
    for (const row of rows) {
      const own = recordDay(row.created_at);
      if (day === null || own < day) day = own;
    }
    const ids: number[] = [];
    let chars = 0;
    let earliest: string | null = null;
    for (const row of rows) {
      if (recordDay(row.created_at) !== day) continue;
      if (ids.length > 0 && chars + row.chars > MAX_BATCH_CHARS) break;
      ids.push(row.id);
      chars += row.chars;
      if (earliest === null || new Date(row.created_at).getTime() < new Date(earliest).getTime()) earliest = row.created_at;
    }
    return { ids, earliest: earliest!, appId: rows[0]!.app_id, accountId: rows[0]!.account_id };
  }

  /** Writes the next batch, if there is one, and answers whether it wrote. */
  private async writeBatch(): Promise<boolean> {
    const bucket = conversationsBucket(this.env);
    if (bucket === null) return false;
    const sql = this.ctx.storage.sql;
    let key = sql.exec<{ key: string }>("SELECT key FROM batch_file WHERE id = 1").toArray()[0]?.key;
    if (key === undefined) {
      const next = this.nextBatch();
      if (next === null) return false;
      const batchId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      // Named from its earliest record: every record in it shares that record's UTC day.
      const named = batchKey(next.accountId, next.appId, next.earliest, batchId);
      this.ctx.storage.transactionSync(() => {
        sql.exec("INSERT INTO batch_file (id, key) VALUES (1, ?)", named);
        for (const id of next.ids) sql.exec("INSERT INTO batch_row (pending_id) VALUES (?)", id);
      });
      key = named;
    }
    const chosen = "id IN (SELECT pending_id FROM batch_row)";
    const lines = sql
      .exec<{ line: string }>(`SELECT line FROM pending WHERE ${chosen} ORDER BY id`)
      .toArray()
      .map((row) => row.line);
    if (lines.length > 0) {
      const gzipped = await new Response(
        new Blob([`${lines.join("\n")}\n`]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer();
      await bucket.put(key, gzipped, {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: { records: String(lines.length) },
      });
    }
    this.ctx.storage.transactionSync(() => {
      sql.exec(`DELETE FROM pending WHERE ${chosen}`);
      sql.exec("DELETE FROM batch_row");
      sql.exec("DELETE FROM batch_file");
    });
    return true;
  }
}

/** The wait before retry number `failures`: one flush interval, doubling, at most `MAX_RETRY_MS`. */
export function retryDelay(failures: number): number {
  return Math.min(FLUSH_INTERVAL_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);
}
