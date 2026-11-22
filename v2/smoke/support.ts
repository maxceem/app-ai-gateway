/**
 * Small helpers the smoke checks share. Not a check itself: the runner reads
 * only `*.smoke.ts`.
 *
 * A failed check prints only what is safe to print: fixed text, a status,
 * an error code shaped like one, and numbers or booleans. Never a response
 * body, a string read from one, or a field name, which can hold an app key, a
 * gateway token or a provider key. The checks' output goes into the reports of
 * whoever runs them (the outside monitor after a release, or a person at a
 * terminal), and those reports should never hold a key either.
 *
 * So the checks assert only through the helpers below, and send requests only
 * through `send`. Every message is typed `Fixed`: the compiler refuses one
 * built from a value. `test/smoke-assertions.test.ts` refuses the rest in the
 * files it guards: a direct `node:assert` call, `fetch`, `console`, or an
 * `Error` made from a value.
 */
import { AssertionError } from "node:assert";
import { randomUUID } from "node:crypto";

/**
 * A message the compiler can see is fixed text: a string literal, or a choice
 * of them. A template with a value in it, or any `string`, is `never`, so the
 * call does not compile.
 */
export type Fixed<M extends string> = {} extends Record<M, 1> ? never : M;

/** How long one request, or one `agw` run, may take. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** How long one smoke test may take, as v1's: `node --test` has no limit of its own. */
export const TEST_TIMEOUT_MS = 180_000;

/** Fails with text these helpers built from fixed parts. */
function stop(message: string): never {
  throw new AssertionError({ message });
}

/** Fails with `message`. */
export function fail<M extends string>(message: Fixed<M>): never {
  stop(message);
}

/** Fails with `message` unless `condition` holds. */
export function check<M extends string>(condition: unknown, message: Fixed<M>): asserts condition {
  if (!condition) stop(message);
}

/**
 * Fails with `message` unless the two parsed values are the same (see
 * `sameJson`). When both are numbers or booleans, which cannot hold a key,
 * it says both.
 */
export function same<M extends string>(actual: unknown, expected: unknown, message: Fixed<M>): void {
  if (sameJson(actual, expected)) return;
  const plain = (value: unknown) => typeof value === "number" || typeof value === "boolean";
  stop(plain(actual) && plain(expected) ? `${message}: got ${String(actual)}, expected ${String(expected)}` : message);
}

/** Fails unless a parsed response answered `status`, saying what answered and its status and code. */
export function expectStatus<W extends string>(response: { status: number; body?: unknown }, status: number, what: Fixed<W>): void {
  if (response.status !== status) stop(`${what} ${outcome({ status: response.status, body: response.body })}`);
}

/** The same for a raw response, read from a copy so the caller can still read it. */
export async function expectResponse<W extends string>(response: Response, status: number, what: Fixed<W>): Promise<void> {
  if (response.status !== status) stop(`${what} ${await responseOutcome(response)}`);
}

/** Fails unless a parsed body's error code is `code`, naming either code only when it is shaped like one. */
export function expectCode<C extends string, W extends string>(body: unknown, code: Fixed<C>, what: Fixed<W>): void {
  if (rawCode(body) !== code) stop(`${what}: expected ${shaped(code)}, got ${errorCode(body)}`);
}

/** Prints `message`. */
export function note<M extends string>(message: Fixed<M>): void {
  console.log(message);
}

/**
 * A request to `path` on `base`, given up after `REQUEST_TIMEOUT_MS`. A
 * request that cannot be made fails with fixed text: Node's own error can
 * quote the URL or a header, and either can hold a key or a token.
 */
export async function send(path: string, base: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(new URL(path, base), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init });
  } catch {
    stop("a request could not be sent");
  }
}

/**
 * A management API call on the deployment the checks run against
 * (`V2_BASE_URL`, `V2_MANAGEMENT_KEY`), with its parsed answer.
 */
export async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await send(path, process.env.V2_BASE_URL ?? "", {
    method,
    headers: { authorization: `Bearer ${process.env.V2_MANAGEMENT_KEY ?? ""}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await readJson(response) };
}

/**
 * `value` when it is shaped like an id the gateway makes, before it is put
 * in a path or an `agw` argument; fails with fixed text otherwise, since a
 * regression could put anything there.
 */
export function checkId<W extends string>(value: unknown, what: Fixed<W>): string {
  if (!(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value))) stop(`${what} is not shaped like an id`);
  return value;
}

/** Fails unless an `agw --json` run exited 0. */
export function expectCli<W extends string>(run: { code: number; json: unknown }, what: Fixed<W>): void {
  if (run.code !== 0) stop(`${what} ${cliOutcome(run)}`);
}

/** How long a check waits for something the deployment writes after its answer. */
export const POLL_DEADLINE_MS = 60_000;

/**
 * Asks `read` every 2 seconds until it returns something other than
 * `undefined`, for at most `POLL_DEADLINE_MS` of wall-clock time, then fails
 * with `message`. Bounded by the clock, not a count of tries, so slow answers
 * never stretch the wait past the test's own limit.
 */
export async function poll<T, M extends string>(read: () => Promise<T | undefined>, message: Fixed<M>): Promise<T> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) stop(message);
    // real-timer: polls a live deployment until what it waits for is written, with a deadline.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** A slug no other run picks: the time, then a random part. */
export function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function rawCode(body: unknown): unknown {
  return (body as { error?: { code?: unknown } } | null)?.error?.code;
}

/**
 * A code, when it is shaped like one: lowercase words joined by `_`, at most
 * 40 characters. Keys and tokens hold digits or capitals, so none passes;
 * anything else is reported as an odd code, since a regression could put
 * anything there.
 */
function shaped(code: unknown): string {
  return typeof code === "string" && code.length <= 40 && /^[a-z]+(_[a-z]+){0,6}$/u.test(code) ? code : "an odd error code";
}

/** The error code in a parsed body, when it is shaped like one. */
function errorCode(body: unknown): string {
  const code = rawCode(body);
  if (code === undefined || code === null) return "no error code";
  return shaped(code);
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
export function assertHolds<M extends string>(actual: unknown, expected: unknown, message: Fixed<M>): void {
  if (!holdsAll(actual, expected)) stop(message);
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
    stop(`answered ${response.status} with a body that is not JSON`);
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
  if (failed.length > 0) stop(`clean-up failed: ${failed.join(", ")}`);
}
