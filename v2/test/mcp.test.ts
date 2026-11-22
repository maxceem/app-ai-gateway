/**
 * Step 2c: the MCP endpoint (`/v2/mcp`) and the CLI's tool catalog
 * (`/v2/cli/tools`). The bearer gate, the host and origin rules, the tool
 * table's allowlist, tools running as their management operations, secrets
 * kept out of arguments and results, and the CLI's list and calls.
 *
 * Driven with plain JSON-RPC requests through the Worker, the way a client
 * sends them, so what is tested is the wire rather than an SDK client's view.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { CLI_CLIENT_ID } from "../src/auth/identity.ts";
import { OAUTH_PATHS } from "../src/management/oauth-routes.ts";
import { MCP_READ_OPERATIONS, MCP_TOOLS, MCP_WRITE_OPERATIONS } from "../src/mcp/tools.ts";
import { LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedHuman, seedManagementKey } from "./helpers.ts";

const CONSOLE = "https://console.gateway.test";
const API = "https://gateway.test";
const MODERN = "2026-07-28";

beforeAll(async () => {
  await loadManagement();
  // The MCP SDK and the tool table load on the first MCP call that gets past the bearer gate.
  await rpc(await seedManagementKey(), "tools/list");
}, LOAD_MANAGEMENT_TIMEOUT_MS);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

/** What a 2026-07-28 client puts in every request's `_meta`. */
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "mcp-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface Sent {
  method?: string;
  base?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** A form body, for the OAuth endpoints. */
  form?: Record<string, string>;
  environment?: Env;
}

let nextId = 1;

async function send({ method = "POST", base = CONSOLE, path = "/v2/mcp", headers = {}, body, form, environment = env }: Sent): Promise<Response> {
  const ctx = createExecutionContext();
  const contentType = form !== undefined ? "application/x-www-form-urlencoded" : body !== undefined ? "application/json" : undefined;
  const payload = form !== undefined ? new URLSearchParams(form).toString() : body !== undefined ? JSON.stringify(body) : undefined;
  const response = await worker.fetch(
    new Request(`${base}${path}`, {
      method,
      headers: {
        accept: "application/json, text/event-stream",
        ...(contentType === undefined ? {} : { "content-type": contentType }),
        ...headers,
      },
      ...(payload === undefined ? {} : { body: payload }),
    }),
    environment,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

async function rpc(key: string, method: string, params: Record<string, unknown> = {}, name?: string) {
  const response = await send({
    headers: {
      ...bearer(key),
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: { jsonrpc: "2.0", id: nextId++, method, params: { ...params, _meta: ENVELOPE } },
  });
  return { status: response.status, headers: response.headers, message: (await response.json()) as { result?: any; error?: { code: number; message: string } } };
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: any;
}

async function callTool(key: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const { status, message } = await rpc(key, "tools/call", { name, arguments: args }, name);
  expect(status, JSON.stringify(message)).toBe(200);
  expect(message.error, JSON.stringify(message.error)).toBeUndefined();
  return message.result as ToolResult;
}

/** A management API call, as a person's script would make it. */
async function admin(key: string, method: string, path: string, body?: unknown) {
  const response = await send({ method, base: API, path, headers: bearer(key), body });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const SECRET = "sk-live-secret-mcp-abcd";

/** A provider connection and an app-key app that routes to it. */
async function populated(key: string) {
  const slug = `openai-${crypto.randomUUID().slice(0, 6)}`;
  const provider = await admin(key, "POST", "/v2/admin/providers", { type: "openai", name: "OpenAI", slug, secret: SECRET });
  expect(provider.status).toBe(201);
  const app = await admin(key, "POST", "/v2/admin/apps", {
    name: "MCP app",
    config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: {} } },
  });
  expect(app.status).toBe(201);
  return { provider: provider.body.provider as { id: string; slug: string; revision: number }, app: app.body.app as { id: string; revision: number } };
}

describe("the tool table", () => {
  it("runs only allowlisted operations, marks every read as reading, and never names a secret-bearing one", () => {
    const reads: readonly string[] = MCP_READ_OPERATIONS;
    const writes: readonly string[] = MCP_WRITE_OPERATIONS;
    for (const tool of MCP_TOOLS) {
      for (const operation of tool.operations) expect(reads.includes(operation) || writes.includes(operation), `${tool.name}: ${operation}`).toBe(true);
      const reading = tool.operations.every((operation) => reads.includes(operation));
      expect(tool.annotations.readOnlyHint, tool.name).toBe(reading);
    }
    for (const secretBearing of ["createApp", "createAppKey", "createProvider", "testProvider", "createManagementKey"]) {
      expect([...reads, ...writes]).not.toContain(secretBearing);
    }
    expect(new Set(MCP_TOOLS.map((tool) => tool.name)).size).toBe(MCP_TOOLS.length);
    expect(new Set(MCP_TOOLS.map((tool) => tool.cli.command)).size).toBe(MCP_TOOLS.length);
  });
});

describe("the MCP endpoint", () => {
  it("lists the tools and runs one as its management operation", async () => {
    const key = await seedManagementKey();
    const { app } = await populated(key);
    const listed = await rpc(key, "tools/list");
    expect(listed.status).toBe(200);
    const names = (listed.message.result.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(MCP_TOOLS.map((tool) => tool.name));

    const apps = await callTool(key, "list_apps");
    expect(apps.isError ?? false).toBe(false);
    expect(apps.structuredContent.apps.map((entry: { id: string }) => entry.id)).toContain(app.id);
    expect(apps.content[0]!.text).toContain(app.id);
  });

  it("asks for a bearer token, naming its protected resource metadata", async () => {
    const response = await send({ body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate")!;
    expect(challenge).toContain('realm="management"');
    expect(challenge).toContain(`resource_metadata="${CONSOLE}/.well-known/oauth-protected-resource/v2/mcp"`);
    expect(((await response.json()) as { jsonrpc: string }).jsonrpc).toBe("2.0");

    const metadata = await send({ method: "GET", path: OAUTH_PATHS.protectedResourceMetadata[1].path });
    expect(((await metadata.json()) as { resource: string }).resource).toBe(`${CONSOLE}/v2/mcp`);

    const wrong = await send({ headers: bearer("agw_mgmt_not-a-real-key"), body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain('error="invalid_token"');
    // A cookie is never a credential here.
    const human = await seedHuman();
    const cookie = await send({ headers: { cookie: human.cookie }, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    expect(cookie.status).toBe(401);
  });

  it("answers only on the console's host, and only to browser origins it lists", async () => {
    const key = await seedManagementKey();
    const request = { headers: bearer(key), body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } };
    expect((await send({ ...request, base: API })).status).toBe(404);
    expect((await send({ ...request, headers: { ...request.headers, origin: "https://evil.test" } })).status).toBe(403);
    const listed = { ...env, MCP_ALLOWED_ORIGINS: "https://inspector.test" } as Env;
    const preflight = await send({ method: "OPTIONS", headers: { origin: "https://inspector.test" }, environment: listed });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://inspector.test");
    const refused = await send({ headers: { origin: "https://inspector.test" }, body: request.body, environment: listed });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
  });

  it("without a console origin, answers on any secure host and 503 on an insecure one, as v1", async () => {
    const key = await seedManagementKey();
    const unset = { ...env, CONSOLE_ORIGIN: undefined } as unknown as Env;
    const request = { headers: bearer(key), body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, environment: unset };
    expect((await send({ ...request, base: API })).status).toBe(200);
    const insecure = await send({ ...request, base: "http://gateway.example.test" });
    expect(insecure.status).toBe(503);
    expect(((await insecure.json()) as { error: { message: string } }).error.message).toBe("Configure a secure console origin");
  });

  it("answers 503 when CONSOLE_ORIGIN is set but not valid, rather than serving every host, as v1", async () => {
    const key = await seedManagementKey();
    const invalid = { ...env, CONSOLE_ORIGIN: "http://console.example.com" } as unknown as Env;
    const response = await send({ base: API, headers: bearer(key), body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, environment: invalid });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe("Configure a secure console origin");
  });

  it("works with a CLI or MCP sign-in, bound to the account the person picked", async () => {
    const started = await send({ path: OAUTH_PATHS.deviceAuthorization, form: { client_id: CLI_CLIENT_ID, scope: "read" } });
    const { device_code, user_code } = (await started.json()) as { device_code: string; user_code: string };
    const human = await seedHuman();
    const asConsole = (path: string, json: unknown) =>
      send({ path, headers: { cookie: human.cookie, "x-console-request": "1", origin: CONSOLE }, body: json });
    const { id } = (await (await asConsole("/v2/console/device/lookup", { userCode: user_code })).json()) as { id: string };
    expect((await asConsole(`/v2/console/device/${id}/approve`, { userCode: user_code, accountId: human.accountId, grant: "read" })).status).toBe(200);
    // As a CLI would, after waiting the polling interval.
    await env.DB.prepare("UPDATE mgmt_operation SET updated_at = updated_at - 60000 WHERE id LIKE 'oauth-device-%'").run();
    const issued = await send({
      path: OAUTH_PATHS.token,
      form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id: CLI_CLIENT_ID },
    });
    const { access_token } = (await issued.json()) as { access_token: string };

    const account = await callTool(access_token, "get_account");
    expect(account.structuredContent.session.account.id).toBe(human.accountId);
    expect(account.structuredContent.session.grant).toBe("read");
    // The read grant reaches no change.
    const blocked = await callTool(access_token, "remove_app", { app: "anything", confirm: "anything" });
    expect(blocked.isError).toBe(true);
  });
});

describe("usage reads with a read grant", () => {
  it("reach an account's usage and charges through MCP and the CLI's tools with a CLI sign-in's read grant (Sol 7b-3 round 1)", async () => {
    const started = await send({ path: OAUTH_PATHS.deviceAuthorization, form: { client_id: CLI_CLIENT_ID, scope: "read" } });
    const { device_code, user_code } = (await started.json()) as { device_code: string; user_code: string };
    const human = await seedHuman();
    const asConsole = (path: string, json: unknown) =>
      send({ path, headers: { cookie: human.cookie, "x-console-request": "1", origin: CONSOLE }, body: json });
    const { id } = (await (await asConsole("/v2/console/device/lookup", { userCode: user_code })).json()) as { id: string };
    expect((await asConsole(`/v2/console/device/${id}/approve`, { userCode: user_code, accountId: human.accountId, grant: "read" })).status).toBe(200);
    await env.DB.prepare("UPDATE mgmt_operation SET updated_at = updated_at - 60000 WHERE id LIKE 'oauth-device-%'").run();
    const issued = await send({
      path: OAUTH_PATHS.token,
      form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id: CLI_CLIENT_ID },
    });
    const { access_token } = (await issued.json()) as { access_token: string };

    // One app of the person's account, with one charge.
    const appId = `reads-${crypto.randomUUID().slice(0, 8)}`;
    const usedAt = Date.parse("2025-10-15T12:00:00Z");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO app (id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, 'Reads', '{}', 1, 'active', 0, 0)",
      ).bind(appId, human.accountId),
      env.DB.prepare(
        `INSERT INTO charge (id, kind, account_id, app_id, owner_type, owner_id, provider_type, operation, model, status, cost_nano,
           measured, price_source, measures_json, used_at, usage_day, written_at)
         VALUES (?, 'attempt', ?, ?, 'call', ?, 'openai', 'openai.chat', 'gpt-4o-mini', 'ok', 2500, 'complete', 'list_rate', '{}', ?, '2025-10-15', ?)`,
      ).bind(`ch_${crypto.randomUUID().slice(0, 8)}`, human.accountId, appId, `call_${crypto.randomUUID().slice(0, 8)}`, usedAt, usedAt),
    ]);

    // Through MCP.
    const usage = await callTool(access_token, "get_usage", { app: appId, month: "2025-10" });
    expect(usage.isError).not.toBe(true);
    expect(usage.structuredContent).toMatchObject({ app_id: appId, charges: 1, cost_nano: 2500 });
    const charges = await callTool(access_token, "list_app_charges", { app: appId });
    expect(charges.structuredContent.charges).toHaveLength(1);
    // Through the CLI's tool route.
    const viaCli = await send({ base: API, path: "/v2/cli/tools/get_usage", headers: bearer(access_token), body: { month: "2025-10" } });
    expect(viaCli.status).toBe(200);
    const body = (await viaCli.json()) as { result: { apps: { app_id: string; charges: number }[] } };
    expect(body.result.apps).toEqual([expect.objectContaining({ app_id: appId, charges: 1 })]);

    // The diagnostics reads take the same read grant (step 7b-4).
    await env.DB.prepare(
      "INSERT INTO app_auth_event (id, app_id, account_id, event, outcome, created_at) VALUES (?, ?, ?, 'token_exchange', 'ok', ?)",
    )
      .bind(`ae_${crypto.randomUUID().slice(0, 8)}`, appId, human.accountId, Date.now())
      .run();
    const attempts = await callTool(access_token, "list_auth_events", { app: appId });
    expect(attempts.isError).not.toBe(true);
    expect(attempts.structuredContent.events).toHaveLength(1);
    const summary = await callTool(access_token, "get_auth_event_summary", { app: appId });
    expect(summary.structuredContent.token_exchange).toMatchObject({ total: 1, ok: 1 });
    const refusals = await send({ base: API, path: "/v2/cli/tools/list_rejection_events", headers: bearer(access_token), body: { app: appId } });
    expect(refusals.status).toBe(200);
  });
});

describe("tools", () => {
  it("refuse a change the credential's grant does not allow, with what to do next", async () => {
    const owner = await seedManagementKey();
    const { app } = await populated(owner);
    const reader = await seedManagementKey({ grant: "read" });
    const refused = await callTool(reader, "patch_app", { app: app.id, revision: app.revision, operations: [{ op: "replace", path: "/name", value: "X" }] });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ error: "grant_insufficient", status: 403 });
    expect(refused.structuredContent.next).toContain("manage grant");
  });

  it("refuse a credential-named argument without echoing it, and an argument the tool does not take", async () => {
    const key = await seedManagementKey();
    const { provider } = await populated(key);
    const withSecret = await callTool(key, "update_provider", { id: provider.id, revision: provider.revision, secret: "sk-new-secret-value" });
    expect(withSecret.isError).toBe(true);
    expect(withSecret.structuredContent.error).toBe("invalid_request");
    expect(JSON.stringify(withSecret)).not.toContain("sk-new-secret-value");
    const nested = await callTool(key, "validate_app", { config: { name: "x", config: { routing: { api_key: "sk-nested" } } } });
    expect(nested.structuredContent.message).toContain("config.config.routing.api_key");
    expect(JSON.stringify(nested)).not.toContain("sk-nested");
    const unknown = await callTool(key, "list_apps", { filter: "x" });
    expect(unknown.structuredContent).toMatchObject({ error: "invalid_request" });
    expect(unknown.structuredContent.message).toContain("filter");
  });

  it("refuse a patch that writes a setting named like a credential, without echoing the value", async () => {
    const key = await seedManagementKey();
    const { app } = await populated(key);
    for (const operation of [
      { op: "add", path: "/config/routing/apiKey", value: "sk-patched-in" },
      { op: "replace", path: "/config/routing/api_key", value: "sk-patched-in" },
      { op: "add", path: "/config/routing/Access-Token", value: "sk-patched-in" },
    ]) {
      const refused = await callTool(key, "patch_app", { app: app.id, revision: app.revision, operations: [operation] });
      expect(refused.structuredContent.error, operation.path).toBe("invalid_request");
      expect(refused.structuredContent.message).toContain("operations.0.path");
      expect(refused.structuredContent.message).toContain("credentials");
      expect(JSON.stringify(refused)).not.toContain("sk-patched-in");
    }
    expect((await admin(key, "GET", `/v2/admin/apps/${app.id}`)).body.app.revision).toBe(app.revision);
  });

  it("never return a key, and find a provider connection by slug", async () => {
    const key = await seedManagementKey();
    const { provider } = await populated(key);
    const found = await callTool(key, "get_provider", { provider: provider.slug });
    expect(found.structuredContent.provider.id).toBe(provider.id);
    expect(found.structuredContent.provider.secretHint).toBe("abcd");
    expect(JSON.stringify(found)).not.toContain(SECRET);
    const missing = await callTool(key, "get_provider", { provider: "pasted-key-value-1234" });
    expect(missing.structuredContent.error).toBe("provider_not_found");
    expect(JSON.stringify(missing)).not.toContain("pasted-key-value-1234");
  });

  it("refuse a path argument of . or .., which a URL would fold into another route", async () => {
    const key = await seedManagementKey();
    for (const app of [".", ".."]) {
      const refused = await callTool(key, "get_app", { app });
      expect(refused.structuredContent, app).toMatchObject({ error: "invalid_request", message: "app: not a valid id" });
    }
    const user = await callTool(key, "get_app_user", { app: "any", user: ".." });
    expect(user.structuredContent).toMatchObject({ error: "invalid_request", message: "user: not a valid id" });
  });

  it("change an app with a patch, and delete only with confirm", async () => {
    const key = await seedManagementKey();
    const { app } = await populated(key);
    const patched = await callTool(key, "patch_app", { app: app.id, revision: app.revision, operations: [{ op: "replace", path: "/name", value: "Renamed" }] });
    expect(patched.isError ?? false).toBe(false);
    expect(patched.structuredContent.app).toMatchObject({ name: "Renamed", revision: app.revision + 1 });
    const stale = await callTool(key, "patch_app", { app: app.id, revision: app.revision, operations: [{ op: "replace", path: "/name", value: "Again" }] });
    expect(stale.structuredContent.error).toBe("app_revision_conflict");
    expect(stale.structuredContent.next).toContain("get_app");

    const unconfirmed = await callTool(key, "remove_app", { app: app.id, confirm: "other" });
    expect(unconfirmed.structuredContent.error).toBe("invalid_request");
    expect((await admin(key, "GET", `/v2/admin/apps/${app.id}`)).status).toBe(200);
    const removed = await callTool(key, "remove_app", { app: app.id, confirm: app.id });
    expect(removed.structuredContent).toMatchObject({ deleted: true, app_id: app.id });
    expect((await admin(key, "GET", `/v2/admin/apps/${app.id}`)).status).toBe(404);
  });

  it("validate a new app's document, and a refusal names what is wrong", async () => {
    const key = await seedManagementKey();
    const draft = await callTool(key, "validate_app", {
      config: { name: "Draft", config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: {} } } },
    });
    expect(draft.isError ?? false).toBe(false);
    expect(draft.content[0]!.text).toContain("new app");
    const bad = await callTool(key, "validate_app", { config: { name: "Draft", config: { authentication: { type: "nope" } } } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error).toBe("invalid_request");
  });
});

describe("the CLI's tool catalog", () => {
  it("lists the tools without a credential, with a revision and a guard per tool", async () => {
    const response = await send({ method: "GET", base: API, path: "/v2/cli/tools" });
    expect(response.status).toBe(200);
    const catalog = (await response.json()) as { revision: string; tools: { name: string; guard: string; cli: { command: string }; inputSchema: Record<string, unknown> }[] };
    expect(catalog.revision).toMatch(/^[0-9a-f]{16}$/u);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    const show = catalog.tools.find((tool) => tool.name === "get_app")!;
    expect(show.cli.command).toBe("app show");
    expect(show.inputSchema).toMatchObject({ type: "object", required: ["app"] });
  });

  it("runs a tool as the caller, and refuses a changed or unknown tool with the revision", async () => {
    const key = await seedManagementKey();
    const { app } = await populated(key);
    const { revision, tools } = (await (await send({ method: "GET", base: API, path: "/v2/cli/tools" })).json()) as { revision: string; tools: { name: string; guard: string }[] };
    const guard = tools.find((tool) => tool.name === "get_app")!.guard;
    const called = await send({ base: API, path: "/v2/cli/tools/get_app", headers: { ...bearer(key), "agw-tool-guard": guard }, body: { app: app.id } });
    expect(called.status).toBe(200);
    expect(called.headers.get("agw-tools-revision")).toBe(revision);
    expect(((await called.json()) as { result: { app: { id: string } } }).result.app.id).toBe(app.id);

    const changed = await send({ base: API, path: "/v2/cli/tools/get_app", headers: { ...bearer(key), "agw-tool-guard": "000000000000" }, body: { app: app.id } });
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { error: { code: string } }).error.code).toBe("tool_changed");
    const unknown = await send({ base: API, path: "/v2/cli/tools/nope", headers: bearer(key), body: {} });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("agw-tools-revision")).toBe(revision);
    const missing = await send({ base: API, path: "/v2/cli/tools/get_app", headers: bearer(key), body: { app: "nope" } });
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("app_not_found");
    expect((await send({ base: API, path: "/v2/cli/tools/list_apps", body: {} })).status).toBe(401);
  });
});
