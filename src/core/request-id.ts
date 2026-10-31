/**
 * The id Cloudflare gives each request it delivers, from its `cf-ray` header:
 * sixteen hex digits and the data centre that served it, such as
 * `8f1a2b3c4d5e6f70-SJC`. It is random and names nothing but the request, so
 * a log line and a management analytics data point may both carry it, and one
 * can be found from the other.
 *
 * Only a value of exactly that shape is returned. The header comes from
 * Cloudflare's edge in production, but a request that reaches the Worker any
 * other way may carry anything, so nothing else is copied.
 */
const RAY_ID = /^[0-9a-f]{16}(?:-[A-Z]{3})?$/u;

export function requestIdOf(header: string | null | undefined): string | null {
  return header !== null && header !== undefined && RAY_ID.test(header) ? header : null;
}
