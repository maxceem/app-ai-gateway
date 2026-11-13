/**
 * A deployment newer than this CLI.
 *
 * Every answer here carries settings no release of `agw` has ever shipped
 * with: keys the configuration grammar does not declare, at several depths,
 * and values its enums do not list. The contract is that an older CLI keeps
 * showing, listing and updating what it understands, ignores what it does not
 * without failing, and never removes or changes it when it saves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { CATALOG, operationPath, type OperationName } from "../../src/contracts/catalog.ts";
import { UsageEventSchema } from "../../src/contracts/responses.ts";
import { parseAppConfig } from "../../src/shared/app-config.ts";
import { CliError } from "../src/common.ts";
import { main } from "../src/main.ts";
import { tolerant } from "../src/tolerant.ts";
import type { CliState } from "../src/state.ts";
import type { Transport } from "../src/transport.ts";
import { fresh, makeStore } from "./helpers.ts";

/** An iOS application as the gateway stores it, before a newer release touched it. */
const known = parseAppConfig({
  authentication: {
    type: "apple_app_attest",
    end_user: { source: "app_install" },
    app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.app", environments: ["production"] },
  },
  routing: {
    providers: {
      mode: "selected",
      selected: {
        openai: {
          allowed_paths: ["v1/responses", { path: "v1/chat/completions", fixed_model: "gpt-x" }],
          allowed_models: [],
        },
      },
    },
    model_rewrites: {},
  },
  endpoints: {
    answer: { provider: "openai", model: "gpt-x", api_style: "responses" },
  },
});

/**
 * The same configuration as a newer gateway writes it: an unknown key at the
 * top of the configuration, in an `allowed_paths` object entry, in `limits`
 * and in a per-user scope, and values no enum of this release lists.
 */
function newerConfig(): Record<string, unknown> {
  const config = structuredClone(known) as unknown as Record<string, any>;
  config.routing.providers.selected.openai.allowed_paths[1].methods = ["POST"];
  config.limits.per_install = { requests: { per_minute: 5 } };
  config.limits.per_user.requests.burst = 3;
  config.endpoints.answer.kind = "video";
  config.authentication.app_attest.verify_on = "on_launch";
  config.moderation = { enabled: true, categories: ["self-harm"] };
  return config;
}

/** Every addition `newerConfig` makes, where `agw` should report it. */
const NEWER_PATHS = [
  "app.config.authentication.app_attest.verify_on",
  "app.config.routing.providers.selected.openai.allowed_paths[1].methods",
  "app.config.limits.per_user.requests.burst",
  "app.config.limits.per_install",
  "app.config.endpoints.answer.kind",
  "app.config.moderation",
];

function newerApp(config: Record<string, unknown> = newerConfig()) {
  return {
    app: {
      id: "app-1",
      revision: 7,
      name: "Newer",
      config,
      status: "active",
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-02T00:00:00Z",
      warnings: [],
      // A field beside the configuration, in an object that has always
      // dropped what it does not declare: it is not the configuration, and
      // `agw` never writes it.
      color: "teal",
    },
    // And one at the very top of the answer.
    served_by: "edge-1",
  };
}

interface Sent {
  name: OperationName;
  body?: unknown;
}

/**
 * A deployment that answers the named operations, recording what each was
 * sent. Anything it was not given an answer for is refused, as a deployment
 * refuses a route it does not have.
 */
function deployment(answers: Partial<Record<OperationName, (body: unknown) => unknown>>) {
  const sent: Sent[] = [];
  const routes = new Map<string, OperationName>();
  for (const name of Object.keys(answers) as OperationName[]) {
    const template = CATALOG[name].path.replace(/\{(\w+)\}/g, "app-1");
    routes.set(`${CATALOG[name].method} ${template}`, name);
  }
  return {
    sent,
    transport: {
      request: async (_url: string, path: string, options: { method?: string; body?: unknown } = {}) => {
        const name = routes.get(`${options.method ?? "GET"} ${path.split("?")[0]}`);
        if (!name) throw new CliError("not_found", `No route ${path}.`, "", 3, { status: 404 });
        sent.push({ name, ...(options.body === undefined ? {} : { body: structuredClone(options.body) }) });
        return { data: answers[name]!(options.body) };
      },
    },
  };
}

const signedIn = (): CliState => ({
  ...fresh(),
  active: { url: "https://gw.example", credential: "token", authenticated: true },
});

async function run(
  argv: string[],
  transport: Pick<Transport, "request">,
  state: CliState = signedIn(),
) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    store: { ...makeStore(), read: async () => state },
    transport,
    stdout: { write: (text: string) => void (out += text) },
    stderr: { write: (text: string) => void (err += text) },
    io: { env: {} },
  });
  return { code, out, err, json: () => JSON.parse(out) as Record<string, any> };
}

test("operation paths in this file are the catalog's", () => {
  assert.equal(operationPath("getApp", { app: "app-1" }), "/v1/admin/apps/app-1");
});

test("app show reads a newer configuration, keeps every addition as sent, and says so once", async () => {
  const gateway = deployment({ getApp: () => newerApp() });
  const human = await run(["app", "show", "app-1"], gateway.transport);
  assert.equal(human.code, 0, human.err);
  assert.match(human.err, /^Note: This deployment is newer than agw \S+ and has settings this agw does not understand\./);
  assert.match(human.err, /npm install -g @maxceem\/agw/);
  assert.match(human.err, /Settings: .*allowed_paths\[1\]\.methods/);
  // One note, however many additions.
  assert.equal(human.err.match(/Note:/g)?.length, 1);
  assert.match(human.out, /^Newer \(app-1\)/);
  assert.match(human.out, /"methods"/);

  const json = await run(["app", "show", "app-1", "--json"], gateway.transport);
  assert.equal(json.code, 0);
  assert.equal(json.err, "");
  const printed = json.json();
  assert.equal(printed.ok, true);
  assert.deepEqual(printed.result.app.config, newerConfig());
  assert.deepEqual(printed.notices, [
    {
      code: "newer_deployment",
      message: printed.notices[0].message,
      paths: NEWER_PATHS,
    },
  ]);
  // Outside the configuration, undeclared fields are dropped as they always were.
  assert.equal("color" in printed.result.app, false);
  assert.equal("served_by" in printed.result, false);
});

test("an answer with nothing new prints exactly what it always did", async () => {
  const gateway = deployment({ getApp: () => newerApp(structuredClone(known) as never) });
  const json = await run(["app", "show", "app-1", "--json"], gateway.transport);
  assert.equal(json.code, 0);
  assert.deepEqual(Object.keys(json.json()), ["schemaVersion", "ok", "context", "result"]);
  const human = await run(["app", "show", "app-1"], gateway.transport);
  assert.equal(human.err, "");
});

test("app list, check and usage accept values no enum of this release lists", async () => {
  const totals = {
    requests: 1, input_tokens: 2, cached_input_tokens: 0, cache_write_tokens: 0,
    output_tokens: 3, cost_usd: 0.5, errors: 0,
  };
  const gateway = deployment({
    listApps: () => ({
      month: "2026-11",
      has_proxied_requests: true,
      apps: [{
        id: "app-1",
        name: "Newer",
        status: "paused",
        authentication_type: "passkey",
        apple_bundle_id: null,
        created_at: "2026-11-01",
        providers: ["openai"],
        referenced_providers: ["openai"],
        allowed_model_count: 0,
        monthly_budget_usd: null,
        users: { total: 1, blocked: 0 },
        usage: totals,
      }],
    }),
    checkApp: () => ({
      appId: "app-1",
      validation: { valid: true, app_id: "app-1" },
      status: "active",
      providers: [{ id: "p1", slug: "openai", status: "rate_limited" }],
      ready: false,
      accountRefusal: "payment_overdue",
      limitations: [],
      warnings: [],
    }),
    getCliUsage: () => ({
      accountId: "account-1",
      month: "2026-11",
      totals,
      apps: [{ appId: "app-1", deleted: false, firstRecord: "2026-11-01", ...totals }],
      coverage: { scope: "all_regions", firstRecord: "2026-11-01" },
    }),
  });

  const list = await run(["app", "list"], gateway.transport);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /app-1\s+Newer\s+passkey\s+paused/);
  assert.match(list.err, /Settings: apps\[0\]\.status, apps\[0\]\.authentication_type/);

  const check = await run(["app", "check", "app-1"], gateway.transport);
  assert.equal(check.code, 0, check.err);
  // A reason this release has no sentence for is shown by its code.
  assert.match(check.out, /Account:\s+payment_overdue/);

  const usage = await run(["usage", "show", "--month", "2026-11", "--json"], gateway.transport);
  assert.equal(usage.code, 0, usage.out);
  assert.equal(usage.json().result.coverage.scope, "all_regions");
  assert.deepEqual(usage.json().notices[0].paths, ["coverage.scope"]);
});

test("app update with flags changes only what it names and resends every addition unchanged", async () => {
  const gateway = deployment({
    getApp: () => newerApp(),
    updateApp: (body) => {
      const { revision: _revision, ...write } = body as Record<string, unknown>;
      return { app: { ...newerApp().app, ...write, revision: 8 } };
    },
  });
  const renamed = await run(["app", "update", "app-1", "--name", "Renamed", "--json"], gateway.transport);
  assert.equal(renamed.code, 0, renamed.out);
  const write = gateway.sent.find((entry) => entry.name === "updateApp")?.body as Record<string, any>;
  assert.deepEqual(write, { name: "Renamed", status: "active", config: newerConfig(), revision: 7 });
  assert.equal(renamed.json().result.app.name, "Renamed");

  // A flag that edits a part of the configuration holding an addition keeps it.
  gateway.sent.length = 0;
  const edited = await run(
    ["app", "update", "app-1", "--team-id", "ZYXWV98765", "--provider", "openai", "--provider", "anthropic"],
    gateway.transport,
  );
  assert.equal(edited.code, 0, edited.err);
  const body = gateway.sent.find((entry) => entry.name === "updateApp")?.body as Record<string, any>;
  const expected = newerConfig() as Record<string, any>;
  expected.authentication.app_attest.team_id = "ZYXWV98765";
  expected.routing.providers.selected.anthropic = { allowed_paths: [], allowed_models: [] };
  assert.deepEqual(body.config, expected);
  assert.match(edited.out, /^Updated app Newer \(app-1\)\./);
});

test("a flag still cannot write a value this release does not know", async () => {
  const gateway = deployment({ getApp: () => newerApp(), updateApp: () => assert.fail("not sent") });
  const refused = await run(["app", "update", "app-1", "--verify-on", "sometimes", "--json"], gateway.transport);
  assert.equal(refused.code, 2);
  const { error } = refused.json();
  assert.equal(error.code, "invalid_input");
  // Named by its own field, and only by it: the additions the app already had
  // are not what is wrong.
  assert.match(error.message, /verify_on/);
  assert.doesNotMatch(error.message, /methods|moderation|per_install/);
});

test("an authentication type newer than this release is kept, and only its own flags are refused", async () => {
  const config = newerConfig() as Record<string, any>;
  config.authentication = { type: "passkey", relying_party: "example.com" };
  const gateway = deployment({
    getApp: () => newerApp(config),
    updateApp: (body) => ({ app: { ...newerApp(config).app, ...(body as object), revision: 8 } }),
  });
  const renamed = await run(["app", "update", "app-1", "--name", "Renamed"], gateway.transport);
  assert.equal(renamed.code, 0, renamed.err);
  assert.deepEqual((gateway.sent[1]?.body as Record<string, unknown>).config, config);
  assert.match(renamed.out, /Authentication:\s+passkey/);

  const refused = await run(["app", "update", "app-1", "--team-id", "ABCDE12345", "--json"], gateway.transport);
  assert.equal(refused.code, 2);
  assert.equal(refused.json().error.code, "cli_outdated");
});

test("a selection made with --provider keeps what a newer gateway wrote beside it", async () => {
  const config = newerConfig() as Record<string, any>;
  config.routing.providers.fallback_order = ["openai"];
  const gateway = deployment({
    getApp: () => newerApp(config),
    updateApp: (body) => ({ app: { ...newerApp(config).app, ...(body as object), revision: 8 } }),
  });
  const result = await run(["app", "update", "app-1", "--provider", "openai"], gateway.transport);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual((gateway.sent[1]?.body as Record<string, any>).config, config);
});

test("a file that changes the inside of an authentication type this release does not know needs --yes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-newer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = structuredClone(known) as Record<string, any>;
  config.authentication = { type: "passkey", relying_party: "example.com" };
  const gateway = deployment({ getApp: () => newerApp(config), updateApp: () => assert.fail("not sent") });
  const path = join(dir, "app.json");
  const edited = structuredClone(config);
  edited.authentication.relying_party = "other.example";
  await writeFile(path, JSON.stringify({ name: "Newer", status: "active", config: edited }));
  const refused = await run(["app", "update", "app-1", "--file", path, "--no-input", "--json"], gateway.transport);
  assert.equal(refused.json().error.code, "confirmation_required");
  assert.match(refused.json().error.message, /config\.authentication\.$/);
});

test("app update --file that would remove or change additions says which, and needs --yes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-newer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gateway = deployment({
    getApp: () => newerApp(),
    validateApp: () => ({ valid: true, app_id: "app-1" }),
    updateApp: (body) => ({ app: { ...newerApp().app, ...(body as object), revision: 8 } }),
  });
  // Written by hand, or saved by an older release: none of the additions.
  const older = join(dir, "older.json");
  await writeFile(older, JSON.stringify({ name: "Newer", status: "active", config: known }));

  const refused = await run(["app", "update", "app-1", "--file", older, "--no-input"], gateway.transport);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /Note: The file leaves out or changes settings app-1 has that agw \S+ does not understand; saving it replaces them\./);
  // Left out, or replaced with a value this release knows: the file names a
  // verify_on and an endpoint kind of its own.
  assert.match(refused.err, /Error: Saving the file replaces settings .* in app-1: config\.authentication\.app_attest\.verify_on, .*config\.endpoints\.answer\.kind, config\.moderation\.\n/);
  assert.match(refused.err, /Code: confirmation_required/);
  assert.equal(gateway.sent.some((entry) => entry.name === "updateApp"), false);

  const json = await run(["app", "update", "app-1", "--file", older, "--no-input", "--json"], gateway.transport);
  assert.equal(json.json().error.code, "confirmation_required");
  assert.deepEqual(
    json.json().notices.find((notice: { code: string }) => notice.code === "unknown_settings_replaced").paths,
    NEWER_PATHS.map((path) => path.slice("app.".length)),
  );

  // A dry run reports it and asks nothing.
  const dry = await run(["app", "update", "app-1", "--file", older, "--dry-run", "--no-input", "--json"], gateway.transport);
  assert.equal(dry.code, 0, dry.out);

  const confirmed = await run(["app", "update", "app-1", "--file", older, "--yes", "--no-input"], gateway.transport);
  assert.equal(confirmed.code, 0, confirmed.err);
  const sent = gateway.sent.filter((entry) => entry.name === "updateApp");
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0]?.body as Record<string, unknown>).config, known);

  // Saved from `app show --json`, the file carries every addition, and there
  // is nothing to confirm.
  const shown = join(dir, "shown.json");
  await writeFile(shown, JSON.stringify({ name: "Kept", status: "active", config: newerConfig() }));
  gateway.sent.length = 0;
  const kept = await run(["app", "update", "app-1", "--file", shown, "--no-input"], gateway.transport);
  assert.equal(kept.code, 0, kept.err);
  assert.doesNotMatch(kept.err, /leaves out/);
  assert.deepEqual((gateway.sent[1]?.body as Record<string, unknown>).config, newerConfig());
});

test("a file using settings newer than this release is left for the gateway to judge", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-newer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "app.json");
  await writeFile(path, JSON.stringify({ name: "Newer", status: "active", config: newerConfig() }));

  // Without a login nothing remote is checked, and the verdict says what was not.
  const offline = await run(["app", "validate", "--file", path, "--json"], deployment({}).transport, fresh());
  assert.equal(offline.code, 0, offline.out);
  const skipped: string[] = offline.json().result.validation.skipped;
  assert.match(skipped.at(-1) ?? "", /does not know were not checked: config\.authentication\.app_attest\.verify_on, .*config\.moderation\.$/);

  // Signed in, the gateway is asked, and is sent the file as written.
  const gateway = deployment({ validateAppDraft: () => ({ valid: true }) });
  const online = await run(["app", "validate", "--file", path], gateway.transport);
  assert.equal(online.code, 0, online.err);
  assert.deepEqual((gateway.sent[0]?.body as Record<string, unknown>).config, newerConfig());

  // A file that is broken, rather than new, is still refused before anything is sent.
  const broken = join(dir, "broken.json");
  const config = newerConfig() as Record<string, any>;
  config.authentication.app_attest.team_id = "nope";
  await writeFile(broken, JSON.stringify({ name: "Newer", config }));
  const refused = await run(["app", "validate", "--file", broken, "--json"], gateway.transport);
  assert.equal(refused.code, 2);
  assert.match(refused.json().error.message, /team_id/);
  assert.doesNotMatch(refused.json().error.message, /moderation/);
});

test("a broken answer is still refused, whatever else it carries", async () => {
  const broken: [string, (app: Record<string, any>) => void][] = [
    ["a missing required field", (app) => delete app.name],
    ["a wrong type", (app) => (app.revision = "7")],
    ["a wrong type beside an addition", (app) => (app.config.routing.model_rewrites = [])],
    ["a number where an enum is expected", (app) => (app.config.endpoints.answer.api_style = 3)],
    ["an empty string a field forbids", (app) => (app.config.routing.providers.selected.openai.allowed_models = [""])],
    ["a configuration of the wrong shape", (app) => (app.config.routing.providers.selected = [])],
  ];
  for (const [label, damage] of broken) {
    const answer = newerApp() as unknown as { app: Record<string, any> };
    damage(answer.app);
    const gateway = deployment({ getApp: () => answer });
    const result = await run(["app", "show", "app-1", "--json"], gateway.transport);
    assert.equal(result.code, 3, label);
    assert.equal(result.json().error.code, "invalid_response", label);
  }
  // A check this release does know is not waved through by having nothing new beside it.
  const refined = structuredClone(known) as Record<string, any>;
  refined.authentication = { type: "api_key", end_user: { source: "none" } };
  refined.limits.per_user.requests.per_minute = 5;
  const gateway = deployment({ getApp: () => newerApp(refined) });
  assert.equal((await run(["app", "show", "app-1", "--json"], gateway.transport)).json().error.code, "invalid_response");
});

test("tolerance keeps additions only in strict objects, so an undeclared field never reaches stdout", () => {
  // A provider gateway's config is a read-only view that drops what it does
  // not declare, here a token. A value no enum lists beside it does not
  // change that.
  const read = tolerant(CATALOG.listProviderGateways.response, {
    gateways: [{
      id: "g", name: "CF", type: "cf_aig", secretHint: "…safe", providerCount: 0,
      referencedCount: 0, revision: 1, status: "suspended", createdAt: "now",
      updatedAt: "now", createdBy: "me",
      config: { accountId: "cf-account", gatewayId: "cf-gateway", token: "SENTINEL" },
    }],
  });
  assert.ok(read);
  assert.equal(JSON.stringify(read.data).includes("SENTINEL"), false);
  assert.deepEqual(read.unknown, [{ path: ["gateways", 0, "status"], value: "suspended" }]);

  // A variant a union of read-only views does not name is broken, not new:
  // there is nothing strict to keep it in.
  const views = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("a"), a: z.string() }),
    z.object({ kind: z.literal("b"), b: z.string() }),
  ]);
  assert.equal(tolerant(views, { kind: "c", secret: "SENTINEL" }), undefined);
  // A protocol version is a number, never an enum to extend.
  assert.equal(tolerant(z.object({ protocolVersion: z.literal(1) }), { protocolVersion: 2 }), undefined);
});

test("usage event cost sources newer than this release are kept as sent", () => {
  const event = {
    id: 1, user_id: null, install_id: null, api_key_id: null, provider: "openai",
    provider_slug: "openai", provider_gateway_id: null, provider_gateway_type: null,
    credential_source: null, model_author: null, served_provider: null, served_model: null,
    model: "gpt-x", route: "v1/responses", endpoint_slug: null, input_tokens: 1,
    cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 1, cost_usd: 0,
    reported_cost_usd: null, cost_source: "estimated", app_version: null, auth_method: null,
    status: "ok", client_aborted: null, latency_ms: 10, client_trace_id: null, created_at: "now",
  };
  const read = tolerant(UsageEventSchema, event);
  assert.deepEqual(read?.data, event);
  assert.deepEqual(read?.unknown, [{ path: ["cost_source"], value: "estimated" }]);
});

/** What `/v1/cli/capabilities` answers for a gateway of this release and mode. */
const capabilities = (serverVersion: string, mode: "cloud" | "self_hosted") => ({
  protocolVersion: 1,
  serverVersion,
  deployment: { id: "dep-1", mode, apiUrl: "https://gw.example", consoleOrigin: "https://console.example" },
  consoleOrigin: "https://console.example",
  providers: [],
  providerGateways: [],
});

/** A gateway that refuses `getApp` as given, and reports its release when asked. */
function refusing(refusal: CliError, serverVersion: string, mode: "cloud" | "self_hosted" = "cloud") {
  const asked: string[] = [];
  const timeouts: (number | undefined)[] = [];
  return {
    asked,
    timeouts,
    transport: {
      request: async (_url: string, path: string, options: { timeoutMs?: number } = {}) => {
        asked.push(path);
        timeouts.push(options.timeoutMs);
        if (path === operationPath("getCliCapabilities")) return { data: capabilities(serverVersion, mode) };
        throw refusal;
      },
    },
  };
}

const badRequest = () => new CliError("invalid_request", "Deployment rejected the request (HTTP 400).", "Review.", 3, { status: 400 });

test("a failure the gateway answered says when the CLI is older than the gateway API", async () => {
  const gateway = refusing(badRequest(), "99.0.0");
  const human = await run(["app", "show", "app-1"], gateway.transport);
  assert.equal(human.code, 3);
  // After the failure, never instead of it.
  assert.match(
    human.err,
    /\nCode: invalid_request\n {2}status: 400\nNote: Your agw CLI \(\S+\) is older than the gateway API it talks to \(99\.0\.0\)\. Updating the CLI may fix this: npm install -g @maxceem\/agw\n$/,
  );
  // The lookup has a short timeout of its own, so a stalled gateway cannot keep
  // the failed command running.
  assert.deepEqual(gateway.timeouts, [undefined, 5000]);
  const json = await run(["app", "show", "app-1", "--json"], gateway.transport);
  assert.equal(json.json().error.code, "invalid_request");
  assert.deepEqual(json.json().notices.map((n: { code: string; apiVersion: string }) => [n.code, n.apiVersion]), [["version_mismatch", "99.0.0"]]);
});

test("a self-hosted gateway older than the CLI is named as the one to update", async () => {
  const human = await run(["app", "show", "app-1"], refusing(badRequest(), "0.1.0", "self_hosted").transport);
  assert.match(human.err, /Note: Your self-hosted gateway API \(0\.1\.0\) is older than this agw CLI \(\S+\)\. Updating the gateway may fix this: agw deployment update\n$/);
  // The hosted gateway is not the user's to update, so nothing is said.
  const hosted = await run(["app", "show", "app-1"], refusing(badRequest(), "0.1.0", "cloud").transport);
  assert.doesNotMatch(hosted.err, /Note:/);
});

test("no version note where versions cannot be the cause", async () => {
  const { VERSION } = await import("../src/common.ts");
  // The same release.
  assert.doesNotMatch((await run(["app", "show", "app-1"], refusing(badRequest(), VERSION).transport)).err, /Note:/);
  // A refusal with a cause of its own: the gateway is not even asked.
  for (const status of [401, 403, 409, 429]) {
    const gateway = refusing(new CliError("refused", "No.", "", 3, { status }), "99.0.0");
    const result = await run(["app", "show", "app-1"], gateway.transport);
    assert.doesNotMatch(result.err, /Note:/, String(status));
    assert.equal(gateway.asked.length, 1);
  }
  // An unreadable body arriving with one of those statuses is the same refusal.
  const unreadable = refusing(new CliError("invalid_response", "Not JSON.", "", 3, { status: 403 }), "99.0.0");
  assert.doesNotMatch((await run(["app", "show", "app-1"], unreadable.transport)).err, /Note:/);
  assert.equal(unreadable.asked.length, 1);
  // A failed connect is about a gateway other than the selected one.
  const connect = refusing(badRequest(), "99.0.0");
  const connected = await run(["deployment", "connect", "--url", "https://other.example", "--no-open", "--no-input"], connect.transport);
  assert.notEqual(connected.code, 0);
  assert.doesNotMatch(connected.err, /Note:/);
  // Nothing reached the gateway at all.
  const unreachable = refusing(new CliError("connection_failed", "Could not reach.", "", 3), "99.0.0");
  assert.doesNotMatch((await run(["app", "show", "app-1"], unreachable.transport)).err, /Note:/);
  assert.equal(unreachable.asked.length, 1);
});
