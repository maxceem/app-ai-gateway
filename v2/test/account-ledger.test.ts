/**
 * The ledger object per account (step 8f, D21): its schema versions, the D1
 * shape the ledger code uses over it, and the rollup trigger inside a Durable
 * Object's SQLite.
 */
import { SWEEP_BATCH } from "../src/ledger/sweep.ts";
import { seenSql } from "../src/admin/users.ts";
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AccountLedger, migrateLedger, NEXT_DUE_SQL, nextNightly } from "../src/do/AccountLedger.ts";
import { ledgerLocationHint, ledgerObject } from "../src/ledger/database.ts";
import { LEDGER_SCHEMA } from "../src/ledger/schema.ts";
import { allowLedgerWork, ledger, pauseLedgerWork } from "./helpers.ts";

/**
 * Puts the clock at noon UTC tomorrow: after the nightly hour, so the nightly
 * maintenance is due whatever time the test runs (it failed between midnight
 * and 04:00 UTC), and still ahead of the real clock, so an alarm set for "now"
 * never fires on its own: only `runDurableObjectAlarm` runs it. Only `Date`
 * is faked; timers stay real.
 */
function afterNightlyHour(): number {
  const noon = new Date();
  noon.setUTCDate(noon.getUTCDate() + 1);
  noon.setUTCHours(12, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"], now: noon });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return noon.getTime();
}

describe("the ledger object", () => {
  it("runs the rollup trigger inside the object's SQLite, once per charge", async () => {
    const db = ledger("acc_trigger");
    const insert = (id: string) =>
      db
        .prepare(
          `INSERT INTO charge (id, kind, account_id, app_id, owner_type, owner_id, provider_type, operation, status,
             cost_nano, measured, price_source, price_is_estimate, measures_json, used_at, usage_day, written_at)
           VALUES (?, 'attempt', 'acc_trigger', 'app_t', 'call', ?, 'openai', 'openai.chat', 'ok', 500, 'complete', 'list_rate', 0, '{}', 1, '2026-11-25', 1)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(id, id);
    const first = await db.batch([insert("c1"), insert("c2")]);
    expect(first.map((result) => result.meta.changes > 0)).toEqual([true, true]);
    // A repeat is skipped, and its trigger does not run again.
    const again = await insert("c1").run();
    expect(again.meta.changes).toBe(0);
    const day = await db.prepare("SELECT charges, cost_nano FROM usage_day WHERE app_id = 'app_t'").first<{ charges: number; cost_nano: number }>();
    expect(day).toEqual({ charges: 2, cost_nano: 1000 });
    const budget = await db.prepare("SELECT cost_nano FROM budget_day WHERE app_id = 'app_t' AND scope = 'app'").first("cost_nano");
    expect(budget).toBe(1000);
  });

  it("keeps each account's ledger apart", async () => {
    await ledger("acc_one")
      .prepare("INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, due_at, tries, created_at) VALUES ('w', 'unresolved', 'acc_one', 'a', 'call', 'o', ?, 0, 1)")
      .bind(Date.now() + 3_600_000)
      .run();
    expect(await ledger("acc_one").prepare("SELECT COUNT(*) AS n FROM open_work").first("n")).toBe(1);
    expect(await ledger("acc_two").prepare("SELECT COUNT(*) AS n FROM open_work").first("n")).toBe(0);
  });

  it("answers numbered parameters, `first` by column, `raw` and a rolled-back batch as D1 does", async () => {
    const db = ledger("acc_shape");
    expect(await db.prepare("SELECT ?2 AS b, ?1 AS a").bind("x", "y").first()).toEqual({ b: "y", a: "x" });
    expect(await db.prepare("SELECT 1 AS one, 2 AS two").raw({ columnNames: true })).toEqual([["one", "two"], [1, 2]]);
    // Two columns of one name: `raw` keeps both, an object keeps the last, as D1 does.
    expect(await db.prepare("SELECT 1 AS same, 2 AS same").raw()).toEqual([[1, 2]]);
    expect(await db.prepare("SELECT 1 AS same, 2 AS same").first()).toEqual({ same: 2 });
    expect(await db.prepare("SELECT 1 AS one WHERE 0").first()).toBeNull();
    // A batch is one transaction: a failing statement leaves nothing of the batch behind.
    const work = (id: string, kind: string) =>
      db
        .prepare("INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, due_at, tries, created_at) VALUES (?, ?, 'acc_shape', 'a', 'call', 'o', 1, 0, 1)")
        .bind(id, kind);
    await expect(db.batch([work("ok", "unresolved"), work("bad", "no_such_kind")])).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM open_work").first("n")).toBe(0);
    expect(() => db.prepare("SELECT ?").bind(undefined)).toThrow(/undefined/);
  });

  it("brings an object created on an older version up to date when it wakes, keeping its rows", async () => {
    const stub = ledgerObject(env, "acc_versions");
    expect(await stub.schemaVersion()).toBe(LEDGER_SCHEMA.length);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO ledger_meta (key, value) VALUES ('probe', 'kept') ON CONFLICT(key) DO NOTHING");
      // A later version, as a future step would add it.
      const next = [...LEDGER_SCHEMA, ["ALTER TABLE charge ADD COLUMN probe_column TEXT", "CREATE TABLE probe_table (id TEXT PRIMARY KEY)"]];
      expect(migrateLedger(state.storage, next)).toBe(LEDGER_SCHEMA.length + 1);
      // Run again: nothing to do, and nothing is applied twice.
      expect(migrateLedger(state.storage, next)).toBe(LEDGER_SCHEMA.length + 1);
      const columns = state.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('charge')").toArray().map((row) => row.name);
      expect(columns).toContain("probe_column");
      expect(state.storage.sql.exec("SELECT value FROM ledger_meta WHERE key = 'probe'").one().value).toBe("kept");
    });
  });

  it("sets its alarm for open work, and its sweep takes the due rows", async () => {
    // This test lets the object set its alarm.
    allowLedgerWork();
    const db = ledger("acc_alarm");
    const stub = ledgerObject(env, "acc_alarm");
    // Tonight's maintenance is done, so the alarm is the work's alone.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO ledger_meta (key, value) VALUES ('nightly_day', ?)", new Date().toISOString().slice(0, 10));
    });
    const due = Date.now() + 3_600_000;
    await db
      .prepare("INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, due_at, tries, created_at) VALUES ('unresolved:gone', 'unresolved', 'acc_alarm', 'a', 'call', 'o', NULL, ?, 0, 1)")
      .bind(due)
      .run();
    // The write set the alarm for the row (no rows besides it, so no nightly run).
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(due);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE open_work SET due_at = ?", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // An `unresolved` row with no charge is done at once, and with no work left no alarm is set.
    expect(await db.prepare("SELECT COUNT(*) AS n FROM open_work").first("n")).toBe(0);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it("keeps its nightly alarm for an account whose only rows are given-up work, so retention still deletes them", async () => {
    allowLedgerWork();
    const now = afterNightlyHour();
    const stub = ledgerObject(env, "acc_given_up");
    await ledger("acc_given_up")
      .prepare(
        "INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, due_at, tries, gave_up_at, created_at) VALUES ('w', 'unresolved', 'acc_given_up', 'a', 'call', 'o', 1, 20, 1, 1)",
      )
      .run();
    // The write set the alarm for the nightly run, due now on a new object. The clock is ahead of
    // the real one, so it waits for this test to run it: the run deletes work given up more than 90 days ago.
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(now);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await ledger("acc_given_up").prepare("SELECT COUNT(*) AS n FROM open_work").first("n")).toBe(0);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it("runs its clean-up even when it cannot write, and still sets its next alarm (step 8f)", async () => {
    allowLedgerWork();
    const now = afterNightlyHour();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stub = ledgerObject(env, "acc_full");
    const old = now - 200 * 86_400_000;
    // Seeded straight into the object's storage, which sets no alarm, then, as on a full ledger:
    // deletes work, inserts and updates fail. So the night's mark cannot be written.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec(
        "INSERT INTO app_auth_event (id, app_id, account_id, event, outcome, created_at) VALUES ('old', 'a', 'acc_full', 'challenge', 'abandoned', ?), ('new', 'a', 'acc_full', 'challenge', 'abandoned', ?)",
        old,
        now,
      );
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      vi.spyOn(state.storage.sql, "exec").mockImplementation(((query: string, ...bindings: unknown[]) => {
        if (/^\s*(INSERT|UPDATE)/iu.test(query)) throw new Error("database or disk is full: SQLITE_FULL");
        return exec(query, ...bindings);
      }) as typeof state.storage.sql.exec);
      await state.storage.setAlarm(now + 600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    vi.restoreAllMocks();
    expect(await ledger("acc_full").prepare("SELECT id FROM app_auth_event").all().then((r) => r.results)).toEqual([{ id: "new" }]);
    // The night was not marked, so a retry is set: the nightly run is due again, after the
    // alarm's one-minute floor (not the 10 minutes the test's own alarm was set for).
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(now + 60_000);
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it("reads a later page of the users only usage names by seeking its indexes from the cursor (step 8f)", async () => {
    const plan = (await ledger().prepare(`EXPLAIN QUERY PLAN ${seenSql("after")}`).bind("app", "acct", null, "cursor", 10).all<{ detail: string }>()).results
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toMatch(/charge_app_user_used \(app_id=\? AND end_user_id>\?\)/u);
    expect(plan).toMatch(/app_rejection_event_app_user_created \(app_id=\? AND user_id>\?\)/u);
  });

  it("never lets a write pull its alarm into the minute after a run (step 8f)", async () => {
    allowLedgerWork();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stub = ledgerObject(env, "acc_pause");
    const work = (id: string, due: number) =>
      ledger("acc_pause")
        .prepare("INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, due_at, tries, created_at) VALUES (?, 'unresolved', 'acc_pause', 'a', 'call', ?, 'missing', ?, 0, 1)")
        .bind(id, id, due)
        .run();
    // Tonight's maintenance is done, so the alarm is the work's alone.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO ledger_meta (key, value) VALUES ('nightly_day', ?)", new Date().toISOString().slice(0, 10));
    });
    await work("first", Date.now() + 3_600_000);
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE open_work SET due_at = ?", Date.now() - 1));
    // The sweep tries it (its charge is not there yet) and leaves it for later: the alarm is a minute out at least.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(after).not.toBeNull();
    expect(after!).toBeGreaterThanOrEqual(Date.now() + 50_000);
    // New work due at once does not pull the alarm into that minute.
    await work("second", 0);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(after);
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it("keeps the minute after a run when the object wakes again from storage (step 8f)", async () => {
    allowLedgerWork();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stub = ledgerObject(env, "acc_wake");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO ledger_meta (key, value) VALUES ('nightly_day', ?)", new Date().toISOString().slice(0, 10));
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    // Run now, as Cloudflare would once it is due.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // Work due at once arrives after the object slept: a new instance on the same storage plans it.
    const planned = await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec(
        "INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, due_at, tries, created_at) VALUES ('w', 'unresolved', 'acc_wake', 'a', 'call', 'o', 0, 0, 1)",
      );
      const woken = new AccountLedger(state, env) as unknown as { planWork(): Promise<void> };
      await woken.planWork();
      return state.storage.getAlarm();
    });
    expect(planned).not.toBeNull();
    expect(planned!).toBeGreaterThanOrEqual(Date.now() + 50_000);
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it("keeps the minute after a run even when the run could not store its time (step 8f)", async () => {
    allowLedgerWork();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stub = ledgerObject(env, "acc_unstored");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO ledger_meta (key, value) VALUES ('nightly_day', ?)", new Date().toISOString().slice(0, 10));
      // More work due at once than one sweep takes, so some is still due when the run ends.
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SWEEP_BATCH + 5})
         INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, due_at, tries, created_at)
         SELECT 'w' || i, 'unresolved', 'acc_unstored', 'a', 'call', 'o' || i, 'missing', 0, 0, 1 FROM n`,
      );
      await state.storage.setAlarm(Date.now() + 3_600_000);
      // Storing the run's time fails; everything else works.
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      vi.spyOn(state.storage.sql, "exec").mockImplementation(((query: string, ...bindings: unknown[]) => {
        if (query.startsWith("INSERT INTO ledger_meta") && bindings[0] === "last_run_at") throw new Error("database or disk is full: SQLITE_FULL");
        return exec(query, ...bindings);
      }) as typeof state.storage.sql.exec);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const next = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    vi.restoreAllMocks();
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThanOrEqual(Date.now() + 50_000);
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it("answers a committed write even when setting its alarm fails, with a warning (step 8f)", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const proto = AccountLedger.prototype as unknown as { planWork(): Promise<void> };
    proto.planWork = () => Promise.reject(new Error("alarm storage unavailable"));
    onTestFinished(() => pauseLedgerWork());
    const written = await ledger("acc_alarm_fails")
      .prepare("INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, due_at, tries, created_at) VALUES ('w', 'unresolved', 'acc_alarm_fails', 'a', 'call', 'o', 0, 0, 1)")
      .run();
    expect(written.meta.changes).toBeGreaterThan(0);
    expect(await ledger("acc_alarm_fails").prepare("SELECT COUNT(*) AS n FROM open_work").first("n")).toBe(1);
    expect(warned.mock.calls.some(([line]) => String(line).includes('"message":"ledger_alarm_unset"'))).toBe(true);
  });

  it("finds its next work through the index of work still being tried (step 8f)", async () => {
    const plan = (await ledger().prepare(`EXPLAIN QUERY PLAN ${NEXT_DUE_SQL}`).all<{ detail: string }>()).results.map((row) => row.detail).join("\n");
    expect(plan).toContain("open_work_due_pending");
  });

  it("runs the nightly maintenance once a day, after its hour", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(nextNightly(at("2026-11-25T02:00:00Z"), null)).toBe(at("2026-11-25T04:00:00Z"));
    expect(nextNightly(at("2026-11-25T09:00:00Z"), "2026-11-24")).toBe(at("2026-11-25T09:00:00Z"));
    expect(nextNightly(at("2026-11-25T09:00:00Z"), "2026-11-25")).toBe(at("2026-11-26T04:00:00Z"));
  });

  it("starts new objects where `LEDGER_LOCATION_HINT` says, and ignores a value Cloudflare does not know", () => {
    expect(ledgerLocationHint({ LEDGER_LOCATION_HINT: "enam" } as unknown as Env)).toBe("enam");
    expect(ledgerLocationHint({ LEDGER_LOCATION_HINT: "mars" } as unknown as Env)).toBeUndefined();
    expect(ledgerLocationHint({} as unknown as Env)).toBeUndefined();
  });
});
