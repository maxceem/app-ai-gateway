import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { responseSchemas } from "../../src/contracts/operation-schemas.ts";
import { parse, commands, type CommandName } from "../src/parser.ts";
import {
  StateStore,
  reserveOutput,
  type CliState,
  type StoredKeyMetadata,
} from "../src/state.ts";
import { Transport } from "../src/transport.ts";
import { Context } from "../src/context.ts";
import { date, month, positive } from "../src/usage.ts";
import { main, type OutputSink } from "../src/main.ts";
import { fail } from "../src/common.ts";
import { fresh, hasCode, makeStore } from "./helpers.ts";

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
  trial: null,
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

test("lost bootstrap response reuses proofs, and logout never bootstraps again", async () => {
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
        return { data: credential };
      },
    },
    {},
  );
  await assert.rejects(() => ctx.bootstrap());
  await ctx.bootstrap();
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(state.active?.credential, credential.credential.token);
  delete state.active!.credential;
  state.active!.authenticated = false;
  await assert.rejects(() => ctx.bootstrap(), hasCode("login_required"));
  assert.equal(bodies.length, 2);
});

/** A poll answer the contract accepts, with the caller's own fields merged in. */
function pollResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "op",
    expiresAt: "2030-01-01T00:00:00.000Z",
    deployment: credential.deployment,
    state: "completed",
    ...extra,
  };
}

test("operation initiation retries persisted proof, then completed polling cannot undo logout", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    account: credential.account,
    credential: credential.credential.token,
    authenticated: true,
  };
  let first = true;
  const proofs: unknown[] = [];
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
        proofs.push((options.body as { pollToken?: string } | undefined)?.pollToken);
        if (first) {
          first = false;
          throw new Error("lost response");
        }
        return {
          data: {
            id: "op",
            state: "pending",
            url: "https://console.example/handoff",
            expiresAt: "2030-01-01T00:00:00.000Z",
            deployment: credential.deployment,
          }
        };
      }
      return {
        data: pollResponse({ account: credential.account, result: { accountId: credential.account.id } })
      };
    },
  };
  const ctx = new Context(makeStore(), state, transport, {
    "no-open": true,
    json: true,
  });
  await assert.rejects(() => ctx.operation("claim", {}));
  await ctx.operation("claim", {});
  assert.equal(proofs[0], proofs[1]);
  const result = await ctx.poll("op");
  assert.equal("credential" in result, false);
  assert.equal(state.active?.credential, credential.credential.token);
  delete state.active!.credential;
  state.active!.authenticated = false;
  state.generation = (state.generation ?? 0) + 1;
  await ctx.poll("op");
  assert.equal(state.active?.credential, undefined);
});

test("stale authentication operation refuses activating account after connection changed", async () => {
  const state = fresh();
  state.generation = 2;
  state.operations["op"] = {
    url: "https://example.com",
    pollToken: "proof",
    kind: "claim",
    generation: 1,
  };
  const ctx = new Context(
    makeStore(),
    state,
    { request: async () => ({ data: pollResponse() }) },
    {},
  );
  await assert.rejects(() => ctx.poll("op"), hasCode("operation_context"));
  assert.equal(state.active, null);
});

test("response parsing emits only declared fields, so no unknown credential reaches stdout", () => {
  const key = responseSchemas.listAppKeys.parse({
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

  const provider = responseSchemas.listProviders.parse({
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

test("a completed key creation leaves no plaintext in protected state, and replays from its metadata", async () => {
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
  };
  const minted = {
    id: "key-1",
    name: "CI",
    key: "SENTINEL-PLAINTEXT-KEY",
    key_prefix: "agw_",
    created_at: "now",
  };
  const transport = {
    request: async (_url: string, _path: string, options: { method?: string } = {}) =>
      options.method === "POST"
        ? { data: minted }
        : {
            data: {
              app_id: "app-1",
              keys: [
                {
                  id: "key-1",
                  name: "CI",
                  key_prefix: "agw_",
                  status: "active",
                  created_at: "now",
                  last_used_at: null,
                },
              ],
            }
          },
  };
  const ctx = new Context(store, state, transport, {});
  const created = await ctx.create("createAppKey", ["app-1"], { name: "CI" });
  assert.equal("key" in created.data && created.data.key, minted.key);
  const stored: StoredKeyMetadata = {
    id: minted.id,
    name: minted.name,
    key_prefix: minted.key_prefix,
    created_at: minted.created_at,
    storagePath: "/tmp/agw-key",
    contentHash: "hash",
  };
  await created.keyStored?.(stored);
  // Until here the plaintext is on disk on purpose: that recovery copy is what
  // lets a failed `--key-output` write be retried without minting a new key.
  assert.ok(
    written.some((value) => value.includes("SENTINEL")),
    "the recovery copy is written before the key output is",
  );
  const beforeCompletion = written.length;
  await created.complete();

  // Delivery ends that lifetime. The receipt that outlives it — until stdout is
  // acknowledged, and across a crash in between — must carry no key at all.
  const receipt = Object.values(state.mutations ?? {})[0]!;
  assert.equal(receipt.response, undefined);
  assert.equal(JSON.stringify(receipt).includes("SENTINEL"), false);
  assert.deepEqual(
    written.slice(beforeCompletion).filter((value) => value.includes("SENTINEL")),
    [],
    "no state write after delivery may contain the plaintext",
  );

  // A replay before acknowledgment still answers, from the recorded metadata.
  const resumed = new Context(store, state, transport, {});
  const replayed = await resumed.create("createAppKey", ["app-1"], { name: "CI" });
  assert.deepEqual(replayed.keyMetadata, stored);
  assert.equal("key" in replayed.data, false);
  assert.equal(JSON.stringify(replayed.data).includes("SENTINEL"), false);
});

test("a completed handoff reports only declared outcome fields", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    credential: "management",
    account: credential.account,
    authenticated: true,
  };
  state.generation = 1;
  state.operations["claim"] = {
    url: "https://example.com",
    pollToken: "proof",
    kind: "claim",
    generation: 1,
  };
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async () => ({
        data: pollResponse({
          id: "claim",
          result: {
            accountId: "account-1",
            // The approving human and the internal compare-and-swap marker the
            // gateway stores beside the outcome; neither is the caller's.
            approvedBy: "user-SENTINEL",
            transition: "b2f0e6c4-SENTINEL",
          },
        })
      }),
    },
    {},
  );
  const result = await ctx.poll("claim");
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

test("resource creates reuse pre-persisted idempotency authorization after a lost response", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    credential: "management",
    account: credential.account,
    authenticated: true,
  };
  let attempts = 0;
  const headers: unknown[] = [];
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async (_url, _path, options = {}) => {
        attempts++;
        headers.push(options.headers);
        if (attempts === 1) throw new Error("lost response");
        return {
          data: {
            app: {
              id: "stable-app",
              revision: 1,
              name: "Test",
              config: {},
              status: "active",
              created_at: "now",
              updated_at: "now",
            },
            resolved: null,
            config_error: null,
            api_key: null,
          }
        };
      },
    },
    {},
  );
  await assert.rejects(() => ctx.create("createApp", [], appBody()));
  const result = await ctx.create("createApp", [], appBody());
  assert.deepEqual(headers[0], headers[1]);
  assert.equal(Object.keys(state.mutations ?? {}).length, 1);
  await result.complete();
  const mutation = Object.values(state.mutations ?? {})[0]!;
  assert.ok(mutation.completedAt);
  assert.equal(mutation.response, undefined);
  await ctx.create("createApp", [], appBody());
  assert.equal(attempts, 2);
});

test("a rate limited creation keeps its receipt, a refused one leaves none behind", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    credential: "management",
    account: credential.account,
    authenticated: true,
  };
  let attempts = 0;
  const authorizations: unknown[] = [];
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async (_url, _path, options = {}) => {
        attempts++;
        authorizations.push(options.headers?.["Idempotency-Key"]);
        return attempts === 1
          ? fail("rate_limited", "Too many attempts.", undefined, 3, { status: 429 })
          : fail("invalid_request", "Duplicate slug.", undefined, 3, { status: 400 });
      },
    },
    {},
  );

  // Refused for now, so the receipt stays and the retry arrives under the same
  // authorization rather than as a second creation.
  await assert.rejects(() => ctx.create("createApp", [], appBody()), hasCode("rate_limited"));
  assert.equal(Object.keys(state.mutations ?? {}).length, 1);

  // Refused for good: nothing was created, the deployment committed no receipt
  // of its own, and keeping this one would only refuse the same command as an
  // unfinished creation once it is ninety days old.
  await assert.rejects(() => ctx.create("createApp", [], appBody()), hasCode("invalid_request"));
  assert.equal(authorizations[0], authorizations[1]);
  assert.deepEqual(state.mutations, {});
});

test("a refused bootstrap leaves no pending account reservation", async () => {
  const refusal = (code: string, status: number) =>
    new Context(
      makeStore(),
      fresh(),
      { request: async () => fail(code, "Refused.", undefined, 3, { status }) },
      {},
    );

  const limited = refusal("rate_limited", 429);
  await assert.rejects(() => limited.bootstrap(), hasCode("rate_limited"));
  assert.ok(limited.state.bootstrap, "a retryable refusal keeps one reserved proof");

  const expired = refusal("account_expired", 403);
  await assert.rejects(() => expired.bootstrap(), hasCode("account_expired"));
  assert.equal(expired.state.bootstrap, undefined);
});

/** The smallest application write the contract accepts. */
function appBody() {
  return {
    name: "Test",
    config: {
      authentication: { type: "api_key" as const },
      routing: { providers: { mode: "all" as const }, model_rewrites: {} },
    },
  };
}

test("advanced public app config and provider gateway IDs survive response parsing", () => {
  const config = {
    authentication: { type: "api_key" },
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
  const parsed = responseSchemas.getApp.parse({
    app: {
      id: "test",
      revision: 1,
      name: "Test",
      config,
      status: "active",
      created_at: "now",
      updated_at: "now",
    },
    resolved: null,
    config_error: null,
  });
  assert.deepEqual(parsed.app.config, config);

  const gateway = responseSchemas.listProviderGateways.parse({
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
  state.generation = 1;
  state.operations["claim"] = {
    url: state.active.url,
    pollToken: "proof",
    kind: "claim",
    generation: 1,
  };
  const ctx = new Context(
    makeStore(),
    state,
    {
      request: async () => ({
        data: pollResponse({
          id: "claim",
          result: { accountId: credential.account.id },
          account: { ...credential.account, claimed: true },
        })
      }),
    },
    {},
  );
  await ctx.poll("claim");
  assert.equal(state.active?.credential, "bootstrap");
  assert.equal(state.active?.authenticated, true);
  assert.equal(state.active?.account?.claimed, true);
});

test("expired local creation proofs never retry a forgotten remote mutation", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    account: credential.account,
    credential: "secret",
    authenticated: true,
  };
  const ctx = new Context(
    makeStore(),
    state,
    { request: async () => assert.fail("no network") },
    {},
  );
  const pending = await ctx.prepareCreate("/v1/admin/apps", appBody());
  pending.createdAt = "2020-01-01T00:00:00Z";
  await assert.rejects(
    () => ctx.create("createApp", [], appBody()),
    hasCode("resource_retry_expired"),
  );
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
        request: async (_url, path) => {
          if (path.endsWith("/bootstrap"))
            return { data: { ...credential, account, trial } };
          if (path.endsWith("/apps"))
            return {
              data: {
                app: {
                  id: "app",
                  revision: 1,
                  name: "Example",
                  config: appleConfig(),
                  status: "active",
                  created_at: "now",
                  updated_at: "now",
                },
                resolved: null,
                config_error: null,
                api_key: null,
              }
            };
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

test("expired or undated pending bootstrap refuses network and preserves recovery proof", async () => {
  for (const createdAt of [undefined, "2020-01-01T00:00:00Z"]) {
    const state = fresh();
    state.bootstrap = {
      idempotencyKey: "saved-id",
      pollToken: "saved-proof",
      ...(createdAt ? { createdAt } : {}),
    };
    const ctx = new Context(
      makeStore(),
      state,
      { request: async () => assert.fail("must not recreate") },
      {},
    );
    await assert.rejects(() => ctx.bootstrap(), hasCode("bootstrap_retry_expired"));
    assert.equal(state.bootstrap.pollToken, "saved-proof");
  }
});

test("retained account usage preserves deleted app attribution and actual backend coverage", () => {
  const totals = {
    requests: 3,
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 4,
    cost_usd: 0.01,
    errors: 0,
    blocked: 0,
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
      historicalAttribution:
        "Earlier unowned history cannot be assigned or counted for this account.",
    },
  };
  assert.deepEqual(responseSchemas.getCliUsage.parse(response), response);
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
  const proofs: unknown[] = [];
  const transport = {
    request: async (
      _url: string,
      _path: string,
      options: { method?: string; headers?: Record<string, string> } = {},
    ) => {
      if (options.method === "POST") {
        const id = `app-${proofs.length}`;
        proofs.push(options.headers?.["Idempotency-Key"]);
        created.add(id);
        return { data: appResponse(id) };
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
      // The completed recovery receipt must remain durable until output flushes.
      const printed = JSON.parse(String(chunk)) as { result?: { app?: unknown } };
      if (printed.result?.app) assert.equal(Object.keys(state.mutations ?? {}).length, 1);
      setImmediate(callback);
    },
  });
  assert.equal(await main(args, { store, transport, stdout }), 0);
  assert.equal(Object.keys(state.mutations ?? {}).length, 0);
  await transport.request(state.active.url, "/v1/admin/apps/app-0", { method: "DELETE" });
  assert.equal(await main(args, { store, transport, stdout }), 0);
  assert.equal(proofs.length, 2);
  assert.notEqual(proofs[0], proofs[1]);
  assert.equal(created.size, 1);
});

function appResponse(id: string) {
  return {
    app: {
      id,
      revision: 1,
      name: "Example",
      config: appleConfig(),
      status: "active",
      created_at: "now",
      updated_at: "now",
    },
    resolved: null,
    config_error: null,
    api_key: null,
  };
}

test("pre-output crash replays completed creation once, then acknowledgment permits another", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    account: credential.account,
    credential: "management",
    authenticated: true,
  };
  let posts = 0;
  const transport = {
    request: async () => {
      posts++;
      return { data: { provider: providerRow(`provider-${posts}`) } };
    },
  };
  const first = new Context(makeStore(), state, transport, {});
  await (await first.create("createProvider", [], providerBody())).complete();
  const resumed = new Context(makeStore(), state, transport, {});
  assert.equal(
    (await resumed.create("createProvider", [], providerBody())).data.provider.id,
    "provider-1",
  );
  assert.equal(posts, 1);
  await resumed.acknowledgeOutput();
  await resumed.create("createProvider", [], providerBody());
  assert.equal(posts, 2);
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
    revision: 1,
    status: "active",
    createdAt: "now",
    createdBy: "me",
  };
}

test("failed stdout acknowledgment retains the completed receipt without failing success", async () => {
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
    { request: async () => ({ data: { provider: providerRow("provider") } }) },
    {},
  );
  await (await ctx.create("createProvider", [], providerBody())).complete();
  failSave = true;
  await ctx.acknowledgeOutput();
  assert.equal(Object.keys(state.mutations ?? {}).length, 1);
  assert.ok(Object.values(state.mutations ?? {})[0]?.completedAt);
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
  theirs.operations["theirs"] = {
    url: "https://example.com",
    pollToken: "b",
    kind: "claim",
  };
  await other.write(theirs);
  mine.operations["mine"] = {
    url: "https://example.com",
    pollToken: "a",
    kind: "claim",
  };
  await store.write(mine);
  assert.deepEqual(Object.keys(mine.operations).sort(), ["mine", "theirs"]);
  const merged = await new StateStore(dir).read();
  assert.deepEqual(Object.keys(merged.operations).sort(), ["mine", "theirs"]);
  // A write this command made itself still wins over the copy on disk.
  delete mine.operations["theirs"];
  await store.write(mine);
  assert.deepEqual(Object.keys((await new StateStore(dir).read()).operations), ["mine"]);
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

test("logout strips the credential of the connection this one replaced", async () => {
  const state = fresh();
  state.active = {
    url: "https://example.com",
    credential: "SENTINEL-ACTIVE",
    authenticated: true,
  };
  state.previous = {
    url: "https://old.example",
    credential: "SENTINEL-PREVIOUS",
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
  assert.equal(state.previous?.authenticated, false);
});

test("a deployment's vault key lives in its own file, is adopted once and never regenerated", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-vault-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const key = await store.vaultKey("deployment-1", "SENTINEL-LEGACY-KEK");
  assert.equal(key, "SENTINEL-LEGACY-KEK");
  const path = join(dir, "vault-keys", "deployment-1.key");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  // A second install of the same deployment must not mint a replacement.
  assert.equal(await store.vaultKey("deployment-1"), key);
  assert.equal(await store.vaultKey("deployment-1", "different"), key);
  assert.notEqual(await store.vaultKey("deployment-2"), key);
  await store.write(fresh());
  assert.equal((await readFile(store.path, "utf8")).includes("SENTINEL"), false);
  await writeFile(path, "", { mode: 0o600 });
  await assert.rejects(() => store.vaultKey("deployment-1"), hasCode("unsafe_storage"));
});

test("commands started side by side reserve one account and one creation receipt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-claim-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const proofs = new Set<unknown>();
  // Both commands read the state before either of them has written anything.
  const start = async () => {
    const store = new StateStore(dir);
    const state = await store.read();
    return new Context(
      store,
      state,
      {
        request: async (_url, _path, options = {}) => {
          proofs.add((options.body as { idempotencyKey?: unknown }).idempotencyKey);
          return { data: credential };
        },
      },
      {},
    );
  };
  const first = await start();
  const second = await start();
  await first.bootstrap();
  await second.bootstrap();
  assert.equal(proofs.size, 1);
  assert.equal(second.active?.credential, credential.credential.token);
  const one = await first.prepareCreate("/v1/admin/apps", { name: "Same" });
  const other = await second.prepareCreate("/v1/admin/apps", { name: "Same" });
  assert.equal(other.id, one.id);
  assert.equal(other.proof, one.proof);
  const different = await second.prepareCreate("/v1/admin/apps", { name: "Other" });
  assert.notEqual(different.id, one.id);
});
