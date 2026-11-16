import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearIsolateCaches, seedServerApp } from "./helpers";

/**
 * A request the app's own settings refuse is recorded as a refusal sample, so
 * the console shows which path or model the app asked for. The client's answer
 * is unchanged; only callers that proved who they are are recorded.
 */

const ORIGIN = "https://example.test";
const contexts: ExecutionContext[] = [];

async function call(
  path: string,
  options: { key: string; body?: unknown; userId?: string },
): Promise<Response> {
  const ctx = createExecutionContext();
  contexts.push(ctx);
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.key}`,
        "content-type": "application/json",
        "x-end-user-id": options.userId ?? "refused-user",
        "x-app-version": "3.1.0",
      },
      body: JSON.stringify(options.body ?? { model: "gpt-5.6-sol", input: "hello" }),
    }),
    env,
    ctx,
  );
}

async function settle(): Promise<void> {
  await Promise.all(contexts.splice(0).map((ctx) => waitOnExecutionContext(ctx)));
}

interface SampleRow {
  reason: string;
  scope: string | null;
  user_id: string | null;
  provider_slug: string | null;
  model: string | null;
  route: string | null;
  endpoint_slug: string | null;
  app_version: string | null;
}

async function samples(appId: string): Promise<SampleRow[]> {
  const rows = await env.DB.prepare(
    `SELECT reason, scope, user_id, provider_slug, model, route, endpoint_slug, app_version
       FROM app_rejection_event WHERE app_id = ? ORDER BY id`,
  ).bind(appId).all<SampleRow>();
  return rows.results;
}

async function errorCode(response: Response): Promise<string> {
  return (await response.json<{ error: { code: string } }>()).error.code;
}

beforeEach(() => {
  clearIsolateCaches();
  // Nothing here may reach a provider: every request is refused before one.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("a refused request must not call a provider");
  });
});

afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
});

describe("refusals by the app's own settings", () => {
  it("records a path the app does not allow, naming the route, and answers as before", async () => {
    const appId = "refused-path";
    const key = await seedServerApp(appId);

    const refused = await call(`/v1/apps/${appId}/proxy/openai/v1/decisions`, { key });
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("path_not_allowed");
    await settle();

    expect(await samples(appId)).toEqual([{
      reason: "path_not_allowed",
      scope: "app",
      user_id: "refused-user",
      provider_slug: "openai",
      model: null,
      route: "openai/v1/decisions",
      endpoint_slug: null,
      app_version: "3.1.0",
    }]);
  });

  it("records a model the app does not allow, naming the model", async () => {
    const appId = "refused-model";
    const key = await seedServerApp(appId);

    const refused = await call(`/v1/apps/${appId}/proxy/openai/v1/responses`, {
      key,
      body: { model: "gpt-not-allowed", input: "hello" },
    });
    expect(await errorCode(refused)).toBe("model_not_allowed");
    await settle();

    expect(await samples(appId)).toMatchObject([{
      reason: "model_not_allowed",
      model: "gpt-not-allowed",
      route: "openai/v1/responses",
    }]);
  });

  it("records a provider the app names that has no key", async () => {
    const appId = "refused-provider";
    const key = await seedServerApp(appId);

    const refused = await call(`/v1/apps/${appId}/proxy/no-such-provider/v1/responses`, { key });
    expect(await errorCode(refused)).toBe("provider_not_configured");
    await settle();

    expect(await samples(appId)).toMatchObject([{
      reason: "provider_not_configured",
      provider_slug: "no-such-provider",
      route: "no-such-provider/v1/responses",
    }]);
  });

  it("records a custom endpoint the app does not have, naming the endpoint", async () => {
    const appId = "refused-endpoint";
    const key = await seedServerApp(appId);

    const refused = await call(`/v1/apps/${appId}/endpoints/summarize`, { key });
    expect(refused.status).toBe(404);
    expect(await errorCode(refused)).toBe("endpoint_not_found");
    await settle();

    expect(await samples(appId)).toMatchObject([{
      reason: "endpoint_not_found",
      scope: "app",
      provider_slug: null,
      route: null,
      endpoint_slug: "summarize",
    }]);
  });

  it("records nothing for a caller that never proved who it is", async () => {
    const appId = "refused-unauthenticated";
    await seedServerApp(appId);

    const refused = await call(`/v1/apps/${appId}/proxy/openai/v1/decisions`, { key: "agw_not-a-real-key" });
    expect(refused.status).toBe(401);
    await settle();

    expect(await samples(appId)).toEqual([]);
  });

  it("samples once a minute per user and reason, so one cause cannot hide another", async () => {
    const appId = "refused-sampling";
    const key = await seedServerApp(appId);

    await call(`/v1/apps/${appId}/proxy/openai/v1/decisions`, { key });
    await call(`/v1/apps/${appId}/proxy/openai/v1/decisions`, { key });
    await call(`/v1/apps/${appId}/proxy/openai/v1/responses`, { key, body: { model: "gpt-not-allowed", input: "x" } });
    await call(`/v1/apps/${appId}/proxy/openai/v1/decisions`, { key, userId: "another-user" });
    await settle();

    // Recorded in the background, so in no fixed order.
    expect((await samples(appId)).map((row) => `${row.reason}:${row.user_id}`).sort()).toEqual([
      "model_not_allowed:refused-user",
      "path_not_allowed:another-user",
      "path_not_allowed:refused-user",
    ]);
  });
});
