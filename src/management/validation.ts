import type { z } from "zod";
import { GatewayError, type RequestFieldIssue } from "../core/errors";
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
  throw new GatewayError(400, "invalid_request", schemaIssueMessage(result.error), undefined, {
    field: fieldIssue(result.error),
  });
}

/** A top-level field name, as the request schemas spell theirs. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * The first issue's top-level field and code, for management analytics. Only
 * the first path segment, because below it a record's keys are the caller's
 * own — a provider-native parameter, a header name — and not the schema's.
 */
function fieldIssue(error: z.ZodError): RequestFieldIssue | undefined {
  const issue = error.issues[0];
  if (issue === undefined) return undefined;
  const head = issue.path[0];
  return { name: typeof head === "string" && FIELD_NAME.test(head) ? head : null, issue: issue.code };
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
