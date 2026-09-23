import type { CliUsageResponse } from "../contracts/cli";

/**
 * Durable ownership survives app deletion and both retention passes.
 *
 * Typed as the documented response rather than inferred, because it is answered
 * verbatim by `GET /v1/cli/usage`: the query and the contract move together.
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
    SELECT app_id AS appId, SUM(requests) AS requests,
      SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cost_usd) AS cost_usd, SUM(errors) AS errors, SUM(blocked) AS blocked,
      MIN(first_record) AS firstRecord
    FROM (
      SELECT app_id, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd,
        SUM(status='provider_error') AS errors, SUM(status LIKE 'blocked_%') AS blocked,
        MIN(created_at) AS first_record
      FROM app_usage_event WHERE organization_id=?1 AND created_at>=?2 AND created_at<?3 GROUP BY app_id
      UNION ALL
      SELECT app_id, SUM(requests), SUM(input_tokens), SUM(cached_input_tokens),SUM(cache_write_tokens),
        SUM(output_tokens),SUM(cost_usd),SUM(CASE WHEN status='provider_error' THEN requests ELSE 0 END),
        SUM(CASE WHEN status LIKE 'blocked_%' THEN requests ELSE 0 END),MIN(bucket)
      FROM app_usage_rollup WHERE organization_id=?1 AND bucket>=?2 AND bucket<?3 GROUP BY app_id
    ) GROUP BY app_id ORDER BY app_id`,
    )
    .bind(accountId, month, end)
    .all<{
      appId: string;
      requests: number;
      input_tokens: number;
      cached_input_tokens: number;
      cache_write_tokens: number;
      output_tokens: number;
      cost_usd: number;
      errors: number;
      blocked: number;
      firstRecord: string;
    }>();
  const totals = {
    requests: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    errors: 0,
    blocked: 0,
  };
  for (const row of result.results)
    for (const key of Object.keys(totals) as Array<keyof typeof totals>)
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
      historicalAttribution:
        "Existing rows were attributed only where the application owner was still known at migration. Earlier unowned history cannot be assigned or counted for this account.",
    },
  };
}
