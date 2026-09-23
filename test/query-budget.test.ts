import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { QueryBudget, QueryBudgetExhausted } from "../src/core/query-budget";

/** Cheap, and answers on every D1 surface the wrapper intercepts. */
const TRIVIAL = "SELECT 1 AS one";

describe("QueryBudget", () => {
  it("charges up to its limit and refuses past it", () => {
    const budget = new QueryBudget(3);
    budget.charge(2);
    expect(budget.spent).toBe(2);
    expect(budget.remaining).toBe(1);

    expect(() => budget.charge(2)).toThrow(QueryBudgetExhausted);
    // A refused charge costs nothing: the limit is a ceiling, not a deadline.
    expect(budget.spent).toBe(2);
    expect(budget.remaining).toBe(1);

    budget.charge(1);
    expect(budget.remaining).toBe(0);
  });

  it("answers what still fits", () => {
    const budget = new QueryBudget(3);
    expect(budget.affords(3)).toBe(true);
    expect(budget.affords(4)).toBe(false);
    budget.charge(1);
    expect(budget.affords(2)).toBe(true);
    expect(budget.affords(3)).toBe(false);
  });

  it("reports the limit that was actually exhausted", () => {
    const budget = new QueryBudget(3);
    try {
      budget.charge(4);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QueryBudgetExhausted);
      expect((error as QueryBudgetExhausted).limit).toBe(3);
    }
  });
});

describe("a limited view", () => {
  it("spends the budget it was taken from", () => {
    const budget = new QueryBudget(10);
    const view = budget.limited(4);

    view.charge(3);
    expect(view.spent).toBe(3);
    expect(budget.spent).toBe(3);
    // Nothing to hand back: what the view did not issue was never taken.
    expect(budget.remaining).toBe(7);
  });

  it("stops at its own share, leaving the rest of the run untouched", () => {
    const budget = new QueryBudget(10);
    const view = budget.limited(4);

    expect(() => view.charge(5)).toThrow(QueryBudgetExhausted);
    expect(budget.spent).toBe(0);
    view.charge(4);
    expect(view.remaining).toBe(0);
    expect(budget.remaining).toBe(6);
  });

  it("is capped by whichever of the two is lower", () => {
    const budget = new QueryBudget(10);
    const view = budget.limited(40);
    expect(view.remaining).toBe(10);

    budget.charge(7);
    expect(view.remaining).toBe(3);
    expect(() => view.charge(4)).toThrow(QueryBudgetExhausted);
    // The parent refused, so nothing landed on either of them.
    expect(view.spent).toBe(0);
    expect(budget.spent).toBe(7);
  });

  it("treats a share of nothing as nothing rather than as a negative", () => {
    const budget = new QueryBudget(5);
    budget.charge(5);
    const view = budget.limited(budget.remaining - 9);
    expect(view.remaining).toBe(0);
    expect(view.affords(1)).toBe(false);
  });
});

describe("the database a budget hands out", () => {
  it("charges one for each statement it runs", async () => {
    const budget = new QueryBudget(10);
    const db = budget.database(env.DB);

    await db.prepare(TRIVIAL).first();
    expect(budget.spent).toBe(1);
    await db.prepare(TRIVIAL).all();
    await db.prepare(TRIVIAL).run();
    await db.prepare(TRIVIAL).raw();
    expect(budget.spent).toBe(4);
  });

  it("charges nothing for preparing a statement that is never run", async () => {
    const budget = new QueryBudget(10);
    const db = budget.database(env.DB);
    db.prepare(TRIVIAL).bind(1).bind(2);
    expect(budget.spent).toBe(0);
  });

  it("keeps the wrapper across bind, so a bound statement still charges", async () => {
    const budget = new QueryBudget(10);
    const db = budget.database(env.DB);

    const row = await db
      .prepare("SELECT ? AS answer")
      .bind(41)
      .bind(42)
      .first<{ answer: number }>();
    expect(row?.answer).toBe(42);
    expect(budget.spent).toBe(1);
  });

  it("charges a batch for every statement in it", async () => {
    const budget = new QueryBudget(10);
    const db = budget.database(env.DB);

    // Wrapped statements are unwrapped on the way to D1, which is the only
    // reason this runs at all rather than being rejected as a foreign object.
    const results = await db.batch([
      db.prepare(TRIVIAL),
      db.prepare(TRIVIAL),
      db.prepare(TRIVIAL),
    ]);
    expect(results).toHaveLength(3);
    expect(budget.spent).toBe(3);
  });

  it("refuses a batch that does not fit, and issues none of it", async () => {
    const budget = new QueryBudget(2);
    const db = budget.database(env.DB);

    await expect(
      db.batch([db.prepare(TRIVIAL), db.prepare(TRIVIAL), db.prepare(TRIVIAL)]),
    ).rejects.toThrow(QueryBudgetExhausted);
    expect(budget.spent).toBe(0);
  });

  it("refuses a statement before issuing it once the budget is gone", async () => {
    const budget = new QueryBudget(1);
    const db = budget.database(env.DB);

    await db.prepare(TRIVIAL).first();
    expect(budget.remaining).toBe(0);
    await expect(db.prepare(TRIVIAL).first()).rejects.toThrow(QueryBudgetExhausted);
    expect(budget.spent).toBe(1);
  });

  it("charges a view's spending to the run it was taken from", async () => {
    const budget = new QueryBudget(10);
    const view = budget.limited(2);
    const db = view.database(env.DB);

    await db.prepare(TRIVIAL).first();
    await db.prepare(TRIVIAL).first();
    await expect(db.prepare(TRIVIAL).first()).rejects.toThrow(QueryBudgetExhausted);
    expect(budget.spent).toBe(2);
    expect(budget.remaining).toBe(8);
  });

  it("gives a view the same database rather than a wrapper of a wrapper", async () => {
    const budget = new QueryBudget(10);
    const db = budget.database(env.DB);
    const view = budget.limited(2);
    // What a sweep handed a share does: re-wrap the database it was given.
    const shared = view.database(db);

    await shared.prepare(TRIVIAL).first();
    // One statement, charged once to each — not twice to the run.
    expect(view.spent).toBe(1);
    expect(budget.spent).toBe(1);

    await shared.prepare(TRIVIAL).first();
    await expect(shared.prepare(TRIVIAL).first()).rejects.toThrow(QueryBudgetExhausted);
    expect(budget.spent).toBe(2);
  });

  it("passes everything else through", async () => {
    const budget = new QueryBudget(10);
    const db = budget.database(env.DB);

    const session = db.withSession("first-unconstrained");
    await session.prepare(TRIVIAL).first();
    expect(budget.spent).toBe(1);
    expect(typeof session.getBookmark()).not.toBe("undefined");
  });
});
