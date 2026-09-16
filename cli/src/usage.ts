import type { CliUsageResponse } from "../../src/contracts/cli.ts";
import type {
  BreakdownResponse,
  MonthlyUsageResponse,
} from "../../src/contracts/responses.ts";
import { fail } from "./common.ts";
import type { Context } from "./context.ts";
import type { Flags } from "./parser.ts";
import { required } from "./resources.ts";

/** What `usage breakdown` adds to the server's answer: how far it reaches back. */
export interface BreakdownCoverage {
  from: string;
  to: string;
  source: string;
}

export type UsageResult =
  | MonthlyUsageResponse
  | CliUsageResponse
  | (BreakdownResponse & { coverage: BreakdownCoverage });

export function month(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
    fail(
      "invalid_input",
      "Month must use YYYY-MM with a valid calendar month.",
    );
  return value;
}

export function date(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    fail(
      "invalid_input",
      "Dates must be real UTC calendar dates in YYYY-MM-DD format.",
    );
  return value;
}

export function positive(value: string | number, max = 3600): number {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > max)
    fail("invalid_input", `Supply an integer between 1 and ${max}.`);
  return Number(value);
}

export async function usageCommand(
  ctx: Context,
  command: string,
  flags: Flags,
): Promise<UsageResult> {
  if (command === "usage show") {
    const m = month(flags.month ?? new Date().toISOString().slice(0, 7));
    return flags.app
      ? (await ctx.call("getAppUsage", [flags.app, { month: m }])).data
      : (await ctx.call("getCliUsage", [{ month: m }])).data;
  }
  const app = await required(flags, "app");
  const by = flags.by ?? "model";
  if (!["provider", "model", "status"].includes(by))
    fail("invalid_input", "--by must be provider, model or status.");
  if (Boolean(flags.from) !== Boolean(flags.to))
    fail("invalid_input", "Supply both --from and --to or neither.");
  const today = new Date().toISOString().slice(0, 10);
  const from = date(flags.from ?? today.slice(0, 7) + "-01");
  const to = date(flags.to ?? today);
  if (from > to) fail("invalid_input", "--from must not be later than --to.");
  const limit = positive(flags.limit ?? 50, 200);
  return {
    ...(await ctx.call("getAppUsageBreakdown", [app, { from, to, by, limit }])).data,
    coverage: {
      from,
      to,
      source:
        "Raw events and retained daily aggregates; dimensions provider, model and status survive raw event retention.",
    },
  };
}
