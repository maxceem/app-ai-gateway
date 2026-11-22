/**
 * Small helpers the smoke checks share. Not a check itself: the runner reads
 * only `*.smoke.ts`.
 *
 * A failed check prints only what is safe to print: a status and the
 * gateway's error code. Never a response body, which can hold an app key, a
 * gateway token or a provider key.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

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

/** The mock's `x-mock-key` for a test key sent in `header`: never the key itself. */
export function keyMark(header: string, key: string): string {
  return `${header}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
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
