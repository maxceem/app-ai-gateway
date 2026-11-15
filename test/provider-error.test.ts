import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { gatewayToken, seedApp, seedProvider, signRequest } from "./helpers";
import { providerErrorCode } from "../src/usage/provider-error";

const whole = (text: string) => ({ head: text, tail: "", truncated: false, totalBytes: text.length, aborted: false });

describe("providerErrorCode", () => {
  it.each([
    ["OpenAI", { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } }, "rate_limit_exceeded"],
    ["OpenAI with no code", { error: { message: "Bad", type: "invalid_request_error", code: null } }, "invalid_request_error"],
    ["Anthropic", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "overloaded_error"],
    ["Gemini", [{ error: { code: 429, message: "Quota", status: "RESOURCE_EXHAUSTED" } }], "RESOURCE_EXHAUSTED"],
    ["a top-level code", { object: "error", message: "No", type: "invalid_model", code: "1500" }, "1500"],
    ["a sentence where a code goes", { error: { code: "this is not a code, it is text the client wrote" } }, null],
    ["no error at all", { ok: true }, null],
  ])("reads %s", (_label, body, code) => {
    expect(providerErrorCode(whole(JSON.stringify(body)))).toBe(code);
  });

  it("reads nothing from a body that is not JSON, or too big to keep whole", () => {
    expect(providerErrorCode(whole("<html>Bad gateway</html>"))).toBeNull();
    expect(providerErrorCode({ ...whole('{"error":{"code":"x"}}'), truncated: true })).toBeNull();
  });
});

describe("a failure written by code from before the error column", () => {
  it("is given the error the backfill gave every earlier failure, and a served one none", async () => {
    // How 0.19.0 writes an event: a status, and no error.
    const insert = (eventId: string, status: string, error: string | null) => env.DB.prepare(
      `INSERT INTO app_usage_event(event_id, organization_id, app_id, provider_type, model, route, status, error)
       VALUES (?, 'operator-test-organization', 'old-writer', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', ?, ?)`,
    ).bind(eventId, status, error).run();
    await insert("old-writer-failed", "provider_error", null);
    await insert("old-writer-served", "ok", null);
    await insert("new-writer-failed", "provider_error", "429 rate_limit_exceeded");

    const { results } = await env.DB.prepare(
      "SELECT event_id, error FROM app_usage_event WHERE app_id = 'old-writer' ORDER BY event_id",
    ).all();
    expect(results).toEqual([
      { event_id: "new-writer-failed", error: "429 rate_limit_exceeded" },
      { event_id: "old-writer-failed", error: "provider_error" },
      { event_id: "old-writer-served", error: null },
    ]);
  });
});

describe("a failed attempt records why it failed", () => {
  let pending: ExecutionContext[] = [];
  afterEach(async () => {
    await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
    pending = [];
    vi.restoreAllMocks();
  });

  it("keeps the provider's status and code, and never its message", async () => {
    const appId = `provider-error-${crypto.randomUUID()}`;
    const slug = `openai-${appId.slice(-12)}`;
    await seedApp(appId, { proxy: { provider_mode: "all", model_rewrites: {} } });
    await seedProvider({ type: "openai", id: `${appId}-provider`, slug, pricing: { "gpt-5.6-sol": { input: 1, output: 4 } } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(
      { error: { message: "Rate limit reached for the prompt about my secret", type: "requests", code: "rate_limit_exceeded" } },
      { status: 429 },
    ));

    const context = createExecutionContext();
    const request = new Request(`https://example.test/v1/apps/${appId}/proxy/${slug}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-version": "1.2.3", authorization: `Bearer ${await gatewayToken(appId)}` },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi" }),
    });
    const response = await app.fetch(await signRequest(request), env, context);
    pending.push(context);
    expect(response.status).toBe(429);
    await response.arrayBuffer();
    await waitOnExecutionContext(context);

    const row = await env.DB.prepare("SELECT * FROM app_usage_event WHERE app_id = ?").bind(appId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: "provider_error", error: "429 rate_limit_exceeded" });
    expect(JSON.stringify(row)).not.toContain("secret");
  });
});
