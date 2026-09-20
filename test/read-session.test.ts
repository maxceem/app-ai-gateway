import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { readDatabase, readSession } from "../src/db";
import { app } from "../src/db/schema";

/**
 * The read path's session wrapper.
 *
 * What matters is not that a session is faster here — locally there are no
 * replicas, so it cannot be — but that asking for one never changes the answer
 * and never breaks on a binding that has no sessions at all. Both halves are
 * pinned below, because the whole point of `first-unconstrained` is that it is
 * free where it does nothing.
 */
describe("read replication sessions", () => {
  it("reads through a session against the real binding", async () => {
    // Whether the local D1 in this test environment implements `withSession` is
    // the runtime's business: either arm of `readSession` has to answer the
    // same query the same way, so the assertion is about the rows, not the path.
    await expect(readDatabase(env.DB).select().from(app).limit(1)).resolves.toBeInstanceOf(Array);
  });

  it("anchors the session at first-unconstrained and queries through it", async () => {
    const constraints: (string | undefined)[] = [];
    const prepared: string[] = [];
    const binding = {
      withSession(constraint?: string) {
        constraints.push(constraint);
        return {
          prepare: (query: string) => {
            prepared.push(query);
            return env.DB.prepare(query);
          },
          batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
        };
      },
    } as unknown as D1Database;

    const rows = await readDatabase(binding).select().from(app).limit(1);

    expect(constraints).toEqual(["first-unconstrained"]);
    // The statement really went through the session object, not around it.
    expect(prepared).toHaveLength(1);
    expect(rows).toBeInstanceOf(Array);
  });

  it("falls back to the binding when it has no sessions", async () => {
    const prepared: string[] = [];
    const binding = {
      prepare: (query: string) => {
        prepared.push(query);
        return env.DB.prepare(query);
      },
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    } as unknown as D1Database;

    expect(readSession(binding)).toBe(binding);
    const rows = await readDatabase(binding).select().from(app).limit(1);
    expect(prepared).toHaveLength(1);
    expect(rows).toBeInstanceOf(Array);
  });
});
