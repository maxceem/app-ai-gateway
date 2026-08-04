import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { devToken, seedApp } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("proxy hot-path latency", () => {
  it("keeps 100-request stub-provider p50 below 50 ms and p95 below 150 ms", async () => {
    await seedApp("proxy-benchmark", { limits: { rpm: 200, rpd: 1000 } });
    const token = await devToken("proxy-benchmark");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ usage: { input_tokens: 0, output_tokens: 0 } }),
    );

    const durations: number[] = [];
    const executionContexts: ExecutionContext[] = [];
    for (let index = 0; index < 100; index += 1) {
      const startedAt = performance.now();
      const executionCtx = createExecutionContext();
      executionContexts.push(executionCtx);
      const response = await app.fetch(
        new Request("https://example.test/v1/apps/proxy-benchmark/proxy/openai/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-app-version": "benchmark",
          },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "ping" }),
        }),
        env,
        executionCtx,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("server-timing")).toMatch(/auth.*limiter.*provider_ttfb/u);
      await response.arrayBuffer();
      durations.push(performance.now() - startedAt);
    }

    durations.sort((left, right) => left - right);
    const percentile = (fraction: number): number =>
      durations[Math.ceil(durations.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
    expect(percentile(0.5)).toBeLessThan(50);
    expect(percentile(0.95)).toBeLessThan(150);
    await Promise.all(executionContexts.map((context) => waitOnExecutionContext(context)));
  });
});
