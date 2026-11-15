/** Values the commands this CLI implements itself read from their flags. */
import { fail } from "./common.ts";

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
