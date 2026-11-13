import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { CliToolCatalogResponseSchema } from "../src/contracts/cli";
import { CLI_HINTS } from "../src/mcp/cli-hints";
import { APP_SHORTCUTS } from "../src/mcp/shortcuts";
import { hiddenNote } from "../src/mcp/run";
import { REDACTED, redactSecrets } from "../src/mcp/secret-fields";
import { MCP_TOOLS } from "../src/mcp/tools";
import { seedAllProviders, seedApp, seedHuman, seedServerApp } from "./helpers";

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

/**
 * An account of its own, with its providers and a management key made in the
 * console: other files share the test account, and leave apps in it this
 * file's listings must not depend on.
 */
async function account(email: string, grant: "manage" | "read" = "manage") {
  const human = await seedHuman(email);
  await seedAllProviders(human.organizationId);
  const created = await worker.request(`${ORIGIN}/v1/admin/keys`, {
    method: "POST",
    headers: { cookie: human.cookie, "x-console-request": "1", "content-type": "application/json" },
    body: JSON.stringify({ name: "CLI tools", grant }),
  }, env);
  expect(created.status).toBe(201);
  const { key } = await created.json<{ key: { plaintext: string } }>();
  return { organizationId: human.organizationId, key: key.plaintext, cookie: human.cookie };
}

let owner: Awaited<ReturnType<typeof account>> | undefined;

async function call(tool: string, body: Record<string, unknown>, key?: string) {
  owner ??= await account("cli-tools-owner@example.com");
  const response = await send(`/v1/cli/tools/${tool}`, { key: key ?? owner.key, body });
  return { response, json: (await response.json()) as any };
}

async function organization(): Promise<string> {
  owner ??= await account("cli-tools-owner@example.com");
  return owner.organizationId;
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

  it("gives every argument a flag of its own that no flag of every command shadows", async () => {
    const { tools } = await catalog();
    const flag = (name: string) => name.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").replace(/_/gu, "-").toLowerCase();
    for (const tool of tools) {
      const flags = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {}).map(flag);
      expect(new Set(flags).size, tool.name).toBe(flags.length);
      for (const shared of ["json", "no-input", "yes", "help", "input"]) expect(flags, tool.name).not.toContain(shared);
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
    await seedServerApp("cli_tools_listed", { organizationId: await organization() });
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

  it("refuses a tool the deployment does not have, with a code of its own and the revision", async () => {
    const { revision } = await catalog();
    const { response, json } = await call("no_such_tool", {});
    expect(response.status).toBe(404);
    expect(json.error.code).toBe("tool_not_found");
    expect(response.headers.get("agw-tools-revision")).toBe(revision);
  });

  it("applies the tool's own operation policy to the key", async () => {
    const reader = await account("cli-tools-reader@example.com", "read");
    await seedServerApp("cli_tools_readable", { organizationId: reader.organizationId });
    const listed = await call("list_apps", {}, reader.key);
    expect(listed.response.status).toBe(200);
    const refused = await call("patch_app", { app: "cli_tools_readable", name: "Not allowed" }, reader.key);
    expect(refused.response.status).toBe(403);
    expect(refused.json.error.code).toBe("grant_insufficient");
  });

  it("refuses with the operation's own error over HTTP, carrying the revision", async () => {
    const { revision } = await catalog();
    const { response, json } = await call("get_app", { app: "cli_tools_missing" });
    expect(response.status).toBe(404);
    expect(json.error.code).toBe("app_not_found");
    expect(response.headers.get("agw-tools-revision")).toBe(revision);
  });
});

describe("values a tool hides", () => {
  it("are named in the summary, with what still works", () => {
    const hidden: string[] = [];
    const shown = redactSecrets({ app: { config: { endpoints: { chat: { params: { api_key: "sk-1", temperature: 0 } } } } } }, [], [], hidden);
    expect(shown.app.config.endpoints.chat.params).toEqual({ api_key: REDACTED, temperature: 0 });
    expect(hidden).toEqual(["app.config.endpoints.chat.params.api_key"]);
    const note = hiddenNote(hidden);
    expect(note).toContain("app.config.endpoints.chat.params.api_key");
    expect(note).toContain("patch_app");
    expect(note).toContain("update_app refuses");
  });

  it("sent back as shown are refused with what to do instead", async () => {
    await seedServerApp("cli_tools_redacted", { organizationId: await organization() });
    const { app } = (await call("get_app", { app: "cli_tools_redacted" })).json.result;
    const { response, json } = await call("update_app", {
      app: "cli_tools_redacted",
      config: {
        name: app.name,
        status: app.status,
        revision: app.revision,
        config: { ...app.config, endpoints: { chat: { provider: "openai", model: "gpt-x", api_style: "responses", params: { api_key: REDACTED } } } },
      },
    });
    expect(response.status).toBe(400);
    expect(json.error.message).toMatch(/still \[redacted\], as it was shown/u);
    expect(json.error.message).toContain("patch_app");
  });
});

describe("patch_app shortcuts", () => {
  it("change the settings they name without a revision, and nothing else", async () => {
    await seedApp("clitoolsios", { organizationId: await organization() });
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
    await seedApp("clitoolsselect", { organizationId: await organization() });
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

  it("apply after explicit operations, reading the document those leave", async () => {
    await seedServerApp("cli_tools_after", { organizationId: await organization() });
    const all = await call("patch_app", { app: "cli_tools_after", all_providers: true });
    expect(all.response.status, JSON.stringify(all.json)).toBe(200);
    const { response, json } = await call("patch_app", {
      app: "cli_tools_after",
      revision: all.json.result.app.revision,
      operations: [{
        op: "replace",
        path: "/config/routing/providers",
        value: { mode: "selected", selected: { openai: { allowed_paths: [], allowed_models: [] } } },
      }],
      all_providers: true,
    });
    expect(response.status, JSON.stringify(json)).toBe(200);
    expect(json.result.app.config.routing.providers).toEqual({ mode: "all" });
  });

  it("read a document the operations left unfinished without failing", async () => {
    await seedServerApp("cli_tools_unfinished", { organizationId: await organization() });
    const before = (await call("get_app", { app: "cli_tools_unfinished" })).json.result.app;
    const { response, json } = await call("patch_app", {
      app: "cli_tools_unfinished",
      revision: before.revision,
      operations: [{ op: "replace", path: "/config/routing/providers", value: null }],
      all_providers: true,
    });
    expect(response.status, JSON.stringify(json)).toBe(200);
    expect(json.result.app.config.routing.providers).toEqual({ mode: "all" });
  });

  it("refuse an iOS setting on a server app by its argument's name", async () => {
    await seedServerApp("cli_tools_server", { organizationId: await organization() });
    const { response, json } = await call("patch_app", { app: "cli_tools_server", team_id: "BBBBBBBBBB" });
    expect(response.status).toBe(400);
    expect(json.error.code).toBe("invalid_request");
    expect(json.error.message).toMatch(/^team_id: /u);
  });

  it("refuse providers and all_providers together", async () => {
    await seedServerApp("cli_tools_both", { organizationId: await organization() });
    const { response, json } = await call("patch_app", { app: "cli_tools_both", providers: ["openai"], all_providers: true });
    expect(response.status).toBe(400);
    expect(json.error.message).toMatch(/^providers: /u);
  });

  it("refuse a value their schema does not take", async () => {
    await seedServerApp("cli_tools_value", { organizationId: await organization() });
    const { response, json } = await call("patch_app", { app: "cli_tools_value", status: "paused" });
    expect(response.status).toBe(400);
    expect(json.error.code).toBe("invalid_request");
  });

  it("leave operations needing the revision they were written against", async () => {
    await seedServerApp("cli_tools_operations", { organizationId: await organization() });
    const { response, json } = await call("patch_app", {
      app: "cli_tools_operations",
      operations: [{ op: "replace", path: "/name", value: "x" }],
    });
    expect(response.status).toBe(400);
    expect(json.error.code).toBe("app_revision_required");
  });
});
