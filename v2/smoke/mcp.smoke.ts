/**
 * The MCP endpoint and the CLI's tool catalog against a live v2 deployment
 * (step 2c): discovery, the bearer gate's challenge, the tool list and one
 * read tool with a management key, over MCP and over the CLI's route.
 *
 *   V2_BASE_URL=https://api.example.com \
 *   V2_CONSOLE_URL=https://console.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * The MCP checks need V2_CONSOLE_URL (MCP is served on the console's host),
 * and the tool calls need V2_MANAGEMENT_KEY. Only reads run: nothing is left
 * behind.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SMOKE_CLIENT } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const consoleUrl = process.env.V2_CONSOLE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const noConsole = consoleUrl === "" ? "V2_CONSOLE_URL is needed" : false;
const noKey = consoleUrl === "" || managementKey === "" ? "V2_CONSOLE_URL and V2_MANAGEMENT_KEY are needed" : false;

const MODERN = "2026-07-28";
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: SMOKE_CLIENT, version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const mcpUrl = () => new URL("/v2/mcp", consoleUrl);

async function rpc(method: string, params: Record<string, unknown> = {}, name?: string): Promise<{ status: number; message: any }> {
  const response = await fetch(mcpUrl(), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${managementKey}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: ENVELOPE } }),
  });
  return { status: response.status, message: await response.json() };
}

test("MCP sign-in is discoverable, and the endpoint asks for a bearer token", { skip: noConsole }, async () => {
  const origin = new URL(consoleUrl).origin;
  const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/v2/mcp", consoleUrl));
  assert.equal(metadata.status, 200);
  const document = (await metadata.json()) as Record<string, unknown>;
  assert.equal(document.resource, `${origin}/v2/mcp`);
  assert.deepEqual(document.authorization_servers, [`${origin}/v2`]);

  const refused = await fetch(mcpUrl(), {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(refused.status, 401);
  const challenge = refused.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /u);
  assert.ok(challenge.includes(`resource_metadata="${origin}/.well-known/oauth-protected-resource/v2/mcp"`), challenge);
});

test("the MCP endpoint is not served on the API host", { skip: noConsole || base === "" || new URL(base).origin === new URL(consoleUrl).origin ? "needs an API host apart from the console's" : false }, async () => {
  const response = await fetch(new URL("/v2/mcp", base), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 404);
});

test("an MCP client lists the tools and reads the account's apps", { skip: noKey }, async () => {
  const listed = await rpc("tools/list");
  assert.equal(listed.status, 200);
  const names = (listed.message.result.tools as { name: string }[]).map((tool) => tool.name);
  for (const name of ["get_account", "list_apps", "get_app", "patch_app"]) assert.ok(names.includes(name), name);

  const called = await rpc("tools/call", { name: "list_apps", arguments: {} }, "list_apps");
  assert.equal(called.status, 200);
  assert.notEqual(called.message.result.isError, true, JSON.stringify(called.message.result.content));
  assert.ok(Array.isArray(called.message.result.structuredContent.apps));
});

test("the CLI's tool list is public, and a call runs as the caller", { skip: noKey || base === "" ? "V2_BASE_URL, V2_CONSOLE_URL and V2_MANAGEMENT_KEY are needed" : false }, async () => {
  const listed = await fetch(new URL("/v2/cli/tools", base));
  assert.equal(listed.status, 200);
  const catalog = (await listed.json()) as { revision: string; tools: { name: string; cli: { command: string } }[] };
  assert.equal(catalog.tools.find((tool) => tool.name === "list_apps")?.cli.command, "app list");

  const called = await fetch(new URL("/v2/cli/tools/get_account", base), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${managementKey}` },
    body: "{}",
  });
  assert.equal(called.status, 200);
  assert.equal(called.headers.get("agw-tools-revision"), catalog.revision);
  const { result } = (await called.json()) as { result: { session: { credentialType: string } } };
  assert.equal(result.session.credentialType, "apiKey");
});
