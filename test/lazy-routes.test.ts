import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { lazyRoutes } from "../src/routes/lazy";

type TestEnv = { Bindings: Env };

/** An inner bundle that answers, and reports what it was handed. */
function innerApp(): Hono<TestEnv> {
  const inner = new Hono<TestEnv>();
  inner.get("/v1/probe", (c) => c.json({
    path: c.req.path,
    // Proves the bindings arrived: the inner app has no other way to reach them.
    hasDatabase: Boolean(c.env.DB),
  }));
  inner.get("/v1/boom", () => {
    throw new Error("inner failure");
  });
  inner.onError((error) => {
    throw error;
  });
  return inner;
}

/** An outer app whose `onError` marks anything the mount let through. */
function outerApp(load: () => Promise<Hono<TestEnv>>): Hono<TestEnv> {
  const app = new Hono<TestEnv>();
  app.all("/v1/*", lazyRoutes<TestEnv>(load));
  app.onError((error) => new Response(`outer:${error.message}`, { status: 500 }));
  return app;
}

describe("lazyRoutes", () => {
  it("retries the loader after it rejects", async () => {
    let attempts = 0;
    const app = outerApp(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("module evaluation failed");
      return innerApp();
    });

    const failed = await app.request("http://gateway.test/v1/probe", undefined, env);
    expect(failed.status).toBe(500);
    await expect(failed.text()).resolves.toBe("outer:module evaluation failed");

    // The rejected promise was forgotten rather than pinned for the isolate's
    // lifetime, so the next request loads the module again and is served.
    const served = await app.request("http://gateway.test/v1/probe", undefined, env);
    expect(served.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("evaluates the module once across requests", async () => {
    let attempts = 0;
    const app = outerApp(async () => {
      attempts += 1;
      return innerApp();
    });

    for (let i = 0; i < 2; i += 1) {
      const response = await app.request("http://gateway.test/v1/probe", undefined, env);
      expect(response.status).toBe(200);
    }
    expect(attempts).toBe(1);
  });

  it("lets an error from the inner app reach the outer handler", async () => {
    const app = outerApp(async () => innerApp());

    const response = await app.request("http://gateway.test/v1/boom", undefined, env);
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("outer:inner failure");
  });

  it("forwards the untouched request with no execution context", async () => {
    const app = outerApp(async () => innerApp());

    const response = await app.request("http://gateway.test/v1/probe", undefined, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ path: "/v1/probe", hasDatabase: true });
  });

  it("forwards the execution context when the request has one", async () => {
    const inner = new Hono<TestEnv>();
    let waited = false;
    inner.get("/v1/probe", (c) => {
      c.executionCtx.waitUntil(Promise.resolve());
      waited = true;
      return c.text("ok");
    });
    const app = outerApp(async () => inner);

    const response = await app.fetch(
      new Request("http://gateway.test/v1/probe"),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(waited).toBe(true);
  });
});
