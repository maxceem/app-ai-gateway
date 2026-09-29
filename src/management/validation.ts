import type { z } from "zod";
import { GatewayError } from "../core/errors";
import { schemaIssueMessage } from "../shared/schema-issues";

/**
 * A request value through its schema, or the 400 that names the first thing
 * wrong with it. The catalog router parses every documented query and body
 * with this; the few surfaces that parse a value of their own — the
 * application-auth routes, and a CLI operation's payload once its browser step
 * has supplied the secret — use it too, so every rejection reads the same.
 */
export function parseRequest<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new GatewayError(400, "invalid_request", schemaIssueMessage(result.error));
}

/** Drizzle wraps D1 errors, so constraint messages may live on a cause. */
export function databaseErrorMatches(error: unknown, pattern: RegExp): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (pattern.test(current.message)) return true;
  }
  return false;
}

/** Display-only tail. Short secrets reveal less rather than more. */
export function secretHint(secret: string): string {
  return secret.length <= 4 ? secret.slice(-2) : secret.slice(-4);
}
