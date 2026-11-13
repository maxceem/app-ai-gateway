/**
 * A deployment newer than this CLI.
 *
 * Every answer here carries settings no release of `agw` has ever shipped
 * with: keys the configuration grammar does not declare, at several depths,
 * and values its enums do not list. The commands that show, list and change
 * an app are the gateway's own, built from the tool list it serves, so they
 * never meet a setting they do not know; what is left here is the tolerance
 * the commands this CLI implements itself still read answers with, and the
 * note a failure gets when the two releases differ.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { CATALOG, operationPath, type OperationName } from "../../src/contracts/catalog.ts";
import { UsageEventSchema } from "../../src/contracts/responses.ts";
import { CliError } from "../src/common.ts";
import { main } from "../src/main.ts";
import { tolerant } from "../src/tolerant.ts";
import type { CliState } from "../src/state.ts";
import type { Transport } from "../src/transport.ts";
import { fresh, makeStore } from "./helpers.ts";

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

test("an answer with nothing new prints exactly what it always did", async () => {
  const gateway = deployment({ getAppSnippet: () => ({ language: "shell", snippet: "curl", notes: [] }) });
  const json = await run(["app", "snippet", "app-1", "--json"], gateway.transport);
  assert.equal(json.code, 0);
  assert.deepEqual(Object.keys(json.json()), ["schemaVersion", "ok", "context", "result"]);
  const human = await run(["app", "snippet", "app-1"], gateway.transport);
  assert.equal(human.err, "");
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

/** A gateway that refuses every call but its capabilities, and reports its release when asked. */
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
  const human = await run(["app", "snippet", "app-1"], gateway.transport);
  assert.equal(human.code, 3);
  // After the failure, never instead of it.
  assert.match(
    human.err,
    /\nCode: invalid_request\n {2}status: 400\nNote: Your agw CLI \(\S+\) is older than the gateway API it talks to \(99\.0\.0\)\. Updating the CLI may fix this: npm install -g @maxceem\/agw\n$/,
  );
  // The lookup has a short timeout of its own, so a stalled gateway cannot keep
  // the failed command running.
  assert.deepEqual(gateway.timeouts, [undefined, 5000]);
  const json = await run(["app", "snippet", "app-1", "--json"], gateway.transport);
  assert.equal(json.json().error.code, "invalid_request");
  assert.deepEqual(json.json().notices.map((n: { code: string; apiVersion: string }) => [n.code, n.apiVersion]), [["version_mismatch", "99.0.0"]]);
});

test("a self-hosted gateway older than the CLI is named as the one to update", async () => {
  const human = await run(["app", "snippet", "app-1"], refusing(badRequest(), "0.1.0", "self_hosted").transport);
  assert.match(human.err, /Note: Your self-hosted gateway API \(0\.1\.0\) is older than this agw CLI \(\S+\)\. Updating the gateway may fix this: agw deployment update\n$/);
  // The hosted gateway is not the user's to update, so nothing is said.
  const hosted = await run(["app", "snippet", "app-1"], refusing(badRequest(), "0.1.0", "cloud").transport);
  assert.doesNotMatch(hosted.err, /Note:/);
});

test("no version note where versions cannot be the cause", async () => {
  const { VERSION } = await import("../src/common.ts");
  // The same release.
  assert.doesNotMatch((await run(["app", "snippet", "app-1"], refusing(badRequest(), VERSION).transport)).err, /Note:/);
  // A refusal with a cause of its own: the gateway is not even asked.
  for (const status of [401, 403, 409, 429]) {
    const gateway = refusing(new CliError("refused", "No.", "", 3, { status }), "99.0.0");
    const result = await run(["app", "snippet", "app-1"], gateway.transport);
    assert.doesNotMatch(result.err, /Note:/, String(status));
    assert.equal(gateway.asked.length, 1);
  }
  // An unreadable body arriving with one of those statuses is the same refusal.
  const unreadable = refusing(new CliError("invalid_response", "Not JSON.", "", 3, { status: 403 }), "99.0.0");
  assert.doesNotMatch((await run(["app", "snippet", "app-1"], unreadable.transport)).err, /Note:/);
  assert.equal(unreadable.asked.length, 1);
  // A failed connect is about a gateway other than the selected one.
  const connect = refusing(badRequest(), "99.0.0");
  const connected = await run(["deployment", "connect", "--url", "https://other.example", "--no-open", "--no-input"], connect.transport);
  assert.notEqual(connected.code, 0);
  assert.doesNotMatch(connected.err, /Note:/);
  // Nothing reached the gateway at all.
  const unreachable = refusing(new CliError("connection_failed", "Could not reach.", "", 3), "99.0.0");
  assert.doesNotMatch((await run(["app", "snippet", "app-1"], unreachable.transport)).err, /Note:/);
  assert.equal(unreachable.asked.length, 1);
});
