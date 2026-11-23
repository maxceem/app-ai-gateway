import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, LocalDirectoryError } from "../src/common.ts";
import { customFields } from "../src/commands.ts";
import { main, MemoryCatalogCache } from "../src/main.ts";
import { signInFailure } from "../src/sign-in-retry.ts";
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

test("app add writes only the settings its flags name: environments, verification, status, and providers", async () => {
  const sent: unknown[] = [];
  const created = await run(
    [
      "app", "add", "--name", "My App", "--team-id", "ABCDE12345", "--bundle-id", "com.example.app",
      "--attest-environments", "production,development", "--verify-on", "token_exchange", "--status", "disabled",
      "--providers", "openai", "--providers", "mine=custom.openai-chat+passthrough", "--json",
    ],
    (path, options) => {
      if (path === "/v2/admin/providers") return { providers: [PROVIDER] };
      if (path === "/v2/admin/provider-types") return { types: [{ type: "openai", label: "OpenAI", styles: [], operations: ["openai.chat", "openai.responses"], cloudflareGateway: true, custom: false }] };
      sent.push(options.body);
      return { app: { ...APP, name: "My App" }, api_key: null };
    },
  );
  assert.equal(created.code, 0, created.err);
  assert.deepEqual(sent, [
    {
      name: "My App",
      status: "disabled",
      config: {
        authentication: {
          type: "apple_app_attest",
          end_user: { source: "app_install" },
          app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.app", environments: ["production", "development"], verify_on: "token_exchange" },
        },
        // A bare slug allows the connection's first operation, as the console does; named ones go as written.
        routing: { providers: { openai: { operations: ["openai.chat"] }, mine: { operations: ["custom.openai-chat", "passthrough"] } } },
      },
    },
  ]);

  // A gateway from before the provider types: a bare slug says to name the operations.
  const older = await run(["app", "add", "--name", "My App", "--team-id", "ABCDE12345", "--bundle-id", "com.example.app", "--providers", "openai", "--json"], (path) => {
    if (path === "/v2/admin/providers") return { providers: [PROVIDER] };
    if (path === "/v2/admin/provider-types") throw new CliError("not_found", "Nothing is served at this path.", "", 3, { status: 404 });
    return assert.fail("nothing is created");
  });
  assert.equal(older.json().error.code, "invalid_input");
  assert.match(older.json().error.message, /does not list its provider types' operations/u);
  assert.match(older.json().error.nextAction, /--providers openai=<operation>\+<operation>/u);

  const server = await run(["app", "add", "--type", "server", "--name", "Backend", "--verify-on", "every_request", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(server.json().error.code, "invalid_input");
  assert.match(server.json().error.message, /--verify-on/);
  const unknown = await run(["app", "add", "--name", "My App", "--team-id", "ABCDE12345", "--bundle-id", "com.example.app", "--providers", "gone", "--json"], (path) => {
    assert.equal(path, "/v2/admin/providers");
    return { providers: [PROVIDER] };
  });
  assert.equal(unknown.json().error.code, "provider_not_found");
  const filed = await run(["app", "add", "--file", "app.json", "--providers", "openai", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(filed.json().error.code, "conflicting_flags");
  // As before this release: --file wins over --user-header, --team-id and --bundle-id, which are left out.
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-"));
  try {
    const document = { name: "From file", config: { authentication: { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.file" } } } };
    await writeFile(join(dir, "app.json"), JSON.stringify(document));
    const sent: unknown[] = [];
    const old = await run(["app", "add", "--file", join(dir, "app.json"), "--user-header", "x-user", "--team-id", "ZZZZZ99999", "--json"], (_path, options) => {
      sent.push(options.body);
      return { app: { ...APP, name: "From file" }, api_key: null };
    });
    assert.equal(old.code, 0, old.err);
    assert.deepEqual(sent, [document]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const status = await run(["app", "add", "--name", "My App", "--team-id", "ABCDE12345", "--bundle-id", "com.example.app", "--status", "paused", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(status.json().error.code, "invalid_input");
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

test("provider add through Cloudflare AI Gateway sends the ids to the browser step, and never takes the token on the command line", async () => {
  const pending = { id: "op_2", kind: "provider.add.browser", state: "pending", createdAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-11-20T10:15:00.000Z" };
  const result = await run(
    ["provider", "add", "--type", "openai", "--cloudflare-account-id", " acct ", "--cloudflare-gateway-id", "gw", "--browser", "--json"],
    (path, options) => {
      if (path === "/v2/admin/provider-handoffs") {
        assert.deepEqual(options.body, { type: "openai", name: "openai", cloudflareGateway: { accountId: "acct", gatewayId: "gw" } });
        return { id: "op_2", kind: "provider.add", url: `${URL_}/v2/approve/op_2#proof`, expiresAt: "2026-11-20T10:15:00.000Z" };
      }
      return pending;
    },
  );
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json().result.state, "pending");

  // The ids need --browser, and each other; a token has no flag at all.
  const keyed = await run(["provider", "add", "--type", "openai", "--cloudflare-account-id", "acct", "--cloudflare-gateway-id", "gw", "--key-stdin", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(keyed.json().error.code, "invalid_input");
  assert.match(keyed.json().error.nextAction, /--browser/);
  const half = await run(["provider", "add", "--type", "openai", "--cloudflare-account-id", "acct", "--browser", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(half.json().error.code, "invalid_input");
  const token = await run(["provider", "add", "--type", "openai", "--cloudflare-token", "x", "--browser", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(token.json().error.code, "unknown_flag");
});

test("provider add --type custom sends its key header, format and paths, read as the console reads path lines", async () => {
  assert.deepEqual(
    customFields("custom", {
      "key-header": "x-api-key",
      "key-format": "Key {key}",
      path: ["post chat/completions openai-chat", "GET models $0.001"],
    }),
    {
      auth: { header: "x-api-key", format: "Key {key}" },
      passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }, { method: "GET", path: "models", per_request: 0.001 }],
    },
  );
  // The console's defaults, and no paths until some are listed.
  assert.deepEqual(customFields("custom", {}), { auth: { header: "authorization", format: "Bearer {key}" } });
  assert.equal(customFields("openai", {}), null);

  const bad = await run(["provider", "add", "--type", "custom", "--base-url", "https://llm.example.com/v1/", "--path", "POST chat/completions chat", "--key-stdin", "--json"], () => assert.fail("nothing is sent"));
  assert.match(bad.json().error.message, /^--path: path 1: chat is not a price or an API style/u);
  // A custom provider's paths are chosen where it is added: never through a browser step.
  const browser = await run(["provider", "add", "--type", "custom", "--base-url", "https://llm.example.com/v1/", "--browser", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(browser.json().error.code, "invalid_input");
  // A built-in provider's paths are a trust choice made in the console, or with agw provider update.
  const builtIn = await run(["provider", "add", "--type", "openai", "--path", "GET v1/files", "--key-stdin", "--json"], () => assert.fail("nothing is sent"));
  assert.match(builtIn.json().error.message, /only for --type custom/u);
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

test("a state file that cannot be read never points at agw account login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-state-"));
  try {
    const store = new StateStore(dir);
    await store.update(() => {});
    await writeFile(store.path, "not JSON");
    const transport = fakeTransport(async () => assert.fail("nothing is called before the state is read"));
    const BOTH =
      "Move the connection state file aside. For a self-hosted gateway, then run agw deployment connect --url with its address; for the hosted one, run the same command again.";
    const cases: [string[], string][] = [
      // The command names its gateway, so running it again finds that one.
      [["deployment", "connect", "--url", URL_, "--json"], "Move the connection state file aside, then run the same command again."],
      [["account", "login", "--json"], BOTH],
      [["deployment", "status", "--json"], BOTH],
    ];
    for (const [argv, expected] of cases) {
      const out = sinks();
      const code = await main(argv, { store, transport, stdout: out.stdout, stderr: out.stderr, io: { env: {} }, catalogCache: new MemoryCatalogCache() });
      assert.equal(code, 4, argv.join(" "));
      const error = JSON.parse(out.out.text).error;
      assert.equal(error.code, "invalid_state", argv.join(" "));
      assert.equal(error.nextAction, expected, argv.join(" "));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logout with an unsafe state file asks to repair it, never to move the sign-in out of reach", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-state-"));
  try {
    const store = new StateStore(dir);
    await store.update((state) => void Object.assign(state, signedInState(URL_, "agw_oat_1")));
    await chmod(store.path, 0o644);
    const transport = fakeTransport(async () => assert.fail("nothing is called before the state is read"));
    const out = sinks();
    const code = await main(["account", "logout", "--json"], { store, transport, stdout: out.stdout, stderr: out.stderr, io: { env: {} }, catalogCache: new MemoryCatalogCache() });
    assert.equal(code, 4);
    const error = JSON.parse(out.out.text).error;
    assert.equal(error.code, "unsafe_storage");
    assert.equal(
      error.nextAction,
      `Restore this file's mode to 0600 (owner read and write only), then run agw account logout again:\n${store.path}\nIf that is not possible, revoke the sign-in in the console under Access.`,
    );
    // The sign-in is still where the repaired file can end it.
    assert.equal(JSON.parse(await readFile(store.path, "utf8")).active.login.refreshToken, "agw_ort_test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logout with a corrupt state file says only to revoke the sign-in under Access, never to change the file's mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-state-"));
  try {
    const store = new StateStore(dir);
    await writeFile(store.path, "{ not json", { mode: 0o600 });
    const transport = fakeTransport(async () => assert.fail("nothing is called before the state is read"));
    const out = sinks();
    const code = await main(["account", "logout", "--json"], { store, transport, stdout: out.stdout, stderr: out.stderr, io: { env: {} }, catalogCache: new MemoryCatalogCache() });
    assert.equal(code, 4);
    const error = JSON.parse(out.out.text).error;
    assert.equal(error.code, "invalid_state");
    assert.equal(
      error.nextAction,
      `The connection state file cannot be read, so its sign-in cannot be revoked from here. Revoke the sign-in in the console under Access:\n${store.path}`,
    );
    assert.doesNotMatch(error.nextAction, /0600/);
    // The file is left as it was.
    assert.equal(await readFile(store.path, "utf8"), "{ not json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a symlinked state directory gets its own hint, which names the directory", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-state-"));
  try {
    await mkdir(join(dir, "real"));
    const link = join(dir, "link");
    await symlink(join(dir, "real"), link);
    const store = new StateStore(link);
    const expected = `Replace this directory with a private directory you own, then run the same command again:\n${link}`;
    const error = await store.update(() => {}).then(
      () => assert.fail("a symlinked directory is refused"),
      (e: unknown) => e,
    );
    assert.ok(error instanceof LocalDirectoryError);
    assert.equal(error.code, "unsafe_storage");
    assert.equal(error.exitCode, 2);
    assert.equal(error.nextAction, expected);
    // Sign-in hints keep it rather than pointing at the state file.
    const shown = signInFailure(error, URL_);
    assert.ok(shown instanceof CliError);
    assert.equal(shown.nextAction, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logout in a symlinked state directory asks to keep the sign-in, never to start over empty", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-state-"));
  try {
    await mkdir(join(dir, "real"));
    await new StateStore(join(dir, "real")).update((state) => void Object.assign(state, signedInState(URL_, "agw_oat_1")));
    const link = join(dir, "link with space");
    await symlink(join(dir, "real"), link);
    const store = new StateStore(link);
    const transport = fakeTransport(async () => assert.fail("nothing is called before the state is read"));
    const out = sinks();
    const code = await main(["account", "logout", "--json"], { store, transport, stdout: out.stdout, stderr: out.stderr, io: { env: {} }, catalogCache: new MemoryCatalogCache() });
    assert.equal(code, 2);
    const error = JSON.parse(out.out.text).error;
    assert.equal(error.code, "unsafe_storage");
    assert.equal(
      error.nextAction,
      `Keep connection.json. Replace this directory with a private directory you own at the same path, move connection.json into it, then run agw account logout again:\n${link}\nIf that is not possible, revoke the sign-in in the console under Access.`,
    );
    // The sign-in is still there to be ended.
    assert.equal(JSON.parse(await readFile(join(dir, "real", "connection.json"), "utf8")).active.login.refreshToken, "agw_ort_test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** One `main` run with the store, transport and environment given. */
async function runWith(argv: string[], options: { store: ReturnType<typeof memoryStore>; handler: (path: string) => unknown; env?: Record<string, string>; openBrowser?: () => Promise<boolean> }) {
  const out = sinks();
  const transport = fakeTransport(async (path) => ({ data: await options.handler(path) }));
  const code = await main(argv, {
    store: options.store,
    transport,
    stdout: out.stdout,
    stderr: out.stderr,
    io: { env: options.env ?? {}, clock: fakeClock(), openBrowser: options.openBrowser ?? (async () => true) },
    catalogCache: new MemoryCatalogCache(),
  });
  return { code, out: out.out.text, err: out.err.text };
}

const SESSION = {
  session: {
    user: { id: "u1", name: null, email: "ops@example.com", emailVerified: true },
    account: { id: "org_1", name: "Acme" },
    role: "owner",
    grant: "manage",
    credentialType: "apiKey",
    accounts: [{ id: "org_1", name: "Acme", role: "owner" }],
  },
};

test("connect with AGW_MANAGEMENT_KEY keeps a sign-in already stored for the same gateway, and names the hosted one when no URL is given", async () => {
  const store = memoryStore(signedInState(URL_, "agw_oat_1"));
  const same = await runWith(["deployment", "connect", "--url", URL_, "--json"], { store, handler: () => SESSION, env: { AGW_MANAGEMENT_KEY: "agw_mgmt_env" } });
  assert.equal(same.code, 0, same.err);
  assert.equal(store.held.active?.login?.accessToken, "agw_oat_1");
  const hosted = await runWith(["deployment", "connect", "--json"], { store: memoryStore(), handler: () => SESSION, env: { AGW_MANAGEMENT_KEY: "agw_mgmt_env" } });
  assert.equal(hosted.code, 0, hosted.err);
  assert.match(hosted.err, /hosted gateway, https:\/\/console\.appaigateway\.com/);
});

test("deployment status checks the gateway with no credential, and a refused AGW_MANAGEMENT_KEY is an error", async () => {
  const notV2 = (path: string) => {
    if (path === "/v1/cli/capabilities") return { serverVersion: "0.22.1" };
    throw new CliError("not_found", "no", "", 3, { status: 404 });
  };
  const bare = await runWith(["deployment", "status", "--json"], { store: memoryStore({ schemaVersion: 1, active: { url: URL_ } }), handler: notV2 });
  assert.equal(JSON.parse(bare.out).error.code, "gateway_v1");
  const refused = await runWith(["deployment", "status", "--json"], {
    store: memoryStore({ schemaVersion: 1, active: { url: URL_ } }),
    handler: () => {
      throw new CliError("auth_required", "no", "", 3, { status: 401 });
    },
    env: { AGW_MANAGEMENT_KEY: "agw_mgmt_bad" },
  });
  assert.equal(refused.code, 3);
  assert.equal(JSON.parse(refused.out).error.code, "auth_required");
});

test("the hand-off link file is removed once the command stops waiting, and a notice is cleaned of control characters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agw-v2-"));
  try {
    const store = memoryStore(signedInState(URL_, "agw_oat_1"));
    const real = new StateStore(dir);
    let written = "";
    store.handoffFile = async (id: string, url: string) => (written = await real.handoffFile(id, url));
    let reads = 0;
    const result = await runWith(["provider", "add", "--type", "openai", "--browser"], {
      store,
      openBrowser: async () => false,
      handler: (path) => {
        if (path === "/v2/admin/provider-handoffs")
          return { id: "op_5", kind: "provider.add", url: `${URL_}/v2/approve/op_5#proof`, expiresAt: "2026-11-20T10:15:00.000Z", notice: "same\u001b[31m request" };
        reads++;
        return reads < 2
          ? { id: "op_5", kind: "provider.add.browser", state: "pending", createdAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-11-20T10:15:00.000Z" }
          : { id: "op_5", kind: "provider.add.browser", state: "completed", createdAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-11-20T10:15:00.000Z", result: { provider: PROVIDER } };
      },
    });
    assert.equal(result.code, 0, result.err);
    assert.ok(written);
    await assert.rejects(stat(written));
    assert.doesNotMatch(result.err, /\u001b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("connect with AGW_MANAGEMENT_KEY leaves the stored sign-in's account beside it, and a key's command names no stored account", async () => {
  const store = memoryStore(signedInState(URL_, "agw_oat_1"));
  const other = { ...SESSION, session: { ...SESSION.session, account: { id: "org_9", name: "Other" } } };
  const connected = await runWith(["deployment", "connect", "--url", URL_, "--json"], { store, handler: () => other, env: { AGW_MANAGEMENT_KEY: "agw_mgmt_env" } });
  assert.equal(connected.code, 0, connected.err);
  assert.equal(store.held.active?.account?.id, "org_1");
  const json = JSON.parse(connected.out);
  assert.equal(json.result.account.id, "org_9");
  assert.equal(json.context.accountId, undefined);
});

test("app update refuses --revision beside the shortcuts", async () => {
  const result = await run(["app", "update", "app_1", "--status", "disabled", "--revision", "7", "--json"], () => assert.fail("nothing is sent"));
  assert.equal(result.json().error.code, "conflicting_flags");
});

test("after logout, no command names the signed-out account", async () => {
  const store = memoryStore(signedInState(URL_, "agw_oat_1"));
  const out = sinks();
  const transport = fakeTransport(async (path) => {
    if (path === "/v2/console/capabilities") return { data: { billing: false, registrationOpen: true, googleAuth: false, oauth: true } };
    throw new Error(`unexpected ${path}`);
  }, () => ({ status: 200, data: {} }));
  const io = { env: {}, clock: fakeClock() };
  assert.equal(await main(["account", "logout", "--json"], { store, transport, stdout: out.stdout, stderr: out.stderr, io, catalogCache: new MemoryCatalogCache() }), 0);
  assert.equal(store.held.active?.account, undefined);
  // A state that still carries an account but no sign-in names none either.
  store.held = { schemaVersion: 1, active: { url: URL_, account: { id: "org_1", name: "Acme" } } };
  const status = sinks();
  const code = await main(["deployment", "status", "--json"], { store, transport, stdout: status.stdout, stderr: status.stderr, io, catalogCache: new MemoryCatalogCache() });
  assert.equal(code, 0, status.err.text);
  assert.equal(JSON.parse(status.out.text).context.accountId, undefined);
});

test("app conversations downloads batches and the media they name, and skips what is already there", async () => {
  const { gzipSync } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const media = `2026-11-01/media/${createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex")}.png`;
  const batch = gzipSync(`{"v":1,"request":{"image":"agw-media:${media}"}}\n`);
  const name = "2026-11-01/010203-aaaaaaaa.jsonl.gz";
  const output = await mkdtemp(join(tmpdir(), "agw-conversations-"));
  try {
    const answer = (path: string, options: RequestOptions) => {
      if (path.startsWith("/v2/admin/apps/app_1/conversations/file")) {
        assert.equal(options.binary, true);
        const file = new URL(path, URL_).searchParams.get("name");
        return file === name ? new Uint8Array(batch) : new Uint8Array([1, 2, 3]);
      }
      assert.match(path, /^\/v2\/admin\/apps\/app_1\/conversations\?/);
      assert.equal(new URL(path, URL_).searchParams.get("from"), "2026-11-01");
      return { app_id: "app_1", files: [{ name, size: batch.byteLength, records: 1, uploaded_at: "2026-11-01T01:02:03.000Z" }], next_cursor: null };
    };
    const argv = ["app", "conversations", "app_1", "--from", "2026-11-01", "--to", "2026-11-02", "--output", output, "--media", "--json"];
    const first = await run(argv, answer);
    assert.equal(first.code, 0, first.err);
    assert.deepEqual(
      { files: first.json().result.files, downloaded: first.json().result.downloaded, media: first.json().result.media },
      { files: 1, downloaded: 1, media: 1 },
    );
    assert.deepEqual(await readFile(join(output, name)), batch);
    assert.equal((await stat(join(output, media))).size, 3);

    const again = await run(argv, answer);
    assert.equal(again.code, 0, again.err);
    assert.equal(again.json().result.downloaded, 0);
    assert.equal(again.json().result.media, 0);
    assert.equal(again.calls.filter((call) => call.path.includes("/conversations/file")).length, 0);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("app conversations downloads again a media file whose content does not match its name, and leaves nothing half-written (Sol round 7)", async () => {
  const { gzipSync } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const { mkdir, readdir } = await import("node:fs/promises");
  const good = new Uint8Array([1, 2, 3]);
  const media = `2026-11-01/media/${createHash("sha256").update(good).digest("hex")}.png`;
  const batch = gzipSync(`{"v":1,"request":{"image":"agw-media:${media}"}}\n`);
  const name = "2026-11-01/010203-aaaaaaaa.jsonl.gz";
  const output = await mkdtemp(join(tmpdir(), "agw-conversations-"));
  try {
    const listing = (path: string) => {
      assert.match(path, /^\/v2\/admin\/apps\/app_1\/conversations\?/);
      return { app_id: "app_1", files: [{ name, size: batch.byteLength, records: 1, uploaded_at: "2026-11-01T01:02:03.000Z" }], next_cursor: null };
    };
    const argv = ["app", "conversations", "app_1", "--from", "2026-11-01", "--to", "2026-11-02", "--output", output, "--media", "--json"];

    // An earlier export was cut short: a media file of the right name holds the wrong bytes.
    await mkdir(join(output, "2026-11-01", "media"), { recursive: true });
    await writeFile(join(output, media), new Uint8Array([1, 2]));
    const repaired = await run(argv, (path: string) => {
      if (!path.startsWith("/v2/admin/apps/app_1/conversations/file")) return listing(path);
      const file = new URL(path, URL_).searchParams.get("name");
      return file === name ? new Uint8Array(batch) : good;
    });
    assert.equal(repaired.code, 0, repaired.err);
    assert.equal(repaired.json().result.media, 1);
    assert.deepEqual(new Uint8Array(await readFile(join(output, media))), good);

    // A download that fails part way leaves no file under the real name, and no temporary file.
    await rm(join(output, media));
    const failed = await run(argv, (path: string) => {
      if (!path.startsWith("/v2/admin/apps/app_1/conversations/file")) return listing(path);
      const file = new URL(path, URL_).searchParams.get("name");
      if (file === name) return new Uint8Array(batch);
      throw new CliError("network_error", "connection reset");
    });
    assert.notEqual(failed.code, 0);
    await assert.rejects(stat(join(output, media)));
    assert.deepEqual((await readdir(join(output, "2026-11-01", "media"))).filter((file) => file.endsWith(".part")), []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("app conversations keeps going past a media name the gateway does not hold, and lists it (Sol round 8)", async () => {
  const { gzipSync } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const good = new Uint8Array([1, 2, 3]);
  const real = `2026-11-01/media/${createHash("sha256").update(good).digest("hex")}.png`;
  // A prompt that quotes an example media name, which never was a file.
  const quoted = `2026-11-01/media/${"b".repeat(64)}.png`;
  const batch = gzipSync(`{"v":1,"request":{"text":"see agw-media:${quoted}","image":"agw-media:${real}"}}\n`);
  const name = "2026-11-01/010203-aaaaaaaa.jsonl.gz";
  const output = await mkdtemp(join(tmpdir(), "agw-conversations-"));
  try {
    const argv = ["app", "conversations", "app_1", "--from", "2026-11-01", "--to", "2026-11-02", "--output", output, "--media", "--json"];
    const result = await run(argv, (path: string) => {
      if (!path.startsWith("/v2/admin/apps/app_1/conversations/file")) {
        return { app_id: "app_1", files: [{ name, size: batch.byteLength, records: 1, uploaded_at: "2026-11-01T01:02:03.000Z" }], next_cursor: null };
      }
      const file = new URL(path, URL_).searchParams.get("name");
      if (file === name) return new Uint8Array(batch);
      if (file === real) return good;
      throw new CliError("not_found", "File not found", "Check the name.", 2, { status: 404 });
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.json().result.media, 1);
    assert.deepEqual(result.json().result.missing_media, [quoted]);
    assert.deepEqual(new Uint8Array(await readFile(join(output, real))), good);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("app conversations refuses a file name that would land outside its folder, and a malformed day", async () => {
  const output = await mkdtemp(join(tmpdir(), "agw-conversations-"));
  try {
    const outside = await run(["app", "conversations", "app_1", "--output", output, "--json"], () => ({
      app_id: "app_1",
      files: [{ name: "../escape.jsonl.gz", size: 1, records: 1, uploaded_at: "2026-11-01T01:02:03.000Z" }],
      next_cursor: null,
    }));
    assert.notEqual(outside.code, 0);
    assert.match(outside.out + outside.err, /outside the export folder/);
    await assert.rejects(stat(join(output, "..", "escape.jsonl.gz")));

    const badDay = await run(["app", "conversations", "app_1", "--from", "2026-13-40", "--output", output, "--json"], () => assert.fail("nothing is asked"));
    assert.notEqual(badDay.code, 0);
    assert.match(badDay.out + badDay.err, /YYYY-MM-DD/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("operation wait exits 5 when it stops waiting, and the step stays open", async () => {
  const result = await run(["operation", "wait", "op_7", "--timeout", "4", "--json"], (path) => {
    assert.equal(path, "/v2/admin/operations/op_7");
    return { id: "op_7", kind: "provider.add.browser", state: "pending", createdAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-11-20T10:15:00.000Z" };
  });
  assert.equal(result.code, 5);
  const error = result.json().error;
  assert.equal(error.code, "operation_pending");
  assert.match(error.nextAction, /agw operation wait op_7/);
});

