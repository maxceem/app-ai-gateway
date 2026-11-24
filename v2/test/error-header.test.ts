/**
 * Every error the gateway answers itself names its code in `X-AGW-Error`, so a
 * client can tell it from a provider's own without reading a streamed body.
 * The app routes' cases are in `proxy.test.ts`; these are the management
 * module's and MCP's, which throw their errors on to the entry module.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the gateway's own error code header", () => {
  it.each([
    ["/v2/admin/apps", "GET", "auth_required"],
    ["/v2/admin/nowhere", "GET", "auth_required"],
    ["/v2/oauth/nowhere", "GET", "not_found"],
    ["/v2/mcp", "GET", null],
  ] as const)("%s answers its code in the header and the body alike", async (path, method, code) => {
    const response = await call(path, { method });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const text = await response.text();
    const body = (() => {
      try {
        return JSON.parse(text) as { error?: { code?: unknown } };
      } catch {
        return {};
      }
    })();
    const named = typeof body.error?.code === "string" ? body.error.code : null;
    if (code !== null) expect(named).toBe(code);
    // Only a gateway error body has a code; the header says the same, or is absent.
    expect(response.headers.get("x-agw-error")).toBe(named);
  });
});
