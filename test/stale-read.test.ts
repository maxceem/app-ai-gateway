import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  readOrKnown,
  resetStallHold,
  STALE_READ_BUDGET_MS,
  STALE_READ_MAX_MS,
  STALL_HOLD_MS,
} from "../src/core/stale-read";
import { clearIsolateCaches, seedServerApp } from "./helpers";

const BUDGET_MS = 20;
const transient = () => new Error("D1_ERROR: Network connection lost.");
const later = <V>(value: V, ms: number) => new Promise<V>((resolve) => setTimeout(() => resolve(value), ms));

beforeEach(() => {
  clearIsolateCaches();
  resetStallHold();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readOrKnown", () => {
  const known = (ageMs = 60_000) => ({ value: "known", storedAt: Date.now() - ageMs });

  it("hands back the read's own promise when nothing usable is known", () => {
    const pending = Promise.resolve("read");
    expect(readOrKnown("t", undefined, () => pending, BUDGET_MS)).toBe(pending);
    expect(readOrKnown("t", known(STALE_READ_MAX_MS + 1), () => pending, BUDGET_MS)).toBe(pending);
  });

  it("answers what the read answers in time, even when that refuses", async () => {
    await expect(readOrKnown("t", known(), () => later("fresh", 1), BUDGET_MS)).resolves.toBe("fresh");
    const refusal = new Error("App is not registered");
    await expect(readOrKnown("t", known(), () => Promise.reject(refusal), BUDGET_MS)).rejects.toBe(refusal);
  });

  it("serves the known record when the read fails with a platform error", async () => {
    await expect(readOrKnown("t", known(), () => Promise.reject(transient()), BUDGET_MS)).resolves.toBe("known");
  });

  it("serves the known record at the budget, then skips D1 while the stall holds", async () => {
    const slow = vi.fn(() => later("fresh", BUDGET_MS * 10));
    await expect(readOrKnown("t", known(), slow, BUDGET_MS)).resolves.toBe("known");
    expect(slow).toHaveBeenCalledOnce();

    const skipped = vi.fn(() => later("fresh", 1));
    await expect(readOrKnown("t", known(), skipped, BUDGET_MS)).resolves.toBe("known");
    expect(skipped).not.toHaveBeenCalled();

    // Once the hold ends, D1 is asked again.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + STALL_HOLD_MS + 1);
    await expect(readOrKnown("t", { value: "known", storedAt: clock() - 60_000 }, skipped, BUDGET_MS))
      .resolves.toBe("fresh");
    expect(skipped).toHaveBeenCalledOnce();
  });

  it("waits for a slow read when nothing usable is known, however long it takes", async () => {
    await expect(readOrKnown("t", undefined, () => later("fresh", BUDGET_MS * 5), BUDGET_MS)).resolves.toBe("fresh");
  });
});

/**
 * The case that happened: D1 slows down while apps keep calling. An isolate
 * that served an app minutes ago keeps serving it from what it knows, instead
 * of holding the request until D1 recovers.
 */
describe("a proxied request while D1 stalls", () => {
  const ORIGIN = "https://example.test";
  const STALL_MS = STALE_READ_BUDGET_MS * 4;
  const contexts: ExecutionContext[] = [];

  /** Every D1 query this environment issues waits `ms` before it runs. */
  function stalling(ms: number): Env {
    const delay = <T>(run: () => Promise<T>) => later(undefined, ms).then(run);
    const statement = (inner: D1PreparedStatement): D1PreparedStatement => new Proxy(inner, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property === "bind") return (...args: unknown[]) => statement(value.apply(target, args));
        if (["first", "all", "raw", "run"].includes(String(property))) {
          return (...args: unknown[]) => delay(() => value.apply(target, args));
        }
        return value.bind(target);
      },
    });
    const db = new Proxy(env.DB, {
      get: (target, property, receiver) => {
        if (property === "prepare") return (query: string) => statement(target.prepare(query));
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) => delay(() => target.batch(statements));
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(env, {
      get: (target, property, receiver) => (property === "DB" ? db : Reflect.get(target, property, receiver)),
    }) as Env;
  }

  async function proxy(appId: string, key: string, through: Env): Promise<Response> {
    const executionCtx = createExecutionContext();
    contexts.push(executionCtx);
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v1/apps/${appId}/proxy/openai/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      through,
      executionCtx,
    );
    return new Response(await response.arrayBuffer(), response);
  }

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((ctx) => waitOnExecutionContext(ctx)));
  });

  it("is served from what this isolate knows, within the budget", async () => {
    const key = await seedServerApp("stale-stall", { endUser: "none" });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    expect((await proxy("stale-stall", key, env)).status).toBe(200);

    // Minutes later every cache entry has expired, and D1 has stalled.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
    const started = performance.now();
    const response = await proxy("stale-stall", key, stalling(STALL_MS));
    expect(response.status).toBe(200);
    // One budget for the first stalled read; the rest skip D1 while it holds.
    expect(performance.now() - started).toBeLessThan(STALL_MS);
  });

  it("waits for D1 when this isolate has never served the app", async () => {
    const key = await seedServerApp("stale-cold", { endUser: "none" });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const started = performance.now();
    const response = await proxy("stale-cold", key, stalling(STALE_READ_BUDGET_MS * 2));
    expect(response.status).toBe(200);
    expect(performance.now() - started).toBeGreaterThanOrEqual(STALE_READ_BUDGET_MS * 2);
  });
});
