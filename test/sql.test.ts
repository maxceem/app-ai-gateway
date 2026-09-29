import { env } from "cloudflare:workers";
import { and, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { compileSql, fromCompiled, prepared } from "../src/db/sql";

describe("composed SQL", () => {
  it("binds every value where it appears, through nested conditions", () => {
    const inner = and(sql`a = ${"first"}`, sql`b = ${2}`)!;
    expect(compileSql(sql`SELECT 1 WHERE ${inner} AND c = ${null}`)).toEqual({
      sql: "SELECT 1 WHERE (a = ? and b = ?) AND c = ?",
      params: ["first", 2, null],
    });
  });

  it("prepares a statement whose parameters follow the text", async () => {
    const middle = fromCompiled({ sql: "? || ?", params: ["x", "y"] });
    const row = await prepared(env.DB, sql`SELECT ${"first"} AS a, ${middle} AS b, ${3} AS c`)
      .first<{ a: string; b: string; c: number }>();
    expect(row).toEqual({ a: "first", b: "xy", c: 3 });
  });

  it("rebuilds a compiled condition with its parameters bound in place", () => {
    const condition = fromCompiled({ sql: `exists (select 1 where "x" = ? and "y" in (?, ?))`, params: ["a", "b", "c"] });
    expect(compileSql(sql`SELECT ${0} WHERE ${condition} AND z = ${"d"}`)).toEqual({
      sql: `SELECT ? WHERE exists (select 1 where "x" = ? and "y" in (?, ?)) AND z = ?`,
      params: [0, "a", "b", "c", "d"],
    });
    expect(compileSql(fromCompiled({ sql: "0", params: [] }))).toEqual({ sql: "0", params: [] });
  });

  it("refuses a compiled condition whose placeholders and parameters disagree", () => {
    expect(() => fromCompiled({ sql: "a = ? and b = ?", params: ["a"] })).toThrow();
    expect(() => fromCompiled({ sql: "a = ?", params: ["a", "b"] })).toThrow();
  });
});
