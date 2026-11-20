import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "../src/core/errors.ts";
import { clientCallDeadline, type DeadlineVariables } from "../src/http/deadline.ts";
import { slowFakes, useFakeClock, watch } from "./helpers.ts";

const slow = slowFakes();

afterEach(() => {
  slow.release();
  vi.useRealTimers();
});

describe("clientCallDeadline", () => {
  it("answers a slow call with a retryable 503 at the deadline and lets it finish in the background", async () => {
    let finished = false;
    let aborted: unknown;
    const app = new Hono<{ Bindings: Env; Variables: DeadlineVariables }>();
    app.get("/slow", clientCallDeadline(20), async (c) => {
      c.get("deadline").addEventListener("abort", () => void (aborted = c.get("deadline").reason));
      // The handler answers only once the test lets it, well after the deadline.
      await slow.held();
      finished = true;
      return c.text("late");
    });
    app.onError((error, c) =>
      error instanceof GatewayError ? c.json({ code: error.code }, error.status as 503) : c.text("other", 500),
    );
    const ctx = createExecutionContext();
    const kept: Promise<unknown>[] = [];
    const keep = ctx.waitUntil.bind(ctx);
    ctx.waitUntil = (promise) => {
      kept.push(promise);
      keep(promise);
    };

    useFakeClock();
    const answer = Promise.resolve(app.fetch(new Request("https://gateway.test/slow"), env, ctx));
    const answered = watch(answer);
    await slow.reached();
    await vi.advanceTimersByTimeAsync(19);
    expect(answered.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(answered.settled).toBe(true);
    const response = await answer;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "service_unavailable" });
    expect(aborted).toMatchObject({ reason: "deadline_exceeded" });

    // The handler is still running, handed to waitUntil, until it is let go.
    expect(kept).toHaveLength(1);
    const background = watch(kept[0]!);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(background.settled).toBe(false);
    expect(finished).toBe(false);
    slow.release();
    await kept[0];
    expect(finished).toBe(true);
  });
});
