import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { useAssertionCounter } from "../src/client-auth/replay.ts";

describe("EndUserLimiter assertion counters", () => {
  it("accepts the first counter it sees, whatever it is, and each later one once", async () => {
    const limiter = env.END_USER_LIMITER.getByName("counters:install:first");
    expect(await limiter.useCounter(1000)).toEqual({ accepted: true });
    expect(await limiter.useCounter(1000)).toEqual({ accepted: false });
    expect(await limiter.useCounter(1001)).toEqual({ accepted: true });
  });

  it("accepts counters out of order inside the window, once each", async () => {
    const limiter = env.END_USER_LIMITER.getByName("counters:install:window");
    expect((await limiter.useCounter(10)).accepted).toBe(true);
    expect((await limiter.useCounter(15)).accepted).toBe(true);
    // Signed before 15, arriving after it.
    expect((await limiter.useCounter(12)).accepted).toBe(true);
    expect((await limiter.useCounter(11)).accepted).toBe(true);
    expect((await limiter.useCounter(12)).accepted).toBe(false);
    expect((await limiter.useCounter(10)).accepted).toBe(false);
    expect((await limiter.useCounter(15)).accepted).toBe(false);
  });

  it("refuses a counter at or past the window's far edge", async () => {
    const limiter = env.END_USER_LIMITER.getByName("counters:install:far");
    expect((await limiter.useCounter(100)).accepted).toBe(true);
    // 100 - 63 is the oldest still inside a 64-wide window; 100 - 64 is not.
    expect((await limiter.useCounter(100 - 63)).accepted).toBe(true);
    expect((await limiter.useCounter(100 - 64)).accepted).toBe(false);
    expect((await limiter.useCounter(1)).accepted).toBe(false);
  });

  it("clears the window on a jump wider than it", async () => {
    const limiter = env.END_USER_LIMITER.getByName("counters:install:jump");
    expect((await limiter.useCounter(5)).accepted).toBe(true);
    expect((await limiter.useCounter(6)).accepted).toBe(true);
    expect((await limiter.useCounter(1005)).accepted).toBe(true);
    expect((await limiter.useCounter(1004)).accepted).toBe(true);
    expect((await limiter.useCounter(1005 - 63)).accepted).toBe(true);
    expect((await limiter.useCounter(6)).accepted).toBe(false);
    expect((await limiter.useCounter(1005 + 64)).accepted).toBe(true);
    expect((await limiter.useCounter(1006)).accepted).toBe(true);
    expect((await limiter.useCounter(1005)).accepted).toBe(false);
  });

  it("refuses a counter that is not a non-negative whole number", async () => {
    const limiter = env.END_USER_LIMITER.getByName("counters:install:nonsense");
    expect((await limiter.useCounter(-1)).accepted).toBe(false);
    expect((await limiter.useCounter(1.5)).accepted).toBe(false);
    expect((await limiter.useCounter(Number.NaN)).accepted).toBe(false);
  });
});

describe("useAssertionCounter", () => {
  it("accepts a counter once, then refuses it as a replay", async () => {
    await useAssertionCounter(env, "replay-app", "key-a", 1);
    await expect(useAssertionCounter(env, "replay-app", "key-a", 1)).rejects.toMatchObject({
      status: 403,
      code: "attest_failed",
    });
  });

  /** An environment whose limiter object never answers, or fails. */
  function limiterThat(answer: () => Promise<{ accepted: boolean }>): Env {
    return { ...env, END_USER_LIMITER: { getByName: () => ({ useCounter: answer }) } } as unknown as Env;
  }

  it("refuses with a retryable 503 when the limiter does not answer in time, never skipping the check", async () => {
    const silent = limiterThat(() => new Promise(() => undefined));
    await expect(useAssertionCounter(silent, "a", "k", 1, 20)).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      reason: "deadline_exceeded",
    });
  });

  it("refuses with a retryable 503 when the limiter fails", async () => {
    const failing = limiterThat(() => Promise.reject(new Error("Durable Object reset because its code was updated.")));
    await expect(useAssertionCounter(failing, "a", "k", 1)).rejects.toMatchObject({ status: 503, code: "service_unavailable" });
  });
});
