import type { CloudflareLogs } from "./env.ts";

/**
 * Counting the deployment's own log lines, through the Workers Observability
 * telemetry query API. Only counts are read, grouped by log message: never a
 * log line's fields, which can name an app, an account or a user.
 */

/** How many times each of `messages` was logged in the last `windowMs`; a message never logged is absent. */
/** How long the log query may take, answer included. */
const QUERY_TIMEOUT_MS = 20_000;

/**
 * The logs could not be read, so nothing is known about the gateway: Cloudflare's
 * API failed, was slow or answered without counts. A check that fails with it
 * says the monitor could not look, not that the gateway fell back.
 */
export class LogsUnreadable extends Error {
  override name = "LogsUnreadable";

  constructor(reason: string) {
    super(`the monitor could not read the gateway's logs, which says nothing about the gateway: ${reason}`);
  }
}

/** How many times each of `messages` was logged in the last `windowMs`; a message never logged is absent. */
export async function countLogMessages(
  logs: CloudflareLogs,
  messages: readonly string[],
  windowMs: number,
  now: number = Date.now(),
): Promise<Record<string, number>> {
  let answer: unknown;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${logs.accountId}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${logs.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify(logMessageQuery(logs.workerName, messages, now - windowMs, now)),
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      },
    );
    // Never the body: Cloudflare echoes the query back, and an error is enough said by its status.
    if (!response.ok) throw new LogsUnreadable(`Cloudflare's log query answered ${response.status}`);
    answer = await response.json();
  } catch (error) {
    throw error instanceof LogsUnreadable ? error : new LogsUnreadable(queryFailure(error));
  }
  return parseMessageCounts(answer);
}

/** Why the query itself failed, by the error's kind only: its message can name the URL. */
export function queryFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return `Cloudflare's log query did not answer within ${QUERY_TIMEOUT_MS / 1000} seconds`;
  if (name === "SyntaxError") return "Cloudflare's log query answered with something other than JSON";
  return `Cloudflare's log query could not be sent (${name || "unknown error"})`;
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
  if (success !== true || !Array.isArray(aggregates)) throw new LogsUnreadable("Cloudflare's log query gave no counts");
  const counts: Record<string, number> = {};
  for (const { groupKey, value } of aggregates) {
    if (typeof groupKey === "string" && typeof value === "number" && value > 0) counts[groupKey] = value;
  }
  return counts;
}
