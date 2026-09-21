import { GatewayError } from "../../core/errors";

/**
 * What is left of the usage surface that is about HTTP rather than about
 * usage: two query-string readers. Everything that is SQL or calendar
 * arithmetic is in `src/management/usage-queries.ts`.
 */
export function parseLimit(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new GatewayError(400, "invalid_request", `limit must be an integer between 1 and ${max}`);
  }
  return limit;
}

export function parseOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const offset = Number.parseInt(value, 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new GatewayError(400, "invalid_request", "offset must be a non-negative integer");
  }
  return offset;
}
