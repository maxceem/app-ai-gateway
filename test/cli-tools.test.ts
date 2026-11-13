import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { CliToolCatalogResponseSchema } from "../src/contracts/cli";
import { CLI_HINTS } from "../src/mcp/cli-hints";
import { APP_SHORTCUTS } from "../src/mcp/shortcuts";
import { MCP_TOOLS } from "../src/mcp/tools";
import { TEST_MANAGEMENT_KEY } from "./apply-migrations";
import { seedApp, seedServerApp } from "./helpers";

/**
 * The MCP tools as `agw` builds its commands from them: the catalog at
 * `GET /v1/cli/tools`, and a tool run through `POST /v1/cli/tools/{tool}`,
 * which answers what the same `tools/call` would and refuses over HTTP.
 */

const ORIGIN = "https://example.test";

function send(path: string, init: { method?: string; key?: string; body?: unknown } = {}) {
  return worker.request(`${ORIGIN}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.key === undefined ? {} : { authorization: `Bearer ${init.key}` }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }, env);
}

async function catalog() {
  const response = await send("/v1/cli/tools");
  expect(response.status).toBe(200);
  return CliToolCatalogResponseSchema.parse(await response.json());
}

async function call(tool: string, body: Record<string, unknown>, key = TEST_MANAGEMENT_KEY) {
  const response = await send(`/v1/cli/tools/${tool}`, { key, body });
  return { response, json: (await response.json()) as any };
}

describe("the CLI tool catalog", () => {
  it("lists every tool the deployment offers, with a command and no credential needed", async () => {
    const { revision, tools } = await catalog();
    expect(revision).toMatch(/^[0-9a-f]{16}$/u);
    const offered = MCP_TOOLS.filter((tool) => tool.name !== "contact_support").map((tool) => tool.name);
    expect(tools.map((tool) => tool.name)).toEqual(offered);
    const commands = tools.map((tool) => tool.cli.command);
    expect(new Set(commands).size).toBe(commands.length);
    for (const tool of tools) {
      const properties = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
      for (const arg of tool.cli.args ?? []) expect(properties, `${tool.name} takes ${arg}`).toContain(arg);
      if (tool.cli.confirm !== undefined) {
        expect(properties, tool.name).toContain("confirm");
        expect(properties, tool.name).toContain(tool.cli.confirm);
      }
    }
  });

  it("names a command for every tool, so none falls back to `tool <name>`", () => {
    for (const tool of MCP_TOOLS) expect(CLI_HINTS[tool.name], tool.name).toBeDefined();
    expect(Object.keys(CLI_HINTS).sort()).toEqual(MCP_TOOLS.map((tool) => tool.name).sort());
  });

  it("carries patch_app's shortcuts as arguments and lists them", async () => {
    const { tools } = await catalog();
    const patch = tools.find((tool) => tool.name === "patch_app")!;
    expect(patch.cli.shortcuts).toEqual(Object.keys(APP_SHORTCUTS));
    const properties = (patch.inputSchema as { properties: Record<string, unknown>; required?: string[] }).properties;
    for (const name of Object.keys(APP_SHORTCUTS)) expect(Object.keys(properties)).toContain(name);
    expect((patch.inputSchema as { required?: string[] }).required).toEqual(["app"]);
  });

  it("keeps the same revision while nothing listed changes", async () => {
    expect((await catalog()).revision).toBe((await catalog()).revision);
  });
});

describe("a tool run for the CLI", () => {
  it("answers the tool's result and summary, and the catalog's revision", async () => {
    await seedServerApp("cli_tools_listed");
    const { revision } = await catalog();
    const { response, json } = await call("list_apps", {});
    expect(response.status).toBe(200);
    expect(response.headers.get("agw-tools-revision")).toBe(revision);
    expect(json.tool).toBe("list_apps");
    expect(json.summary).toEqual(expect.any(String));
    expect(json.result.apps.map((app: { id: string }) => app.id)).toContain("cli_tools_listed");
  });

  it("refuses without a management key", async () => {
    const response = await send("/v1/cli/tools/list_apps", { body: {} });
    expect(response.status).toBe(401);
  });

  it("refuses a tool the deployment does not have", async () => {
    const { response, json } = await call("no_such_tool", {});
    expect(response.status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });

  it("refuses with the operation's own error over HTTP", async () => {
    const { response, json } = await call("get_app", { app: "cli_tools_missing" });
    expect(response.status).toBe(404);
    expect(json.error.code).toBe("app_not_found");
  });
});

describe("patch_app shortcuts", () => {
  it("change the settings they name without a revision, and nothing else", async () => {
    await seedApp("clitoolsios");
    const before = (await call("get_app", { app: "clitoolsios" })).json.result.app;
    const { response, json } = await call("patch_app", {
      app: "clitoolsios",
      name: "Renamed by a shortcut",
      team_id: "BBBBBBBBBB",
      verify_on: "token_exchange",
    });
    expect(response.status, JSON.stringify(json)).toBe(200);
    const after = json.result.app;
    expect(after.name).toBe("Renamed by a shortcut");
    expect(after.revision).toBe(before.revision + 1);
    expect(after.config.authentication.app_attest.team_id).toBe("BBBBBBBBBB");
    expect(after.config.authentication.app_attest.verify_on).toBe("token_exchange");
    expect(after.config.routing).toEqual(before.config.routing);
    expect(after.config.limits).toEqual(before.config.limits);
  });

  it("select providers, keeping what a provider already selected allows", async () => {
    await seedApp("clitoolsselect");
    const before = (await call("get_app", { app: "clitoolsselect" })).json.result.app;
    const selected = Object.keys(before.config.routing.providers.selected ?? {});
    const kept = selected[0] ?? "openai";
    const { response, json } = await call("patch_app", { app: "clitoolsselect", providers: [kept] });
    expect(response.status, JSON.stringify(json)).toBe(200);
    const providers = json.result.app.config.routing.providers;
    expect(providers.mode).toBe("selected");
    expect(Object.keys(providers.selected)).toEqual([kept]);
    if (before.config.routing.providers.mode === "selected") {
      expect(providers.selected[kept]).toEqual(before.config.routing.providers.selected[kept]);
    }
  });

  it("refuse an iOS setting on a server app by its argument's name", async () => {
    await seedServerApp("cli_tools_server");
    const { response, json } = await call("patch_app", { app: "cli_tools_server", team_id: "BBBBBBBBBB" });
    expect(response.status).toBe(400);
    expect(json.error.code).toBe("invalid_request");
    expect(json.error.message).toMatch(/^team_id: /u);
  });

  it("refuse providers and all_providers together", async () => {
    await seedServerApp("cli_tools_both");
    const { response, json } = await call("patch_app", { app: "cli_tools_both", providers: ["openai"], all_providers: true });
    expect(response.status).toBe(400);
    expect(json.error.message).toMatch(/^providers: /u);
  });

  it("refuse a value their schema does not take", async () => {
    await seedServerApp("cli_tools_value");
    const { response, json } = await call("patch_app", { app: "cli_tools_value", status: "paused" });
    expect(response.status).toBe(400);
    expect(json.error.code).toBe("invalid_request");
  });

  it("leave operations needing the revision they were written against", async () => {
    await seedServerApp("cli_tools_operations");
    const { response, json } = await call("patch_app", {
      app: "cli_tools_operations",
      operations: [{ op: "replace", path: "/name", value: "x" }],
    });
    expect(response.status).toBe(400);
    expect(json.error.code).toBe("app_revision_required");
  });
});
