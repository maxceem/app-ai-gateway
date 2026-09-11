import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { timeOrderedId } from "../src/core/ids";
import {
  CHUNK_ROWS,
  compactUsageEvents,
  foldUsageRollupMonths,
  USAGE_EVENT_RETENTION_DAYS,
  USAGE_ROLLUP_DAY_RETENTION_DAYS,
} from "../src/core/usage-retention";
import {
  organizationMonthUsage,
  usageBreakdown,
  usageMonthTotals,
  usageTimeseries,
} from "../src/routes/admin/shared";
import { TEST_ORGANIZATION_ID, seedServerApp } from "./helpers";

/** Fixed so every cutoff below is arithmetic rather than a moving target. */
const NOW = Date.parse("2026-06-01T00:00:00Z");

/** Comfortably past both windows. */
const EXPIRED_DAY = "2026-01-10";
const OTHER_EXPIRED_DAY = "2026-01-11";
/** Comfortably inside the retention window. */
const LIVE_DAY = "2026-05-20";

const APP = "retention-app";

/** A UTC timestamp as the `YYYY-MM-DD` a bucket is named with. */
function dayString(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

interface EventInput {
  day: string;
  appId?: string;
  model?: string;
  provider?: string;
  status?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  time?: string;
}

async function insertEvent(input: EventInput): Promise<void> {
  await env.DB
    .prepare(`
      INSERT INTO app_usage_event
        (event_id, app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status, created_at)
      VALUES (?, ?, NULL, ?, ?, '/v1/chat/completions', ?, 0, 0, ?, ?, ?, ?)`)
    .bind(
      timeOrderedId(),
      input.appId ?? APP,
      input.provider ?? "openai",
      input.model ?? "gpt-4o-mini",
      input.inputTokens ?? 10,
      input.outputTokens ?? 5,
      input.costUsd ?? 0.25,
      input.status ?? "ok",
      `${input.day} ${input.time ?? "12:00:00"}`,
    )
    .run();
}

/** Many identical events in one statement, for the chunk-boundary cases. */
async function insertEvents(count: number, day: string): Promise<void> {
  await env.DB
    .prepare(`
      INSERT INTO app_usage_event
        (event_id, app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status, created_at)
      WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
      SELECT lower(hex(randomblob(16))), ?, NULL, 'openai', 'gpt-4o-mini',
             '/v1/chat/completions', 1, 0, 0, 1, 0.01, 'ok', ?
      FROM seq`)
    .bind(count, APP, `${day} 12:00:00`)
    .run();
}

async function eventCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_usage_event").first<{ n: number }>();
  return row?.n ?? 0;
}

interface RollupRow {
  grain: string;
  bucket: string;
  app_id: string;
  model: string;
  provider_type: string;
  status: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

async function rollupRows(): Promise<RollupRow[]> {
  const { results } = await env.DB
    .prepare("SELECT * FROM app_usage_rollup ORDER BY grain, bucket, model, provider_type, status")
    .all<RollupRow>();
  return results;
}

async function remainingEventDays(): Promise<string[]> {
  const { results } = await env.DB
    .prepare("SELECT substr(created_at, 1, 10) AS day FROM app_usage_event ORDER BY id")
    .all<{ day: string }>();
  return results.map((row) => row.day);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_usage_event"),
    env.DB.prepare("DELETE FROM app_usage_rollup"),
  ]);
});

describe("timeOrderedId", () => {
  it("sorts lexically in the order it was minted", () => {
    const ids = [timeOrderedId(1), timeOrderedId(1_000), timeOrderedId(1_700_000_000_000)];
    expect([...ids].sort()).toEqual(ids);
  });

  it("keeps the timestamp prefix a fixed width, which is what makes it sortable", () => {
    // Without the padding a smaller timestamp would produce a shorter prefix and
    // sort after a larger one, which is the whole bug this guards.
    expect(timeOrderedId(1)).toHaveLength(32);
    expect(timeOrderedId(Date.now())).toHaveLength(32);
  });

  it("does not repeat itself", () => {
    const minted = new Set(Array.from({ length: 2_000 }, () => timeOrderedId()));
    expect(minted.size).toBe(2_000);
  });
});

describe("compactUsageEvents", () => {
  it("sums expired events into day buckets and deletes them", async () => {
    await insertEvent({ day: EXPIRED_DAY });
    await insertEvent({ day: EXPIRED_DAY });
    await insertEvent({ day: OTHER_EXPIRED_DAY, model: "gpt-4o" });

    const result = await compactUsageEvents(env, NOW);

    expect(result.deleted).toBe(3);
    expect(result.caughtUp).toBe(true);
    expect(await remainingEventDays()).toEqual([]);

    const rows = await rollupRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      grain: "day",
      bucket: EXPIRED_DAY,
      model: "gpt-4o-mini",
      requests: 2,
      input_tokens: 20,
      output_tokens: 10,
      cost_usd: 0.5,
    });
    expect(rows[1]).toMatchObject({ bucket: OTHER_EXPIRED_DAY, model: "gpt-4o", requests: 1 });
  });

  it("leaves events inside the retention window alone", async () => {
    await insertEvent({ day: LIVE_DAY });

    const result = await compactUsageEvents(env, NOW);

    expect(result.deleted).toBe(0);
    expect(await remainingEventDays()).toEqual([LIVE_DAY]);
    expect(await rollupRows()).toEqual([]);
  });

  it("splits one day across dimensions rather than collapsing them", async () => {
    await insertEvent({ day: EXPIRED_DAY, model: "a", provider: "openai", status: "ok" });
    await insertEvent({ day: EXPIRED_DAY, model: "a", provider: "openai", status: "provider_error" });
    await insertEvent({ day: EXPIRED_DAY, model: "b", provider: "anthropic", status: "ok" });

    await compactUsageEvents(env, NOW);

    const rows = await rollupRows();
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.requests === 1)).toBe(true);
  });

  it("adds to a bucket a previous run already wrote instead of duplicating it", async () => {
    await insertEvent({ day: EXPIRED_DAY, costUsd: 1 });
    await compactUsageEvents(env, NOW);

    // A chunk is an id range and a bucket is a calendar day, so a day arriving
    // across two runs is the normal case, not an edge one.
    await insertEvent({ day: EXPIRED_DAY, costUsd: 2 });
    await compactUsageEvents(env, NOW);

    const rows = await rollupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 2, cost_usd: 3 });
  });

  it("stops at the first live row instead of walking the rest of the table", async () => {
    await insertEvent({ day: EXPIRED_DAY });
    await insertEvent({ day: LIVE_DAY });

    const result = await compactUsageEvents(env, NOW);

    expect(result.caughtUp).toBe(true);
    expect(result.chunks).toBe(1);
    expect(await remainingEventDays()).toEqual([LIVE_DAY]);
  });

  it("reports nothing to do for an empty table without opening a transaction", async () => {
    const result = await compactUsageEvents(env, NOW);
    expect(result).toEqual({ chunks: 0, rolledUp: 0, deleted: 0, caughtUp: true });
  });

  it("collects an expired row behind a live one in the same chunk", async () => {
    // A chunk is an id range and both of its statements filter on `created_at`,
    // so position inside the chunk decides nothing.
    await insertEvent({ day: LIVE_DAY });
    await insertEvent({ day: EXPIRED_DAY });

    await compactUsageEvents(env, NOW);

    expect(await remainingEventDays()).toEqual([LIVE_DAY]);
    expect((await rollupRows())[0]).toMatchObject({ bucket: EXPIRED_DAY, requests: 1 });
  });

  it("defers an expired row that a live chunk boundary hides, then collects it", async () => {
    // One whole chunk of live rows, so the loop stops at that boundary and never
    // reaches the expired row behind it. Only clock skew between two nodes
    // inserting at once produces this, and it resolves itself a run later.
    await insertEvents(CHUNK_ROWS, LIVE_DAY);
    await insertEvent({ day: EXPIRED_DAY });

    await compactUsageEvents(env, NOW);
    expect(await rollupRows()).toEqual([]);
    expect(await eventCount()).toBe(CHUNK_ROWS + 1);

    // Far enough forward that the chunk in front of it has expired too.
    const later = NOW + (USAGE_EVENT_RETENTION_DAYS + 10) * 86_400_000;
    await compactUsageEvents(env, later);

    expect(await eventCount()).toBe(0);
    const rows = await rollupRows();
    expect(rows.map((row) => row.bucket)).toEqual([EXPIRED_DAY, LIVE_DAY]);
  });

  it("does not count an event twice when run again", async () => {
    await insertEvent({ day: EXPIRED_DAY });
    await compactUsageEvents(env, NOW);

    // Idempotence across runs. That the two statements cannot come apart *within*
    // a run rests on D1's `batch` being a transaction, which no test here can
    // observe; this only pins that a second run finds nothing left to do.
    const second = await compactUsageEvents(env, NOW);
    expect(second.deleted).toBe(0);
    const rows = await rollupRows();
    expect(rows[0]?.requests).toBe(1);
  });

  it("stops when the query budget runs out and resumes on the next run", async () => {
    await insertEvents(CHUNK_ROWS + 1, EXPIRED_DAY);

    // Enough for the opening cursor read and exactly one chunk.
    const first = await compactUsageEvents(env, NOW, { remaining: 4 });
    expect(first.chunks).toBe(1);
    expect(first.caughtUp).toBe(false);
    expect(await eventCount()).toBe(1);

    const second = await compactUsageEvents(env, NOW);
    expect(second.caughtUp).toBe(true);
    expect(await eventCount()).toBe(0);
    // One bucket, summed across both runs rather than duplicated by them.
    const rows = await rollupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bucket: EXPIRED_DAY, requests: CHUNK_ROWS + 1 });
  });
});

describe("foldUsageRollupMonths", () => {
  /** Writes a day bucket directly, standing in for an earlier compaction. */
  async function seedDayBucket(bucket: string, requests: number, model = "gpt-4o-mini"): Promise<void> {
    await env.DB
      .prepare(`
        INSERT INTO app_usage_rollup
          (grain, bucket, app_id, model, provider_type, status, requests,
           input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd)
        VALUES ('day', ?, ?, ?, 'openai', 'ok', ?, ?, 0, 0, 0, ?)`)
      .bind(bucket, APP, model, requests, requests * 10, requests * 0.5)
      .run();
  }

  it("folds every day of a month into one month bucket", async () => {
    await seedDayBucket("2024-03-01", 2);
    await seedDayBucket("2024-03-02", 3);

    const result = await foldUsageRollupMonths(env, NOW);

    expect(result.months).toBe(1);
    const rows = await rollupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      grain: "month",
      bucket: "2024-03",
      requests: 5,
      input_tokens: 50,
      cost_usd: 2.5,
    });
  });

  it("keeps a month's dimensions apart", async () => {
    await seedDayBucket("2024-03-01", 2, "gpt-4o-mini");
    await seedDayBucket("2024-03-02", 3, "gpt-4o");

    await foldUsageRollupMonths(env, NOW);

    const rows = await rollupRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.requests).sort()).toEqual([2, 3]);
  });

  it("leaves a month that is not yet entirely past the day window", async () => {
    const inside = new Date(NOW - (USAGE_ROLLUP_DAY_RETENTION_DAYS - 14) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await seedDayBucket(inside, 4);

    const result = await foldUsageRollupMonths(env, NOW);

    expect(result.months).toBe(0);
    expect((await rollupRows())[0]).toMatchObject({ grain: "day", bucket: inside });
  });

  it("holds back the whole month the window falls inside, not just its tail", async () => {
    /*
     * The month containing the cutoff day has days on both sides of it. Folding
     * it the moment its first day expires would bury days that are still inside
     * the window in a bucket a day-resolution query can no longer read, so the
     * month waits until all of it has aged out.
     */
    // The window lands on 2025-04-27, so these sit either side of it inside one
    // April: the first has aged out, the second has not.
    const straddled = dayString(NOW - (USAGE_ROLLUP_DAY_RETENTION_DAYS + 5) * 86_400_000);
    const stillInside = dayString(NOW - (USAGE_ROLLUP_DAY_RETENTION_DAYS - 3) * 86_400_000);
    const cutoffDay = dayString(NOW - USAGE_ROLLUP_DAY_RETENTION_DAYS * 86_400_000);
    expect(straddled.slice(0, 7)).toBe(stillInside.slice(0, 7));
    expect(straddled < cutoffDay).toBe(true);
    expect(stillInside > cutoffDay).toBe(true);
    await seedDayBucket(straddled, 1);
    await seedDayBucket(stillInside, 1);

    const result = await foldUsageRollupMonths(env, NOW);

    expect(result.months).toBe(0);
    expect((await rollupRows()).every((row) => row.grain === "day")).toBe(true);
  });

  it("adds to a month bucket that already exists", async () => {
    await seedDayBucket("2024-03-01", 2);
    await foldUsageRollupMonths(env, NOW);
    await seedDayBucket("2024-03-09", 5);
    await foldUsageRollupMonths(env, NOW);

    const rows = await rollupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ grain: "month", bucket: "2024-03", requests: 7 });
  });

  it("does not read back the month rows it writes", async () => {
    // The scan is filtered to day rows and every row written is a month row, so
    // a fold can never sum its own output into itself.
    await seedDayBucket("2024-03-01", 1);
    await seedDayBucket("2024-04-01", 1);

    const result = await foldUsageRollupMonths(env, NOW);

    expect(result.months).toBe(2);
    const rows = await rollupRows();
    expect(rows.map((row) => row.bucket)).toEqual(["2024-03", "2024-04"]);
    expect(rows.every((row) => row.requests === 1)).toBe(true);
  });
});

describe("reading across both tables", () => {
  // Once, not per test: the surrounding beforeEach clears the usage tables but
  // leaves the application row, and seeding it twice collides on its primary key.
  beforeAll(async () => {
    await seedServerApp(APP);
  });

  it("totals a month that is half compacted", async () => {
    await insertEvent({ day: "2026-05-02", costUsd: 1 });
    await insertEvent({ day: "2026-05-03", costUsd: 2 });
    // Compact only the first of the two, by asking from a `now` that has just
    // aged it out.
    await compactUsageEvents(env, Date.parse("2026-05-03T00:00:00Z") + USAGE_EVENT_RETENTION_DAYS * 86_400_000);

    expect(await remainingEventDays()).toEqual(["2026-05-03"]);
    expect((await rollupRows()).map((row) => row.bucket)).toEqual(["2026-05-02"]);

    const totals = await usageMonthTotals(env.DB, APP, "2026-05");
    expect(totals).toMatchObject({ requests: 2, cost_usd: 3 });
  });

  it("rejoins a single day that is split across both tables", async () => {
    await insertEvent({ day: EXPIRED_DAY, time: "01:00:00", costUsd: 1 });
    await compactUsageEvents(env, NOW);
    // A late-arriving event for a day already summed: the union has to add the
    // rollup row and the raw row back together rather than report two buckets.
    await insertEvent({ day: EXPIRED_DAY, time: "02:00:00", costUsd: 2 });

    const { results } = await usageTimeseries(env.DB, APP, { from: "2026-01-01", to: "2026-01-31" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ date: EXPIRED_DAY, provider: "openai", requests: 2, cost_usd: 3 });
  });

  it("weighs the rollup's status counters by requests, not by rows", async () => {
    await insertEvent({ day: EXPIRED_DAY, status: "provider_error" });
    await insertEvent({ day: EXPIRED_DAY, status: "provider_error" });
    await insertEvent({ day: EXPIRED_DAY, status: "blocked_app_rate" });
    await insertEvent({ day: EXPIRED_DAY, status: "blocked_app_rate" });
    await insertEvent({ day: EXPIRED_DAY, status: "blocked_app_rate" });
    await compactUsageEvents(env, NOW);

    const { results } = await usageTimeseries(env.DB, APP, { from: "2026-01-01", to: "2026-01-31" });
    /*
     * Five events compacted into two rows. Both counters have to weigh by
     * `requests`: counting rows instead would report one error and one blocked,
     * so each needs more than one event behind it to tell the two apart.
     */
    expect(results[0]).toMatchObject({ requests: 5, errors: 2, blocked: 3 });
  });

  it("honours both ends of the range on both halves of the union", async () => {
    // A row outside each end of the range in each table, so dropping any one of
    // the four date predicates shows up as an extra bucket rather than as
    // nothing at all.
    await insertEvent({ day: "2026-01-05", model: "rollup-before" });
    await insertEvent({ day: EXPIRED_DAY, model: "rollup-inside" });
    await insertEvent({ day: "2026-01-20", model: "rollup-after" });
    await compactUsageEvents(env, NOW);
    expect(await eventCount()).toBe(0);

    // Late arrivals for the same days stay raw, so both tables hold a row on
    // either side of the range and one inside it.
    await insertEvent({ day: "2026-01-08", model: "raw-before" });
    await insertEvent({ day: "2026-01-12", model: "raw-inside" });
    await insertEvent({ day: "2026-01-18", model: "raw-after" });

    const range = { from: EXPIRED_DAY, to: "2026-01-15" };
    const series = await usageTimeseries(env.DB, APP, range);
    expect(series.results.map((row) => row.date)).toEqual([EXPIRED_DAY, "2026-01-12"]);

    const breakdown = await usageBreakdown(env.DB, APP, range, "model", 50);
    expect(breakdown.results.map((row) => row.key).sort()).toEqual(["raw-inside", "rollup-inside"]);
  });

  it("breaks down by model across the boundary", async () => {
    await insertEvent({ day: EXPIRED_DAY, model: "gpt-4o" });
    await insertEvent({ day: EXPIRED_DAY, model: "gpt-4o" });
    await compactUsageEvents(env, NOW);
    await insertEvent({ day: LIVE_DAY, model: "gpt-4o" });
    await insertEvent({ day: LIVE_DAY, model: "claude-sonnet-4-5" });

    const { results } = await usageBreakdown(
      env.DB,
      APP,
      { from: "2026-01-01", to: "2026-05-31" },
      "model",
      50,
    );
    expect(results).toEqual([
      expect.objectContaining({ key: "gpt-4o", requests: 3 }),
      expect.objectContaining({ key: "claude-sonnet-4-5", requests: 1 }),
    ]);
  });

  it("excludes month buckets from a day series, which has nowhere to put them", async () => {
    await insertEvent({ day: "2024-03-05" });
    await compactUsageEvents(env, NOW);
    await foldUsageRollupMonths(env, NOW);
    expect((await rollupRows())[0]).toMatchObject({ grain: "month", bucket: "2024-03" });

    // The range deliberately opens in the previous month: `'2024-03'` sorts
    // inside `'2024-02-15' .. '2024-03-31'`, so only the grain filter keeps a
    // month bucket from being served as if it were a date.
    const { results } = await usageTimeseries(env.DB, APP, { from: "2024-02-15", to: "2024-03-31" });
    expect(results).toEqual([]);
    // The breakdown carries its own grain filter and needs its own guard: without
    // one, a ten-day range would be answered with a whole folded month.
    const breakdown = await usageBreakdown(
      env.DB,
      APP,
      { from: "2024-02-15", to: "2024-03-10" },
      "model",
      50,
    );
    expect(breakdown.results).toEqual([]);
    // The month total still finds it, because that query matches on the prefix
    // and so reads whichever grain currently holds the month.
    expect(await usageMonthTotals(env.DB, APP, "2024-03")).toMatchObject({ requests: 1 });
  });

  it("reports an organization's apps from both tables", async () => {
    await insertEvent({ day: "2026-05-02", costUsd: 1 });
    await insertEvent({ day: "2026-05-03", costUsd: 2 });
    await compactUsageEvents(env, Date.parse("2026-05-03T00:00:00Z") + USAGE_EVENT_RETENTION_DAYS * 86_400_000);

    const { results } = await organizationMonthUsage(env.DB, TEST_ORGANIZATION_ID, "2026-05");
    expect(results).toEqual([expect.objectContaining({ app_id: APP, requests: 2, cost_usd: 3 })]);
  });

  it("finds a folded month for an organization too", async () => {
    await insertEvent({ day: "2024-03-05" });
    await compactUsageEvents(env, NOW);
    await foldUsageRollupMonths(env, NOW);

    const { results } = await organizationMonthUsage(env.DB, TEST_ORGANIZATION_ID, "2024-03");
    expect(results).toEqual([expect.objectContaining({ app_id: APP, requests: 1 })]);
  });

  it("keeps another organization's traffic out", async () => {
    await insertEvent({ day: EXPIRED_DAY, appId: "someone-elses-app" });
    await compactUsageEvents(env, NOW);

    const { results } = await organizationMonthUsage(env.DB, TEST_ORGANIZATION_ID, "2026-01");
    expect(results).toEqual([]);
  });
});
