/**
 * Small helpers the smoke checks share. Not a check itself: the runner reads
 * only `*.smoke.ts`.
 *
 * A failed check prints only what is safe to print: fixed text, a status,
 * and an error code from a fixed list. Never a response body, a value read
 * from one, or a field name, which can hold an app key, a gateway token or a
 * provider key. The checks' output goes into the reports of whoever runs them
 * (the outside monitor after a release, or a person at a terminal), and those
 * reports should never hold a key either.
 *
 * So the checks assert only through the helpers below, each taking a fixed
 * message, and send requests only through `send`. `test/smoke-assertions.test.ts`
 * refuses anything else in the files it guards: a direct `node:assert` call,
 * `fetch` or `console`, or a message that is not a plain string.
 */
import { AssertionError } from "node:assert";
import { randomUUID } from "node:crypto";

/**
 * The error codes a failed check may name: the gateway's own (`src/core/errors.ts`,
 * written out here because a smoke check runs against older deployments too),
 * the mock provider's, and the CLI's. Any other code is reported as unlisted,
 * since a regression could put anything there.
 */
const KNOWN_CODES: ReadonlySet<string> = new Set([
  "auth_required", "assertion_required", "attest_failed", "auth_method_not_supported", "issuer_token_rejected",
  "issuer_claims_missing", "issuer_verification_unavailable", "invalid_request", "payload_too_large", "rate_limited",
  "app_not_found", "app_disabled", "not_found", "service_unavailable", "internal_error", "provider_not_configured",
  "provider_disabled", "provider_unavailable", "provider_error", "path_not_allowed", "model_not_allowed",
  "pricing_not_configured", "max_output_tokens_exceeded", "preset_not_found", "job_not_found", "app_rate_limited",
  "app_budget_exhausted", "billing_request_quota_exceeded", "billing_payment_required", "billing_unavailable",
  "forbidden", "grant_insufficient", "conflict", "app_revision_required", "app_revision_conflict", "account_changed",
  "provider_not_found", "key_not_found", "billing_plan_limit_reached", "billing_feature_not_included",
  "session_required", "not_a_member", "last_owner", "operation_expired", "operation_denied", "operation_not_found",
  "operation_mismatch", "already_revealed", "already_completed", "no_eligible_organization", "registration_disabled",
  "tool_not_found", "tool_changed",
  // The mock provider's.
  "mock_error", "mock_failure",
]);

/** Fails with `message`, which is fixed text. */
export function fail(message: string): never {
  throw new AssertionError({ message });
}

/** Fails with `message` unless `condition` holds. */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

/** Fails with `message` unless the two parsed values are the same (see `sameJson`). */
export function same(actual: unknown, expected: unknown, message: string): void {
  check(sameJson(actual, expected), message);
}

/** Fails unless a parsed response answered `status`, saying what answered and its status and listed code. */
export function expectStatus(response: { status: number; body?: unknown }, status: number, what: string): void {
  check(response.status === status, `${what} ${outcome({ status: response.status, body: response.body })}`);
}

/** The same for a raw response, read from a copy so the caller can still read it. */
export async function expectResponse(response: Response, status: number, what: string): Promise<void> {
  if (response.status !== status) fail(`${what} ${await responseOutcome(response)}`);
}

/** Fails unless a parsed body's error code is `code`, naming either code only when it is a listed one. */
export function expectCode(body: unknown, code: string, what: string): void {
  check(rawCode(body) === code, `${what}: expected ${listed(code)}, got ${errorCode(body)}`);
}

/** Prints `message`, which is fixed text. */
export function note(message: string): void {
  console.log(message);
}

/**
 * A request to `path` on `base`. A request that cannot be made fails with
 * fixed text: Node's own error can quote the URL or a header, and either
 * can hold a key or a token.
 */
export async function send(path: string, base: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(new URL(path, base), init);
  } catch {
    fail("a request could not be sent");
  }
}

/**
 * `value` when it is shaped like an id the gateway makes, before it is put
 * in a path or an `agw` argument; fails with fixed text otherwise, since a
 * regression could put anything there.
 */
export function checkId(value: unknown, what: string): string {
  check(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value), `${what} is not shaped like an id`);
  return value;
}

/** Fails unless an `agw --json` run exited 0. */
export function expectCli(run: { code: number; json: unknown }, what: string): void {
  check(run.code === 0, `${what} ${cliOutcome(run)}`);
}

/** A slug no other run picks: the time, then a random part. */
export function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function rawCode(body: unknown): unknown {
  return (body as { error?: { code?: unknown } } | null)?.error?.code;
}

/** A code, when it is a listed one. */
function listed(code: unknown): string {
  return typeof code === "string" && KNOWN_CODES.has(code) ? code : "an unlisted error code";
}

/** The error code in a parsed body, when it is a listed one. */
function errorCode(body: unknown): string {
  const code = rawCode(body);
  if (code === undefined || code === null) return "no error code";
  return listed(code);
}

/** What a failed check may say about a parsed response: its status and error code. */
export function outcome(response: { status: number; body: unknown }): string {
  return `answered ${response.status} (${errorCode(response.body)})`;
}

/** What a failed check may say about an `agw --json` run: its exit code and error code. */
export function cliOutcome(run: { code: number; json: unknown }): string {
  return `exited ${run.code} (${errorCode(run.json)})`;
}

/**
 * Whether two parsed JSON values are the same: arrays in the same order,
 * objects with the same fields whatever their order.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const names = Object.keys(left);
    return names.length === Object.keys(right).length && names.every((name) => Object.hasOwn(right, name) && sameJson(left[name], right[name]));
  }
  return a === b;
}

/**
 * Fails unless `actual` holds every value `expected` sets, at the same place:
 * objects may hold more fields, arrays must hold the same items in the same
 * order (each item whole, its fields in any order). Fails with `message`
 * alone: not the values, and not the field names either, which come from
 * the response.
 */
export function assertHolds(actual: unknown, expected: unknown, message: string): void {
  check(holdsAll(actual, expected), message);
}

function holdsAll(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([name, value]) => holdsAll((actual as Record<string, unknown>)[name], value));
  }
  return sameJson(actual, expected);
}

/**
 * A response's JSON body. A body that is not JSON fails with the status alone:
 * a parse error quotes part of the text, which can hold a key or a token.
 */
export async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    fail(`answered ${response.status} with a body that is not JSON`);
  }
}

/** The same for a raw response, read from a copy so the caller can still read it. */
export async function responseOutcome(response: Response): Promise<string> {
  let body: unknown = null;
  try {
    body = await response.clone().json();
  } catch {
    // Not JSON: the status alone.
  }
  return outcome({ status: response.status, body });
}

/**
 * The mock's `x-mock-key` for a fixture key's `label` sent in `header`, as
 * `smoke/mock/index.ts` (`FIXTURE_KEYS`) reports it: in `authorization`, after
 * the `Bearer` scheme.
 */
export function keyMark(header: string, label: string): string {
  return header === "authorization" ? `${header}:bearer ${label}` : `${header}:${label}`;
}

/** Whether a parsed body holds `secret` anywhere, said without printing either. */
export function holds(body: unknown, secret: string): boolean {
  return JSON.stringify(body).includes(secret);
}

/**
 * Runs every clean-up step, even after one fails, then fails if any did. A
 * step that finds its thing already gone (404) is fine.
 */
export async function cleanUp(steps: readonly (() => Promise<{ status: number }>)[]): Promise<void> {
  const failed: string[] = [];
  for (const [index, step] of steps.entries()) {
    try {
      const { status } = await step();
      if (!(status >= 200 && status < 300) && status !== 404) failed.push(`step ${index + 1} answered ${status}`);
    } catch {
      failed.push(`step ${index + 1} threw`);
    }
  }
  check(failed.length === 0, `clean-up failed: ${failed.join(", ")}`);
}
