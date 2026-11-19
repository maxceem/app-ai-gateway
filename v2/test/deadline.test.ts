import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/core/errors.ts";
import { clientCallDeadline, type DeadlineVariables } from "../src/http/deadline.ts";

describe("clientCallDeadline", () => {
  it("answers a slow call with a retryable 503 and lets it finish in the background", async () => {
    let finished = false;
    let aborted: unknown;
    const app = new Hono<{ Bindings: Env; Variables: DeadlineVariables }>();
    app.get("/slow", clientCallDeadline(20), async (c) => {
      c.get("deadline").addEventListener("abort", () => (aborted = c.get("deadline").reason));
      await new Promise((resolve) => setTimeout(resolve, 60));
      finished = true;
      return c.text("late");
    });
    app.onError((error, c) =>
      error instanceof GatewayError ? c.json({ code: error.code }, error.status as 503) : c.text("other", 500),
    );
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request("https://gateway.test/slow"), env, ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "service_unavailable" });
    expect(aborted).toMatchObject({ reason: "deadline_exceeded" });
    await waitOnExecutionContext(ctx);
    expect(finished).toBe(true);
  });
});
