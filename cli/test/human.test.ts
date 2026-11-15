import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { CliAccountResponse, CliDeployment } from "../../src/contracts/cli.ts";
import type {
  AppResponse,
  ProviderGatewaySummary,
  ProviderSummary,
} from "../../src/contracts/responses.ts";
import { parseAppConfig } from "../../src/shared/app-config.ts";
import { CliError } from "../src/common.ts";
import { humanResult, type OutputContext } from "../src/human.ts";
import { maskDelta } from "../src/input.ts";
import { colorEnabled, style } from "../src/style.ts";
import { main } from "../src/main.ts";
import type { CommandName } from "../src/parser.ts";
import type { RenderedResult } from "../src/results.ts";
import { fresh, makeStore, served } from "./helpers.ts";

const context: OutputContext = { url: "https://gw.example" };
const owned: OutputContext = { url: "https://gw.example", accountId: "acct_1" };

const deployment: CliDeployment = {
  id: "dep_1",
  mode: "cloud",
  apiUrl: "https://api.example",
  consoleOrigin: "https://console.example",
};

const provider: ProviderSummary = {
  id: "prv_1",
  type: "openai",
  slug: "openai",
  name: "OpenAI",
  secretHint: "ab12",
  providerGatewayId: null,
  gatewayRoute: null,
  baseUrl: null,
  pricing: null,
  ...served("openai"),
  revision: 1,
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  createdBy: "user_1",
};

const gateway: ProviderGatewaySummary = {
  id: "pgw_1",
  name: "Cloudflare AI Gateway",
  secretHint: "cd34",
  providerCount: 1,
  referencedCount: 2,
  revision: 1,
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  createdBy: "user_1",
  type: "cf_aig",
  config: { accountId: "cf_acct", gatewayId: "gw_1" },
};

const stored = {
  id: "key_1",
  name: "server",
  key_prefix: "agw_abc",
  created_at: "2026-01-01T00:00:00Z",
  storagePath: "/tmp/app.key",
  contentHash: "hash",
};

/** The smallest valid server configuration, as the schema's own parse produces it. */
const UNLIMITED_SERVER_CONFIG = parseAppConfig({
  authentication: { type: "api_key", end_user: { source: "none" } },
  routing: { providers: { mode: "all" }, model_rewrites: {} },
});

const app: AppResponse = {
  app: {
    revision: 1,
    id: "app_1",
    name: "Example",
    config: UNLIMITED_SERVER_CONFIG,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    warnings: [],
  },
};

const account: CliAccountResponse = {
  deployment,
  account: {
    id: "acct_1",
    name: "Example",
    createdAt: "2026-01-01T00:00:00Z",
    claimed: false,
    expiresAt: null,
  },
  billing: { access: { state: "self_hosted" } },
  usage: null,
};

/** One command shape and what its plain-text rendering has to say about it. */
interface Case {
  name: string;
  command: CommandName;
  result: RenderedResult;
  context?: OutputContext;
  includes: string[];
  excludes?: string[];
}

const cases: Case[] = [
  {
    name: "deployment status reports the version and what it supports",
    command: "deployment status",
    result: {
      protocolVersion: 1,
      serverVersion: "0.1.9",
      deployment,
      consoleOrigin: "https://console.example",
      providers: [
        {
          type: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1/",
          apiStyles: ["responses"],
          endpointStyles: [],
        },
      ],
      providerGateways: [{ type: "cf_aig", name: "Cloudflare AI Gateway" }],
      url: "https://gw.example",
      authenticated: true,
      connected: true,
    },
    includes: ["Version:", "0.1.9", "Authenticated:", "yes", "Provider types:"],
    excludes: ["{"],
  },
  {
    name: "account login confirms the sign-in before reporting the account",
    command: "account login",
    result: { ...account, connected: true },
    context: owned,
    includes: ["Signed in to https://gw.example.", "Account:", "Example (acct_1)"],
  },
  {
    name: "deployment connect confirms which deployment it selected",
    command: "deployment connect",
    result: { ...account, connected: true },
    context: owned,
    includes: ["Connected to https://gw.example.", "Account:", "Example (acct_1)"],
  },
  {
    name: "provider types is a table of the adapters this deployment carries",
    command: "provider types",
    result: [
      {
        type: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1/",
        apiStyles: ["responses"],
        endpointStyles: [],
      },
    ],
    includes: ["TYPE", "openai", "https://api.openai.com/v1/"],
  },
  {
    name: "provider update confirms in one line and prints only the hint",
    command: "provider update",
    result: { provider },
    includes: ["Updated provider OpenAI (prv_1).", "Key hint:", "ab12"],
    excludes: ["{"],
  },
  {
    name: "provider add says the credential was stored without a probe",
    command: "provider add",
    result: { provider },
    includes: ["Stored provider OpenAI (prv_1).", "no upstream probe"],
  },
  {
    name: "provider-gateway rotate-key confirms the gateway it rotated",
    command: "provider-gateway rotate-key",
    result: { gateway },
    includes: ["Updated provider gateway Cloudflare AI Gateway (pgw_1).", "Token hint:"],
  },
  {
    name: "provider remove names what is gone",
    command: "provider remove",
    result: { deleted: true, provider_id: "prv_1" },
    includes: ["Removed provider prv_1."],
  },
  {
    name: "app key add names the file the key was written to",
    command: "app key add",
    result: { appId: "app_1", applicationKey: stored },
    includes: ["Created key server (key_1) for app app_1.", "Key saved: /tmp/app.key"],
    excludes: ["hash"],
  },
  {
    name: "logout says which gateway the credential was removed for",
    command: "account logout",
    result: { loggedOut: true },
    includes: ["Signed out of https://gw.example."],
  },
  {
    name: "a pending handoff keeps its URL and the command that resumes it",
    command: "provider add",
    result: {
      id: "op_1",
      url: "https://console.example/cli/op_1",
      expiresAt: "2026-09-17T00:00:00Z",
      state: "pending",
      deployment,
    },
    includes: [
      "Waiting for browser approval (op_1).",
      "https://console.example/cli/op_1",
      "Resume: agw operation wait op_1",
    ],
  },
  {
    name: "a completed operation reports its state and what it created",
    command: "operation wait",
    result: {
      id: "op_1",
      kind: "provider.add",
      expiresAt: "2026-09-17T00:00:00Z",
      deployment,
      state: "completed",
      result: { provider },
    },
    includes: ["Operation:", "State:", "completed", "Provider:", "OpenAI (prv_1)"],
    excludes: ["{"],
  },
  {
    name: "a dry-run application write says nothing was written",
    command: "app add",
    result: {
      dryRun: true,
      definition: {
        name: "Example",
        status: "active",
        config: UNLIMITED_SERVER_CONFIG,
      },
      validation: { local: true, remote: true, valid: true, app_id: "app_1" },
    },
    includes: ["Dry run: Example is valid here and on the gateway.", "Nothing was written."],
  },
  {
    name: "a written application keeps its guidance and its key path",
    command: "app add",
    result: {
      app: app.app,
      applicationKey: stored,
      guidance: "Store the generated key on your server.",
    },
    includes: [
      "Created app Example (app_1).",
      "Gateway:",
      "Authentication:",
      "server application API key",
      "Per-user limits:",
      "Key saved:",
      "/tmp/app.key",
      "Store the generated key on your server.",
    ],
    excludes: ["App ID:"],
  },
  {
    name: "a snippet written to a file reports only the path",
    command: "app snippet",
    result: { output: "/tmp/snippet.sh" },
    includes: ["Saved: /tmp/snippet.sh"],
  },
  {
    name: "deployment domain prints the plan it would apply",
    command: "deployment domain",
    result: {
      dryRun: true,
      hostname: "api.example.com",
      zoneId: "zone_1",
      worker: "gateway",
      accountId: "cf_acct",
      previousUrl: "https://gateway.workers.dev",
    },
    includes: ["Would attach domain:", "api.example.com", "Worker:", "Zone:"],
    excludes: ["{"],
  },
  {
    name: "deployment update prints both versions",
    command: "deployment update",
    result: {
      updated: true,
      worker: "gateway",
      accountId: "cf_acct",
      databaseId: "db_1",
      fromVersion: "0.1.8",
      toVersion: "0.1.9",
    },
    includes: ["From version:", "0.1.8", "To version:", "0.1.9", "Updated:", "yes"],
  },
  {
    name: "deployment setup prints the installation it made",
    command: "deployment setup",
    result: {
      installed: true,
      name: "gateway",
      accountId: "cf_acct",
      url: "https://gateway.workers.dev",
      version: "0.1.9",
      domain: null,
      resources: ["D1 database", "Worker"],
      deploymentId: "dep_1",
    },
    includes: ["Worker:", "gateway", "Resources:", "D1 database, Worker", "Deployment:", "dep_1"],
  },
];

/** The same output as a terminal would receive it, with the colour taken off. */
const stripped = (text: string): string => text.replace(/\u001b\[\d+m/g, "");

test("every command shape renders as plain text a person can read", () => {
  for (const item of cases) {
    const where = item.context ?? context;
    const text = humanResult(item.command, item.result, where);
    assert.equal(text.endsWith("\n"), true, item.name);
    assert.equal(text.includes("\u001b["), false, `${item.name}: coloured by default`);
    for (const expected of item.includes)
      assert.ok(text.includes(expected), `${item.name}: missing ${expected}\n${text}`);
    for (const forbidden of item.excludes ?? [])
      assert.ok(!text.includes(forbidden), `${item.name}: printed ${forbidden}\n${text}`);
    // Colour is added on top of a layout that is decided without it: every
    // width is measured on the plain text, so taking the colour off again has
    // to give back exactly the plain rendering.
    assert.equal(
      stripped(humanResult(item.command, item.result, where, style(true))),
      text,
      item.name,
    );
    assert.equal(text.includes("Account ID"), false, `${item.name}: trailer returned`);
  }
});

test("a snippet is the whole of its own output, with nothing appended", () => {
  const snippet = "curl https://gw.example/v1/app_1/proxy/openai/v1/responses";
  assert.equal(
    humanResult("app snippet", { language: "shell", snippet, notes: [] }, owned),
    snippet,
  );
  // On a terminal nothing is being piped, so the same snippet is framed.
  const framed = humanResult(
    "app snippet",
    { language: "shell", snippet, notes: [] },
    owned,
    style(true),
  );
  assert.equal(stripped(framed), `── shell ──\n${snippet}\n───────────\n`);
  assert.ok(framed.includes("\u001b[2m"));
});

test("colour is decided by the destination, and NO_COLOR and FORCE_COLOR settle it", () => {
  const sink = { write: () => {} };
  const terminal = new Writable({ write(_chunk, _encoding, done) { done(); } });
  Object.defineProperty(terminal, "isTTY", { value: true });
  Object.defineProperty(terminal, "getColorDepth", { value: () => 24 });
  const piped = new Writable({ write(_chunk, _encoding, done) { done(); } });
  // An injected sink and a pipe are the same thing to this: not a terminal.
  assert.equal(colorEnabled(sink, {}), false);
  assert.equal(colorEnabled(piped, {}), false);
  assert.equal(colorEnabled(terminal, { FORCE_COLOR: "1" }), true);
  assert.equal(colorEnabled(terminal, { NO_COLOR: "1" }), false);
  // FORCE_COLOR reaches a stream, but never a sink that is not one at all,
  // which is what keeps this suite's own output plain wherever it runs.
  assert.equal(colorEnabled(sink, { FORCE_COLOR: "1" }), false);
  assert.equal(colorEnabled(piped, { FORCE_COLOR: "1" }), true);
});

test("colour marks the headline, the labels and the state words, and nothing else", () => {
  const types = humanResult(
    "provider types",
    [{ type: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1/", apiStyles: [], endpointStyles: [] }],
    context,
    style(true),
  );
  // Dim table header, and a value left in the terminal's own colour.
  assert.ok(types.includes("\u001b[2mTYPE"), types);
  assert.ok(!types.includes("\u001b[32mopenai"), types);
  const updated = humanResult("provider update", { provider }, context, style(true));
  // Green state, and an id left in the terminal's own colour.
  assert.ok(updated.includes("\u001b[32mactive\u001b[39m"), updated);
  assert.ok(!updated.includes("\u001b[32mprv_1"), updated);
  const removed = humanResult(
    "provider remove",
    { deleted: true, provider_id: "prv_1" },
    context,
    style(true),
  );
  assert.equal(removed, "\u001b[1mRemoved provider prv_1.\u001b[22m\n");
  const status = humanResult("account logout", { loggedOut: true }, context, style(true));
  assert.ok(status.startsWith("\u001b[1mSigned out of https://gw.example.\u001b[22m"), status);
  const disabled = humanResult("provider update", { provider: { ...provider, status: "disabled" } }, context, style(true));
  assert.ok(disabled.includes("\u001b[31mdisabled\u001b[39m"), disabled);
});

test("the JSON document is highlighted on a terminal and exact everywhere else", () => {
  const document = { app_id: "app_1", revision: 1, enabled: true, note: null };
  const off = humanResult("provider-gateway show", { ...gateway }, context);
  assert.equal(off.includes("\u001b["), false);
  const on = style(true).json(document);
  assert.equal(stripped(on), JSON.stringify(document, null, 2));
  // Keys bold, punctuation dim, strings plain, scalars in the accent colour.
  assert.ok(on.includes('\u001b[1m"revision"\u001b[22m'), on);
  assert.ok(on.includes("\u001b[32m1\u001b[39m"), on);
  assert.ok(on.includes("\u001b[32mtrue\u001b[39m"), on);
  assert.ok(on.includes("\u001b[32mnull\u001b[39m"), on);
  assert.ok(on.includes('"app_1"'), on);
  assert.equal(style(false).json(document), JSON.stringify(document, null, 2));
});

test("key and value lines share one value column", () => {
  const text = humanResult("account logout", { loggedOut: true }, context);
  assert.equal(text, "Signed out of https://gw.example. The stored credential was removed.\n");
  const status = humanResult("deployment status", {
    protocolVersion: 1,
    serverVersion: "0.1.9",
    deployment,
    consoleOrigin: "https://console.example",
    providers: [],
    providerGateways: [],
    url: "https://gw.example",
    authenticated: false,
    connected: true,
  }, context).split("\n");
  const columns = status
    .filter((line) => line.includes(": "))
    .map((line) => /^[^:]+: +/.exec(line)?.[0].length);
  assert.equal(new Set(columns).size, 1, status.join("\n"));
});

test("a hidden prompt acknowledges every character it accepts, up to a line of them", () => {
  // The prompt itself needs a real terminal, so what is tested here is the one
  // thing that decides what appears: the mask, with the value nowhere in it.
  assert.equal(maskDelta(0, 3), "***");
  assert.equal(maskDelta(3, 3), "");
  assert.equal(maskDelta(3, 2), "\b \b");
  assert.equal(maskDelta(3, 0), "\b \b\b \b\b \b");
  // A pasted key is acknowledged without wrapping the line away.
  assert.equal(maskDelta(0, 5000).length, 64);
  assert.equal(maskDelta(64, 5000), "");
});

test("a plain-text failure goes to stderr, leaving stdout empty, and keeps its exit code", async () => {
  let out = "";
  let err = "";
  const code = await main(["operation", "wait", "op_1", "--timeout", "0"], {
    store: { ...makeStore(), read: async () => fresh() },
    transport: {
      request: async () => {
        throw new Error("no request is made for a refused timeout");
      },
    },
    stdout: { write: (text: string) => void (out += text) },
    stderr: { write: (text: string) => void (err += text) },
  });
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /^Error: Supply an integer between 1 and 3600\./);
  assert.match(err, /\nNext: /);
  assert.match(err, /\nCode: invalid_input\n$/);
});

test("the same failure with --json stays one document on stdout", async () => {
  let out = "";
  let err = "";
  const code = await main(["operation", "wait", "op_1", "--timeout", "0", "--json"], {
    store: { ...makeStore(), read: async () => fresh() },
    transport: { request: async () => assert.fail("no request") },
    stdout: { write: (text: string) => void (out += text) },
    stderr: { write: (text: string) => void (err += text) },
  });
  assert.equal(code, 2);
  assert.equal(err, "");
  assert.equal(out.trimEnd().includes("\n"), false);
  const printed: unknown = JSON.parse(out);
  assert.deepEqual(printed, {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "invalid_input",
      message: "Supply an integer between 1 and 3600.",
      nextAction: "Run agw --help for usage.",
    },
  });
});

test("error details are printed as indented fields under the text failure", async () => {
  let err = "";
  const code = await main(["operation", "status", "op_1"], {
    store: {
      ...makeStore(),
      read: async () => ({
        ...fresh(),
        active: { url: "https://gw.example", credential: "token", authenticated: true },
        operations: {
          op_1: {
            url: "https://gw.example",
            token: "t".repeat(40),
            kind: "claim",
            requestHash: "hash",
            accountId: null,
            createdAt: "now",
          },
        },
      }),
    },
    transport: {
      request: async () => {
        throw new CliError("rate_limited", "Too many requests.", "Wait and repeat it.", 3, {
          retryAfterSeconds: 30,
          scope: "account",
        });
      },
    },
    stdout: { write: () => {} },
    stderr: { write: (text: string) => void (err += text) },
  });
  assert.notEqual(code, 0);
  assert.match(err, /\n {2}retryAfterSeconds: 30\n/);
  assert.match(err, /\n {2}scope: account\n/);
});
