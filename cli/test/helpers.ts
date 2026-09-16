import { Context, type ContextStore } from "../src/context.ts";
import type { CliState } from "../src/state.ts";

export const fresh = (): CliState => ({
  schemaVersion: 1,
  active: null,
  operations: {},
});

export const makeStore = (): ContextStore => ({
  write: async () => {},
  // The real store looks under its lock; with no file to share, this is the same.
  reserve: async (state, find, create) => find(state) ?? create(state),
  directory: "/unused",
  keyOutput: () => {
    throw new Error("keyOutput is not stubbed in this test");
  },
  vaultKey: async () => {
    throw new Error("vaultKey is not stubbed in this test");
  },
});

/**
 * A `Context` with some of its methods replaced.
 *
 * `Object.defineProperty` rather than `Object.assign`, because `url` and
 * `active` are accessors on the prototype and assigning through them would
 * throw. The single cast is the point of this helper: every test that needs a
 * stub declares it here instead of building a lookalike object.
 */
export function stubContext(parts: Record<string, unknown>): Context {
  const ctx: object = Object.create(Context.prototype) as object;
  for (const [key, value] of Object.entries(parts)) {
    Object.defineProperty(ctx, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  return ctx as Context;
}

/** The `code` a rejected CLI promise carries, for `assert.rejects` predicates. */
export function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error &&
    (error as { code: unknown }).code === code;
}

export function errorOf(error: unknown): { code?: string; details?: Record<string, unknown> } {
  return error as { code?: string; details?: Record<string, unknown> };
}
