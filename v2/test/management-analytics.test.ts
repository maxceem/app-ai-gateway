/**
 * The optional `MANAGEMENT_ANALYTICS` dataset (v1's
 * `management-analytics.test.ts`, ported): one data point per management
 * call, over each channel, for a call that succeeds, one that is refused and
 * one refused before anyone is known — and nothing at all where it is unbound.
 * The dataset is always a fake here: nothing is sent anywhere.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { knownClient, recordManagementCall, userAgentOf, versionOf, type ManagementCall } from "../src/analytics/management.ts";
import worker from "../src/index.ts";
import { LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedHuman, seedManagementKey } from "./helpers.ts";

const API = "https://gateway.test";
const CONSOLE = "https://console.gateway.test";

/** A successful API call, for tests that vary one field of it. */
function call(): ManagementCall {
  return {
    accountId: null, channel: "api", credential: "apiKey", identity: "human",
    operation: "listApps", tool: null,
    outcome: "ok", status: 200, code: null, reason: null, field: null, issue: null,
    client: null, clientVersion: null, requestId: null, durationMs: 1,
  };
}

/** The blobs of a data point, by the positions `recordManagementCall` documents. */
const BLOBS = [
  "channel", "operation", "tool", "kind", "outcome", "code", "reason",
  "field", "issue", "credential", "identity", "client", "clientVersion", "requestId",
] as const;

/** A request id as Cloudflare's edge sends it in `cf-ray`. */
const RAY = "8f1a2b3c4d5e6f70-SJC";

type Point = Record<(typeof BLOBS)[number], string | null> & { account: string; status: number };

/** A deployment that binds the dataset, the way a profile overlay does, and the points written to it. */
function recording(write: (point: AnalyticsEngineDataPoint) => void = () => {}, overrides: Record<string, unknown> = {}) {
  const points: Point[] = [];
  const dataset = {
    writeDataPoint: vi.fn((point: AnalyticsEngineDataPoint = {}) => {
      points.push({
        account: point.indexes?.[0] as string,
        ...Object.fromEntries(BLOBS.map((name, index) => [name, point.blobs?.[index] ?? null])),
        status: point.doubles?.[0] as number,
      } as Point);
      write(point);
    }),
  };
  const runtime = new Proxy(env, {
    get(target, property, receiver) {
      if (property === "MANAGEMENT_ANALYTICS") return dataset;
      if (Object.hasOwn(overrides, property)) return overrides[property as string];
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
  /** A request to the API's host, or to the console's for a path under `/v2/mcp` or a console call. */
  const send = async (path: string, init: RequestInit & { base?: string } = {}) => {
    const ctx = createExecutionContext();
    const base = init.base ?? (path.startsWith("/v2/mcp") ? CONSOLE : API);
    const response = await worker.fetch(new Request(`${base}${path}`, init), runtime, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { points, dataset, send };
}

const key = (value: string) => ({ authorization: `Bearer ${value}` });

/** An account of its own and a management key for it, set up where nothing is recorded. */
async function account() {
  const human = await seedHuman();
  return { ...human, key: await seedManagementKey({ userId: human.userId, accountId: human.accountId, grant: "manage" }) };
}

/** One MCP `tools/call`, as a 2026-07-28 client sends it. */
function toolCall(name: string, args: Record<string, unknown>, headers: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "Claude Code", version: "2.3.1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  };
}

beforeAll(async () => {
  await loadManagement();
  // The MCP SDK and the tool table load on the first MCP call that gets past the bearer gate: about a second
  // alone, several on a loaded machine. Loaded here, as `mcp.test.ts` does, so the first MCP test does not pay it.
  // The first call is checked too, so the path that loads the SDK is still covered.
  const { points, send } = recording();
  const owner = await account();
  const response = await send("/v2/mcp", toolCall("list_apps", {}, key(owner.key)));
  expect(response.status).toBe(200);
  expect(points).toEqual([expect.objectContaining({ account: owner.accountId, channel: "mcp", tool: "list_apps", outcome: "ok", status: 200 })]);
}, LOAD_MANAGEMENT_TIMEOUT_MS);

describe("management analytics", () => {
  it("records a management API call by its operation, channel and account", async () => {
    const { points, send } = recording();
    const owner = await account();
    const response = await send("/v2/admin/apps", { headers: { ...key(owner.key), "user-agent": "curl/8.7.1" } });
    expect(response.status).toBe(200);
    expect(points).toEqual([expect.objectContaining({
      account: owner.accountId,
      channel: "api",
      operation: "listApps",
      outcome: "ok",
      status: 200,
      code: null,
      credential: "apiKey",
      identity: "human",
      client: "curl",
      clientVersion: null,
    })]);
  });

  it("tells the CLI apart by the name it gives itself, with its version, and labels the smoke checks by theirs", async () => {
    const { points, send } = recording();
    const owner = await account();
    await send("/v2/admin/apps", { headers: { ...key(owner.key), "user-agent": "agw/1.4.0" } });
    await send("/v2/admin/apps", { headers: { ...key(owner.key), "user-agent": "agw-smoke/0.13.0" } });
    await send("/v2/admin/apps", { headers: { ...key(owner.key), "user-agent": "agw/1.4.0 agw-smoke/0.13.0" } });
    expect(points).toEqual([
      expect.objectContaining({ channel: "cli", client: "agw", clientVersion: "1.4.0" }),
      expect.objectContaining({ channel: "api", client: "smoke", clientVersion: null }),
      // Only the first product is read: a CLI the checks run is the CLI.
      expect.objectContaining({ channel: "cli", client: "agw", clientVersion: "1.4.0" }),
    ]);
  });

  it("records the console from a person's session", async () => {
    const { points, send } = recording();
    const human = await seedHuman();
    const response = await send("/v2/admin/apps", { base: CONSOLE, headers: { cookie: human.cookie, "x-console-request": "1" } });
    expect(response.status).toBe(200);
    expect(points).toEqual([expect.objectContaining({
      account: human.accountId,
      channel: "console",
      credential: "session",
      identity: "human",
      outcome: "ok",
    })]);
  });

  it("records a validation refusal by its code and field, never its message or value", async () => {
    const { points, dataset, send } = recording();
    const owner = await account();
    const response = await send("/v2/admin/apps", {
      method: "POST",
      headers: { ...key(owner.key), "content-type": "application/json" },
      body: JSON.stringify({ name: 42, config: { secret_marker: "do-not-record" } }),
    });
    expect(response.status).toBe(400);
    expect(points).toEqual([expect.objectContaining({
      operation: "createApp",
      outcome: "refused",
      status: 400,
      code: "invalid_request",
      field: "name",
      issue: "invalid_type",
    })]);
    expect(JSON.stringify(dataset.writeDataPoint.mock.calls)).not.toContain("do-not-record");
  });

  it("records a credential refused before sign-in by the operation it asked for, and the path's template, never its parameters", async () => {
    const { points, dataset, send } = recording();
    const response = await send("/v2/admin/apps", { headers: key("agw_mgmt_not-a-real-key") });
    expect(response.status).toBe(401);
    await send("/v2/admin/apps/secret-looking-app-id", { headers: key("agw_mgmt_not-a-real-key") });
    await send("/v2/admin/apps/secret-looking-app-id", { method: "DELETE", headers: key("agw_mgmt_not-a-real-key") });
    expect(points[0]).toEqual(expect.objectContaining({
      account: "",
      channel: "api",
      operation: "listApps",
      outcome: "refused",
      status: 401,
      code: "auth_required",
      credential: "apiKey",
      identity: null,
    }));
    expect(points.map((point) => point.operation)).toEqual(["listApps", "getApp", "deleteApp"]);
    const written = JSON.stringify(dataset.writeDataPoint.mock.calls);
    expect(written).not.toContain("not-a-real-key");
    expect(written).not.toContain("secret-looking-app-id");
  });

  it("carries Cloudflare's request id on the data point and on the gateway's log line, and only one shaped like it", async () => {
    const { points, send } = recording();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await send("/v2/admin/apps", { headers: { ...key("agw_mgmt_not-a-real-key"), "cf-ray": RAY } });
    await send("/v2/admin/apps", { headers: { ...key("agw_mgmt_not-a-real-key"), "cf-ray": "alice@example.com" } });
    expect(points).toEqual([
      expect.objectContaining({ requestId: RAY, code: "auth_required" }),
      expect.objectContaining({ requestId: null }),
    ]);
    const lines = warn.mock.calls.map(([entry]) => JSON.parse(String(entry))).filter((entry) => entry.message === "gateway_error");
    expect(lines[0]).toMatchObject({ ray: RAY, code: "auth_required", status: 401 });
    expect(lines[1]?.ray).toBeUndefined();
  });

  it("names why a credential was refused, by what the request sent, and answers each exactly as before", async () => {
    const human = await seedHuman();
    const sessionCookie = `${human.cookie.split("=")[0]}=not-a-live-session`;
    const cases: [Record<string, string>, string][] = [
      [{}, "credential_missing"],
      [{ authorization: "Token agw_mgmt_anything" }, "credential_malformed"],
      [{ authorization: "Bearer sk-a-provider-key" }, "credential_malformed"],
      [{ authorization: "Bearer agw_mgmt_revoked-or-unknown" }, "credential_rejected"],
      [{ authorization: "Bearer agw_oat_expired-or-unknown" }, "credential_rejected"],
      [{ cookie: sessionCookie, "x-console-request": "1" }, "session_expired"],
      [{ cookie: sessionCookie }, "console_header_missing"],
      [{ cookie: human.cookie }, "console_header_missing"],
    ];
    for (const [headers, reason] of cases) {
      const { points, send } = recording();
      const response = await send("/v2/admin/apps", { base: CONSOLE, headers });
      expect(response.status, reason).toBe(401);
      const body = (await response.json()) as { error: Record<string, unknown> };
      // The caller's answer never names the reason.
      expect(JSON.stringify(body), reason).not.toMatch(/credential_|session_expired|console_header/u);
      expect(points, reason).toEqual([expect.objectContaining({ code: "auth_required", reason, operation: "listApps" })]);
    }
  });

  it("records nothing for sign-in itself, which is not a management call", async () => {
    const { points, send } = recording();
    const response = await send("/v2/auth/get-session", { base: CONSOLE, headers: { "x-console-request": "1" } });
    expect(response.status).toBe(200);
    expect(points).toEqual([]);
  });

  it("names a refused credential on the CLI's surface and at the MCP endpoint too", async () => {
    const cli = recording();
    await cli.send("/v2/cli/tools/list_apps", {
      method: "POST",
      headers: { authorization: "Bearer agw_mgmt_revoked-or-unknown", "user-agent": "agw/1.4.0", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cli.points).toEqual([expect.objectContaining({
      channel: "cli",
      operation: "callCliTool",
      tool: "list_apps",
      code: "auth_required",
      reason: "credential_rejected",
    })]);

    const human = await seedHuman();
    const cases: [Record<string, string>, string][] = [
      [{}, "credential_missing"],
      // A cookie is never a credential at the MCP endpoint.
      [{ cookie: human.cookie }, "credential_missing"],
      [{ authorization: "Bearer sk-a-provider-key" }, "credential_malformed"],
      [{ authorization: "Bearer agw_mgmt_revoked-or-unknown" }, "credential_rejected"],
    ];
    for (const [headers, reason] of cases) {
      const mcp = recording();
      const response = await mcp.send("/v2/mcp", toolCall("list_apps", {}, headers));
      expect(response.status, reason).toBe(401);
      expect(mcp.points, reason).toEqual([expect.objectContaining({ channel: "mcp", reason })]);
    }
  });

  it("records a CLI tool only by its registered name, never the name a request sent", async () => {
    const { points, dataset, send } = recording();
    for (const name of ["list_apps", "alice@example.com", "not_a_tool"]) {
      await send(`/v2/cli/tools/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { authorization: "Bearer agw_mgmt_revoked-or-unknown", "content-type": "application/json" },
        body: JSON.stringify({}),
      });
    }
    expect(points.map((point) => [point.operation, point.tool, point.code])).toEqual([
      ["callCliTool", "list_apps", "auth_required"],
      ["callCliTool", null, "auth_required"],
      ["callCliTool", null, "auth_required"],
    ]);
    expect(JSON.stringify(dataset.writeDataPoint.mock.calls)).not.toMatch(/alice|not_a_tool/u);
  });

  it("records the field and issue a validation refusal names, through a CLI tool call too", async () => {
    const { points, dataset, send } = recording();
    const owner = await account();
    const response = await send("/v2/cli/tools/validate_app", {
      method: "POST",
      headers: { ...key(owner.key), "content-type": "application/json", "user-agent": "agw/1.4.0" },
      body: JSON.stringify({ config: { name: 42, config: { secret_marker: "do-not-record" } } }),
    });
    expect(response.status).toBe(400);
    expect(points).toEqual([expect.objectContaining({
      channel: "cli",
      operation: "callCliTool",
      tool: "validate_app",
      code: "invalid_request",
      field: "name",
      issue: "invalid_type",
    })]);
    expect(JSON.stringify(dataset.writeDataPoint.mock.calls)).not.toContain("do-not-record");
  });

  it("records an unknown admin path as refused", async () => {
    const { points, send } = recording();
    const owner = await account();
    const response = await send("/v2/admin/no-such-thing", { headers: key(owner.key) });
    expect(response.status).toBe(404);
    expect(points).toEqual([expect.objectContaining({ operation: null, outcome: "refused", status: 404 })]);
  });

  it("records an MCP tool call once, with the client's declared name, and not the operation it runs", async () => {
    const { points, send } = recording();
    const owner = await account();
    const response = await send("/v2/mcp", toolCall("list_apps", {}, { ...key(owner.key), "cf-ray": RAY }));
    expect(response.status).toBe(200);
    expect(points).toEqual([expect.objectContaining({
      account: owner.accountId,
      requestId: RAY,
      channel: "mcp",
      operation: "listApps",
      tool: "list_apps",
      outcome: "ok",
      status: 200,
      credential: "apiKey",
      client: "claude-code",
      clientVersion: "2.3.1",
    })]);
  });

  it("records a refused MCP tool call by the refusal's code, though the answer is a tool result", async () => {
    const { points, send } = recording();
    const owner = await account();
    const response = await send("/v2/mcp", toolCall("get_app", { app: "no-such-app" }, key(owner.key)));
    expect(response.status).toBe(200);
    expect(points).toEqual([expect.objectContaining({ channel: "mcp", tool: "get_app", outcome: "refused", status: 404 })]);
    expect(points[0]!.code).toMatch(/not_found$/u);
  });

  it("records the MCP bearer gate's refusal", async () => {
    const { points, send } = recording();
    const response = await send("/v2/mcp", toolCall("list_apps", {}, { "user-agent": "claude-code/2.3.1", "cf-ray": RAY }));
    expect(response.status).toBe(401);
    expect(points).toEqual([expect.objectContaining({
      account: "",
      requestId: RAY,
      channel: "mcp",
      outcome: "refused",
      status: 401,
      code: "auth_required",
      credential: "none",
      client: "claude-code",
    })]);
  });

  it("records an MCP bearer gate that fails rather than refuses, as the client is answered", async () => {
    const owner = await account();
    const unreachable = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare" || property === "batch") {
          return () => {
            throw new Error("D1_ERROR: Network connection lost.");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { points, send } = recording(undefined, { DB: unreachable });
    const response = await send("/v2/mcp", toolCall("list_apps", {}, key(owner.key)));
    expect(response.status).toBeGreaterThanOrEqual(500);
    const { error } = (await response.json()) as { error: { code: string } };
    expect(points).toEqual([expect.objectContaining({
      channel: "mcp",
      credential: "apiKey",
      outcome: "failed",
      status: response.status,
      code: error.code,
    })]);
    vi.restoreAllMocks();
  });

  it("answers as usual when the dataset fails to take a point, and where it is unbound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { send } = recording(() => {
      throw new Error("dataset unavailable");
    });
    const owner = await account();
    expect((await send("/v2/admin/apps", { headers: key(owner.key) })).status).toBe(200);
    expect(warn.mock.calls.some(([entry]) => String(entry).includes("management_analytics_write_failed"))).toBe(true);
    warn.mockRestore();

    expect((env as unknown as { MANAGEMENT_ANALYTICS?: unknown }).MANAGEMENT_ANALYTICS).toBeUndefined();
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${API}/v2/admin/apps`, { headers: key(owner.key) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
  });

  it("answers as usual when the data point cannot be built, and logs why", async () => {
    // The tool table, loaded only to name a CLI tool, fails to load.
    vi.doMock("../src/mcp/tools.ts", () => {
      throw new Error("the tool table could not be loaded");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { points, send } = recording();
      const response = await send("/v2/cli/tools/list_apps", {
        method: "POST",
        headers: { authorization: "Bearer agw_mgmt_revoked-or-unknown", "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("auth_required");
      expect(points).toEqual([]);
      expect(warn.mock.calls.some(([entry]) => String(entry).includes("management_analytics_write_failed"))).toBe(true);
    } finally {
      vi.doUnmock("../src/mcp/tools.ts");
      warn.mockRestore();
    }
  });

  it("records an account id the sign-in library creates, and none for anything not shaped like one", async () => {
    const written: AnalyticsEngineDataPoint[] = [];
    const runtime = { MANAGEMENT_ANALYTICS: { writeDataPoint: (point: AnalyticsEngineDataPoint) => written.push(point) } } as unknown as Env;
    const { accountId } = await seedHuman();
    const ids = [accountId, crypto.randomUUID(), "a".repeat(96)];
    for (const id of ids) recordManagementCall(runtime, { ...call(), accountId: id });
    expect(written.map((point) => point.indexes?.[0])).toEqual(ids);

    written.length = 0;
    for (const id of ["a".repeat(97), "alice@example.com"]) recordManagementCall(runtime, { ...call(), accountId: id });
    expect(written.map((point) => point.indexes?.[0])).toEqual(["", ""]);
  });

  it("records a client's name only as a label of its own, never as sent", () => {
    expect(userAgentOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toEqual({ client: "browser", version: null, isCli: false });
    expect(userAgentOf("agw/1.4.0")).toEqual({ client: "agw", version: "1.4.0", isCli: true });
    expect(knownClient("Claude Code")).toBe("claude-code");
    // Whatever a caller names itself — a key included — is not copied.
    expect(userAgentOf("sk-example-secret/1.0").client).toBe("other");
    expect(knownClient("alice@example.com")).toBe("other");
    expect(userAgentOf("<script>alert(1)</script>").client).toBe("other");
    expect(userAgentOf(undefined)).toEqual({ client: null, version: null, isCli: false });
    expect(userAgentOf("  ").client).toBeNull();
    // Only a version's digits, and only the CLI's: a suffix is free text.
    expect(userAgentOf("agw/1.4.0-beta.2").version).toBe("1.4.0");
    expect(userAgentOf("agw/1.0-sk.secret123").version).toBe("1.0");
    expect(userAgentOf("agw/latest").version).toBeNull();
    expect(userAgentOf("curl/8.7.1").version).toBeNull();
    // The smoke checks, by their own name.
    expect(userAgentOf("agw-smoke/0.13.0")).toEqual({ client: "smoke", version: null, isCli: false });
    expect(userAgentOf("agw/1.4.0 agw-smoke/0.13.0")).toEqual({ client: "agw", version: "1.4.0", isCli: true });
    expect(versionOf("1.0+jane.smith")).toBe("1.0");
    expect(versionOf("sk-example-secret")).toBeNull();
  });

  it("records an MCP client that declares an unknown name as other, without its version", async () => {
    const { points, send } = recording();
    const owner = await account();
    const request = toolCall("list_apps", {}, key(owner.key));
    const body = JSON.parse(request.body as string);
    body.params._meta["io.modelcontextprotocol/clientInfo"] = { name: "sk-example-secret", version: "my-api-key" };
    await send("/v2/mcp", { ...request, body: JSON.stringify(body) });
    expect(points).toEqual([expect.objectContaining({ client: "other", clientVersion: null })]);
  });
});
