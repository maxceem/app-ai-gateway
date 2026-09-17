import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppWrite } from "../../src/contracts/schemas.ts";
import { operations } from "../../src/contracts/operations.ts";
import { CliErrorDetailsSchema } from "../../src/contracts/operation-schemas.ts";
import { appDocument, appCommand, type AppResult } from "../src/apps.ts";
import { resourceCommand } from "../src/resources.ts";
import {
  Cloudflare,
  deploymentCommand,
  runWrangler,
  wranglerEnvironment,
  wranglerFailure,
  type CloudflareClient,
  type CloudflareRequestOptions,
  type WranglerOptions,
} from "../src/deployment.ts";
import { StateStore, reserveOutput, type CliState, type InstallationJournal } from "../src/state.ts";
import { Context } from "../src/context.ts";
import type { Flags } from "../src/parser.ts";
import { fail } from "../src/common.ts";
import { errorOf, hasCode, stubContext } from "./helpers.ts";

const server: AppWrite = {
  name: "Server",
  status: "active",
  config: {
    authentication: { type: "api_key" },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
  },
};
const iosFlags: Flags = {
  type: "ios",
  "team-id": "ABCDE12345",
  "bundle-id": "com.example.app",
  "no-input": true,
};

/** The App Attest half of a document, once the union has been narrowed. */
function attest(doc: AppWrite) {
  const auth = doc.config.authentication;
  assert.equal(auth.type, "apple_app_attest");
  if (auth.type !== "apple_app_attest") throw new Error("unreachable");
  return auth.app_attest;
}

test("quickstart and JSON defaults remain distinct, and retained provider policies survive updates", async () => {
  const ios = await appDocument(iosFlags);
  assert.deepEqual(attest(ios).environments, ["production", "development"]);
  assert.equal(ios.config.limits?.per_user.requests.per_day, 300);
  const previous = structuredClone(server);
  previous.config.routing.providers = {
    mode: "selected",
    selected: {
      openai: {
        allowed_paths: ["v1/responses"],
        allowed_models: ["restricted-model"],
      },
    },
  };
  const updated = await appDocument({ provider: ["openai", "other"] }, previous);
  assert.deepEqual(
    updated.config.routing.providers.selected?.["openai"],
    previous.config.routing.providers.selected?.["openai"],
  );
  // Unrestricted is the empty list: the gateway has no wildcard, and a literal
  // "*" both fails the save-time price check and matches no request.
  assert.deepEqual(
    updated.config.routing.providers.selected?.["other"],
    { allowed_paths: [], allowed_models: [] },
  );
  await assert.rejects(() =>
    appDocument({
      type: "server",
      name: "Test",
      "team-id": "ABCDE12345",
      "no-input": true,
    }),
  );
});

test("file mode honors omission of environments and refuses type conversion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-app-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const doc = await appDocument(iosFlags);
  delete attest(doc).environments;
  const path = join(dir, "app.json");
  await writeFile(path, JSON.stringify(doc));
  assert.equal(attest(await appDocument({ file: path })).environments, undefined);
  await assert.rejects(
    () => appDocument({ file: path }, server),
    hasCode("app_type_immutable"),
  );
  await assert.rejects(
    () => appDocument({ file: path, name: "bad" }),
    hasCode("conflicting_flags"),
  );
});

test("app remove supplies required confirmation query and full writes supply the revision", async () => {
  const calls: { name: string; params: unknown[]; options?: Record<string, unknown> }[] = [];
  const ctx = stubContext({
    call: async (name: string, params: unknown[], options?: Record<string, unknown>) => {
      calls.push({ name, params, ...(options ? { options } : {}) });
      return {
        data: { app: { ...server, id: "app-1", revision: 1 }, resolved: null, config_error: null },
      };
    },
  });
  await appCommand(ctx, "app remove", ["app-1"], { yes: true });
  assert.equal(calls[1]?.name, "deleteApp");
  // The confirmation query is the descriptor's, so it is asserted there.
  assert.equal(operations.deleteApp.path("app-1"), "/v1/admin/apps/app-1?confirm=app-1");
  calls.length = 0;
  await appCommand(ctx, "app update", ["app-1"], { name: "Renamed" });
  assert.equal(calls[1]?.name, "updateApp");
  const options = calls[1]?.options as { body: AppWrite & { revision: number } };
  // The revision the edit was made against, read from the application and sent
  // back in the body — no header is involved.
  assert.equal(options.body.revision, 1);
  assert.equal(options.body.name, "Renamed");
});

/** A provider as `listProviders` answers with one, named and typed by this test. */
const providerRow = (slug: string, type: string) => ({
  id: `p-${slug}`, slug, type, name: slug, secretHint: null, providerGatewayId: null,
  gatewayRoute: null, baseUrl: null, pricing: null, status: "active",
  createdAt: "now", createdBy: "me",
});

/** The example a command answered with, refused as a string by the union's other members. */
function snippetOf(result: AppResult): string {
  assert.ok("snippet" in result && typeof result.snippet === "string");
  return result.snippet;
}

/** A context that answers the three reads an example is written from. */
const snippetContext = (providers: ReturnType<typeof providerRow>[], app: AppWrite = server) =>
  stubContext({
    url: "https://gw.test",
    active: null,
    call: async (name: string) => {
      if (name === "listProviders") return { data: { providers } };
      if (name === "listModelPrices")
        return { data: { prices: { openai: { "gpt-5.6": { input: 5, output: 30 } } } } };
      return { data: { app: { ...app, id: "app-1", revision: 1 }, resolved: null, config_error: null } };
    },
  });

test("a server app gets a runnable example, with placeholders for what it does not have yet", async () => {
  const bare = await appCommand(snippetContext([]), "app snippet", ["app-1"], {});
  const bareSnippet = snippetOf(bare);
  assert.ok(bareSnippet.includes("/proxy/PROVIDER_SLUG/v1/chat/completions"));
  assert.ok(bareSnippet.includes('"model":"MODEL"'));
  assert.ok(bareSnippet.includes('-H "Authorization: Bearer $APP_AI_GATEWAY_KEY"'));
  assert.ok("notes" in bare && bare.notes.length === 2);
  // The placeholders are named in the snippet itself, as shell comments, so
  // the human output says why without a second channel to read.
  assert.match(bareSnippet, /^# No provider is configured yet/);

  const configured = snippetOf(
    await appCommand(
      snippetContext([providerRow("openai", "openai"), providerRow("second", "openai")]),
      "app snippet",
      ["app-1"],
      {},
    ),
  );
  assert.ok(configured.includes("/proxy/openai/v1/responses"));
  assert.ok(configured.includes('{"model":"gpt-5.6","input":"Say hello."}'));
  // Two reachable providers is not an ambiguity to refuse over: the first is
  // shown, and the other is named as one flag away.
  assert.match(configured, /^# This app can reach 2 providers/);

  const named = snippetOf(
    await appCommand(
      snippetContext([providerRow("openai", "openai"), providerRow("claude", "anthropic")]),
      "app snippet",
      ["app-1"],
      { provider: "claude" },
    ),
  );
  assert.ok(named.includes("/proxy/claude/v1/messages"));
  assert.ok(named.includes("anthropic-version: 2023-06-01"));
});

test("creating a server app hands back the request to send, keyed from the file it just wrote", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-add-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyPath = join(dir, "app.key");
  const created = { ...server, id: "app-1", revision: 1, created_at: "now", updated_at: "now" };
  const ctx = stubContext({
    url: "https://gw.test",
    active: null,
    bootstrap: async () => {},
    call: async (name: string) => {
      if (name === "listProviders") return { data: { providers: [providerRow("openai", "openai")] } };
      if (name === "listModelPrices")
        return { data: { prices: { openai: { "gpt-5.6": { input: 5, output: 30 } } } } };
      return { data: { app: created, resolved: null, config_error: null } };
    },
    keyOutput: async () => await reserveOutput(keyPath),
    create: async () => ({
      data: {
        app: created,
        resolved: null,
        config_error: null,
        api_key: { id: "key-1", key: "SENTINEL-KEY", name: "default", key_prefix: "agw_", created_at: "now" },
      },
      complete: async () => {},
    }),
  });
  const result = await appCommand(ctx, "app add", [], { type: "server", name: "Server", "no-input": true });
  const snippet = snippetOf(result);
  assert.equal(snippet.includes("SENTINEL-KEY"), false);
  assert.match(snippet, /^export APP_AI_GATEWAY_KEY="\$\(cat '.*app\.key'\)"/);
  assert.ok(snippet.includes("/v1/apps/app-1/proxy/openai/v1/responses"));
  assert.ok("applicationKey" in result && result.applicationKey?.storagePath === keyPath);
});

test("each application type is offered only the snippet its callers can authenticate", async () => {
  const ios = await appDocument(iosFlags);
  await assert.rejects(
    () => appCommand(snippetContext([], server), "app snippet", ["app-1"], { language: "swift" }),
    hasCode("unsupported_snippet"),
  );
  await assert.rejects(
    () => appCommand(snippetContext([], ios), "app snippet", ["app-1"], { language: "curl" }),
    hasCode("unsupported_snippet"),
  );
  await assert.rejects(
    () => appCommand(snippetContext([], server), "app snippet", ["app-1"], { language: "python" }),
    hasCode("invalid_input"),
  );
  await assert.rejects(
    () => appCommand(snippetContext([], server), "app snippet", ["app-1"], { provider: "absent" }),
    hasCode("provider_not_found"),
  );
  // A provider the account holds but the app cannot send to is a different
  // answer from one that does not exist.
  await assert.rejects(
    () =>
      appCommand(
        snippetContext([{ ...providerRow("openai", "openai"), status: "disabled" }], server),
        "app snippet",
        ["app-1"],
        { provider: "openai" },
      ),
    hasCode("provider_unavailable"),
  );
  // An iOS app defaults to Swift, and its example carries a body like the rest.
  const swift = snippetOf(
    await appCommand(snippetContext([providerRow("openai", "openai")], ios), "app snippet", ["app-1"], {}),
  );
  assert.ok(swift.includes("import AppAIGateway"));
  assert.ok(swift.includes('providerPath: "v1/responses"'));
  assert.ok(swift.includes("request.httpBody = Data("));
});

test("app key failures revoke one-time credential before returning error", async () => {
  const calls: string[] = [];
  const ctx = stubContext({
    call: async (name: string) => {
      calls.push(name);
      if (name === "getApp")
        return { data: { app: { ...server, id: "app-1", revision: 1 }, resolved: null, config_error: null } };
      return { data: {} };
    },
    keyOutput: async () => ({
      path: "/key",
      write: async () => {
        throw new Error("disk full");
      },
      cancel: async () => {},
    }),
    create: async () => ({
      data: { id: "key-1", key: "SENTINEL", name: "CI", key_prefix: "agw_", created_at: "now" },
      complete: async () => {},
    }),
    save: async () => {},
  });
  await assert.rejects(
    () => appCommand(ctx, "app key add", ["app-1"], { name: "CI" }),
    (error: unknown) =>
      errorOf(error).code === "key_storage_failed" &&
      errorOf(error).details?.["revoked"] === true,
  );
  assert.ok(calls.includes("revokeAppKey"));
});

test("provider canonical-origin reset can initiate a narrowly bound browser resubmission", async () => {
  let operation: { kind: string; payload: Record<string, unknown> } | undefined;
  const ctx = stubContext({
    call: async () => ({
      data: {
        providers: [
          {
            id: "p1",
            slug: "openai",
            type: "openai",
            name: "OpenAI",
            secretHint: null,
            providerGatewayId: null,
            gatewayRoute: null,
            baseUrl: "https://custom.example",
            pricing: null,
            status: "active",
            createdAt: "now",
            createdBy: "me",
          },
        ],
      }
    }),
    operation: async (kind: string, payload: Record<string, unknown>) => {
      operation = { kind, payload };
      return { state: "pending" };
    },
  });
  await resourceCommand(ctx, "provider update", ["openai"], {
    "clear-base-url": true,
    browser: true,
    "no-open": true,
  });
  assert.deepEqual(operation, {
    kind: "provider.update",
    payload: { id: "p1", baseUrl: null },
  });
});

interface CloudflareMock extends Omit<CloudflareClient, "run"> {
  calls: [string, unknown][];
  run: CloudflareClient["run"];
}

function cfMock(): CloudflareMock {
  return {
    calls: [],
    authenticate: async () => {},
    account: async () => "account-cf",
    all: async function <T>(path: string): Promise<T[]> {
      this.calls.push(["GET", path]);
      return [];
    },
    request: async function <T>(path: string, options?: CloudflareRequestOptions) {
      this.calls.push([options?.method ?? "GET", path]);
      const result = path.endsWith("/subdomain")
        ? { subdomain: "example" }
        : { uuid: "db-1" };
      return { success: true, result: result as T };
    },
    run: async function (args: string[]) {
      this.calls.push(["wrangler", args]);
      return "";
    },
  };
}

/** A release double: the commands only ever read these three members. */
function artifactStub(manifest: Record<string, unknown>) {
  return async () =>
    ({ directory: "", config: {}, manifest }) as never;
}

test("setup dry run neither provisions nor saves state or changes selected account", async () => {
  const cf = cfMock();
  let writes = 0;
  const active = { url: "https://old.example", authenticated: false, deployment: { id: "old" } };
  const state = { active, installations: {} } as unknown as CliState;
  const ctx = stubContext({
    state,
    active,
    url: active.url,
    save: async () => {
      writes++;
    },
  });
  const result = await deploymentCommand(
    ctx,
    "deployment setup",
    { name: "new", "no-input": true, "dry-run": true },
    cf,
    artifactStub({ version: "0.1.0" }),
  );
  assert.equal("dryRun" in result && result.dryRun, true);
  assert.equal(writes, 0);
  assert.ok(cf.calls.every(([method]) => method === "GET"));
  assert.equal(state.active, active);
});

test("setup refuses existing Worker name before any remote mutation", async () => {
  const cf = cfMock();
  cf.all = async () => [{ id: "taken" }] as never;
  await assert.rejects(
    () =>
      deploymentCommand(
        stubContext({ state: {}, url: "https://old.example" }),
        "deployment setup",
        { name: "taken", "no-input": true, yes: true },
        cf,
        artifactStub({ version: "0.1.0" }),
      ),
    hasCode("worker_name_collision"),
  );
  assert.ok(cf.calls.every(([method]) => method === "GET"));
});

test("ready setup does not replay secrets or retired bootstrap credentials", async () => {
  const cf = cfMock();
  cf.all = async () => [{ id: "existing" }] as never;
  cf.request = async () =>
    ({
      success: true,
      result: { bindings: [{ name: "DEPLOYMENT_ID", text: "deployment-1" }] },
    }) as never;
  const journal: InstallationJournal = {
    id: "deployment-1",
    name: "existing",
    accountId: "account-cf",
    version: "0.1.0",
    phase: "ready",
    url: "https://existing.example",
    // What an installation completed by an earlier release left in the journal.
    secrets: {
      JWT_SECRET: "SENTINEL-JWT",
      BETTER_AUTH_SECRET: "SENTINEL-AUTH",
      SECRET_VAULT_LOCAL_KEK_V1: "SENTINEL-KEK",
    },
  };
  let publicCalls = 0;
  const adopted: [string, string | undefined][] = [];
  const ctx = stubContext({
    state: { installations: { "deployment-1": journal } },
    url: "https://other.example",
    save: async () => {},
    store: {
      vaultKey: async (id: string, adopt?: string) => {
        adopted.push([id, adopt]);
        return adopt ?? "generated";
      },
    },
    publicCall: async (name: string, _params: unknown[], options: { url?: string }) => {
      publicCalls++;
      assert.equal(name, "getCliCapabilities");
      assert.equal(options.url, journal.url);
      return { data: { deployment: { id: journal.id } } };
    },
  });
  const result = await deploymentCommand(
    ctx,
    "deployment setup",
    { name: "existing", "no-input": true, yes: true },
    cf,
    artifactStub({ version: "0.1.0" }),
  );
  assert.equal("installed" in result && result.installed, true);
  assert.equal(publicCalls, 1);
  assert.equal(cf.calls.length, 0);
  // The vault key moves to its own file; the auth secrets leave state for good.
  assert.deepEqual(adopted, [["deployment-1", "SENTINEL-KEK"]]);
  assert.equal(journal.secrets, undefined);
  assert.equal(JSON.stringify(ctx.state).includes("SENTINEL"), false);
});

test("journal-backed deployment updates refuse a replaced Cloudflare Worker", async () => {
  const cf = cfMock();
  cf.request = async () =>
    ({
      success: true,
      result: {
        bindings: [
          { name: "DEPLOYMENT_ID", type: "plain_text", text: "different-installation" },
        ],
      },
    }) as never;
  const active = {
    url: "https://selected.example",
    authenticated: true,
    deployment: { id: "deployment-1", mode: "self_hosted" },
  };
  const journal: InstallationJournal = {
    id: "deployment-1",
    accountId: "account-cf",
    name: "worker",
    version: "0.1.0",
    phase: "ready",
  };
  const ctx = stubContext({
    active,
    url: active.url,
    state: { active, installations: { "deployment-1": journal } },
  });
  await assert.rejects(
    () =>
      deploymentCommand(
        ctx,
        "deployment update",
        { "dry-run": true, "no-input": true },
        cf,
        artifactStub({ version: "0.1.0", upgradeFrom: ["0.1.0"] }),
      ),
    hasCode("deployment_identity_mismatch"),
  );
});

test("domain changes cannot implicitly upgrade or downgrade the gateway code", async () => {
  const cf = cfMock();
  cf.request = async () =>
    ({
      success: true,
      result: {
        bindings: [
          { name: "DB", type: "d1", id: "db-old" },
          { name: "DEPLOYMENT_ID", type: "plain_text", text: "deployment-1" },
        ],
      },
    }) as never;
  const active = {
    url: "https://selected.example",
    authenticated: true,
    deployment: { id: "deployment-1", mode: "self_hosted" },
  };
  const journal: InstallationJournal = {
    id: "deployment-1",
    accountId: "account-cf",
    name: "worker",
    version: "0.1.0",
    phase: "ready",
  };
  const ctx = stubContext({
    active,
    url: active.url,
    state: { active, installations: { "deployment-1": journal } },
    publicCall: async () => ({
      data: { deployment: { id: "deployment-1" }, serverVersion: "0.2.0" }
    }),
  });
  await assert.rejects(
    () =>
      deploymentCommand(
        ctx,
        "deployment domain",
        { hostname: "ai.example.com", "dry-run": true, "no-input": true },
        cf,
        artifactStub({ version: "0.1.0" }),
      ),
    hasCode("domain_release_mismatch"),
  );
  assert.equal(journal.version, "0.1.0");
});

test("explicit key output resumes after durable response and disk failure without minting again", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const state: CliState = {
    schemaVersion: 1,
    operations: {},
    active: {
      url: "https://example.com",
      account: {
        id: "account",
        name: "Account",
        createdAt: "now",
        claimed: true,
        expiresAt: null,
      },
      credential: "management",
      authenticated: true,
    },
  };
  let posts = 0;
  const transport = {
    request: async (
      _url: string,
      path: string,
      options: { method?: string } = {},
    ) => {
      if (options.method === "POST") {
        posts++;
        return {
          data: {
            id: "key-1",
            key: "SENTINEL-KEY",
            name: "CI",
            key_prefix: "agw_",
            created_at: "now",
          }
        };
      }
      if (path.endsWith("/keys"))
        return {
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
        };
      return {
        data: {
          app: { ...server, id: "app-1", revision: 1, created_at: "now", updated_at: "now" },
          resolved: null,
          config_error: null,
        }
      };
    },
  };
  const outputPath = join(dir, "explicit.key");
  await store.write(state);
  const ctx = new Context(store, state, transport, {});
  const originalOutput = ctx.keyOutput.bind(ctx);
  ctx.keyOutput = async (...args: Parameters<Context["keyOutput"]>) => {
    const output = await originalOutput(...args);
    output.write = async () => {
      throw new Error("disk full");
    };
    return output;
  };
  await assert.rejects(
    () =>
      appCommand(ctx, "app key add", ["app-1"], {
        name: "CI",
        "key-output": outputPath,
      }),
    hasCode("key_output_pending"),
  );
  assert.equal(posts, 1);
  const resumed = new Context(store, await store.read(), transport, {});
  const result = await appCommand(resumed, "app key add", ["app-1"], {
    name: "CI",
    "key-output": outputPath,
  });
  assert.equal(posts, 1);
  assert.equal(await readFile(outputPath, "utf8"), "SENTINEL-KEY\n");
  assert.equal(JSON.stringify(result).includes("SENTINEL"), false);
  assert.equal(
    Object.values((await store.read()).mutations ?? {})[0]?.response,
    undefined,
  );
  await appCommand(resumed, "app key add", ["app-1"], {
    name: "CI",
    "key-output": outputPath,
  });
  assert.equal(posts, 1);
});

test("a refused key creation releases both its receipt and its reserved output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-refused-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const state: CliState = {
    schemaVersion: 1,
    operations: {},
    active: {
      url: "https://example.com",
      account: {
        id: "account",
        name: "Account",
        createdAt: "now",
        claimed: true,
        expiresAt: null,
      },
      credential: "management",
      authenticated: true,
    },
  };
  let posts = 0;
  const authorizations: unknown[] = [];
  const transport = {
    request: async (
      _url: string,
      _path: string,
      options: { method?: string; headers?: Record<string, string> } = {},
    ) => {
      if (options.method === "POST") {
        posts++;
        authorizations.push(options.headers?.["Idempotency-Key"]);
        if (posts === 1)
          fail("invalid_input", "Key name is already in use.", undefined, 3, {
            status: 400,
          });
        return {
          data: {
            id: "key-1",
            key: "SENTINEL-KEY",
            name: "CI",
            key_prefix: "agw_",
            created_at: "now",
          }
        };
      }
      return {
        data: {
          app: { ...server, id: "app-1", revision: 1, created_at: "now", updated_at: "now" },
          resolved: null,
          config_error: null,
        }
      };
    },
  };
  const outputPath = join(dir, "explicit.key");
  await store.write(state);
  const ctx = new Context(store, state, transport, {});
  await assert.rejects(
    () =>
      appCommand(ctx, "app key add", ["app-1"], {
        name: "CI",
        "key-output": outputPath,
      }),
    hasCode("invalid_input"),
  );
  assert.equal((await store.read()).mutations, undefined);
  // The reservation was made before the request and holds nothing, so leaving
  // it would make the corrected command fail on a file the CLI itself wrote.
  await assert.rejects(() => stat(outputPath));

  const retry = new Context(store, await store.read(), transport, {});
  const result = await appCommand(retry, "app key add", ["app-1"], {
    name: "CI",
    "key-output": outputPath,
  });
  assert.notEqual(authorizations[0], authorizations[1]);
  assert.equal(await readFile(outputPath, "utf8"), "SENTINEL-KEY\n");
  assert.equal(JSON.stringify(result).includes("SENTINEL"), false);
});

test("journal inventory refuses D1 rebinding and unsupported new resources", async () => {
  for (const [binding, expected] of [
    [{ name: "DB", type: "d1", id: "db-new" }, "deployment_database_mismatch"],
    [{ name: "EXTRA", type: "kv_namespace", namespace_id: "kv" }, "deployment_binding_unsupported"],
    [
      {
        name: "ORG_QUOTA",
        type: "durable_object_namespace",
        class_name: "ExternalQuota",
        script_name: "worker",
      },
      "deployment_binding_unsupported",
    ],
    [
      {
        name: "ORG_QUOTA",
        type: "durable_object_namespace",
        class_name: "OrgQuota",
        script_name: "other-worker",
      },
      "deployment_binding_unsupported",
    ],
    [
      {
        name: "ORG_QUOTA",
        type: "durable_object_namespace",
        class_name: "OrgQuota",
        script_name: "worker",
        environment: "staging",
      },
      "deployment_binding_unsupported",
    ],
  ] as const) {
    const cf = cfMock();
    cf.request = async () =>
      ({
        success: true,
        result: {
          bindings: [
            { name: "DEPLOYMENT_ID", type: "plain_text", text: "deployment-1" },
            { name: "DB", type: "d1", id: "db-old" },
            binding,
          ].filter((_entry, i) => binding.name !== "DB" || i !== 1),
        },
      }) as never;
    const active = {
      url: "https://selected.example",
      authenticated: true,
      deployment: { id: "deployment-1", mode: "self_hosted" },
    };
    const ctx = stubContext({
      active,
      url: active.url,
      state: {
        installations: {
          "deployment-1": {
            id: "deployment-1",
            accountId: "account-cf",
            name: "worker",
            databaseId: "db-old",
          },
        },
      },
      publicCall: async () => ({
        data: { deployment: { id: "deployment-1" }, serverVersion: "0.1.0" }
      }),
    });
    await assert.rejects(
      () =>
        deploymentCommand(
          ctx,
          "deployment update",
          { "dry-run": true },
          cf,
          artifactStub({ version: "0.1.0", upgradeFrom: ["0.1.0"] }),
        ),
      hasCode(expected),
    );
  }
});

test("pending setup domain resumes without bootstrap and preserves current inventory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-domain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const releaseDir = join(dir, "artifact");
  await mkdir(releaseDir);
  const cf = cfMock();
  cf.all = (async (path: string) =>
    path.includes("/zones")
      ? [{ id: "zone", name: "example.com" }]
      : path.endsWith("/workers/domains")
        ? [
            { hostname: "existing.example.com", service: "worker" },
            { hostname: "new.example.com", service: "worker" },
          ]
        : [{ id: "worker" }]) as CloudflareClient["all"];
  cf.request = async () =>
    ({
      success: true,
      result: {
        bindings: [
          { name: "DEPLOYMENT_ID", type: "plain_text", text: "deployment-1" },
          { name: "DB", type: "d1", id: "db" },
          { name: "CUSTOM_SETTING", type: "plain_text", text: "current-value" },
          { name: "ALLOW_ADDITIONAL_REGISTRATIONS", type: "plain_text", text: "true" },
          {
            name: "ORG_QUOTA",
            type: "durable_object_namespace",
            class_name: "OrgQuota",
            script_name: "worker",
          },
          { name: "USER_LIMITER", type: "durable_object_namespace", class_name: "UserLimiter" },
          {
            name: "ENDPOINT_RATE_LIMITER",
            type: "durable_object_namespace",
            class_name: "EndpointRateLimiter",
          },
        ],
      },
    }) as never;
  let deploys = 0;
  cf.run = async (args: string[]) => {
    assert.equal(args[0], "deploy");
    deploys++;
    if (deploys === 1) throw new Error("connection lost");
    return "";
  };
  const journal: InstallationJournal = {
    id: "deployment-1",
    name: "worker",
    accountId: "account-cf",
    databaseId: "db",
    phase: "ready",
    pendingDomain: "new.example.com",
    url: "https://worker.example",
    version: "0.1.0",
    vars: { CUSTOM_SETTING: "stale" },
    domains: [],
  };
  const installations: Record<string, InstallationJournal> = { "deployment-1": journal };
  const ctx = stubContext({
    state: { installations },
    url: journal.url,
    store: { directory: dir },
    save: async () => {},
    publicCall: async (name: string) => {
      assert.equal(name, "getCliCapabilities");
      return {
        data: { deployment: { id: journal.id }, serverVersion: "0.1.0" }
      };
    },
  });
  const artifact = async () =>
    ({
      directory: releaseDir,
      config: { assets: {} },
      manifest: { version: "0.1.0" },
    }) as never;
  const flags: Flags = { name: "worker", "no-input": true, yes: true };
  await assert.rejects(() => deploymentCommand(ctx, "deployment setup", flags, cf, artifact));
  assert.equal(installations[journal.id]?.pendingDomain, "new.example.com");
  await deploymentCommand(ctx, "deployment setup", flags, cf, artifact);
  assert.equal(deploys, 2);
  const saved = installations[journal.id]!;
  assert.equal(saved.pendingDomain, undefined);
  assert.equal(saved.vars?.["CUSTOM_SETTING"], "current-value");
  assert.equal(saved.vars?.["ALLOW_ADDITIONAL_REGISTRATIONS"], "true");
  const generated = JSON.parse(
    await readFile(join(dir, "deployments", journal.id, "wrangler.json"), "utf8"),
  ) as { vars: Record<string, string> };
  assert.equal(generated.vars["ALLOW_ADDITIONAL_REGISTRATIONS"], "true");
  assert.ok(saved.domains?.includes("existing.example.com"));
});

test("a failed wrangler run reports its own output, minus the secrets it was given", () => {
  const failure = wranglerFailure(
    ["deploy", "--config", "wrangler.json"],
    1,
    `${"noise\n".repeat(600)}✘ A worker with this name already exists\nusing SENTINEL-VAULT-KEY-VALUE\n`,
    ["SENTINEL-VAULT-KEY-VALUE", "short"],
  );
  assert.equal(failure.code, "wrangler_failed");
  assert.match(failure.message, /wrangler deploy failed \(exit 1\)/);
  // The envelope only prints what the details schema declares.
  const details = CliErrorDetailsSchema.parse(failure.details);
  assert.match(details.output ?? "", /A worker with this name already exists/);
  assert.match(details.output ?? "", /using \[redacted\]/);
  assert.ok(!(details.output ?? "").includes("SENTINEL"));
  assert.ok((details.output ?? "").length <= 2000);
});

/**
 * The snippet is compiled into an application, so its base URL has to be the
 * host that application calls. A deployment publishing a separate API domain
 * names it in its own identity, which is not the URL this CLI manages the
 * gateway through — the console host serves both.
 */
test("app snippet names the deployment's API host, not the managed URL", async () => {
  const ios = await appDocument(iosFlags);
  const ctx = stubContext({
    url: "https://console.example",
    active: {
      url: "https://console.example",
      authenticated: true,
      deployment: {
        id: "deployment-1",
        mode: "cloud",
        apiUrl: "https://api.example.com",
        consoleOrigin: "https://console.example",
      },
    },
    call: async (name: string) => {
      if (name === "getApp")
        return { data: { app: { ...ios, id: "app-1", revision: 1 }, resolved: null, config_error: null } };
      if (name === "listModelPrices")
        return { data: { prices: { openai: { "gpt-5.6": { input: 5, output: 30 } } } } };
      return { data: { providers: [{ id: "p-1", slug: "openai", type: "openai", status: "active" }] } };
    },
  });
  const result = await appCommand(ctx, "app snippet", ["app-1"], {});
  const snippet = "snippet" in result ? result.snippet : undefined;
  assert.equal(typeof snippet, "string");
  assert.ok(snippet !== undefined);
  assert.match(snippet, /baseURL: URL\(string: "https:\/\/api\.example\.com"\)!/u);
  assert.equal(snippet.includes("console.example"), false);
});

/** A wrangler double that records every run and answers from a script. */
function runnerMock(answers: Record<string, string | { exit: number; output: string }>) {
  const runs: [string[], WranglerOptions | undefined][] = [];
  const run = async (args: string[], options?: WranglerOptions): Promise<string> => {
    runs.push([args, options]);
    const answer = answers[args.join(" ")];
    if (answer === undefined) throw new Error(`unscripted wrangler run: ${args.join(" ")}`);
    // Failures arrive the way the real runner raises them, redaction included,
    // so a test cannot pass on an error shape production never produces.
    if (typeof answer !== "string")
      throw wranglerFailure(args, answer.exit, answer.output, options?.redact ?? []);
    return answer;
  };
  return { runs, run, ran: (name: string) => runs.some(([args]) => args[0] === name) };
}

/** What wrangler answers with when nobody is logged in and nothing is set. */
const loggedOut = { exit: 1, output: "Not logged in. Please run `wrangler login`." };

/** Runs with the Cloudflare credential variables cleared from the environment. */
async function withoutCloudflareEnv(body: () => Promise<void>): Promise<void> {
  const names = [
    "CLOUDFLARE_API_TOKEN",
    "CF_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CF_API_KEY",
    "CLOUDFLARE_EMAIL",
    "CF_EMAIL",
  ];
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("a parsed wrangler run keeps the log level its answer is printed at", () => {
  // The regression this guards: quietening the run that reports the current
  // authorization leaves it exiting 0 with nothing on stdout, which reads as
  // being logged out and sends an authorized caller to a login that refuses.
  assert.equal(wranglerEnvironment({ parse: true }).WRANGLER_LOG, "log");
  assert.equal(wranglerEnvironment().WRANGLER_LOG, "error");
  assert.equal(wranglerEnvironment({ interactive: true, parse: true }).WRANGLER_LOG, "log");
  assert.equal(wranglerEnvironment().CI, "true");
  assert.equal(wranglerEnvironment({ interactive: true }).CI, "");
  assert.equal(wranglerEnvironment().WRANGLER_SEND_METRICS, "false");
});

test("an existing wrangler authorization is reused instead of starting a login", async () => {
  for (const [reported, expected] of [
    [
      { type: "api_token", token: "SENTINEL-TOKEN" },
      { authorization: "Bearer SENTINEL-TOKEN" },
    ],
    [
      { type: "oauth", token: "SENTINEL-OAUTH" },
      { authorization: "Bearer SENTINEL-OAUTH" },
    ],
    [
      { type: "api_key", key: "SENTINEL-KEY", email: "someone@example.com" },
      { "x-auth-key": "SENTINEL-KEY", "x-auth-email": "someone@example.com" },
    ],
  ] as const) {
    const wrangler = runnerMock({ "auth token --json": JSON.stringify(reported) });
    const sent: Headers[] = [];
    const cf = new Cloudflare(wrangler.run, async (_url, init) => {
      sent.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    });
    await cf.authenticate({});
    assert.equal(wrangler.ran("login"), false);
    // Silencing this run is what broke it before, so the option is the point.
    assert.equal(wrangler.runs[0]?.[1]?.parse, true);
    await cf.request("/accounts");
    for (const [name, value] of Object.entries(expected))
      assert.equal(sent[0]?.get(name), value);
  }
});

test("wrangler output that will not parse is reported, not read as being logged out", async () => {
  const wrangler = runnerMock({ "auth token --json": "", login: "" });
  await assert.rejects(
    () => new Cloudflare(wrangler.run).authenticate({}),
    hasCode("cloudflare_auth_unreadable"),
  );
  assert.equal(wrangler.ran("login"), false);
});

test("a wrangler run that failed at something else keeps its own cause", async () => {
  await withoutCloudflareEnv(async () => {
    process.env["CLOUDFLARE_API_TOKEN"] = "SENTINEL-TOKEN-VALUE";
    // With credentials set, wrangler cannot be reporting a missing login, so
    // this failure is about something else — here a project config beside the
    // caller — and answering it with a login would bury the reason.
    const wrangler = runnerMock({
      "auth token --json": {
        exit: 1,
        output: 'Expected "name" to be of type string\nusing SENTINEL-TOKEN-VALUE',
      },
      login: "",
    });
    const error = await new Cloudflare(wrangler.run).authenticate({}).catch((e: unknown) => e);
    assert.equal(errorOf(error).code, "wrangler_failed");
    assert.match(String(errorOf(error).details?.["output"]), /Expected "name"/);
    assert.equal(wrangler.ran("login"), false);
    // The run declares the environment's credentials as secrets, so neither the
    // reported output nor the message may echo one back.
    assert.equal(JSON.stringify(error).includes("SENTINEL"), false);
    assert.equal((error as Error).message.includes("SENTINEL"), false);
    assert.match(String(errorOf(error).details?.["output"]), /using \[redacted\]/);
  });
});

test("the authorization read cannot be decided by a config beside the caller", async () => {
  const wrangler = runnerMock({
    "auth token --json": JSON.stringify({ type: "oauth", token: "t" }),
  });
  await new Cloudflare(wrangler.run).authenticate({});
  assert.equal(wrangler.runs[0]?.[1]?.cwd, tmpdir());
});

test("a login that refuses is reported as such, without a crash in its place", async () => {
  await withoutCloudflareEnv(async () => {
    // Wrangler prints a refusal on stderr and still exits 0; only what it holds
    // afterwards says whether the login took.
    const wrangler = runnerMock({ "auth token --json": loggedOut, login: "" });
    await assert.rejects(
      () => new Cloudflare(wrangler.run).authenticate({}),
      hasCode("cloudflare_auth_required"),
    );
    assert.equal(wrangler.ran("login"), true);
  });
});

test("a non-interactive run asks for a token rather than opening a browser", async () => {
  await withoutCloudflareEnv(async () => {
    for (const flags of [{ "no-input": true }, { "dry-run": true }] as Flags[]) {
      const wrangler = runnerMock({ "auth token --json": loggedOut });
      await assert.rejects(
        () => new Cloudflare(wrangler.run).authenticate(flags),
        hasCode("cloudflare_auth_required"),
      );
      assert.equal(wrangler.ran("login"), false);
    }
  });
});

test("the real wrangler answers a parsed run where this CLI reads it", async () => {
  // The bug this guards was invisible to every double: wrangler exited 0 and
  // printed its answer where a quietened run could not see it. Only the real
  // binary can say whether that is still true.
  await withoutCloudflareEnv(async () => {
    process.env["CLOUDFLARE_API_TOKEN"] = "dummy_value_123";
    const reported = await runWrangler(["auth", "token", "--json"], {
      parse: true,
      cwd: tmpdir(),
    });
    assert.deepEqual(JSON.parse(reported), {
      type: "api_token",
      token: "dummy_value_123",
    });
  });
});
