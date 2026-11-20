import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/common.ts";
import { main, MemoryCatalogCache } from "../src/main.ts";
import { StateStore } from "../src/state.ts";
import type { RequestOptions } from "../src/transport.ts";
import { fakeClock, fakeTransport, memoryStore, signedInState, sinks } from "./helpers.ts";

/**
 * The built-in commands that change things: adding a provider with its key
 * from stdin or a browser, adding an app with its key in a private file, and
 * the `app update` shortcuts. Run end to end through `main`.
 */

const URL_ = "https://console.gw.example";

const APP = {
  id: "app_1",
  name: "Backend",
  status: "active",
  revision: 3,
  config: { authentication: { type: "api_key", end_user: { source: "none" } } },
  created_at: "2026-11-20T10:00:00.000Z",
  updated_at: "2026-11-20T10:00:00.000Z",
};

const KEY = { id: "key_1", name: "default", key_prefix: "agw_app_ab", created_at: "2026-11-20T10:00:00.000Z", key: "agw_app_abcdefghijklmnopqrstuvwxyz" };

const PROVIDER = {
  id: "prov_1",
  type: "openai",
  slug: "openai",
  name: "openai",
  status: "active",
  secretHint: "wxyz",
  baseUrl: null,
  pricing: null,
  revision: 2,
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
};

async function run(argv: string[], handler: (path: string, options: RequestOptions) => unknown, store = memoryStore(signedInState(URL_, "agw_oat_1"))) {
  const out = sinks();
  const transport = fakeTransport(async (path, options) => ({ data: await handler(path, options) }));
  const code = await main(argv, {
    store,
    transport,
    stdout: out.stdout,
    stderr: out.stderr,
    io: { env: {}, clock: fakeClock(), openBrowser: async () => true },
    catalogCache: new MemoryCatalogCache(),
  });
  return { code, out: out.out.text, err: out.err.text, calls: transport.calls, json: () => JSON.parse(out.out.text) };
}

test("a server app's first key is written to a private file and never printed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-"));
  try {
    const store = memoryStore(signedInState(URL_, "agw_oat_1"));
    const path = join(dir, "backend.key");
    store.keyOutput = new StateStore(dir).keyOutput.bind(new StateStore(dir));
    const result = await run(["app", "add", "--type", "server", "--name", "Backend", "--key-output", path, "--json"], (p, options) => {
      assert.equal(p, "/v2/admin/apps");
      assert.equal(options.method, "POST");
      assert.deepEqual(options.body, { name: "Backend", config: APP.config });
      return { app: APP, api_key: KEY };
    }, store);
    assert.equal(result.code, 0, result.err);
    assert.equal(await readFile(path, "utf8"), KEY.key + "\n");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(!result.out.includes(KEY.key));
    assert.equal(result.json().result.key.storagePath, path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a key path that is already taken is refused before anything is created", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-"));
  try {
    const path = join(dir, "taken.key");
    await writeFile(path, "keep me\n");
    const store = memoryStore(signedInState(URL_, "agw_oat_1"));
    store.keyOutput = new StateStore(dir).keyOutput.bind(new StateStore(dir));
    const result = await run(["app", "key", "add", "app_1", "--name", "ci", "--key-output", path, "--json"], () => assert.fail("nothing is created"), store);
    assert.equal(result.json().error.code, "output_unavailable");
    assert.equal(await readFile(path, "utf8"), "keep me\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an iOS app needs its team and bundle ids, and is created with no key file", async () => {
  const missing = await run(["app", "add", "--name", "My App", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(missing.json().error.code, "invalid_input");
  const created = await run(
    ["app", "add", "--name", "My App", "--team-id", "ABCDE12345", "--bundle-id", "com.example.app", "--json"],
    (_path, options) => {
      const body = options.body as { config: { authentication: { type: string; app_attest: object } } };
      assert.equal(body.config.authentication.type, "apple_app_attest");
      assert.deepEqual(body.config.authentication.app_attest, { team_id: "ABCDE12345", bundle_id: "com.example.app" });
      return { app: { ...APP, name: "My App" }, api_key: null };
    },
  );
  assert.equal(created.code, 0, created.err);
  assert.equal(created.json().result.key, null);
});

test("app update --status reads the revision and sends it once more after someone else's change", async () => {
  let reads = 0;
  let patches = 0;
  const result = await run(["app", "update", "app_1", "--status", "disabled", "--json"], (path, options) => {
    if (options.method === undefined || options.method === "GET") {
      reads++;
      return { app: { ...APP, revision: 3 + reads } };
    }
    patches++;
    assert.equal(path, "/v2/admin/apps/app_1");
    const body = options.body as { revision: number; operations: unknown[] };
    assert.deepEqual(body.operations, [{ op: "replace", path: "/status", value: "disabled" }]);
    if (patches === 1) throw new CliError("app_revision_conflict", "changed", "", 3, { status: 409 });
    assert.equal(body.revision, 5);
    return { app: { ...APP, status: "disabled", revision: 6 } };
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json().result.app.status, "disabled");
  assert.equal(patches, 2);
});

test("app update with --operations needs --revision and sends the patch as given", async () => {
  const missing = await run(["app", "update", "app_1", "--operations", "[]", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(missing.json().error.code, "invalid_input");
  const ops = [{ op: "replace", path: "/config/limits/per_app/requests/per_minute", value: 10 }];
  const result = await run(["app", "update", "app_1", "--operations", JSON.stringify(ops), "--revision", "3", "--json"], (_path, options) => {
    assert.deepEqual(options.body, { revision: 3, operations: ops });
    return { app: APP };
  });
  assert.equal(result.code, 0, result.err);
});

test("provider add --browser opens the gateway's own page without printing its link, and --json answers the pending step", async () => {
  const result = await run(["provider", "add", "--type", "openai", "--browser", "--json"], (path, options) => {
    if (path === "/v2/admin/provider-handoffs") {
      assert.deepEqual(options.body, { type: "openai", name: "openai" });
      return { id: "op_1", kind: "provider.add", url: `${URL_}/v2/approve/op_1#proof`, expiresAt: "2026-11-20T10:15:00.000Z" };
    }
    assert.equal(path, "/v2/admin/operations/op_1");
    return { id: "op_1", kind: "provider.add.browser", state: "pending", createdAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-11-20T10:15:00.000Z" };
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json().result.state, "pending");
  // The link's fragment is the page's proof: it never reaches the terminal.
  assert.doesNotMatch(result.err + result.out, /proof|v2\/approve/);
  assert.match(result.err, /browser window/);
});

test("when no browser opens, the hand-off link goes to a private file and only its path is printed", async () => {
  const store = memoryStore(signedInState(URL_, "agw_oat_1"));
  const out = sinks();
  const transport = fakeTransport(async (path) => ({
    data:
      path === "/v2/admin/provider-handoffs"
        ? { id: "op_9", kind: "provider.add", url: `${URL_}/v2/approve/op_9#proof`, expiresAt: "2026-11-20T10:15:00.000Z" }
        : { id: "op_9", kind: "provider.add.browser", state: "pending", createdAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-11-20T10:15:00.000Z" },
  }));
  const code = await main(["provider", "add", "--type", "openai", "--browser", "--json"], {
    store,
    transport,
    stdout: out.stdout,
    stderr: out.stderr,
    io: { env: {}, clock: fakeClock(), openBrowser: async () => false },
    catalogCache: new MemoryCatalogCache(),
  });
  assert.equal(code, 0, out.err.text);
  assert.equal(store.handoffs.get("op_9"), `${URL_}/v2/approve/op_9#proof`);
  assert.match(out.err.text, /\/private\/handoffs\/op_9\.url/);
  assert.doesNotMatch(out.err.text + out.out.text, /proof/);
});

test("the handoff file is private", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-"));
  try {
    const path = await new StateStore(dir).handoffFile("op_1", "https://console.gw.example/v2/approve/op_1#proof");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, "utf8"), "https://console.gw.example/v2/approve/op_1#proof\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("app update --status active turns an app back on", async () => {
  const result = await run(["app", "update", "app_1", "--status", "active", "--json"], (_path, options) => {
    if (options.method === undefined || options.method === "GET") return { app: { ...APP, status: "disabled" } };
    assert.deepEqual((options.body as { operations: unknown[] }).operations, [{ op: "replace", path: "/status", value: "active" }]);
    return { app: { ...APP, status: "active", revision: 4 } };
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json().result.app.status, "active");
  const wrong = await run(["app", "update", "app_1", "--status", "enabled", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(wrong.json().error.code, "invalid_input");
});

test("a hand-off link off the gateway's origin is never opened", async () => {
  const result = await run(["provider", "add", "--type", "openai", "--browser", "--json"], () => ({
    id: "op_1",
    kind: "provider.add",
    url: "https://evil.example/v2/approve/op_1",
    expiresAt: "2026-11-20T10:15:00.000Z",
  }));
  assert.equal(result.json().error.code, "invalid_response");
});

test("provider rotate-key finds the connection by slug and sends its revision with the new key from the browser step", async () => {
  const result = await run(["provider", "rotate-key", "openai", "--browser", "--json"], (path, options) => {
    if (path === "/v2/admin/providers") return { providers: [PROVIDER] };
    if (path === "/v2/admin/operations/op_2")
      return { id: "op_2", kind: "provider.rotate-key.browser", state: "pending", createdAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-11-20T10:15:00.000Z" };
    assert.equal(path, "/v2/admin/providers/prov_1/key-handoffs");
    assert.deepEqual(options.body, { revision: 2 });
    return { id: "op_2", kind: "provider.rotate-key", url: `${URL_}/v2/approve/op_2#p`, expiresAt: "2026-11-20T10:15:00.000Z" };
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json().result.id, "op_2");
});

test("a v1 gateway's commands are refused with the agw 1.x message", async () => {
  const out = sinks();
  const transport = fakeTransport(async (path) => {
    if (path === "/v1/cli/capabilities") return { data: { serverVersion: "0.22.1" } };
    throw new CliError("not_found", "no", "", 3, { status: 404 });
  });
  const code = await main(["app", "list", "--json"], {
    store: memoryStore(signedInState(URL_, "agw_oat_1")),
    transport,
    stdout: out.stdout,
    stderr: out.stderr,
    io: { env: {} },
    catalogCache: new MemoryCatalogCache(),
  });
  assert.equal(code, 3);
  const error = JSON.parse(out.out.text).error;
  assert.equal(error.code, "gateway_v1");
  assert.match(error.nextAction, /agw 1\.x/);
});

test("deployment status at a v1 gateway with AGW_MANAGEMENT_KEY gets the agw 1.x message", async () => {
  const out = sinks();
  const transport = fakeTransport(async (path) => {
    if (path === "/v1/cli/capabilities") return { data: { serverVersion: "0.22.1" } };
    throw new CliError("not_found", "no", "", 3, { status: 404 });
  });
  const code = await main(["deployment", "status", "--json"], {
    store: memoryStore({ schemaVersion: 1, active: { url: URL_ } }),
    transport,
    stdout: out.stdout,
    stderr: out.stderr,
    io: { env: { AGW_MANAGEMENT_KEY: "agw_mgmt_env" } },
    catalogCache: new MemoryCatalogCache(),
  });
  assert.equal(code, 3);
  assert.equal(JSON.parse(out.out.text).error.code, "gateway_v1");
});
