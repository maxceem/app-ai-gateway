/**
 * Every error the gateway answers itself names its code in `X-AGW-Error`, so a
 * client can tell it from a provider's own without reading a streamed body.
 * The app routes' cases are in `proxy.test.ts`; these are the management
 * module's and MCP's, which throw their errors on to the entry module.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import management from "../src/management/app.ts";
import { GatewayError } from "../src/core/errors.ts";
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

describe("the management module's not-found answer", () => {
  it("is thrown on as the gateway's own not_found, for the entry module to format", async () => {
    let thrown: unknown;
    try {
      await management.request("https://gateway.test/v2/console-nothing-here", {}, env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    expect(thrown).toMatchObject({ status: 404, code: "not_found" });
  });

  it("is logged at info through the entry module, not as a warning", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await call("/v2/cli/nowhere");
      expect(response.headers.get("x-agw-error")).toBe("not_found");
      const warned = warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes("gateway_error"));
      expect(warned).toEqual([]);
      expect(info.mock.calls.some((args) => String(args[0]).includes("gateway_error"))).toBe(true);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
