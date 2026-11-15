import type { CloudflareLogs } from "./env.ts";

/**
 * Counting the deployment's own log lines, through the Workers Observability
 * telemetry query API. Only counts are read, grouped by log message: never a
 * log line's fields, which can name an app, an account or a user.
 */

/** How many times each of `messages` was logged in the last `windowMs`; a message never logged is absent. */
export async function countLogMessages(
  logs: CloudflareLogs,
  messages: readonly string[],
  windowMs: number,
  now: number = Date.now(),
): Promise<Record<string, number>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${logs.accountId}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${logs.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify(logMessageQuery(logs.workerName, messages, now - windowMs, now)),
      signal: AbortSignal.timeout(20_000),
    },
  );
  // Never the body: Cloudflare echoes the query back, and an error is enough said by its status.
  if (!response.ok) throw new Error(`Cloudflare's log query answered ${response.status}`);
  return parseMessageCounts(await response.json());
}

export function logMessageQuery(workerName: string, messages: readonly string[], from: number, to: number): unknown {
  return {
    queryId: "smoke-log-message-counts",
    view: "calculations",
    timeframe: { from, to },
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [
        { key: "$workers.scriptName", operation: "eq", type: "string", value: workerName },
        {
          kind: "group",
          filterCombination: "or",
          filters: messages.map((message) => ({ key: "$metadata.message", operation: "eq", type: "string", value: message })),
        },
      ],
      calculations: [{ operator: "count", alias: "count" }],
      groupBys: [{ type: "string", value: "$metadata.message" }],
    },
  };
}

interface QueryAnswer {
  success?: boolean;
  result?: { calculations?: { aggregates?: { groupKey?: unknown; value?: unknown }[] }[] };
}

export function parseMessageCounts(answer: unknown): Record<string, number> {
  const { success, result } = (answer ?? {}) as QueryAnswer;
  const aggregates = result?.calculations?.[0]?.aggregates;
  if (success !== true || !Array.isArray(aggregates)) throw new Error("Cloudflare's log query gave no counts");
  const counts: Record<string, number> = {};
  for (const { groupKey, value } of aggregates) {
    if (typeof groupKey === "string" && typeof value === "number" && value > 0) counts[groupKey] = value;
  }
  return counts;
}
