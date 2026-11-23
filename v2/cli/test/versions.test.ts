import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError, VERSION } from "../src/common.ts";
import { main, MemoryCatalogCache } from "../src/main.ts";
import { compareVersions } from "../src/versions.ts";
import type { RequestOptions } from "../src/transport.ts";
import { fakeClock, fakeTransport, memoryStore, signedInState, sinks } from "./helpers.ts";

const URL_ = "https://console.gw.example";

/** `VERSION` moved by one patch release, up or down. */
function shifted(by: 1 | -1): string {
  const [major, minor, patch] = VERSION.split(".").map(Number) as [number, number, number];
  if (by === 1) return `${major}.${minor}.${patch + 1}`;
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  return minor > 0 ? `${major}.${minor - 1}.9` : `${major - 1}.9.9`;
}

/**
 * Runs `agw app update app_1 --status disabled`, whose app read the gateway
 * refuses with `status`, against a gateway that reports `capabilities`.
 */
async function failing(status: number, capabilities: Record<string, unknown>, json = true) {
  const out = sinks();
  const lookups: string[] = [];
  const transport = fakeTransport(async (path: string, _options: RequestOptions) => {
    if (path === "/v2/console/capabilities") {
      lookups.push(path);
      return { data: { billing: false, registrationOpen: true, googleAuth: false, oauth: true, ...capabilities } };
    }
    throw new CliError("invalid_request", "The gateway refused this.", "Fix the request.", 3, { status });
  });
  const argv = ["app", "update", "app_1", "--status", "disabled", ...(json ? ["--json"] : [])];
  const code = await main(argv, {
    store: memoryStore(signedInState(URL_, "agw_oat_1")),
    transport,
    stdout: out.stdout,
    stderr: out.stderr,
    io: { env: {}, clock: fakeClock() },
    catalogCache: new MemoryCatalogCache(),
  });
  return { code, out: out.out.text, err: out.err.text, lookups };
}

test("releases compare as numbers, and anything else is not compared", () => {
  assert.ok(compareVersions("2.0.9", "2.0.10")! < 0);
  assert.equal(compareVersions("2.1.0", "2.1.0"), 0);
  assert.ok(compareVersions("3.0.0", "2.9.9")! > 0);
  assert.equal(compareVersions("2.0", "2.0.0"), undefined);
  assert.equal(compareVersions("2.0.0-beta", "2.0.0"), undefined);
});

test("a failure from a newer gateway says the CLI is older, in the envelope and after the error", async () => {
  const newer = shifted(1);
  const json = await failing(400, { serverVersion: newer });
  assert.notEqual(json.code, 0);
  const envelope = JSON.parse(json.out);
  assert.equal(envelope.ok, false);
  assert.deepEqual(envelope.notices, [
    {
      code: "version_mismatch",
      message: `Your agw CLI (${VERSION}) is older than the gateway it talks to (${newer}). Updating the CLI may fix this: npm install -g @maxceem/agw`,
      cliVersion: VERSION,
      apiVersion: newer,
    },
  ]);
  const text = await failing(400, { serverVersion: newer }, false);
  assert.ok(text.err.indexOf("Error: The gateway refused this.") < text.err.indexOf("Note: Your agw CLI"), text.err);
});

test("an older self-hosted gateway is the person's to update; an older hosted one is not mentioned", async () => {
  const older = shifted(-1);
  const selfHosted = JSON.parse((await failing(400, { serverVersion: older })).out);
  assert.equal(selfHosted.notices?.[0]?.code, "version_mismatch");
  assert.match(selfHosted.notices[0].message, /self-hosted gateway .* is older than this agw CLI/u);
  const hosted = JSON.parse((await failing(400, { serverVersion: older, billing: true })).out);
  assert.equal(hosted.notices, undefined);
});

test("no note for the same release, a gateway that does not say its release, or a refusal releases cannot explain", async () => {
  assert.equal(JSON.parse((await failing(400, { serverVersion: VERSION })).out).notices, undefined);
  assert.equal(JSON.parse((await failing(400, {})).out).notices, undefined);
  for (const status of [401, 403, 409, 429]) {
    const result = await failing(status, { serverVersion: shifted(1) });
    assert.equal(JSON.parse(result.out).notices, undefined, String(status));
    assert.deepEqual(result.lookups, [], `no lookup after a ${status}`);
  }
});

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

async function status(capabilities: (options: RequestOptions, sessionAsked: Promise<void>) => Promise<unknown>) {
  const out = sinks();
  let asked!: () => void;
  const sessionAsked = new Promise<void>((resolve) => (asked = resolve));
  const transport = fakeTransport(async (path: string, options: RequestOptions) => {
    if (path === "/v2/console/capabilities") return { data: await capabilities(options, sessionAsked) };
    if (path === "/v2/admin/session") {
      asked();
      return { data: SESSION };
    }
    throw new Error(`unexpected ${path}`);
  });
  const code = await main(["deployment", "status", "--json"], {
    store: memoryStore(signedInState(URL_, "agw_oat_1")),
    transport,
    stdout: out.stdout,
    stderr: out.stderr,
    io: { env: {}, clock: fakeClock() },
    catalogCache: new MemoryCatalogCache(),
  });
  return { code, json: JSON.parse(out.out.text || "{}"), err: out.err.text };
}

test("deployment status asks for the release beside the session, with a short limit, and shows it", async () => {
  const result = await status(async (options, sessionAsked) => {
    // The session is asked before this answers: the two run side by side.
    await sessionAsked;
    assert.ok(options.timeoutMs !== undefined && options.timeoutMs <= 5_000, `timeoutMs ${options.timeoutMs}`);
    return { billing: false, registrationOpen: true, googleAuth: false, oauth: true, serverVersion: "2.0.0", prices: { revision: "abcdef012345", updated: null } };
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json.result.serverVersion, "2.0.0");
  assert.deepEqual(result.json.result.prices, { revision: "abcdef012345", updated: null });
  assert.equal(result.json.result.signedIn, true);
});

test("deployment status still answers when the release cannot be read", async () => {
  const result = await status(async () => {
    throw new CliError("network_error", "connection reset");
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json.result.signedIn, true);
  assert.equal(result.json.result.serverVersion, undefined);
});
