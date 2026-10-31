import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { clientOf, cliVersionOf, knownClient, versionOf } from "../src/analytics/management";
import worker from "../src/index";
import { seedHuman } from "./helpers";

/**
 * The optional `MANAGEMENT_ANALYTICS` dataset: one data point per management
 * call, over each channel, for a call that succeeds, one that is refused and
 * one refused before anyone is known — and nothing at all where it is unbound.
 */

const ORIGIN = "https://example.test";

/** The blobs of a data point, by the positions `recordManagementCall` documents. */
const BLOBS = [
  "channel", "operation", "tool", "kind", "outcome", "code", "reason",
  "field", "issue", "credential", "identity", "client", "clientVersion",
] as const;

type Point = Record<(typeof BLOBS)[number], string | null> & { account: string; status: number };

/** A deployment that binds the dataset, the way a profile overlay does, and the points written to it. */
function recording(
  write: (point: AnalyticsEngineDataPoint) => void = () => {},
  overrides: Partial<Env> = {},
) {
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
    get(target, key, receiver) {
      if (key === "MANAGEMENT_ANALYTICS") return dataset;
      if (Object.hasOwn(overrides, key)) return overrides[key as keyof Env];
      if (key === "DEPLOYMENT_ID") return "management-analytics-tests";
      if (key === "CLI_CONSOLE_ORIGIN") return ORIGIN;
      return Reflect.get(target, key, receiver);
    },
  });
  const send = (path: string, init: RequestInit = {}) => worker.request(`${ORIGIN}${path}`, init, runtime);
  return { points, dataset, send };
}

const key = (value: string) => ({ authorization: `Bearer ${value}` });

/**
 * An account of its own and a management key made for it in the console,
 * set up where nothing is recorded, so a test sees only its own call.
 */
async function account(email: string) {
  const human = await seedHuman(email);
  const created = await worker.request(`${ORIGIN}/v1/admin/keys`, {
    method: "POST",
    headers: { cookie: human.cookie, "x-console-request": "1", "content-type": "application/json" },
    body: JSON.stringify({ name: "Analytics", grant: "manage" }),
  }, env);
  expect(created.status).toBe(201);
  const { key } = await created.json<{ key: { plaintext: string } }>();
  return { ...human, key: key.plaintext };
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

describe("management analytics", () => {
  it("records a management API call by its operation, channel and account", async () => {
    const { points, send } = recording();
    const owner = await account("analytics-api@example.test");
    const response = await send("/v1/admin/apps", { headers: { ...key(owner.key), "user-agent": "curl/8.7.1" } });
    expect(response.status).toBe(200);
    expect(points).toEqual([expect.objectContaining({
      account: owner.organizationId,
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

  it("tells the CLI apart by the name it gives itself, with its version", async () => {
    const { points, send } = recording();
    const owner = await account("analytics-cli@example.test");
    await send("/v1/admin/apps", { headers: { ...key(owner.key), "user-agent": "agw/1.4.0" } });
    expect(points).toEqual([expect.objectContaining({ channel: "cli", client: "agw", clientVersion: "1.4.0" })]);
  });

  it("records the console from a person's session", async () => {
    const { points, send } = recording();
    const human = await seedHuman("analytics-console@example.test");
    const response = await send("/v1/admin/apps", { headers: { cookie: human.cookie, "x-console-request": "1" } });
    expect(response.status).toBe(200);
    expect(points).toEqual([expect.objectContaining({
      account: human.organizationId,
      channel: "console",
      credential: "session",
      identity: "human",
      outcome: "ok",
    })]);
  });

  it("records a validation refusal by its code and field, never its message or value", async () => {
    const { points, dataset, send } = recording();
    const owner = await account("analytics-invalid@example.test");
    const response = await send("/v1/admin/apps", {
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

  it("records a credential refused before any operation or account is known", async () => {
    const { points, dataset, send } = recording();
    const response = await send("/v1/admin/apps", { headers: key("agw_mgmt_not-a-real-key") });
    expect(response.status).toBe(401);
    expect(points).toEqual([expect.objectContaining({
      account: "",
      channel: "api",
      operation: null,
      outcome: "refused",
      status: 401,
      code: "auth_required",
      credential: "apiKey",
      identity: null,
    })]);
    expect(JSON.stringify(dataset.writeDataPoint.mock.calls)).not.toContain("not-a-real-key");
  });

  it("records an unknown admin path as refused", async () => {
    const { points, send } = recording();
    const owner = await account("analytics-unknown-path@example.test");
    const response = await send("/v1/admin/no-such-thing", { headers: key(owner.key) });
    expect(response.status).toBe(404);
    expect(points).toEqual([expect.objectContaining({ operation: null, outcome: "refused", status: 404 })]);
  });

  it("records an MCP tool call with the client's declared name", async () => {
    const { points, send } = recording();
    const owner = await account("analytics-mcp@example.test");
    const response = await send("/mcp", toolCall("list_apps", {}, key(owner.key)));
    expect(response.status).toBe(200);
    expect(points).toEqual([expect.objectContaining({
      account: owner.organizationId,
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
    const owner = await account("analytics-mcp-refused@example.test");
    const response = await send("/mcp", toolCall("get_app", { app: "no-such-app" }, key(owner.key)));
    expect(response.status).toBe(200);
    expect(points).toEqual([expect.objectContaining({
      channel: "mcp",
      tool: "get_app",
      outcome: "refused",
      status: 404,
      code: "app_not_found",
    })]);
  });

  it("records the MCP bearer gate's refusal", async () => {
    const { points, send } = recording();
    const response = await send("/mcp", toolCall("list_apps", {}, { "user-agent": "claude-code/2.3.1" }));
    expect(response.status).toBe(401);
    expect(points).toEqual([expect.objectContaining({
      account: "",
      channel: "mcp",
      outcome: "refused",
      status: 401,
      code: "auth_required",
      credential: "none",
      client: "claude-code",
    })]);
  });

  it("records an MCP bearer gate that fails rather than refuses, as the client is answered", async () => {
    const owner = await account("analytics-mcp-gate-failure@example.test");
    const unreachable = new Proxy(env.DB, {
      get(target, key, receiver) {
        if (key === "prepare" || key === "batch") {
          return () => {
            throw new Error("D1_ERROR: Network connection lost.");
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const { points, send } = recording(undefined, { DB: unreachable });
    const response = await send("/mcp", toolCall("list_apps", {}, key(owner.key)));
    expect(response.status).toBeGreaterThanOrEqual(500);
    const { error } = await response.json<{ error: { code: string } }>();
    expect(points).toEqual([expect.objectContaining({
      channel: "mcp",
      credential: "apiKey",
      outcome: "failed",
      status: response.status,
      code: error.code,
    })]);
  });

  it("answers as usual when the dataset fails to take a point", async () => {
    const { send } = recording(() => {
      throw new Error("dataset unavailable");
    });
    const owner = await account("analytics-write-failure@example.test");
    const response = await send("/v1/admin/apps", { headers: key(owner.key) });
    expect(response.status).toBe(200);
  });

  it("writes nothing and still answers where the dataset is unbound", async () => {
    expect(env.MANAGEMENT_ANALYTICS).toBeUndefined();
    const owner = await account("analytics-unbound@example.test");
    const response = await worker.request(`${ORIGIN}/v1/admin/apps`, { headers: key(owner.key) }, env);
    expect(response.status).toBe(200);
  });

  it("records a client's name only as a label of its own, never as sent", () => {
    expect(clientOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("browser");
    expect(clientOf("agw/1.4.0")).toBe("agw");
    expect(knownClient("Claude Code")).toBe("claude-code");
    // Whatever a caller names itself — a key included — is not copied.
    expect(clientOf("sk-example-secret/1.0")).toBe("other");
    expect(knownClient("alice@example.com")).toBe("other");
    expect(clientOf("<script>alert(1)</script>")).toBe("other");
    expect(clientOf(undefined)).toBeNull();
    expect(clientOf("  ")).toBeNull();
    // Only a version's digits: a suffix is free text.
    expect(cliVersionOf("agw/1.4.0-beta.2")).toBe("1.4.0");
    expect(cliVersionOf("agw/1.0-sk.secret123")).toBe("1.0");
    expect(cliVersionOf("agw/latest")).toBeNull();
    expect(cliVersionOf("curl/8.7.1")).toBeNull();
    expect(versionOf("1.0+jane.smith")).toBe("1.0");
    expect(versionOf("sk-example-secret")).toBeNull();
  });

  it("records an MCP client that declares an unknown name as other, without its version", async () => {
    const { points, send } = recording();
    const owner = await account("analytics-mcp-unknown@example.test");
    const request = toolCall("list_apps", {}, key(owner.key));
    const body = JSON.parse(request.body as string);
    body.params._meta["io.modelcontextprotocol/clientInfo"] = { name: "sk-example-secret", version: "my-api-key" };
    await send("/mcp", { ...request, body: JSON.stringify(body) });
    expect(points).toEqual([expect.objectContaining({ client: "other", clientVersion: null })]);
  });
});
