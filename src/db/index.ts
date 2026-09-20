import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function database(binding: D1Database) {
  return drizzle(binding, { schema });
}

export type Database = ReturnType<typeof database>;

/**
 * A D1 session anchored at `first-unconstrained`, for reads that fill a cache.
 *
 * `first-unconstrained` lets a database with read replication enabled answer
 * the first query of the session from the nearest replica instead of from the
 * primary, which is what removes the cross-region round trip a Worker far from
 * the primary otherwise pays on a cold isolate. On a database without replicas
 * the session is served by the primary exactly as before, so this is free
 * where it does nothing, and nothing has to be configured for it.
 *
 * It is used only for reads that fill a per-isolate cache — the app row, its
 * provider rows, its key rows and the account lifecycle row — all of which
 * already tolerate up to a minute of staleness, so a replica lagging behind
 * the primary costs them nothing they did not already accept. It is never used
 * for a read whose answer must be current: the token exchange's uncached key
 * lookup, every write, and everything on the admin and console paths keep
 * reading the primary through {@link database}.
 *
 * The binding is probed rather than assumed, because an older runtime — or a
 * stub standing in for D1 — may not carry `withSession` at all, and falling
 * back to the plain binding is exactly the behaviour this had before.
 */
export function readSession(binding: D1Database): D1Database | D1DatabaseSession {
  return typeof binding.withSession === "function"
    ? binding.withSession("first-unconstrained")
    : binding;
}

/**
 * Drizzle over {@link readSession}. Use it wherever a read fills one of the
 * per-isolate caches; use {@link database} everywhere else.
 */
export function readDatabase(binding: D1Database): Database {
  // Drizzle's `AnyD1Database` type does not name `D1DatabaseSession`, but at
  // runtime the D1 driver only ever calls `prepare()` and `batch()`, both of
  // which a session has, so the session satisfies everything drizzle asks of a
  // binding and the cast only tells the type system what is already true.
  return drizzle(readSession(binding) as unknown as D1Database, { schema });
}
