import { randomBytes } from "node:crypto";
import type { z } from "zod";
import type { CliErrorDetails } from "../../src/contracts/operation-schemas.ts";

export { VERSION } from "./manifest.ts";
export const CLOUD = "https://api.appaigateway.com";

/**
 * Everything a failure has to say, in the shape the error envelope prints.
 *
 * `details` is declared rather than free-form: it reaches stdout, and
 * `CliErrorDetailsSchema` is what parses it on the way out, so a field that has
 * not been written down as public cannot be attached here by accident.
 */
export class CliError extends Error {
  readonly code: string;
  readonly nextAction: string;
  readonly exitCode: number;
  readonly details: CliErrorDetails | undefined;

  constructor(
    code: string,
    message: string,
    nextAction = "Run agw --help for usage.",
    exitCode = 2,
    details?: CliErrorDetails,
  ) {
    super(message);
    this.code = code;
    this.nextAction = nextAction;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function fail(
  code: string,
  message: string,
  nextAction?: string,
  exitCode?: number,
  details?: CliErrorDetails,
): never {
  throw new CliError(code, message, nextAction, exitCode, details);
}

export const randomToken = (): string => randomBytes(32).toString("base64url");

export function origin(value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    fail("invalid_url", "Supply a valid deployment HTTPS URL.");
  }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname !== "/" && u.pathname !== "")
  )
    fail(
      "invalid_url",
      "Deployment URL must be an origin without credentials, path, query or fragment.",
    );
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
  )
    fail(
      "invalid_url",
      "Public deployments require HTTPS; HTTP is permitted only on loopback.",
    );
  return u.origin;
}

/** Parses caller-supplied input, reporting every issue the way `agw` does. */
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    fail(
      "invalid_input",
      r.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; "),
    );
  return r.data;
}
