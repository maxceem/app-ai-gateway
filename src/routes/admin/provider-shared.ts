import type { Context } from "hono";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

type AdminEnv = { Bindings: Env; Variables: AdminVariables };

export async function providerRequestBody(c: Context<AdminEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
}

export function providerSchemaBody<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new GatewayError(
    400,
    "invalid_request",
    issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request body",
  );
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
