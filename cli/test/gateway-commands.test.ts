import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CATALOG_TTL_MS, findTool, ToolCatalog, type CachedCatalog, type CliTool } from "../src/catalog.ts";
import { CliError } from "../src/common.ts";
import { flagsIn } from "../src/gateway-commands.ts";
import { main, MemoryCatalogCache } from "../src/main.ts";
import { plain, style } from "../src/style.ts";
import { fieldsOf, flagName, readInvocation } from "../src/tool-args.ts";
import { clean, humanToolResult, mentions, toolHelp } from "../src/tool-output.ts";
import type { RequestOptions } from "../src/transport.ts";
import { cliTool, fresh, hasCode, makeStore } from "./helpers.ts";

/**
 * The commands this CLI builds from the gateway's tool list: how a command
 * line is read against a tool's input schema, how the list is kept and
 * refreshed, how a result looks, and how a run goes end to end.
 */

const PATCH = cliTool(
  "patch_app",
  { command: "app update", args: ["app"], shortcuts: ["name", "team_id", "providers", "all_providers"] },
  {
    properties: {
      app: { type: "string", description: "The app's id, as list_apps returns it." },
      revision: { type: "integer" },
      operations: { type: "array", items: { type: "object" } },
      name: { type: "string" },
      team_id: { type: "string" },
      providers: { type: "array", items: { type: "string" } },
      all_providers: { type: "boolean", const: true },
      status: { type: "string", enum: ["active", "disabled"] },
      limit: { anyOf: [{ type: "number" }, { type: "null" }] },
    },
    required: ["app"],
  },
  { readOnlyHint: false },
);

const LIST = cliTool("list_apps", {
  command: "app list",
  view: { rows: "apps", columns: ["id", "name", "status"] },
});

const REMOVE = cliTool(
  "remove_app",
  { command: "app remove", args: ["app"], confirm: "app" },
  { properties: { app: { type: "string" }, confirm: { type: "string" } }, required: ["app", "confirm"] },
  { readOnlyHint: false, destructiveHint: true },
);

const noStdin = async () => assert.fail("standard input is not read");

test("input fields become flags, kebab-cased, positional where the gateway says", () => {
  assert.equal(flagName("team_id"), "team-id");
  assert.equal(flagName("fromDate"), "from-date");
  const fields = fieldsOf(PATCH);
  assert.deepEqual(fields.slice(0, 1).map((field) => [field.name, field.positional]), [["app", true]]);
  // Shortcuts come first after the arguments, in the order they were listed.
  assert.deepEqual(fields.slice(1, 5).map((field) => field.name), ["name", "team_id", "providers", "all_providers"]);
  const kinds = Object.fromEntries(fields.map((field) => [field.name, field.kind]));
  assert.deepEqual(kinds, {
    app: "string",
    name: "string",
    team_id: "string",
    providers: "list",
    all_providers: "boolean",
    revision: "integer",
    operations: "json",
    status: "string",
    limit: "number",
  });
  assert.deepEqual(fields.find((field) => field.name === "status")?.choices, ["active", "disabled"]);
});

test("a command line is read by the schema: numbers, lists, switches, JSON and positional arguments", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-tool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "operations.json");
  await writeFile(file, JSON.stringify([{ op: "replace", path: "/name", value: "x" }]));
  const read = await readInvocation(
    PATCH,
    ["app-1", "--revision", "3", "--providers", "openai", "--providers", "claude", "--all-providers", `--operations=@${file}`, "--team-id", "ABCDE12345", "--json"],
    noStdin,
  );
  assert.deepEqual(read.input, {
    app: "app-1",
    revision: 3,
    providers: ["openai", "claude"],
    all_providers: true,
    operations: [{ op: "replace", path: "/name", value: "x" }],
    team_id: "ABCDE12345",
  });
  assert.equal(read.json, true);
  // A value that is not a number is sent as typed, for the gateway to refuse in its words.
  assert.equal((await readInvocation(PATCH, ["app-1", "--revision", "three"], noStdin)).input.revision, "three");
  // A JSON array is the whole list at once; otherwise values may be comma-separated.
  assert.deepEqual((await readInvocation(PATCH, ["app-1", "--providers", '["a","b"]'], noStdin)).input.providers, ["a", "b"]);
  assert.deepEqual((await readInvocation(PATCH, ["app-1", "--providers", "a, b", "--providers", "c"], noStdin)).input.providers, ["a", "b", "c"]);
  // A value starting with a bracket that is not JSON is a value.
  assert.deepEqual((await readInvocation(PATCH, ["app-1", "--providers", "[beta]"], noStdin)).input.providers, ["[beta]"]);
  // --input gives every argument at once; flags and arguments override it.
  const merged = await readInvocation(PATCH, ["app-2", "--input", '{"app":"app-1","name":"From input","revision":2}', "--name", "From flag"], noStdin);
  assert.deepEqual(merged.input, { app: "app-2", name: "From flag", revision: 2 });
  assert.deepEqual((await readInvocation(PATCH, ["--input", "@-"], async () => '{"app":"a"}')).input, { app: "a" });
});

test("a command line the schema cannot read is refused before anything is sent", async () => {
  await assert.rejects(() => readInvocation(PATCH, ["app-1", "--color", "red"], noStdin), hasCode("unknown_flag"));
  await assert.rejects(() => readInvocation(PATCH, ["app-1", "extra"], noStdin), hasCode("invalid_arguments"));
  await assert.rejects(() => readInvocation(PATCH, ["app-1", "--name"], noStdin), hasCode("missing_value"));
  await assert.rejects(() => readInvocation(PATCH, ["app-1", "--name", "a", "--name", "b"], noStdin), hasCode("duplicate_flag"));
  await assert.rejects(() => readInvocation(PATCH, ["app-1", "--operations", "{nope"], noStdin), hasCode("invalid_input"));
  await assert.rejects(() => readInvocation(PATCH, ["--input", "[1]"], noStdin), hasCode("invalid_input"));
  assert.equal((await readInvocation(PATCH, ["--help"], noStdin)).help, true);
});

test("a command resolves to the longest tool command, and a built-in command always wins", () => {
  const user = cliTool("get_app_user", { command: "app user show", args: ["app", "user"] });
  const show = cliTool("get_app", { command: "app show", args: ["app"] });
  const tools = [show, user, LIST];
  assert.equal(findTool(tools, ["app", "user", "show", "a", "u"], () => false)?.name, "get_app_user");
  assert.equal(findTool(tools, ["app", "show", "a"], () => false)?.name, "get_app");
  assert.equal(findTool(tools, ["app", "show", "a"], (command) => command === "app show"), undefined);
  assert.equal(findTool(tools, ["app"], () => false), undefined);
});

/** A gateway that serves a tool list and answers its tools, counting what it was asked. */
function gateway(options: {
  tools?: CliTool[];
  revision?: string;
  answer?: (tool: string, body: Record<string, unknown>) => unknown;
  /** The revision every tool call answers with in its header. */
  callRevision?: string;
  missing?: boolean;
  offline?: boolean;
  /** A refusal for one call, sent with the list's revision as every answer is. */
  refuse?: (tool: string, body: Record<string, unknown>) => CliError | undefined;
  /** The list request fails as a broken gateway's would. */
  broken?: boolean;
  /** Entries listed beside the tools, as a newer gateway might write them. */
  extra?: unknown[];
} = {}) {
  const asked: { path: string; method: string; body?: unknown; key?: string }[] = [];
  let revision = options.revision ?? "r1";
  let tools = options.tools ?? [LIST, PATCH, REMOVE];
  return {
    asked,
    lists: () => asked.filter((entry) => entry.path === "/v1/cli/tools").length,
    publish(next: { revision: string; tools: CliTool[] }) {
      revision = next.revision;
      tools = next.tools;
    },
    transport: {
      request: async (_url: string, path: string, request: RequestOptions = {}) => {
        const method = request.method ?? "GET";
        asked.push({ path, method, ...(request.body === undefined ? {} : { body: request.body }), ...(request.key ? { key: request.key } : {}) });
        if (options.offline) throw new CliError("connection_failed", "Could not reach the selected deployment.", "", 3);
        if (path === "/v1/cli/tools") {
          if (options.missing) throw new CliError("invalid_request", "Route not found", "", 3, { status: 404 });
          if (options.broken) throw new CliError("http_502", "Bad gateway", "", 3, { status: 502 });
          return { data: { revision, tools: [...(options.extra ?? []), ...tools] } };
        }
        const call = /^\/v1\/cli\/tools\/([a-z_]+)$/u.exec(path);
        if (call && method === "POST") {
          const sent = request.headers?.["agw-tool-guard"];
          const current = tools.find((tool) => tool.name === call[1]);
          const refusal = !current
            ? new CliError("tool_not_found", `This deployment has no tool named ${call[1]}`, "", 3, { status: 404 })
            : sent !== undefined && current.guard !== undefined && sent !== current.guard
              ? new CliError("tool_changed", `${call[1]} has changed; nothing ran`, "", 3, { status: 409 })
              : options.refuse?.(call[1]!, request.body as Record<string, unknown>);
          if (refusal) {
            refusal.headers = new Headers({ "agw-tools-revision": options.callRevision ?? revision });
            throw refusal;
          }
          const result = options.answer?.(call[1]!, request.body as Record<string, unknown>) ?? { ok: true };
          return {
            data: { tool: call[1], summary: `Ran ${call[1]}.`, result },
            headers: new Headers({ "agw-tools-revision": options.callRevision ?? revision }),
          };
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    },
  };
}

const signedIn = () => ({ ...fresh(), active: { url: "https://gw.example", credential: "agw_mgmt_test", authenticated: true } });

async function run(argv: string[], fake: ReturnType<typeof gateway>, cache = new MemoryCatalogCache()) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    store: { ...makeStore(), read: async () => signedIn() },
    transport: fake.transport,
    stdout: { write: (text: string) => void (out += text) },
    stderr: { write: (text: string) => void (err += text) },
    io: { env: {} },
    catalogCache: cache,
    stdin: noStdin,
  });
  return { code, out, err, json: () => JSON.parse(out) as Record<string, any> };
}

test("a gateway command runs its tool with the management key and prints its summary and view", async () => {
  const fake = gateway({ answer: () => ({ apps: [{ id: "app-1", name: "Example", status: "active" }] }) });
  const human = await run(["app", "list"], fake);
  assert.equal(human.code, 0, human.err);
  // The summary names tools as agents call them; a terminal reads the command.
  assert.equal(human.out, "Ran agw app list.\n\nID     Name     Status\napp-1  Example  active\n");
  assert.equal(fake.asked.find((entry) => entry.method === "POST")?.key, "agw_mgmt_test");
  const json = await run(["app", "list", "--json"], fake);
  assert.deepEqual(Object.keys(json.json()), ["schemaVersion", "ok", "context", "summary", "result"]);
  assert.deepEqual(json.json().result, { apps: [{ id: "app-1", name: "Example", status: "active" }] });
});

test("a deletion asks first: without a terminal only --yes goes ahead, and confirm repeats the id", async () => {
  const fake = gateway({ answer: (_tool, body) => ({ deleted: true, app_id: body.app }) });
  const refused = await run(["app", "remove", "app-1", "--json"], fake);
  assert.equal(refused.code, 4);
  assert.equal(refused.json().error.code, "confirmation_required");
  assert.equal(fake.asked.some((entry) => entry.method === "POST"), false);
  const removed = await run(["app", "remove", "app-1", "--yes", "--json"], fake);
  assert.equal(removed.code, 0, removed.out);
  assert.deepEqual(fake.asked.find((entry) => entry.method === "POST")?.body, { app: "app-1", confirm: "app-1" });
});

test("a required argument left out is named as it is typed, before anything is sent", async () => {
  const fake = gateway();
  const result = await run(["app", "update", "--name", "x", "--json"], fake);
  assert.equal(result.code, 2);
  assert.equal(result.json().error.code, "missing_value");
  assert.match(result.json().error.message, /<app>/);
  assert.equal(fake.asked.some((entry) => entry.method === "POST"), false);
});

test("a gateway's refusal names the flag, not the argument", () => {
  assert.equal(
    flagsIn(PATCH, "Deployment rejected the request (HTTP 400): team_id: only an iOS (App Attest) app has this setting"),
    "Deployment rejected the request (HTTP 400): --team-id: only an iOS (App Attest) app has this setting",
  );
  assert.equal(flagsIn(PATCH, "Deployment rejected the request (HTTP 400): app: unknown"), "Deployment rejected the request (HTTP 400): <app>: unknown");
  assert.equal(flagsIn(PATCH, "Deployment rejected the request (HTTP 404): App is not registered"), "Deployment rejected the request (HTTP 404): App is not registered");
});

test("the tool list is kept for a day, and fetched again once it is older", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway();
  await run(["app", "list"], fake, cache);
  await run(["app", "list"], fake, cache);
  assert.equal(fake.lists(), 1);
  const kept = (await cache.read("https://gw.example"))!;
  await cache.write({ ...kept, fetchedAt: Date.now() - CATALOG_TTL_MS - 1 });
  await run(["app", "list"], fake, cache);
  assert.equal(fake.lists(), 2);
});

test("a tool call answering another revision refreshes the list for the next run", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway({ callRevision: "r2" });
  await run(["app", "list"], fake, cache);
  // The first run fetched the list itself, so the call's revision is not news yet.
  assert.equal(fake.lists(), 1);
  const timeseries = cliTool("get_usage_timeseries", { command: "usage timeseries" });
  fake.publish({ revision: "r2", tools: [LIST, PATCH, REMOVE, timeseries] });
  await cache.write({ ...(await cache.read("https://gw.example"))!, revision: "r1" });
  await run(["app", "list"], fake, cache);
  assert.equal(fake.lists(), 2);
  assert.equal((await cache.read("https://gw.example"))?.revision, "r2");
  assert.ok((await cache.read("https://gw.example"))?.tools.some((tool) => tool.name === "get_usage_timeseries"));
});

test("a command not in the kept list is looked up once on the gateway before it is unknown", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway();
  await run(["app", "list"], fake, cache);
  fake.publish({ revision: "r2", tools: [LIST, cliTool("list_models", { command: "model list" })] });
  const found = await run(["model", "list"], fake, cache);
  assert.equal(found.code, 0, found.err);
  assert.equal(fake.lists(), 2);
  const unknown = await run(["model", "frobnicate", "--json"], fake, cache);
  assert.equal(unknown.json().error.code, "unknown_command");
  assert.equal(fake.lists(), 3);
});

test("a tool the gateway no longer has refreshes the list and says the commands changed", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway();
  await run(["app", "list"], fake, cache);
  fake.publish({ revision: "r2", tools: [PATCH] });
  const result = await run(["app", "list", "--json"], fake, cache);
  assert.equal(result.json().error.code, "tool_not_found");
  assert.match(result.json().error.nextAction, /commands changed/);
  assert.equal((await cache.read("https://gw.example"))?.revision, "r2");
});

test("an unreachable gateway leaves a kept list in use, however old, and a gateway without one says to update", async () => {
  const cache = new MemoryCatalogCache();
  await run(["app", "list"], gateway(), cache);
  const kept = (await cache.read("https://gw.example"))!;
  await cache.write({ ...kept, fetchedAt: 0 });
  const unreachable = async (): Promise<never> => {
    throw new CliError("connection_failed", "Could not reach the selected deployment.", "", 3);
  };
  const list: CachedCatalog = await new ToolCatalog({ url: "https://gw.example", fetchList: unreachable }, cache).load();
  assert.equal(list.revision, "r1");
  // Nothing kept and nothing reachable is the connection's own failure.
  await assert.rejects(
    () => new ToolCatalog({ url: "https://gw.example", fetchList: unreachable }, new MemoryCatalogCache()).load(),
    hasCode("connection_failed"),
  );
  const old = await run(["app", "list", "--json"], gateway({ missing: true }), new MemoryCatalogCache());
  assert.equal(old.json().error.code, "gateway_outdated");
  assert.match(old.json().error.nextAction, /agw deployment update/);
});

test("a command kept as needing a newer agw is looked up again before it is refused", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway({ tools: [LIST, cliTool("list_models", { command: "model list", requires: ["teleport"] })] });
  await run(["app", "list"], fake, cache);
  // The release that added the requirement was reverted.
  fake.publish({ revision: "r2", tools: [LIST, cliTool("list_models", { command: "model list" })] });
  const ran = await run(["model", "list"], fake, cache);
  assert.equal(ran.code, 0, ran.err);
  assert.equal(fake.lists(), 2);
});

test("a result is written before the list is read again for a changed gateway", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway({ answer: () => ({ apps: [] }) });
  await run(["app", "list"], fake, cache);
  fake.publish({ revision: "r2", tools: [LIST, PATCH, REMOVE] });
  const order: string[] = [];
  await main(["app", "list", "--json"], {
    store: { ...makeStore(), read: async () => signedIn() },
    transport: {
      request: async (url: string, path: string, options: RequestOptions = {}) => {
        if (path === "/v1/cli/tools") order.push("list");
        return fake.transport.request(url, path, options);
      },
    },
    stdout: { write: () => void order.push("output") },
    stderr: { write: () => {} },
    io: { env: {} },
    catalogCache: cache,
    stdin: noStdin,
  });
  assert.deepEqual(order, ["output", "list"]);
});

test("a refusal by a changed guard that no newer list explains is not sent again", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway({ tools: [LIST, { ...PATCH, guard: "g1" }] });
  await run(["app", "list"], fake, cache);
  // The gateway refuses by a guard its list does not show yet.
  fake.publish({ revision: "r1", tools: [LIST, { ...PATCH, guard: "g1" }] });
  const refusing = { ...fake, transport: { request: async (url: string, path: string, options: RequestOptions = {}) => {
    if (path.endsWith("patch_app")) {
      fake.asked.push({ path, method: "POST" });
      throw new CliError("tool_changed", "patch_app has changed", "", 3, { status: 409 });
    }
    return fake.transport.request(url, path, options);
  } } };
  const result = await run(["app", "update", "app-1", "--name", "x", "--json"], refusing, cache);
  assert.equal(result.json().error.code, "tool_changed");
  assert.match(result.json().error.nextAction, /Nothing ran/);
  assert.equal(fake.asked.filter((entry) => entry.path.endsWith("patch_app")).length, 1);
});

test("help for a built-in group does not fetch the list", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway();
  await run(["app", "list"], fake, cache);
  await run(["support", "--help"], fake, cache);
  assert.equal(fake.lists(), 1);
});

test("help for a command the kept list does not have looks on the gateway once, as running it would", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway();
  await run(["app", "list"], fake, cache);
  fake.publish({ revision: "r2", tools: [LIST, cliTool("list_models", { command: "model list" })] });
  const help = await run(["model", "list", "--help"], fake, cache);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /^agw model list/);
  assert.equal(fake.lists(), 2);
});

test("a flag the kept list does not know is looked up once on the gateway before it is refused", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway();
  await run(["app", "list"], fake, cache);
  const widened = { ...PATCH, inputSchema: { ...PATCH.inputSchema, properties: { ...(PATCH.inputSchema.properties as object), new_setting: { type: "string" } } } };
  fake.publish({ revision: "r2", tools: [LIST, widened, REMOVE] });
  const changed = await run(["app", "update", "app-1", "--new-setting", "x", "--json"], fake, cache);
  assert.equal(changed.code, 0, changed.out);
  assert.deepEqual(fake.asked.find((entry) => entry.method === "POST" && entry.path.endsWith("patch_app"))?.body, { app: "app-1", new_setting: "x" });
  const unknown = await run(["app", "update", "app-1", "--nonsense", "x", "--json"], fake, cache);
  assert.equal(unknown.json().error.code, "unknown_flag");
});

test("a newer description fetched for a flag is checked for what it needs, and reads standard input once", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway();
  await run(["app", "list"], fake, cache);
  const widened = { ...PATCH, inputSchema: { ...PATCH.inputSchema, properties: { ...(PATCH.inputSchema.properties as object), new_setting: { type: "string" } } } };
  fake.publish({ revision: "r2", tools: [LIST, { ...widened, cli: { ...widened.cli, requires: ["teleport"] } }, REMOVE] });
  const refused = await run(["app", "update", "app-1", "--new-setting", "x", "--json"], fake, cache);
  assert.equal(refused.json().error.code, "cli_outdated");
  assert.equal(fake.asked.some((entry) => entry.method === "POST" && entry.path.endsWith("patch_app")), false);

  const later = new MemoryCatalogCache();
  const next = gateway();
  await run(["app", "list"], next, later);
  next.publish({ revision: "r2", tools: [LIST, widened, REMOVE] });
  let reads = 0;
  let out = "";
  const code = await main(["app", "update", "--input", "@-", "--new-setting", "x", "--json"], {
    store: { ...makeStore(), read: async () => signedIn() },
    transport: next.transport,
    stdout: { write: (text: string) => void (out += text) },
    stderr: { write: () => {} },
    io: { env: {} },
    catalogCache: later,
    stdin: async () => (reads++ === 0 ? '{"app":"app-1"}' : ""),
  });
  assert.equal(code, 0, out);
  assert.deepEqual(next.asked.find((entry) => entry.method === "POST" && entry.path.endsWith("patch_app"))?.body, { app: "app-1", new_setting: "x" });
});

test("a result's own keys are cleaned before they label a table or a field", () => {
  const bare = cliTool("get_thing", { command: "thing show" });
  const hostile = "name\u001b[2J";
  const out = humanToolResult(bare, "A thing.", { [hostile]: "x", items: [{ [hostile]: 1 }] }, [bare], plain);
  assert.equal(out.includes("\u001b"), false, JSON.stringify(out));
  const record = cliTool("get_app", { command: "app show", view: { record: "app" } });
  assert.equal(humanToolResult(record, "App.", { app: { [hostile]: "x" } }, [record], plain).includes("\u001b"), false);
});

test("a release that leaves a command's guard alone runs it with the list kept, at once", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway({ tools: [{ ...LIST, guard: "g1" }] });
  await run(["app", "list"], fake, cache);
  // Reworded and given a new view, but no safer or less safe to run.
  fake.publish({ revision: "r2", tools: [{ ...LIST, description: "Lists apps, reworded.", guard: "g1" }] });
  const posts = () => fake.asked.filter((entry) => entry.method === "POST").length;
  const before = posts();
  const result = await run(["app", "list", "--json"], fake, cache);
  assert.equal(result.code, 0, result.out);
  assert.equal(posts() - before, 1);
});

test("a command that has become destructive since the list was kept is asked about again before it runs", async () => {
  const update = { ...PATCH, guard: "g1" };
  const destructive = { ...PATCH, guard: "g2", annotations: { ...PATCH.annotations, destructiveHint: true } };
  const posts = (fake: ReturnType<typeof gateway>) =>
    fake.asked.filter((entry) => entry.method === "POST" && entry.path.endsWith("patch_app"));

  const cache = new MemoryCatalogCache();
  const fake = gateway({ tools: [LIST, update] });
  await run(["app", "list"], fake, cache);
  fake.publish({ revision: "r2", tools: [LIST, destructive] });
  const refused = await run(["app", "update", "app-1", "--name", "x", "--json"], fake, cache);
  assert.equal(refused.json().error.code, "confirmation_required");
  // One call, refused before it ran, and none after it.
  assert.equal(posts(fake).length, 1);

  const agreed = new MemoryCatalogCache();
  const again = gateway({ tools: [LIST, update] });
  await run(["app", "list"], again, agreed);
  again.publish({ revision: "r2", tools: [LIST, destructive] });
  const ran = await run(["app", "update", "app-1", "--name", "x", "--yes", "--json"], again, agreed);
  assert.equal(ran.code, 0, ran.out);
  assert.deepEqual(posts(again).map((entry) => entry.body), [{ app: "app-1", name: "x" }, { app: "app-1", name: "x" }]);
});

test("a command that has come to need a newer agw is refused by name, having run nothing", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway({ tools: [LIST, { ...PATCH, guard: "g1" }] });
  await run(["app", "list"], fake, cache);
  fake.publish({ revision: "r2", tools: [LIST, { ...PATCH, guard: "g2", cli: { ...PATCH.cli, requires: ["teleport"] } }] });
  const refused = await run(["app", "update", "app-1", "--name", "x", "--json"], fake, cache);
  assert.equal(refused.json().error.code, "cli_outdated");
});

test("a refusal about what a tool names is not mistaken for the tool being gone", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway({ refuse: () => new CliError("not_found", "Key is not registered", "", 3, { status: 404 }) });
  await run(["app", "list"], fake, cache);
  const result = await run(["app", "list", "--json"], fake, cache);
  assert.equal(result.json().error.code, "not_found");
  assert.doesNotMatch(result.json().error.nextAction, /commands changed/);
  assert.equal(fake.lists(), 1);
});

test("a refusal carrying another revision refreshes the list for the next run", async () => {
  const cache = new MemoryCatalogCache();
  const fake = gateway({ refuse: () => new CliError("invalid_request", "No.", "", 3, { status: 400 }) });
  await run(["app", "list"], fake, cache);
  fake.publish({ revision: "r2", tools: [LIST, PATCH, REMOVE] });
  const refused = await run(["app", "list", "--json"], fake, cache);
  assert.equal(refused.json().error.code, "invalid_request");
  assert.equal((await cache.read("https://gw.example"))?.revision, "r2");
});

test("a gateway that fails to give its list leaves an old kept one in use", async () => {
  const cache = new MemoryCatalogCache();
  await run(["app", "list"], gateway(), cache);
  await cache.write({ ...(await cache.read("https://gw.example"))!, fetchedAt: 0 });
  const broken = gateway({ broken: true });
  // Listing fails, the kept list stands in, and the call itself still goes through.
  const result = await run(["app", "list"], { ...broken, transport: { request: async (url: string, path: string, options: RequestOptions = {}) => {
    if (path === "/v1/cli/tools") return broken.transport.request(url, path, options);
    return gateway().transport.request(url, path, options);
  } } }, cache);
  assert.equal(result.code, 0, result.err);
});

test("a tool this release cannot read is left out, and the rest still work", async () => {
  const fake = gateway({ extra: [{ name: "future_tool", cli: { command: "future", args: [{ name: "x" }] } }] });
  const listed = await run(["app", "list"], fake);
  assert.equal(listed.code, 0, listed.err);
  const help = await run(["--help"], fake);
  assert.doesNotMatch(help.out, /future/);
});

test("a tool needing a feature this release lacks is hidden from help and refused by name", async () => {
  const future = cliTool("future_tool", { command: "future thing", requires: ["teleport"] });
  const fake = gateway({ tools: [LIST, future] });
  assert.doesNotMatch((await run(["--help"], fake)).out, /future thing/);
  const refused = await run(["future", "thing", "--json"], fake);
  assert.equal(refused.json().error.code, "cli_outdated");
  assert.match(refused.json().error.nextAction, /npm install -g @maxceem\/agw/);
  assert.equal(fake.asked.some((entry) => entry.method === "POST"), false);
});

test("a deletion missing what it deletes says so before asking for confirmation", async () => {
  const result = await run(["app", "remove", "--json"], gateway());
  assert.equal(result.json().error.code, "missing_value");
  assert.match(result.json().error.message, /<app>/);
});

test("help lists the gateway's commands beside the built-in ones, and explains one from its schema", async () => {
  const fake = gateway();
  const all = await run(["--help"], fake);
  assert.match(all.out, /agw app list +list apps/);
  assert.match(all.out, /agw app add +Add an iOS or server app/);
  const one = await run(["app", "update", "--help"], fake);
  assert.equal(one.code, 0);
  assert.match(one.out, /^agw app update <app> \[flags\]\n/);
  assert.match(one.out, /\nShortcuts\n {2}--name <value>/);
  assert.match(one.out, /\n {2}--all-providers\n/);
  assert.match(one.out, /--providers <value>… +Repeat the flag, or separate values with commas\./);
  // A tool named in a description reads as the command it is.
  assert.match(one.out, /as agw app list returns it/);
  assert.equal(fake.asked.some((entry) => entry.method === "POST"), false);
});

test("everything the gateway says is cleaned of control characters before a terminal sees it", () => {
  const hostile = "Name\u001b[2J\u001b]8;;https://evil\u0007 ‮evil\u009b31m";
  assert.equal(clean(hostile).includes("\u001b"), false);
  assert.equal(/[\p{Cc}\p{Cf}]/u.test(clean(hostile)), false);
  const tool = cliTool("get_app", {
    command: "app show",
    view: { record: "app", columns: ["name"], notes: ["app.warnings"], document: "app.config" },
  });
  const out = humanToolResult(
    tool,
    hostile,
    { app: { name: hostile, warnings: [{ message: hostile }], config: { label: hostile } } },
    [tool],
    style(true),
  );
  // Escape sequences the renderer adds are SGR colours only; nothing the gateway sent survives.
  assert.equal(out.replace(/\u001b\[\d+m/gu, "").includes("\u001b"), false, JSON.stringify(out));
  assert.equal(/[\u0080-\u009f‮]/u.test(out), false, JSON.stringify(out));
  assert.equal(toolHelp({ ...tool, description: hostile, title: hostile }, [tool], plain).includes("\u001b"), false);
});

test("a tool list's own labels, flags and commands are made printable before anything shows them", async () => {
  const hostile = cliTool(
    "list_apps",
    { command: "app list", view: { rows: "apps", columns: ["id=ID\u001b[2J"] } },
    { properties: { "bad\u001b[2Jname": { type: "string", enum: ["a\u001b]8;;x\u0007"] } } },
  );
  const fake = gateway({ tools: [hostile], answer: () => ({ apps: [{ id: "app-1" }] }) });
  const listed = await run(["app", "list"], fake);
  assert.equal(listed.code, 0, listed.err);
  assert.equal(listed.out.includes("\u001b"), false, JSON.stringify(listed.out));
  const help = await run(["app", "list", "--help"], fake);
  assert.equal(help.out.includes("\u001b") || help.out.includes("\u0007"), false, JSON.stringify(help.out));
});

test("views lay out records, notes, documents and rows a wildcard reaches", () => {
  const models = cliTool("list_models", {
    command: "model list",
    view: { rows: "prices.*.*", columns: ["$1=Provider", "$2=Model", "input"] },
  });
  assert.equal(
    humanToolResult(models, "2 models.", { prices: { openai: { "gpt-x": { input: 1 } }, claude: { "c-1": { input: 2 } } } }, [models], plain),
    "2 models.\n\nProvider  Model  Input\nopenai    gpt-x  1\nclaude    c-1    2\n",
  );
  const show = cliTool("get_app", {
    command: "app show",
    view: { record: "app", columns: ["name", "id", "config.mode=Mode"], notes: ["app.warnings"], document: "app.config" },
  });
  assert.equal(
    humanToolResult(show, "App X.", { app: { name: "X", id: "app-1", config: { mode: "all" }, warnings: [{ message: "Stops soon." }] } }, [show], plain),
    'App X.\n\nName: X\nID:   app-1\nMode: all\n\n- Stops soon.\n\n{\n  "mode": "all"\n}\n',
  );
  // Without a view: the plain fields, then the first list of objects as a table.
  const bare = cliTool("get_thing", { command: "thing show" });
  assert.equal(
    humanToolResult(bare, "A thing.", { id: "t-1", items: [{ key: "a", count: 2 }] }, [bare], plain),
    "A thing.\n\nID: t-1\n\nKey  Count\na    2\n",
  );
  assert.equal(mentions("Call list_apps, then get_app.", [LIST, show]), "Call agw app list, then agw app show.");
});
