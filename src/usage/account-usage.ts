import type { CliUsageResponse } from "../contracts/cli";
import type { UsageTotals } from "../contracts/responses";
import {
  EMPTY_USAGE_TOTALS,
  rawTotals,
  rollupTotals,
  UNION_TOTALS,
} from "../management/usage-queries";

/**
 * Durable ownership survives app deletion and both retention passes.
 *
 * Typed as the documented response rather than inferred, because it is answered
 * verbatim by `GET /v1/cli/usage`: the query and the contract move together.
 * The counters are the ones every usage aggregate sums, from
 * `src/management/usage-queries.ts`; what is this query's own is matching on
 * the organization each row was recorded under rather than on the apps it owns
 * now, which is what keeps a deleted app's usage in the account's.
 */
export async function accountMonthUsage(
  db: D1Database,
  accountId: string,
  month: string,
): Promise<CliUsageResponse> {
  const next = new Date(`${month}-01T00:00:00.000Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const end = next.toISOString().slice(0, 7);
  const result = await db
    .prepare(
      `
    SELECT app_id AS appId,${UNION_TOTALS},
      MIN(first_record) AS firstRecord
    FROM (
      SELECT events.app_id AS app_id,${rawTotals("events")},
        MIN(events.created_at) AS first_record
      FROM app_usage_event AS events
      WHERE events.organization_id=?1 AND events.created_at>=?2 AND events.created_at<?3
      GROUP BY events.app_id
      UNION ALL
      SELECT rollup.app_id AS app_id,${rollupTotals("rollup")},
        MIN(rollup.bucket) AS first_record
      FROM app_usage_rollup AS rollup
      WHERE rollup.organization_id=?1 AND rollup.bucket>=?2 AND rollup.bucket<?3
      GROUP BY rollup.app_id
    ) GROUP BY app_id ORDER BY app_id`,
    )
    .bind(accountId, month, end)
    .all<UsageTotals & { appId: string; firstRecord: string }>();
  const totals = { ...EMPTY_USAGE_TOTALS };
  for (const row of result.results)
    for (const key of Object.keys(totals) as (keyof UsageTotals)[])
      totals[key] += row[key];
  const current = await db
    .prepare("SELECT id FROM app WHERE organization_id=?")
    .bind(accountId)
    .all<{ id: string }>();
  const currentIds = new Set(current.results.map((row) => row.id));
  return {
    accountId,
    month,
    totals,
    apps: result.results.map((row) => ({
      ...row,
      deleted: !currentIds.has(row.appId),
    })),
    coverage: {
      scope: "retained_account_usage",
      firstRecord: result.results.reduce<string | null>(
        (first, row) =>
          first === null || row.firstRecord < first ? row.firstRecord : first,
        null,
      ),
    },
  };
}
