import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { CATALOG } from "../../src/contracts/catalog.ts";
import { parseAppConfig } from "../../src/shared/app-config.ts";
import { parse, commands, type CommandName } from "../src/parser.ts";
import {
  StateStore,
  reserveOutput,
  stateDirectory,
  type CliState,
} from "../src/state.ts";
import { Transport } from "../src/transport.ts";
import { Context, operationIdFor } from "../src/context.ts";
import { date, month, positive } from "../src/usage.ts";
import { main, type OutputSink } from "../src/main.ts";
import { fail } from "../src/common.ts";
import { fresh, hasCode, makeStore, served } from "./helpers.ts";

const credential = {
  credential: { token: "SENTINEL-MANAGEMENT-SECRET", expiresAt: "2030-01-01" },
  account: {
    id: "account-1",
    name: "Account",
    createdAt: "2026-09-14T00:00:00.000Z",
    claimed: false,
    expiresAt: null,
  },
  deployment: {
    id: "deploy-1",
    mode: "cloud",
    apiUrl: "https://api.example.com",
    consoleOrigin: "https://console.example.com",
  },
  unclaimedAccess: null,
};

test("all public commands parse help; forbidden and conflicting inputs fail before transport", () => {
  for (const command of Object.keys(commands) as CommandName[])
    assert.equal(parse([...command.split(" "), "--help"]).help, true);
  for (const args of [
    ["provider", "add", "--key", "SENTINEL"],
    ["app", "add", "--profile", "x"],
    ["provider", "add", "--browser", "--key-stdin"],
    ["deployment", "connect", "--url", "https://x.test", "--cloud"],
    ["app", "snippet", "id", "--provider", "x", "--endpoint", "y"],
  ])
    assert.throws(() => parse(args));
});

test("loopback transport refuses redirect and never forwards credentials to a different origin", async () => {
  let calls = 0;
  const transport = new Transport(async (url, init) => {
    calls++;
    assert.equal(url, "https://one.example/v1/cli/account");
    assert.equal(init.redirect, "manual");
    assert.equal((init.headers as Record<string, string>)["authorization"], "Bearer SENTINEL");
    return new Response("", {
      status: 302,
      headers: { location: "https://evil.example" },
    });
  });
  await assert.rejects(
    () =>
      transport.request("https://one.example", "/v1/cli/account", {
        key: "SENTINEL",
      }),
    hasCode("redirect_refused"),
  );
  assert.equal(calls, 1);
});

test("transport never echoes a submitted secret back out of an error body", async () => {
  const transport = new Transport(async () =>
    Response.json(
      { error: { code: "invalid_request", message: "Rejected key SENTINEL-KEY-VALUE" } },
      { status: 400 },
    ),
  );
  await assert.rejects(
    () =>
      transport.request("https://example.com", "/test", {
        method: "POST",
        body: { credential: { key: "SENTINEL-KEY-VALUE" } },
      }),
    (error: unknown) =>
      !JSON.stringify(error).includes("SENTINEL") &&
      !(error as Error).message.includes("SENTINEL"),
  );
});

test("transport reports the deployment's own explanation, sanitized and capped", async () => {
  const transport = new Transport(async () =>
    Response.json(
      {
        error: {
          code: "conflict",
          message: `Slug\n\u0000already in use ${"x".repeat(400)}`,
        },
      },
      { status: 409 },
    ),
  );
  await assert.rejects(
    () => transport.request("https://example.com", "/test"),
    (error: unknown) => {
      const failure = error as Error & { code: string };
      assert.equal(failure.code, "conflict");
      assert.match(failure.message, /\(HTTP 409\): Slug already in use x+…$/);
      assert.ok(failure.message.length < 360);
      return true;
    },
  );
});

test("protected state rejects corrupt prior state and output does not overwrite", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  await store.write(fresh());
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.read(), fresh());
  await writeFile(
    store.path,
    JSON.stringify({ schemaVersion: 1, operations: {} }),
  );
  await assert.rejects(() => store.read(), hasCode("invalid_state"));
  const out = await reserveOutput(join(dir, "key"));
  await out.write("SENTINEL");
  await out.cancel();
  assert.equal(await readFile(out.path, "utf8"), "SENTINEL");
  await assert.rejects(() => reserveOutput(out.path), hasCode("output_unavailable"));
});

test("a state file this release cannot read is refused, never replaced", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agw-state-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = home;
  t.after(() => {
    if (previous === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previous;
  });
  // The real state directory for this run, so the path a person would be told
  // to repair is the path the CLI actually reads.
  const directory = process.platform === "win32" ? home : stateDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const store = new StateStore(directory);
  for (const junk of [
    "{not json at all",
    // Parses, but is not a state: the `mutations` map holds a receipt that has
    // lost the proof it would have to be honoured with.
    JSON.stringify({
      schemaVersion: 1,
      active: null,
      operations: {},
      mutations: { "m-1": { id: "m-1", url: "https://example.com" } },
    }),
    // A connection that claims to be authenticated without a credential.
    JSON.stringify({
      schemaVersion: 1,
      active: { url: "https://example.com", authenticated: true },
      operations: {},
    }),
  ]) {
    await writeFile(store.path, junk, { mode: 0o600 });
    await assert.rejects(() => store.read(), hasCode("invalid_state"));
    // And a write does not get to replace what the read would not accept: the
    // file holds a credential and unfinished creations, so it is repaired by
    // hand or not at all.
    await assert.rejects(() => store.write(fresh()), hasCode("invalid_state"));
    assert.equal(await readFile(store.path, "utf8"), junk);
  }
});

test("lost bootstrap response reuses its token, and logout never bootstraps again", async () => {
  const state = fresh();
  const bodies: unknown[] = [];
  let failing = true;
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async (_url, _path, options = {}) => {
        bodies.push(options.body);
        if (failing) {
          failing = false;
          throw new Error("lost response");
        }
        return answered(options, bootstrapped);
      },
    },
    {},
  );
  await assert.rejects(() => ctx.bootstrap());
  await ctx.bootstrap();
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(state.active?.credential, credential.credential.token);
  // The bootstrap is done, so its record is too.
  assert.deepEqual(state.operations, {});
  delete state.active!.credential;
  state.active!.authenticated = false;
  await assert.rejects(() => ctx.bootstrap(), hasCode("login_required"));
  assert.equal(bodies.length, 2);
});

/** A poll answer the contract accepts, with the caller's own fields merged in. */
function pollResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "op",
    kind: "claim",
    expiresAt: "2030-01-01T00:00:00.000Z",
    deployment: credential.deployment,
    state: "completed",
    ...extra,
  };
}

/** How the deployment answers an operation: its id is the digest of the token it was sent. */
function answered(options: { body?: unknown }, extra: Record<string, unknown> = {}) {
  const body = options.body as { token: string; kind?: string };
  return {
    data: {
      id: operationIdFor(body.token),
      kind: body.kind ?? "bootstrap",
      state: "completed",
      expiresAt: "2030-01-01T00:00:00.000Z",
      deployment: credential.deployment,
      ...extra,
    },
  };
}

/** What a completed bootstrap carries beyond its envelope. */
const bootstrapped = {
  account: credential.account,
  result: { credential: { token: credential.credential.token }, unclaimedAccess: null },
};

/** A stored operation record for a token, as `reserveOperation` writes one. */
function record(token: string, kind: string, url = "https://example.com") {
  return { url, token, kind, requestHash: `hash-${token}`, accountId: credential.account.id, createdAt: "now" };
}

test("operation initiation retries its saved token, then completed polling cannot undo logout", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    account: credential.account,
    credential: credential.credential.token,
    authenticated: true,
  };
  let first = true;
  const tokens: string[] = [];
  const transport = {
    request: async (_url: string, path: string, options: { body?: unknown } = {}) => {
      if (path.endsWith("/capabilities"))
        return {
          data: {
            protocolVersion: 1,
            serverVersion: "0.1.0",
            deployment: credential.deployment,
            consoleOrigin: "https://console.example",
            providers: [],
            providerGateways: [],
          }
        };
      if (path.endsWith("/operations")) {
        tokens.push((options.body as { token: string }).token);
        if (first) {
          first = false;
          throw new Error("lost response");
        }
        return answered(options, { state: "pending", url: "https://console.example/cli/approve/op" });
      }
      return {
        data: pollResponse({
          id: operationIdFor(tokens[0]!),
          account: credential.account,
          result: { accountId: credential.account.id },
        }),
      };
    },
  };
  const ctx = new Context(makeStore(), state, transport, {
    "no-open": true,
    json: true,
  });
  await assert.rejects(() => ctx.operation("claim", {}));
  const pending = await ctx.operation("claim", {});
  assert.equal(tokens[0], tokens[1]);
  assert.equal(pending.id, operationIdFor(tokens[0]!));
  const result = await ctx.poll(pending.id);
  assert.equal(result.result?.credential, undefined);
  assert.equal(state.active?.credential, credential.credential.token);
  delete state.active!.credential;
  state.active!.authenticated = false;
  await ctx.poll(pending.id);
  assert.equal(state.active?.credential, undefined);
});

test("an operation is polled only on the deployment it was sent to", async () => {
  const state = fresh();
  state.active = { url: "https://other.example", credential: "management", authenticated: true };
  const id = operationIdFor("proof");
  state.operations[id] = record("proof", "claim");
  const ctx = new Context(
    makeStore(),
    state,
    { request: async () => assert.fail("no request to the wrong deployment") },
    {},
  );
  await assert.rejects(() => ctx.poll(id), hasCode("operation_context"));
});

test("an operation that delivers a key is never polled to stdout", async () => {
  const state = fresh();
  state.active = { url: "https://example.com", credential: "management", authenticated: true };
  const id = operationIdFor("proof");
  state.operations[id] = record("proof", "app.key.add");
  const ctx = new Context(
    makeStore(),
    state,
    { request: async () => assert.fail("a key is only ever collected by the command that files it") },
    {},
  );
  await assert.rejects(() => ctx.poll(id), hasCode("operation_key_output"));
  assert.ok(state.operations[id]);
});

test("a claim polled from another account's connection leaves that connection alone", async () => {
  const state = fresh();
  const other = { ...credential.account, id: "account-2", name: "Other" };
  state.active = { url: "https://example.com", credential: "other", account: other, authenticated: true };
  const id = operationIdFor("proof");
  state.operations[id] = record("proof", "claim");
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async () => ({
        data: pollResponse({ id, account: { ...credential.account, claimed: true } }),
      }),
    },
    {},
  );
  await ctx.poll(id);
  assert.deepEqual(state.active.account, other);
  assert.equal(state.active.credential, "other");
});

test("an expired browser step retires its token, so the same command starts afresh", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    account: credential.account,
    credential: "management",
    authenticated: true,
  };
  const tokens: string[] = [];
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async (_url: string, path: string, options: { body?: unknown } = {}) => {
        if (path.endsWith("/operations")) {
          tokens.push((options.body as { token: string }).token);
          return answered(options, { state: "expired" });
        }
        return { data: pollResponse({ state: "expired" }) };
      },
    },
    { "no-open": true, json: true },
  );
  await assert.rejects(() => ctx.operation("claim", {}), hasCode("operation_expired"));
  assert.deepEqual(state.operations, {});
  await assert.rejects(() => ctx.operation("claim", {}), hasCode("operation_expired"));
  assert.notEqual(tokens[0], tokens[1]);
  // Polling one that expired retires it the same way.
  const id = operationIdFor("proof");
  state.operations[id] = record("proof", "claim");
  await assert.rejects(() => ctx.wait(id, 1), hasCode("operation_expired"));
  assert.equal(state.operations[id], undefined);
});

test("an unfinished operation older than the deployment keeps it is not resent", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    account: credential.account,
    credential: "management",
    authenticated: true,
  };
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async (_url: string, path: string, options: { body?: unknown } = {}) => {
        if (path.endsWith("/operations")) return answered(options, { kind: "app.add", result: {} });
        return assert.fail(`unexpected ${path}`);
      },
    },
    {},
  );
  const [id] = await (ctx as unknown as {
    reserveOperation(kind: string, payload: unknown, url: string): Promise<[string, { createdAt: string }]>;
  }).reserveOperation("provider.add", { slug: "old" }, "https://example.com");
  state.operations[id]!.createdAt = new Date(Date.now() - 91 * 86_400_000).toISOString();
  await assert.rejects(
    () => ctx.operation("provider.add", { slug: "old" } as never),
    hasCode("operation_retry_expired"),
  );
  assert.equal(state.operations[id], undefined);
});

test("response parsing emits only declared fields, so no unknown credential reaches stdout", () => {
  const key = CATALOG.listAppKeys.response.parse({
    app_id: "app",
    keys: [
      {
        id: "key",
        name: "CI",
        key_prefix: "agw_",
        status: "active",
        created_at: "now",
        last_used_at: null,
        key: "SENTINEL",
        secretBlob: "SENTINEL",
      },
    ],
    managementKey: "SENTINEL",
  });
  assert.equal(JSON.stringify(key).includes("SENTINEL"), false);
  assert.deepEqual(Object.keys(key), ["app_id", "keys"]);

  const provider = CATALOG.listProviders.response.parse({
    providers: [
      {
        id: "p",
        type: "openai",
        slug: "openai",
        name: "OpenAI",
        secretHint: "…safe",
        providerGatewayId: null,
        gatewayRoute: null,
        baseUrl: null,
        pricing: null,
        ...served("openai"),
        revision: 1,
        status: "active",
        createdAt: "now",
        createdBy: "me",
        secretBlob: "SENTINEL",
      },
    ],
  });
  assert.equal(JSON.stringify(provider).includes("SENTINEL"), false);
  assert.equal(provider.providers[0]?.secretHint, "…safe");
});

test("a key creation never puts its plaintext in protected state, and replays from its metadata", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = fresh();
  state.active = {
    url: "https://example.com",
    credential: "management",
    account: credential.account,
    authenticated: true,
  };
  // Every write the CLI makes, as the state file would hold it.
  const written: string[] = [];
  const store = {
    ...makeStore(),
    write: async (value: CliState) => {
      written.push(JSON.stringify(value));
    },
    keyOutput: (_path: string | undefined, options: Parameters<typeof reserveOutput>[1]) =>
      reserveOutput(join(dir, "key"), options),
  };
  const minted = {
    id: "key-1",
    name: "CI",
    key: "SENTINEL-PLAINTEXT-KEY",
    key_prefix: "agw_",
    created_at: "now",
  };
  let requests = 0;
  const transport = {
    request: async (_url: string, _path: string, options: { body?: unknown } = {}) => {
      requests++;
      return answered(options, { result: { api_key: minted } });
    },
  };
  const ctx = new Context(store, state, transport, {});
  const created = await ctx.keyOperation("app.key.add", { app: "app-1", name: "CI" }, undefined);
  assert.equal(await readFile(join(dir, "key"), "utf8"), `${minted.key}\n`);
  assert.equal(created.key.id, minted.id);
  // The deployment holds the key sealed for a lost response; this machine
  // never writes it anywhere but the output file.
  assert.deepEqual(written.filter((value) => value.includes("SENTINEL")), []);
  assert.equal(JSON.stringify(created.operation).includes("SENTINEL"), false);

  // A replay before acknowledgment answers from the recorded metadata, and
  // asks the deployment nothing.
  const resumed = new Context(store, state, transport, {});
  const replayed = await resumed.keyOperation("app.key.add", { app: "app-1", name: "CI" }, undefined);
  assert.deepEqual(replayed.key, created.key);
  assert.equal(requests, 1);
});

test("a completed operation reports only declared outcome fields", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    credential: "management",
    account: credential.account,
    authenticated: true,
  };
  const id = operationIdFor("proof");
  state.operations[id] = record("proof", "claim");
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async () => ({
        data: pollResponse({
          id,
          result: {
            accountId: "account-1",
            // The approving human, which the gateway stores beside the
            // outcome and which is not the caller's.
            approvedBy: "user-SENTINEL",
          },
        })
      }),
    },
    {},
  );
  const result = await ctx.poll(id);
  assert.deepEqual(result.result, { accountId: "account-1" });
  assert.equal(JSON.stringify(result).includes("SENTINEL"), false);
});

test("calendar and wait validation rejects impossible dates and unbounded waits", () => {
  assert.equal(date("2024-02-29"), "2024-02-29");
  assert.throws(() => date("2025-02-29"));
  assert.throws(() => month("2025-13"));
  assert.throws(() => positive("0"));
  assert.throws(() => positive("4000"));
  assert.equal(positive("300"), 300);
});

test("an operation reuses its saved token after a lost response, and a new one follows acknowledgment", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    credential: "management",
    account: credential.account,
    authenticated: true,
  };
  const tokens: string[] = [];
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async (_url, _path, options = {}) => {
        tokens.push((options.body as { token: string }).token);
        if (tokens.length === 1) throw new Error("lost response");
        return answered(options, {
          result: {
            app: {
              id: "stable-app",
              revision: 1,
              name: "Test",
              config: appBody().config,
              status: "active",
              created_at: "now",
              updated_at: "now",
            },
            api_key: null,
          },
        });
      },
    },
    {},
  );
  await assert.rejects(() => ctx.operation("app.add", appBody()));
  assert.equal(Object.keys(state.operations).length, 1);
  const result = await ctx.operation("app.add", appBody());
  assert.equal(result.result?.app?.id, "stable-app");
  assert.equal(tokens[0], tokens[1]);
  // Printed, so released: the same command run again is a new operation.
  await ctx.acknowledgeOutput();
  assert.deepEqual(state.operations, {});
  await ctx.operation("app.add", appBody());
  assert.notEqual(tokens[2], tokens[0]);
});

test("a rate limited operation keeps its token, a refused one leaves none behind", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    credential: "management",
    account: credential.account,
    authenticated: true,
  };
  const tokens: string[] = [];
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async (_url, _path, options = {}) => {
        tokens.push((options.body as { token: string }).token);
        return tokens.length === 1
          ? fail("rate_limited", "Too many attempts.", undefined, 3, { status: 429 })
          : fail("invalid_request", "Duplicate slug.", undefined, 3, { status: 400 });
      },
    },
    {},
  );

  // Refused for now, so the record stays and the retry arrives under the same
  // token rather than as a second operation.
  await assert.rejects(() => ctx.operation("app.add", appBody()), hasCode("rate_limited"));
  assert.equal(Object.keys(state.operations).length, 1);

  // Refused for good: nothing was written, so keeping the record would only
  // send the refused token again.
  await assert.rejects(() => ctx.operation("app.add", appBody()), hasCode("invalid_request"));
  assert.equal(tokens[0], tokens[1]);
  assert.deepEqual(state.operations, {});
});

test("a refused bootstrap leaves no pending account reservation", async () => {
  const refusal = (code: string, status: number) =>
    new Context(
      makeStore(),
      fresh(),
      { request: async () => fail(code, "Refused.", undefined, 3, { status }) },
      {},
    );
  const bootstraps = (ctx: Context) =>
    Object.values(ctx.state.operations).filter((entry) => entry.kind === "bootstrap");

  const limited = refusal("rate_limited", 429);
  await assert.rejects(() => limited.bootstrap(), hasCode("rate_limited"));
  assert.equal(bootstraps(limited).length, 1, "a retryable refusal keeps one reserved token");

  const expired = refusal("account_expired", 403);
  await assert.rejects(() => expired.bootstrap(), hasCode("account_expired"));
  assert.deepEqual(bootstraps(expired), []);
});

/** The smallest application write the contract accepts. */
function appBody() {
  return {
    name: "Test",
    config: parseAppConfig({
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { mode: "all" }, model_rewrites: {} },
    }),
  };
}

test("advanced public app config and provider gateway IDs survive response parsing", () => {
  const config = {
    authentication: { type: "api_key", end_user: { source: "none" } },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
    endpoints: {
      answer: {
        provider: "openai",
        model: "example",
        api_style: "responses",
        params: {
          response_format: {
            json_schema: {
              schema: {
                type: "object",
                properties: { custom: { type: "string" } },
              },
            },
          },
        },
      },
    },
  };
  const parsed = CATALOG.getApp.response.parse({
    app: {
      id: "test",
      revision: 1,
      name: "Test",
      config,
      status: "active",
      created_at: "now",
      updated_at: "now",
    },
  });
  // Parsed, so the schema's own defaults are there too; everything the body
  // named survives them untouched.
  assert.deepEqual(parsed.app.config, parseAppConfig(config));

  const gateway = CATALOG.listProviderGateways.response.parse({
    gateways: [
      {
        id: "g",
        name: "CF",
        type: "cf_aig",
        secretHint: "…safe",
        providerCount: 0,
        referencedCount: 0,
        revision: 1,
        status: "active",
        createdAt: "now",
        updatedAt: "now",
        createdBy: "me",
        config: { accountId: "cf-account", gatewayId: "cf-gateway", token: "SENTINEL" },
      },
    ],
  });
  assert.deepEqual(gateway.gateways[0]?.config, {
    accountId: "cf-account",
    gatewayId: "cf-gateway",
  });
});

test("claim completion records the claimed account and keeps this connection signed in", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    credential: "bootstrap",
    account: credential.account,
    authenticated: true,
  };
  const id = operationIdFor("proof");
  state.operations[id] = record("proof", "claim", state.active.url);
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async () => ({
        data: pollResponse({
          id,
          result: { accountId: credential.account.id },
          account: { ...credential.account, claimed: true },
        })
      }),
    },
    {},
  );
  await ctx.poll(id);
  assert.equal(state.active?.credential, "bootstrap");
  assert.equal(state.active?.authenticated, true);
  assert.equal(state.active?.account?.claimed, true);
});

test("fresh onboarding output includes exact free access dates without management secrets", async () => {
  const state = fresh();
  let printed = "";
  const trial = { limit: 1000, endsAt: "2026-10-14T00:00:00.000Z" };
  const account = { ...credential.account, expiresAt: "2026-11-14T00:00:00.000Z" };
  const code = await main(
    [
      "app", "add", "--type", "ios", "--team-id", "ABCDE12345",
      "--bundle-id", "com.example.app", "--name", "Example",
      "--no-input", "--json",
    ],
    {
      store: {
        ...makeStore(),
        read: async () => state,
      },
      stdout: {
        write: (text: string) => {
          printed += text;
        },
      },
      transport: {
        request: async (_url, path, options = {}) => {
          if (path.endsWith("/bootstrap"))
            return answered(options, {
              account,
              result: { credential: { token: credential.credential.token }, unclaimedAccess: trial },
            });
          if (path.endsWith("/operations"))
            return answered(options, {
              result: {
                app: {
                  id: "app",
                  revision: 1,
                  name: "Example",
                  config: appleConfig(),
                  status: "active",
                  created_at: "now",
                  updated_at: "now",
                },
                api_key: null,
              },
            });
          return { data: { providers: [] } };
        },
      },
    },
  );
  assert.equal(code, 0, printed);
  assert.ok(printed.includes(trial.endsAt));
  assert.ok(printed.includes(account.expiresAt));
  assert.ok(printed.includes("1000"));
  assert.equal(printed.includes("SENTINEL"), false);
});

function appleConfig() {
  return {
    authentication: {
      type: "apple_app_attest",
      end_user: { source: "app_install" },
      app_attest: {
        team_id: "ABCDE12345",
        bundle_id: "com.example.app",
        environments: ["production", "development"],
      },
    },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
    limits: {
      per_user: {
        requests: { per_minute: 10, per_day: 300 },
        spending: { monthly_usd: null },
      },
      per_app: {
        requests: { per_minute: null, per_day: null },
        spending: { monthly_usd: null },
      },
    },
  };
}

test("retained account usage preserves deleted app attribution and actual backend coverage", () => {
  const totals = {
    requests: 3,
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 4,
    cost_usd: 0.01,
    errors: 0,
    };
  const response = {
    accountId: "account",
    month: "2026-09",
    totals,
    apps: [
      {
        appId: "deleted-app",
        deleted: true,
        firstRecord: "2026-09-01",
        ...totals,
      },
    ],
    coverage: {
      scope: "retained_account_usage" as const,
      firstRecord: "2026-09-01",
    },
  };
  assert.deepEqual(CATALOG.getCliUsage.response.parse(response), response);
});

test("successful stdout acknowledges creation so delete and re-add makes a new request", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    account: credential.account,
    credential: "management",
    authenticated: true,
  };
  const store = {
    ...makeStore(),
    read: async () => state,
  };
  const created = new Set<string>();
  const tokens: string[] = [];
  const transport = {
    request: async (
      _url: string,
      path: string,
      options: { method?: string; body?: unknown } = {},
    ) => {
      if (path.endsWith("/operations")) {
        const id = `app-${tokens.length}`;
        tokens.push((options.body as { token: string }).token);
        created.add(id);
        return answered(options, { result: appResponse(id) });
      }
      if (options.method === "DELETE") {
        created.clear();
        return {
          data: {
            deleted: true,
            app_id: "app-0",
            removed_users: 0,
            usage_events_retained: true,
          }
        };
      }
      return { data: { ...appResponse([...created][0] ?? "app"), providers: [] } };
    },
  };
  const args = [
    "app", "add", "--type", "ios", "--team-id", "ABCDE12345",
    "--bundle-id", "com.example.app", "--name", "Example", "--no-input", "--json",
  ];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      // The operation's record must stay durable until output flushes.
      const printed = JSON.parse(String(chunk)) as { result?: { app?: unknown } };
      if (printed.result?.app) assert.equal(Object.keys(state.operations).length, 1);
      setImmediate(callback);
    },
  });
  assert.equal(await main(args, { store, transport, stdout }), 0);
  assert.equal(Object.keys(state.operations).length, 0);
  await transport.request(state.active.url, "/v1/admin/apps/app-0", { method: "DELETE" });
  assert.equal(await main(args, { store, transport, stdout }), 0);
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  assert.equal(created.size, 1);
});

function appResponse(id: string) {
  return {
    app: {
      id,
      revision: 1,
      name: "Example",
      config: parseAppConfig(appleConfig()),
      status: "active",
      created_at: "now",
      updated_at: "now",
    },
    api_key: null,
  };
}

test("a pre-output crash resends the same token, then acknowledgment permits another", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    account: credential.account,
    credential: "management",
    authenticated: true,
  };
  const tokens: string[] = [];
  const transport = {
    request: async (_url: string, _path: string, options: { body?: unknown } = {}) => {
      const token = (options.body as { token: string }).token;
      if (!tokens.includes(token)) tokens.push(token);
      // The deployment answers a token it already ran with what that run made.
      return answered(options, { result: { provider: providerRow(`provider-${tokens.indexOf(token) + 1}`) } });
    },
  };
  const first = new Context(makeStore(), state, transport, {});
  await first.operation("provider.add", providerBody());
  // The command died before stdout: nothing acknowledged it.
  const resumed = new Context(makeStore(), state, transport, {});
  assert.equal(
    (await resumed.operation("provider.add", providerBody())).result?.provider?.id,
    "provider-1",
  );
  assert.equal(tokens.length, 1);
  await resumed.acknowledgeOutput();
  await resumed.operation("provider.add", providerBody());
  assert.equal(tokens.length, 2);
});

function providerBody() {
  return { type: "openai" as const, name: "Test", secret: "sk-test" };
}

function providerRow(id: string) {
  return {
    id,
    type: "openai",
    slug: "openai",
    name: "Test",
    secretHint: "…st",
    providerGatewayId: null,
    gatewayRoute: null,
    baseUrl: null,
    pricing: null,
    ...served("openai"),
    revision: 1,
    status: "active",
    createdAt: "now",
    createdBy: "me",
  };
}

test("failed stdout acknowledgment retains the operation's record without failing success", async () => {
  const state: CliState = fresh();
  state.active = {
    url: "https://example.com",
    account: credential.account,
    credential: "management",
    authenticated: true,
  };
  let failSave = false;
  const store = {
    ...makeStore(),
    write: async () => {
      if (failSave) throw new Error("disk full");
    },
  };
  const ctx = new Context(
    store,
    state,
    { request: async (_url, _path, options = {}) => answered(options, { result: { provider: providerRow("provider") } }) },
    {},
  );
  await ctx.operation("provider.add", providerBody());
  failSave = true;
  await ctx.acknowledgeOutput();
  assert.equal(Object.keys(state.operations).length, 1);
});

/** The injected sink `main` accepts is deliberately minimal. */
const _sinkShape: OutputSink = { write: () => {} };
void _sinkShape;

test("a write breaks a lock whose owner is gone and keeps a concurrent command's record", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const mine = await store.read();
  await store.write(mine);
  // A lock left behind by a command that was killed must not strand the state.
  await writeFile(
    join(dir, "connection.lock"),
    JSON.stringify({ pid: 0x7ffffffe, host: hostname() }),
    { mode: 0o600 },
  );
  const other = new StateStore(dir);
  const theirs = await other.read();
  theirs.operations["theirs"] = record("b", "claim");
  await other.write(theirs);
  mine.operations["mine"] = record("a", "claim");
  await store.write(mine);
  assert.deepEqual(Object.keys(mine.operations).sort(), ["mine", "theirs"]);
  const merged = await new StateStore(dir).read();
  assert.deepEqual(Object.keys(merged.operations).sort(), ["mine", "theirs"]);
  // A write this command made itself still wins over the copy on disk.
  delete mine.operations["theirs"];
  await store.write(mine);
  assert.deepEqual(Object.keys((await new StateStore(dir).read()).operations), ["mine"]);  // And a record another command dropped stays dropped when this one, which
  // never touched it, writes something unrelated.
  const third = new StateStore(dir);
  const later = await third.read();
  delete later.operations["mine"];
  await third.write(later);
  mine.operations["unrelated"] = record("c", "claim");
  await store.write(mine);
  assert.deepEqual(Object.keys((await new StateStore(dir).read()).operations), ["unrelated"]);
});

test("a state file keeps working on Windows, where every file reports mode 0666", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-win-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  await store.write(fresh());
  await chmod(store.path, 0o666);
  await assert.rejects(() => store.read(), hasCode("unsafe_storage"));
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() =>
    Object.defineProperty(process, "platform", { value: real, configurable: true }),
  );
  assert.deepEqual(await store.read(), fresh());
  await store.write(fresh());
});

test("logout strips the connection's credential without a request", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    credential: "SENTINEL-ACTIVE",
    authenticated: true,
  };
  const code = await main(["account", "logout", "--json"], {
    store: { ...makeStore(), read: async () => state },
    stdout: { write: () => {} },
    transport: {
      request: async () => {
        throw new Error("logout makes no request");
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(JSON.stringify(state).includes("SENTINEL"), false);
  assert.equal(state.active?.authenticated, false);
});

test("a deployment's vault key lives in its own file and is never regenerated", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-vault-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const key = await store.vaultKey("deployment-1");
  const path = join(dir, "vault-keys", "deployment-1.key");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  // A second install of the same deployment must not mint a replacement.
  assert.equal(await store.vaultKey("deployment-1"), key);
  assert.notEqual(await store.vaultKey("deployment-2"), key);
  await store.write(fresh());
  assert.equal((await readFile(store.path, "utf8")).includes(key), false);
  await writeFile(path, "", { mode: 0o600 });
  await assert.rejects(() => store.vaultKey("deployment-1"), hasCode("unsafe_storage"));
});

test("commands started side by side reserve one account and one operation token", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-claim-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bootstrapTokens = new Set<string>();
  const operationTokens: string[] = [];
  // Both commands read the state before either of them has written anything.
  const start = async () => {
    const store = new StateStore(dir);
    const state = await store.read();
    return new Context(
      store,
      state,
      {
        request: async (_url, path, options = {}) => {
          const token = (options.body as { token: string }).token;
          if (path.endsWith("/bootstrap")) {
            bootstrapTokens.add(token);
            return answered(options, bootstrapped);
          }
          operationTokens.push(token);
          return answered(options, { result: appResponse("same") });
        },
      },
      {},
    );
  };
  const first = await start();
  const second = await start();
  await first.bootstrap();
  await second.bootstrap();
  assert.equal(bootstrapTokens.size, 1);
  assert.equal(second.active?.credential, credential.credential.token);
  const body = { name: "Same", config: parseAppConfig(appleConfig()) };
  await first.operation("app.add", body);
  await second.operation("app.add", body);
  assert.equal(operationTokens[0], operationTokens[1]);
  await second.operation("app.add", { ...body, name: "Other" });
  assert.notEqual(operationTokens[2], operationTokens[0]);
});
