import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, CLOUD } from "../src/common.ts";
import { operationIdFor } from "../src/context.ts";
import { browserAvailable, listenLoopback } from "../src/login.ts";
import { main } from "../src/main.ts";
import type { RequestOptions } from "../src/transport.ts";
import { StateStore, type CliState } from "../src/state.ts";
import { fresh, makeStore } from "./helpers.ts";

/** Where a fresh CLI logs in. */
const URL_ = CLOUD;
const CONSOLE = "https://console.example.com";
const ISSUED = "SENTINEL-ISSUED-KEY";

const account = {
  id: "account-1",
  name: "Account",
  createdAt: "2026-09-14T00:00:00.000Z",
  claimed: true,
  expiresAt: null,
};
const deployment = { id: "deploy-1", mode: "cloud", apiUrl: URL_, consoleOrigin: CONSOLE };
const accountResponse = {
  deployment,
  account,
  billing: { access: { state: "self_hosted" } },
  usage: null,
};

interface Call {
  path: string;
  method: string;
  key?: string | undefined;
  body?: unknown;
}

/**
 * A deployment that serves the login endpoints the way the gateway does: one
 * login at a time, approved or declined by `approve`/`deny` as a person on the
 * console would, its key handed to the first completed poll or, with a
 * loopback redirect, only to `redeem`.
 */
function deploymentFake({ browserLogin = true }: { browserLogin?: boolean } = {}) {
  const calls: Call[] = [];
  let login:
    | {
        token: string;
        id: string;
        loopbackRedirect?: string;
        client: unknown;
        state: "pending" | "completed" | "denied";
        redeemCode?: string;
        collected: boolean;
      }
    | undefined;
  const revoked = new Set<string>();
  /** Each login gets its own pairing code, so a replaced one is told apart. */
  const codes = ["ABCD-EFGH", "WXYZ-2345"];
  let opened = 0;
  const request = async (_url: string, path: string, options: RequestOptions = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path, method, key: options.key, body: options.body });
    // As the transport reports a refusal: the deployment's code and its status.
    const refuse = (status: number, code: string): never => {
      throw new CliError(code, `Deployment rejected the request (HTTP ${status}).`, "Run agw account login.", 3, { status });
    };
    if (path === "/v1/cli/capabilities")
      return {
        data: {
          protocolVersion: 1,
          serverVersion: "0.5.0",
          deployment,
          consoleOrigin: CONSOLE,
          providers: [],
          providerGateways: [],
          ...(browserLogin ? { features: { browserLogin: true } } : {}),
        },
      };
    if (path === "/v1/cli/login" && method === "POST") {
      const body = options.body as { token: string; client: unknown; loopbackRedirect?: string };
      const id = operationIdFor(body.token);
      login = {
        token: body.token,
        id,
        client: body.client,
        state: "pending",
        collected: false,
        ...(body.loopbackRedirect ? { loopbackRedirect: body.loopbackRedirect } : {}),
      };
      return {
        data: {
          id,
          kind: "login",
          state: "pending",
          url: `${CONSOLE}/cli/approve/${encodeURIComponent(id)}#proof-proof-proof-proof-proof-proof`,
          userCode: codes[opened++ % codes.length],
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      };
    }
    const operation = /^\/v1\/cli\/operations\/([^/]+)$/.exec(path);
    if (operation && method === "GET") {
      const id = decodeURIComponent(operation[1]!);
      if (!login || login.id !== id || options.key !== login.token) return refuse(401, "invalid_proof");
      const base = { id, kind: "login", expiresAt: "2030-01-01T00:00:00.000Z", deployment };
      if (login.state === "denied") return { data: { ...base, state: "expired", denied: true } };
      if (login.state === "pending") return { data: { ...base, state: "pending" } };
      const handOver = !login.loopbackRedirect && !login.collected;
      if (handOver) login.collected = true;
      return {
        data: {
          ...base,
          state: "completed",
          result: { ...(handOver ? { credential: { token: ISSUED } } : {}), accountId: account.id },
          account,
        },
      };
    }
    const redeem = /^\/v1\/cli\/login\/([^/]+)\/redeem$/.exec(path);
    if (redeem && method === "POST") {
      const { redeemCode } = options.body as { redeemCode: string };
      if (!login || options.key !== login.token || redeemCode !== login.redeemCode || login.collected)
        return refuse(401, "invalid_proof");
      login.collected = true;
      return { data: { credential: { token: ISSUED }, account } };
    }
    if (path === "/v1/cli/account") {
      if (!options.key || revoked.has(options.key)) return refuse(401, "invalid_key");
      return { data: accountResponse };
    }
    if (path === "/v1/cli/credential" && method === "DELETE") {
      if (!options.key || revoked.has(options.key)) return refuse(401, "invalid_key");
      revoked.add(options.key);
      return { data: { revoked: true } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return {
    calls,
    revoked,
    transport: { request },
    get login() {
      return login;
    },
    /** A person approving on the console: the page sends the browser to the listener, if any. */
    approve(): string | undefined {
      assert.ok(login);
      login.state = "completed";
      if (!login.loopbackRedirect) return undefined;
      login.redeemCode = "R".repeat(43);
      const url = new URL(login.loopbackRedirect);
      url.searchParams.set("code", login.redeemCode);
      return url.toString();
    },
    deny() {
      assert.ok(login);
      login.state = "denied";
    },
  };
}

/** A `main` run against the fake, with stdout and stderr captured. */
async function run(
  argv: string[],
  fake: ReturnType<typeof deploymentFake>,
  {
    state = fresh(),
    openBrowser = async () => true,
    browserAvailable = () => true,
    env = {},
  }: {
    state?: CliState;
    openBrowser?: (url: string) => Promise<boolean>;
    browserAvailable?: () => boolean;
    env?: Record<string, string>;
  } = {},
) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    store: { ...makeStore(), read: async () => state },
    transport: fake.transport,
    stdout: { write: (text: string) => { out += text; } },
    stderr: { write: (text: string) => { err += text; } },
    io: { openBrowser, browserAvailable, env },
  });
  return { code, out, err, state, json: argv.includes("--json") ? (JSON.parse(out) as Record<string, any>) : undefined };
}

test("browser login: the approval page returns to the loopback listener and the key is redeemed", async () => {
  const fake = deploymentFake();
  let browser: Promise<Response> | undefined;
  const result = await run(["account", "login"], fake, {
    openBrowser: async (url) => {
      assert.ok(url.startsWith(`${CONSOLE}/cli/approve/`));
      // The person approves a moment later; the page then navigates here.
      setTimeout(() => {
        browser = fetch(fake.approve()!);
      }, 50);
      return true;
    },
  });
  assert.equal(result.code, 0, result.err);
  const opened = fake.calls.find((call) => call.path === "/v1/cli/login")!.body as {
    client: { label: string; os?: string };
    loopbackRedirect?: string;
  };
  assert.match(opened.loopbackRedirect ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.match(opened.client.label, /^CLI on /);
  assert.ok(opened.client.os);
  // The pairing code is on stderr, with the instruction to compare it.
  assert.match(result.err, /Pairing code: ABCD-EFGH/);
  assert.match(result.err, /same code/);
  const page = await browser!;
  assert.equal(page.status, 200);
  assert.match(await page.text(), /terminal is connected/);
  // The key never reached a poll, and it is stored as a pasted key would be.
  assert.equal(result.state.active?.credential, ISSUED);
  assert.equal(result.state.active?.url, URL_);
  assert.equal(result.state.active?.account?.id, account.id);
  assert.equal(result.state.active?.deployment?.id, deployment.id);
  assert.deepEqual(result.state.operations, {});
  assert.match(result.out, new RegExp(`Signed in to ${URL_}`));
  assert.equal(result.out.includes(ISSUED), false);
  assert.equal(result.err.includes(ISSUED), false);
});

test("browser login with --no-open registers no listener and collects the key by polling", async () => {
  const fake = deploymentFake();
  const state = fresh();
  let opened = false;
  let polls = 0;
  const request = fake.transport.request;
  fake.transport.request = async (url, path, options) => {
    // Approved after the first poll, on some other device.
    if (path.startsWith("/v1/cli/operations/") && ++polls === 2) fake.approve();
    return request(url, path, options);
  };
  const result = await run(["account", "login", "--no-open"], fake, {
    state,
    openBrowser: async () => {
      opened = true;
      return true;
    },
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(opened, false);
  assert.equal(fake.login?.loopbackRedirect, undefined);
  assert.match(result.err, /Pairing code: ABCD-EFGH/);
  assert.match(result.err, new RegExp(`Approve at: ${CONSOLE}/cli/approve/`));
  assert.equal(state.active?.credential, ISSUED);
  assert.deepEqual(state.operations, {});
  assert.equal(result.out.includes(ISSUED), false);
});

test("browser login with --json answers pending, and operation wait stores the key", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-login-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const fake = deploymentFake();
  const io = { openBrowser: async () => true, browserAvailable: () => true, env: {} };
  let out = "";
  const code = await main(["account", "login", "--no-open", "--json"], {
    store,
    transport: fake.transport,
    stdout: { write: (text: string) => { out += text; } },
    stderr: { write: () => {} },
    io,
  });
  assert.equal(code, 0);
  const pending = JSON.parse(out).result;
  assert.equal(pending.state, "pending");
  assert.equal(pending.kind, "login");
  assert.equal(pending.userCode, "ABCD-EFGH");
  assert.ok(pending.url.startsWith(`${CONSOLE}/`));
  assert.equal(pending.id, fake.login?.id);
  assert.equal(fake.login?.loopbackRedirect, undefined);
  // The record is on disk, so a later command can finish it.
  assert.ok((await store.read()).operations[pending.id]);

  fake.approve();
  out = "";
  const waited = await main(["operation", "wait", pending.id, "--json"], {
    store,
    transport: fake.transport,
    stdout: { write: (text: string) => { out += text; } },
    stderr: { write: () => {} },
    io,
  });
  assert.equal(waited, 0);
  assert.equal(out.includes(ISSUED), false);
  const done = JSON.parse(out).result;
  assert.equal(done.state, "completed");
  assert.equal(done.result.accountId, account.id);
  const saved = await store.read();
  assert.equal(saved.active?.credential, ISSUED);
  assert.equal(saved.active?.url, URL_);
  assert.deepEqual(saved.operations, {});
});

test("a machine that cannot show a browser polls, and never registers a loopback redirect", async () => {
  const fake = deploymentFake();
  let opened = false;
  let polls = 0;
  const request = fake.transport.request;
  fake.transport.request = async (url, path, options) => {
    if (path.startsWith("/v1/cli/operations/") && ++polls === 1) fake.approve();
    return request(url, path, options);
  };
  const state = fresh();
  const result = await run(["account", "login"], fake, {
    state,
    browserAvailable: () => false,
    openBrowser: async () => {
      opened = true;
      return true;
    },
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(opened, false);
  const logins = fake.calls.filter((call) => call.path === "/v1/cli/login");
  assert.equal(logins.length, 1);
  assert.equal((logins[0]!.body as { loopbackRedirect?: string }).loopbackRedirect, undefined);
  assert.match(result.err, /Pairing code: ABCD-EFGH/);
  assert.match(result.err, /Approve at: /);
  assert.equal(state.active?.credential, ISSUED);
});

test("a browser that fails to open replaces the loopback login with a polled one", async () => {
  const fake = deploymentFake();
  const redirects: (string | undefined)[] = [];
  const request = fake.transport.request;
  fake.transport.request = async (url, path, options) => {
    if (path === "/v1/cli/login")
      redirects.push((options?.body as { loopbackRedirect?: string }).loopbackRedirect);
    // The replacement is approved on another device; the first never is.
    if (path.startsWith("/v1/cli/operations/") && redirects.length === 2 && fake.login?.state === "pending")
      fake.approve();
    return request(url, path, options);
  };
  const state = fresh();
  const result = await run(["account", "login"], fake, {
    state,
    openBrowser: async () => false,
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(redirects.length, 2);
  assert.match(redirects[0] ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(redirects[1], undefined);
  assert.match(
    result.err,
    /The browser could not be opened, so the approval will be collected by polling\./,
  );
  // Only the replacement's code and URL are shown: the first could never be finished.
  assert.equal(result.err.includes("ABCD-EFGH"), false);
  assert.match(result.err, /Pairing code: WXYZ-2345/);
  assert.equal(state.active?.credential, ISSUED);
  assert.deepEqual(state.operations, {});
  // The first login's listener is gone.
  await assert.rejects(() => fetch(`${redirects[0]}?code=${"C".repeat(43)}`));
});

test("a browser is assumed only for a person at a local terminal with a display", () => {
  const local = { env: {}, platform: "darwin" as const, terminal: true };
  assert.equal(browserAvailable(local), true);
  assert.equal(browserAvailable({ ...local, terminal: false }), false);
  assert.equal(browserAvailable({ ...local, env: { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" } }), false);
  assert.equal(browserAvailable({ ...local, env: { SSH_TTY: "/dev/ttys001" } }), false);
  assert.equal(browserAvailable({ ...local, platform: "linux" }), false);
  assert.equal(browserAvailable({ ...local, platform: "linux", env: { DISPLAY: ":0" } }), true);
  assert.equal(browserAvailable({ ...local, platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }), true);
  assert.equal(browserAvailable({ ...local, platform: "win32" }), true);
});

test("a declined browser login fails clearly and leaves nothing behind", async () => {
  const fake = deploymentFake();
  const request = fake.transport.request;
  fake.transport.request = async (url, path, options) => {
    // Declined on the console before the first poll.
    if (path.startsWith("/v1/cli/operations/")) fake.deny();
    return request(url, path, options);
  };
  let browser: Promise<Response> | undefined;
  const state = fresh();
  const denied = await run(["account", "login"], fake, {
    state,
    openBrowser: async () => true,
  });
  assert.equal(denied.code, 3);
  assert.match(denied.err, /declined/);
  assert.match(denied.err, /operation_denied/);
  assert.equal(browser, undefined);
  assert.equal(state.active, null);
  assert.deepEqual(state.operations, {});
  // The listener is gone with the command.
  const redirect = fake.login?.loopbackRedirect;
  assert.ok(redirect);
  await assert.rejects(() => fetch(`${redirect}?code=${"C".repeat(43)}`));
});

test("browser login refuses a deployment that does not offer it, pointing at --key-stdin", async () => {
  const result = await run(["account", "login", "--json"], deploymentFake({ browserLogin: false }));
  assert.equal(result.code, 3);
  assert.equal(result.json?.error.code, "browser_login_unsupported");
  assert.match(result.json?.error.nextAction, /--key-stdin/);
});

test("AGW_MANAGEMENT_KEY is the credential for every call, ahead of the stored one", async () => {
  const fake = deploymentFake();
  const state = fresh();
  state.active = { url: URL_, credential: "SENTINEL-STORED", authenticated: true, account, deployment: deployment as never };
  const status = await run(["account", "status", "--json"], fake, {
    state,
    env: { AGW_MANAGEMENT_KEY: "SENTINEL-ENV" },
  });
  assert.equal(status.code, 0, status.err);
  assert.equal(fake.calls.at(-1)?.key, "SENTINEL-ENV");

  // Nothing to log in to: the environment would override a stored login.
  const login = await run(["account", "login", "--json"], fake, {
    state,
    env: { AGW_MANAGEMENT_KEY: "SENTINEL-ENV" },
  });
  assert.equal(login.code, 4);
  assert.equal(login.json?.error.code, "environment_credential");
  assert.match(login.json?.error.message, /AGW_MANAGEMENT_KEY/);

  // A command with no stored login at all still runs on the environment's key.
  const bare = fresh();
  const again = await run(["account", "status", "--json"], fake, {
    state: bare,
    env: { AGW_MANAGEMENT_KEY: "SENTINEL-ENV" },
  });
  assert.equal(again.code, 0);
  assert.equal(fake.calls.at(-1)?.key, "SENTINEL-ENV");

  // Logout revokes and forgets the stored key, never the environment's.
  const logout = await run(["account", "logout", "--json"], fake, {
    state,
    env: { AGW_MANAGEMENT_KEY: "SENTINEL-ENV" },
  });
  assert.equal(logout.code, 0);
  assert.deepEqual(logout.json?.result, { loggedOut: true, revoked: true });
  assert.ok(fake.revoked.has("SENTINEL-STORED"));
  assert.equal(fake.revoked.has("SENTINEL-ENV"), false);
  assert.match(logout.err, /AGW_MANAGEMENT_KEY is still set/);
  assert.equal(state.active?.credential, undefined);
});

test("logout tolerates a key the deployment no longer accepts", async () => {
  const fake = deploymentFake();
  fake.revoked.add("SENTINEL-GONE");
  const state = fresh();
  state.active = { url: URL_, credential: "SENTINEL-GONE", authenticated: true };
  const result = await run(["account", "logout", "--json"], fake, { state });
  assert.equal(result.code, 0);
  assert.deepEqual(result.json?.result, { loggedOut: true, revoked: false });
  assert.equal(result.err, "");
  assert.equal(state.active?.credential, undefined);
  assert.equal(state.active?.authenticated, false);
});

test("the loopback listener hands over one well-formed code and answers only its callback", async () => {
  const loopback = await listenLoopback();
  try {
    assert.match(loopback.redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const base = loopback.redirect.replace("/callback", "");
    assert.equal((await fetch(`${base}/other`)).status, 404);
    assert.equal((await fetch(`${loopback.redirect}?code=short`)).status, 400);
    const page = fetch(`${loopback.redirect}?code=${"C".repeat(43)}`);
    assert.equal(await loopback.code, "C".repeat(43));
    // A second delivery is refused, whatever it carries.
    assert.equal((await fetch(`${loopback.redirect}?code=${"D".repeat(43)}`)).status, 400);
    loopback.answer(true);
    assert.match(await (await page).text(), /You can close this tab/);
  } finally {
    await loopback.close();
  }
});

test("the pasted-key path still logs in from stdin", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agw-stdin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization);
    response.setHeader("content-type", "application/json");
    if (request.url !== "/v1/cli/account" || request.headers.authorization !== "Bearer SENTINEL-PASTED") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { code: "invalid_key", message: "no" } }));
      return;
    }
    response.end(JSON.stringify({ ...accountResponse, deployment: { ...deployment, mode: "self_hosted" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [bin, "deployment", "connect", "--url", url, "--key-stdin", "--json"],
    {
      env: { ...process.env, XDG_STATE_HOME: dir, AGW_MANAGEMENT_KEY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end("SENTINEL-PASTED\n");
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.equal(exit, 0, out);
  assert.equal(JSON.parse(out).result.connected, true);
  assert.equal(out.includes("SENTINEL"), false);
  assert.deepEqual(seen, ["Bearer SENTINEL-PASTED"]);
  const saved = await new StateStore(join(dir, "agw")).read();
  assert.equal(saved.active?.credential, "SENTINEL-PASTED");
  assert.equal(saved.active?.url, url);
});
