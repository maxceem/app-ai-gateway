/**
 * The ledger object per account (step 8f, D21): its schema versions, the D1
 * shape the ledger code uses over it, and the rollup trigger inside a Durable
 * Object's SQLite.
 */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrateLedger, nextNightly } from "../src/do/AccountLedger.ts";
import { ledgerLocationHint, ledgerObject } from "../src/ledger/database.ts";
import { LEDGER_SCHEMA } from "../src/ledger/schema.ts";
import { ledger } from "./helpers.ts";

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
    const db = ledger("acc_alarm");
    const due = Date.now() + 3_600_000;
    await db
      .prepare("INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, due_at, tries, created_at) VALUES ('unresolved:gone', 'unresolved', 'acc_alarm', 'a', 'call', 'o', NULL, ?, 0, 1)")
      .bind(due)
      .run();
    const stub = ledgerObject(env, "acc_alarm");
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
