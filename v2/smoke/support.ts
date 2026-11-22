/**
 * Small helpers the smoke checks share. Not a check itself: the runner reads
 * only `*.smoke.ts`.
 *
 * A failed check prints only what is safe to print: a status and the
 * gateway's error code. Never a response body, which can hold an app key, a
 * gateway token or a provider key.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** A slug no other run picks: the time, then a random part. */
export function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

/** The gateway's error code in a parsed body, when there is one. */
function errorCode(body: unknown): string {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/u.test(code) ? code : "no error code";
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
 * order (each item whole, its fields in any order). Says only where it
 * differs, never the values, since settings can name a key's header.
 */
export function assertHolds(actual: unknown, expected: unknown, where = "config"): void {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${where} is not an object`);
    for (const [name, value] of Object.entries(expected)) assertHolds((actual as Record<string, unknown>)[name], value, `${where}.${name}`);
    return;
  }
  assert.ok(sameJson(actual, expected), `${where} is not what was saved`);
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
    assert.fail(`answered ${response.status} with a body that is not JSON`);
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
    } catch (error) {
      failed.push(`step ${index + 1} threw ${error instanceof Error ? error.name : "an error"}`);
    }
  }
  assert.deepEqual(failed, [], "clean-up failed");
}
