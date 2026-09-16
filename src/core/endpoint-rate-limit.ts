import { GatewayError } from "./errors";

const encoder = new TextEncoder();

async function subjectDigest(subject: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(subject)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Enforces a gateway endpoint's fixed-window abuse policy for one subject. */
export async function enforceEndpointRateLimit(
  env: Env,
  subject: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const name = `endpoint-rate:${await subjectDigest(subject)}`;
  const result = await env.ENDPOINT_RATE_LIMITER
    .getByName(name)
    .check({ limit, windowMs });
  if (!result.allowed)
    throw new GatewayError(
      429,
      "rate_limited",
      "Too many attempts; try again later",
      { "Retry-After": String(result.retryAfterSeconds) },
    );
}
