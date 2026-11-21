import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CliError, CLOUD, LocalStateError } from "../src/common.ts";
import { Context, launch } from "../src/context.ts";
import { listenLoopback, type Callback, type Loopback } from "../src/login.ts";
import { deviceLogin, discover, type OAuthServer } from "../src/oauth.ts";
import { Transport, type FormResponse } from "../src/transport.ts";
import { fakeClock, fakeTransport, hasCode, memoryStore, signedInState, sinks } from "./helpers.ts";

/**
 * Signing in through the gateway's OAuth server: discovery, the browser flow
 * with PKCE, the device flow, renewing the access token and signing out.
 */

const URL_ = "https://console.gw.example";
const ISSUER = `${URL_}/v2`;

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  device_authorization_endpoint: `${ISSUER}/oauth/device_authorization`,
};

const SERVER: OAuthServer = {
  issuer: ISSUER,
  authorize: "/v2/oauth/authorize",
  token: "/v2/oauth/token",
  revoke: "/v2/oauth/revoke",
  device: "/v2/oauth/device_authorization",
};

const SESSION = {
  session: {
    user: { id: "u1", name: "Ada", email: "ada@example.com", emailVerified: true },
    account: { id: "org_1", name: "Acme" },
    role: "owner",
    grant: "manage",
    credentialType: "oauth",
    accounts: [{ id: "org_1", name: "Acme", role: "owner" }],
  },
};

const tokens = (n: number): FormResponse => ({
  status: 200,
  data: { access_token: `agw_oat_${n}`, refresh_token: `agw_ort_${n}`, token_type: "Bearer", expires_in: 3600, scope: "manage" },
});

const notFound = () => {
  throw new CliError("not_found", "Nothing is served at this path.", "", 3, { status: 404 });
};

test("discovery refuses metadata naming another issuer or an endpoint on another origin", async () => {
  const answer = (meta: object) => fakeTransport((path) => (path === "/.well-known/oauth-authorization-server/v2" ? { data: meta } : notFound()));
  assert.deepEqual(await discover(answer(METADATA), URL_), SERVER);
  await assert.rejects(discover(answer({ ...METADATA, issuer: "https://evil.example/v2" }), URL_), hasCode("invalid_response"));
  await assert.rejects(
    discover(answer({ ...METADATA, token_endpoint: "https://evil.example/v2/oauth/token" }), URL_),
    hasCode("invalid_response"),
  );
});

test("a v1 gateway is named as one, and a gateway with no sign-in says so", async () => {
  const v1 = fakeTransport((path) => (path === "/v1/cli/capabilities" ? { data: { serverVersion: "0.22.1" } } : notFound()));
  await assert.rejects(discover(v1, URL_), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "gateway_v1");
    assert.match(error.nextAction, /agw 1\.x/);
    return true;
  });
  await assert.rejects(discover(fakeTransport(notFound), URL_), hasCode("oauth_unavailable"));
});

test("the device flow waits while pending, slows down when told to, and returns the tokens", async () => {
  const clock = fakeClock();
  const answers: FormResponse[] = [
    { status: 400, data: { error: "authorization_pending" } },
    { status: 400, data: { error: "slow_down" } },
    { status: 400, data: { error: "authorization_pending" } },
    tokens(1),
  ];
  const transport = fakeTransport(notFound, (path, fields) => {
    if (path === SERVER.device) {
      assert.equal(fields["client_id"], "agw-cli");
      assert.equal(fields["resource"], ISSUER);
      return {
        status: 200,
        data: {
          device_code: "dc",
          user_code: "KMXT-4R9Q",
          verification_uri: `${URL_}/v2/device`,
          verification_uri_complete: `${URL_}/v2/device?user_code=KMXT-4R9Q`,
          expires_in: 600,
          interval: 5,
        },
      };
    }
    assert.equal(fields["grant_type"], "urn:ietf:params:oauth:grant-type:device_code");
    return answers.shift()!;
  });
  let shown = "";
  const login = await deviceLogin(transport, URL_, SERVER, "manage", (prompt) => (shown = prompt.userCode), clock);
  assert.equal(shown, "KMXT-4R9Q");
  assert.equal(login.accessToken, "agw_oat_1");
  assert.equal(login.refreshToken, "agw_ort_1");
  // RFC 8628: every slow_down adds five seconds to the interval.
  assert.deepEqual(clock.slept, [5000, 5000, 10000, 10000]);
});

test("the device flow stops on a decline, on an expired code, and on a page off the gateway's origin", async () => {
  const opened = (extra: object = {}): FormResponse => ({
    status: 200,
    data: { device_code: "dc", user_code: "AAAA-BBBB", verification_uri: `${URL_}/v2/device`, expires_in: 30, interval: 5, ...extra },
  });
  const run = (answer: FormResponse, first = opened()) =>
    deviceLogin(fakeTransport(notFound, (path) => (path === SERVER.device ? first : answer)), URL_, SERVER, "manage", () => {}, fakeClock());
  await assert.rejects(run({ status: 400, data: { error: "access_denied" } }), hasCode("login_denied"));
  await assert.rejects(run({ status: 400, data: { error: "expired_token" } }), hasCode("login_expired"));
  await assert.rejects(run({ status: 400, data: { error: "authorization_pending" } }), hasCode("login_expired"));
  await assert.rejects(
    run(tokens(1), opened({ verification_uri: "https://evil.example/device" })),
    hasCode("invalid_response"),
  );
});

/** A loopback a test answers by hand, with the redirect a real one would have. */
function handLoopback(answer: (url: URL) => Callback) {
  let deliver!: (value: Callback) => void;
  const callback = new Promise<Callback>((resolve) => (deliver = resolve));
  const state = { answered: undefined as boolean | undefined, closed: false };
  const loopback: Loopback = {
    redirect: "http://127.0.0.1:43210/callback",
    callback,
    answer: (connected) => void (state.answered ??= connected),
    close: async () => void (state.closed = true),
  };
  return {
    state,
    listen: async () => loopback,
    openBrowser: async (address: string) => {
      deliver(answer(new URL(address)));
      return true;
    },
  };
}

function contextFor(transport: ReturnType<typeof fakeTransport>, io: Partial<ConstructorParameters<typeof Context>[4]> = {}, store = memoryStore()) {
  const out = sinks();
  const ctx = new Context(store, store.held, transport, {}, { stderr: out.stderr, env: {}, browserAvailable: () => true, clock: fakeClock(), ...io });
  return { ctx, store, out };
}

test("a browser sign-in sends a PKCE challenge, checks the issuer, and stores the tokens it exchanges the code for", async () => {
  let challenge = "";
  const transport = fakeTransport(
    (path) => (path === "/.well-known/oauth-authorization-server/v2" ? { data: METADATA } : path === "/v2/admin/session" ? { data: SESSION } : notFound()),
    (path, fields) => {
      assert.equal(path, SERVER.token);
      assert.equal(fields["grant_type"], "authorization_code");
      assert.equal(fields["code"], "the-code");
      assert.equal(fields["redirect_uri"], "http://127.0.0.1:43210/callback");
      assert.equal(createHash("sha256").update(fields["code_verifier"]!).digest("base64url"), challenge);
      return tokens(1);
    },
  );
  const hand = handLoopback((url) => {
    assert.equal(url.pathname, "/v2/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "agw-cli");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("resource"), ISSUER);
    challenge = url.searchParams.get("code_challenge")!;
    return { code: "the-code", iss: ISSUER };
  });
  const { ctx, store } = contextFor(transport, hand);
  const result = await ctx.login(URL_);
  assert.equal(result.credential, "oauth");
  assert.equal(result.account.name, "Acme");
  assert.equal(store.held.active?.login?.accessToken, "agw_oat_1");
  assert.equal(store.held.active?.url, URL_);
  assert.equal(hand.state.answered, true);
  assert.equal(hand.state.closed, true);
  // The session was read with the new token, which no output carries.
  assert.equal(transport.calls.find((call) => call.path === "/v2/admin/session")?.key, "agw_oat_1");
  assert.ok(!JSON.stringify(result).includes("agw_oat_1"));
});

test("a browser sign-in answered by another issuer, or declined, stores nothing", async () => {
  const transport = fakeTransport((path) => (path === "/.well-known/oauth-authorization-server/v2" ? { data: METADATA } : notFound()), () => tokens(1));
  const other = contextFor(transport, handLoopback(() => ({ code: "c", iss: "https://evil.example/v2" })));
  await assert.rejects(other.ctx.login(URL_), hasCode("login_failed"));
  assert.equal(other.store.held.active, null);
  const declined = contextFor(transport, handLoopback(() => ({ error: "access_denied", description: null })));
  await assert.rejects(declined.ctx.login(URL_), hasCode("login_denied"));
  assert.equal(declined.store.held.active, null);
  assert.equal(transport.calls.filter((call) => call.kind === "form").length, 0);
});

test("a browser sign-in nobody approves stops waiting with exit 5", async () => {
  const transport = fakeTransport((path) => (path === "/.well-known/oauth-authorization-server/v2" ? { data: METADATA } : notFound()), () => tokens(1));
  // The browser opens but never answers; the deadline fires at once instead of after five minutes.
  const silent: Loopback = { redirect: "http://127.0.0.1:43210/callback", callback: new Promise<Callback>(() => {}), answer: () => {}, close: async () => {} };
  let cancelled = 0;
  const io = {
    listen: async () => silent,
    openBrowser: async () => true,
    loginDeadline: () => ({ expired: Promise.reject(new Error("timeout")), cancel: () => void cancelled++ }),
  };
  for (const run of [(ctx: Context) => ctx.connect(URL_), (ctx: Context) => ctx.login(URL_)]) {
    const error = await run(contextFor(transport, io).ctx).then(() => assert.fail("expected a timeout"), (caught: unknown) => caught);
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "login_expired");
    assert.equal(error.exitCode, 5);
  }
  // The deadline is cleared each time, so nothing keeps the process waiting.
  assert.equal(cancelled, 2);
});

test("each failed sign-in's hint names no other command; gateway errors, redirects and lost connections come from the real Transport", async () => {
  const starts = [
    { name: "browser", flags: {}, run: (ctx: Context) => ctx.connect(URL_), target: URL_ },
    { name: "device", flags: { device: true }, run: (ctx: Context) => ctx.login(URL_), target: URL_ },
  ] as const;
  const AGAIN = "Run the same command again.";
  // Redirects and lost connections also come from the real transport.
  const refusal = (_path: string): Promise<never> =>
    new Transport(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })).postForm(
      "https://gateway.example",
      "/answer",
      {},
    ) as Promise<never>;
  const unreachable = (): Promise<never> =>
    new Transport(async () => {
      throw new TypeError("fetch failed");
    }).request("https://gateway.example", "/answer") as Promise<never>;
  // Error answers from the gateway go through the real transport too, so the
  // hint the sign-in replaces is the one the transport really produces.
  // Token endpoint answers are given as they are.
  const answered = (status: number, body: string, type = "application/json") => (): Promise<never> =>
    new Transport(async () => new Response(body, { status, headers: { "content-type": type } })).request(
      "https://gateway.example",
      "/answer",
    ) as Promise<never>;
  const unauthorized = answered(401, JSON.stringify({ error: { code: "unauthorized", message: "No session." } }));
  // A proxy's HTML page in front of the gateway: no JSON, only the status.
  const htmlUnauthorized = answered(401, "<html>401 Unauthorized</html>", "text/html");
  const unavailable = answered(503, JSON.stringify({ error: { code: "service_unavailable", message: "Starting." } }));
  // A 503 whose body names a code that alone would mean "check connectivity".
  const unavailableAsUnreachable = answered(503, JSON.stringify({ error: { code: "connection_failed", message: "Upstream down." } }));
  // Every row's exit code as well as its hint: the same as before the hints
  // changed, except that a sign-in nobody approved in time now exits 5.
  const EXITS: Record<string, number> = {
    timeout: 5,
    "timeout, no code endpoint": 5,
    declined: 4,
    "device code expired": 4,
    "device declined": 4,
    "device poll 403 access_denied": 4,
  };
  const check = (error: CliError, hint: string, label: string) => {
    assert.equal(error.nextAction, hint, label);
    const row = label.slice(label.indexOf(": ") + 2);
    assert.equal(error.exitCode, EXITS[row] ?? 3, `${label}: exit code`);
  };
  const ACCESS = "Fix access to the gateway, then run the same command again.";
  const WAIT = "Wait until the gateway is available, then run the same command again.";
  const deviceOpened = (extra: object = {}): FormResponse => ({
    status: 200,
    data: { device_code: "dc", user_code: "AAAA-BBBB", verification_uri: "%ORIGIN%/v2/device", expires_in: 30, interval: 5, ...extra },
  });
  for (const start of starts) {
    const target = start.target;
    const issuer = `${target}/v2`;
    const metadata = (device = true) => ({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      ...(device ? { device_authorization_endpoint: `${issuer}/oauth/device_authorization` } : {}),
    });
    const usesBrowser = !("device" in start.flags) && !("no-open" in start.flags);
    type Get = (path: string) => { data: unknown } | Promise<never> | never;
    const failure = async (form: (path: string) => FormResponse | Promise<FormResponse>, io: object = {}, device = true, get?: Get) => {
      const transport = fakeTransport(
        get ?? ((path) => (path === "/.well-known/oauth-authorization-server/v2" ? { data: metadata(device) } : notFound())),
        async (path) => JSON.parse(JSON.stringify(await form(path)).replaceAll("%ORIGIN%", target)) as FormResponse,
      );
      const out = sinks();
      const store = memoryStore();
      const ctx = new Context(store, store.held, transport, start.flags, { stderr: out.stderr, env: {}, browserAvailable: () => true, clock: fakeClock(), ...io });
      const error = await start.run(ctx).then(() => assert.fail(`${start.name}: expected a failure`), (caught: unknown) => caught);
      assert.ok(error instanceof CliError, start.name);
      assert.equal(store.held.active, null, start.name);
      // Only the hint for another machine names a command, and it names this
      // gateway's address on a line of its own.
      if (error.code !== "device_flow_unavailable") assert.doesNotMatch(error.nextAction, /agw (account|deployment)|--url/, start.name);
      assert.doesNotMatch(error.nextAction, /agw account login/, start.name);
      assert.doesNotMatch(error.nextAction, /state file/, start.name);
      return error;
    };
    const browser = (answer: Callback) => handLoopback(() => answer);
    const noBrowser = usesBrowser ? { browserAvailable: () => false } : {};
    // Failures around the sign-in itself, whichever flow it takes.
    const around: [string, Promise<CliError>, string][] = [
      ["discovery 401", failure(() => tokens(1), noBrowser, true, unauthorized), ACCESS],
      ["discovery HTML 401", failure(() => tokens(1), noBrowser, true, htmlUnauthorized), ACCESS],
      ["discovery JSON 503", failure(() => tokens(1), noBrowser, true, unavailable), WAIT],
      ["discovery 503 connection_failed", failure(() => tokens(1), noBrowser, true, unavailableAsUnreachable), WAIT],
      ["discovery unreachable", failure(() => tokens(1), noBrowser, true, unreachable), "Check connectivity and the URL, then run the same command again."],
      ["session check 401", failure((path) => (path === "/v2/oauth/device_authorization" ? deviceOpened() : tokens(1)), noBrowser, true, (path) => (path === "/.well-known/oauth-authorization-server/v2" ? { data: metadata() } : unauthorized())), ACCESS],
      ["token exchange unreachable", failure((path) => (path === "/v2/oauth/device_authorization" ? deviceOpened() : unreachable()), noBrowser), "Check connectivity and the URL, then run the same command again."],
    ];
    for (const [what, pending, expected] of around) check(await pending, expected, `${start.name}: ${what}`);
    if (usesBrowser) {
      const silent: Loopback = { redirect: "http://127.0.0.1:43210/callback", callback: new Promise<Callback>(() => {}), answer: () => {}, close: async () => {} };
      const timeout = { listen: async () => silent, openBrowser: async () => true, loginDeadline: () => ({ expired: Promise.reject(new Error("timeout")), cancel: () => {} }) };
      const cases: [string, Promise<CliError>, string][] = [
        ["timeout", failure(() => tokens(1), timeout), "Run the same command again, or add --device to sign in with a code."],
        ["timeout, no code endpoint", failure(() => tokens(1), timeout, false), AGAIN],
        ["declined", failure(() => tokens(1), browser({ error: "access_denied", description: null })), "Run the same command again to start over."],
        ["refused", failure(() => tokens(1), browser({ error: "server_error", description: null })), AGAIN],
        ["token refused", failure(() => ({ status: 400, data: { error: "invalid_grant" } }), browser({ code: "c", iss: null })), AGAIN],
        ["token unusable", failure(() => ({ status: 200, data: { access_token: "" } }), browser({ code: "c", iss: null })), AGAIN],
        ["token redirected", failure(refusal, browser({ code: "c", iss: null })), "Fix the gateway's address, then run the same command again."],
      ];
      for (const [what, pending, expected] of cases) check(await pending, expected, `${start.name}: ${what}`);
    }
    // The device flow: chosen by the flags, or because this machine has no browser.
    const device = (answer: FormResponse, first = deviceOpened()) => (path: string) => (path === "/v2/oauth/device_authorization" ? first : answer);
    const deviceCases: [string, Promise<CliError>, string][] = [
      ["unusable body", failure(device(tokens(1), { status: 200, data: {} }), noBrowser), AGAIN],
      ["sign-in page off the origin", failure(device(tokens(1), deviceOpened({ verification_uri: "https://evil.example/device" })), noBrowser), AGAIN],
      ["code expired", failure(device({ status: 400, data: { error: "expired_token" } }), noBrowser), "Run the same command again for a new code."],
      ["declined", failure(device({ status: 400, data: { error: "access_denied" } }), noBrowser), "Run the same command again to start over."],
      // The status decides before the body's code.
      ["poll 403 access_denied", failure(device({ status: 403, data: { error: "access_denied" } }), noBrowser), ACCESS],
      ["poll 503", failure(device({ status: 503, data: { error: "temporarily_unavailable" } }), noBrowser), WAIT],
      ["start refused", failure(device(tokens(1), { status: 400, data: { error: "invalid_client" } }), noBrowser), AGAIN],
      ["poll redirected", failure((path) => (path === "/v2/oauth/device_authorization" ? deviceOpened() : refusal(path)), noBrowser), "Fix the gateway's address, then run the same command again."],
      ["no code endpoint", failure(() => tokens(1), noBrowser, false), `On a machine with a browser, run agw deployment connect --url with this gateway's address:\n${target}`],
    ];
    for (const [what, pending, expected] of deviceCases) check(await pending, expected, `${start.name}: device ${what}`);
  }
});

test("a sign-in whose state file cannot be saved says to move it aside and run the same command again", async () => {
  const transport = fakeTransport(
    (path) => (path === "/.well-known/oauth-authorization-server/v2" ? { data: METADATA } : path === "/v2/admin/session" ? { data: SESSION } : notFound()),
    (path) => (path === "/v2/oauth/device_authorization" ? { status: 200, data: { device_code: "dc", user_code: "AAAA-BBBB", verification_uri: `${URL_}/v2/device`, expires_in: 30, interval: 5 } } : tokens(1)),
  );
  const store = memoryStore();
  store.update = async () => {
    throw new LocalStateError("unsafe_storage", "The connection state must be a file owned by you with mode 0600.", "Move the file aside and sign in again with agw account login.", 4);
  };
  const ctx = new Context(store, store.held, transport, { device: true }, { stderr: sinks().stderr, env: {}, browserAvailable: () => true, clock: fakeClock() });
  const error = await ctx.connect(URL_).then(() => assert.fail("expected a failure"), (caught: unknown) => caught);
  assert.ok(error instanceof CliError);
  assert.equal(error.code, "unsafe_storage");
  // A self-hosted gateway is named: once the file is gone, the same command would not find it.
  assert.equal(error.nextAction, `Move the connection state file aside, then run agw deployment connect --url with this gateway's address:\n${URL_}`);
});

test("a hosted sign-in whose state file cannot be saved says to run the same command again", async () => {
  const issuer = `${CLOUD}/v2`;
  const transport = fakeTransport(
    (path) =>
      path === "/.well-known/oauth-authorization-server/v2"
        ? { data: { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, revocation_endpoint: `${issuer}/oauth/revoke`, device_authorization_endpoint: `${issuer}/oauth/device_authorization` } }
        : path === "/v2/admin/session"
          ? { data: SESSION }
          : notFound(),
    (path) => (path === "/v2/oauth/device_authorization" ? { status: 200, data: { device_code: "dc", user_code: "AAAA-BBBB", verification_uri: `${CLOUD}/v2/device`, expires_in: 30, interval: 5 } } : tokens(1)),
  );
  const store = memoryStore();
  store.update = async () => {
    throw new LocalStateError("invalid_state", "The connection state is not readable JSON.", "Move the file aside and sign in again with agw account login.", 4);
  };
  const ctx = new Context(store, store.held, transport, { device: true }, { stderr: sinks().stderr, env: {}, browserAvailable: () => true, clock: fakeClock() });
  const error = await ctx.login(CLOUD).then(() => assert.fail("expected a failure"), (caught: unknown) => caught);
  assert.ok(error instanceof CliError);
  assert.equal(error.nextAction, "Move the connection state file aside, then run the same command again.");
});

test("without a browser, sign-in uses the device flow and shows its code on stderr", async () => {
  const transport = fakeTransport(
    (path) => (path === "/.well-known/oauth-authorization-server/v2" ? { data: METADATA } : path === "/v2/admin/session" ? { data: SESSION } : notFound()),
    (path) =>
      path === SERVER.device
        ? { status: 200, data: { device_code: "dc", user_code: "WXYZ-1234", verification_uri: `${URL_}/v2/device`, expires_in: 600, interval: 5 } }
        : tokens(2),
  );
  const { ctx, store, out } = contextFor(transport, { browserAvailable: () => false, listen: async () => assert.fail("nothing listens") });
  const result = await ctx.login(URL_);
  assert.equal(result.user.email, "ada@example.com");
  assert.match(out.err.text, /WXYZ-1234/);
  assert.equal(store.held.active?.login?.refreshToken, "agw_ort_2");
});

test("an access token about to expire is renewed once, under the lock, and the new pair is stored", async () => {
  const clock = fakeClock();
  const soon = new Date(clock.time + 30_000).toISOString();
  const store = memoryStore(signedInState(URL_, "agw_oat_old", soon));
  let refreshes = 0;
  const transport = fakeTransport(notFound, (path, fields) => {
    assert.equal(path, "/v2/oauth/token");
    assert.equal(fields["grant_type"], "refresh_token");
    assert.equal(fields["refresh_token"], "agw_ort_test");
    refreshes++;
    return tokens(9);
  });
  const ctx = new Context(store, store.held, transport, {}, { env: {}, clock, stderr: sinks().stderr });
  assert.equal(await ctx.credential(), "agw_oat_9");
  assert.equal(await ctx.credential(), "agw_oat_9");
  assert.equal(refreshes, 1);
  assert.equal(store.held.active?.login?.refreshToken, "agw_ort_9");
});

test("a token another command already renewed is adopted, and its spent refresh token is never sent again", async () => {
  const clock = fakeClock();
  const stale = signedInState(URL_, "agw_oat_old", new Date(clock.time + 10_000).toISOString());
  const store = memoryStore(stale);
  // Another command renewed it while this one ran.
  store.held = {
    ...stale,
    active: { ...stale.active!, login: { ...stale.active!.login!, accessToken: "agw_oat_new", refreshToken: "agw_ort_new", expiresAt: new Date(clock.time + 3_600_000).toISOString() } },
  };
  const transport = fakeTransport(notFound, () => assert.fail("nothing is refreshed"));
  const ctx = new Context(store, stale, transport, {}, { env: {}, clock, stderr: sinks().stderr });
  assert.equal(await ctx.credential(), "agw_oat_new");
});

test("a sign-in the gateway has ended is forgotten, and the command says to sign in again", async () => {
  const clock = fakeClock();
  const store = memoryStore(signedInState(URL_, "agw_oat_old", new Date(clock.time - 1).toISOString()));
  const transport = fakeTransport(notFound, () => ({ status: 400, data: { error: "invalid_grant" } }));
  const ctx = new Context(store, store.held, transport, {}, { env: {}, clock, stderr: sinks().stderr });
  await assert.rejects(ctx.credential(), hasCode("login_required"));
  assert.equal(store.held.active?.login, undefined);
  assert.equal(store.held.active?.url, URL_);
});

test("a refused renewal says to sign in again, naming a self-hosted gateway", async () => {
  const cases: [string, string][] = [
    [URL_, `Run agw deployment connect --url with this gateway's address:\n${URL_}`],
    [CLOUD, "Run agw account login again."],
  ];
  for (const [url, expected] of cases) {
    const clock = fakeClock();
    const store = memoryStore(signedInState(url, "agw_oat_old", new Date(clock.time - 1).toISOString()));
    const transport = fakeTransport(notFound, () => ({ status: 400, data: { error: "invalid_client" } }));
    const ctx = new Context(store, store.held, transport, {}, { env: {}, clock, stderr: sinks().stderr });
    const error = await ctx.credential().then(() => assert.fail("expected a refusal"), (caught: unknown) => caught);
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "invalid_client", url);
    assert.equal(error.nextAction, expected, url);
  }
});

test("a busy or unavailable gateway during renewal keeps the sign-in and says to run the same command again", async () => {
  const cases: [string, FormResponse, string][] = [
    ["429 slow_down", { status: 429, data: { error: "slow_down" } }, "Wait a moment, then run the same command again."],
    ["503", { status: 503, data: { error: "temporarily_unavailable" } }, "Wait until the gateway is available, then run the same command again."],
  ];
  for (const url of [URL_, CLOUD])
    for (const [what, answer, expected] of cases) {
      const clock = fakeClock();
      const store = memoryStore(signedInState(url, "agw_oat_old", new Date(clock.time - 1).toISOString()));
      const transport = fakeTransport(notFound, () => answer);
      const ctx = new Context(store, store.held, transport, {}, { env: {}, clock, stderr: sinks().stderr });
      const error = await ctx.credential().then(() => assert.fail("expected a failure"), (caught: unknown) => caught);
      assert.ok(error instanceof CliError);
      assert.equal(error.nextAction, expected, `${url}: ${what}`);
      // The stored sign-in is kept, to be renewed once the gateway answers.
      assert.notEqual(store.held.active, null, `${url}: ${what}`);
    }
});

test("the environment's key wins over a stored sign-in, and signing in while it is set is refused", async () => {
  const store = memoryStore(signedInState(URL_, "agw_oat_1"));
  const transport = fakeTransport(notFound);
  const ctx = new Context(store, store.held, transport, {}, { env: { AGW_MANAGEMENT_KEY: "agw_mgmt_env" }, stderr: sinks().stderr });
  assert.equal(await ctx.credential(), "agw_mgmt_env");
  await assert.rejects(ctx.login(URL_), hasCode("environment_credential"));
});

test("logout revokes the refresh token, and forgets the sign-in only once the gateway accepted it", async () => {
  const store = memoryStore(signedInState(URL_, "agw_oat_1"));
  const sent: Record<string, string>[] = [];
  const ok = fakeTransport(notFound, (path, fields) => {
    assert.equal(path, "/v2/oauth/revoke");
    sent.push(fields);
    return { status: 200, data: {} };
  });
  const ctx = new Context(store, store.held, ok, {}, { env: {}, stderr: sinks().stderr });
  assert.deepEqual(await ctx.logout(), { loggedOut: true, revoked: true });
  assert.equal(sent[0]?.["token"], "agw_ort_test");
  assert.equal(store.held.active?.login, undefined);

  const down = memoryStore(signedInState(URL_, "agw_oat_1"));
  const failing = fakeTransport(notFound, () => {
    throw new CliError("connection_failed", "Could not reach the selected gateway.", "", 3);
  });
  const offline = new Context(down, down.held, failing, {}, { env: {}, stderr: sinks().stderr });
  await assert.rejects(offline.logout(), hasCode("logout_failed"));
  assert.equal(down.held.active?.login?.refreshToken, "agw_ort_test");
});

test("logout revokes the newest refresh token on disk, and leaves another sign-in stored meanwhile alone", async () => {
  const started = signedInState(URL_, "agw_oat_1");
  const store = memoryStore(started);
  // Another command renewed this same sign-in: its refresh token is the one to end.
  store.held = { ...started, active: { ...started.active!, login: { ...started.active!.login!, refreshToken: "agw_ort_newer" } } };
  const sent: string[] = [];
  const ok = fakeTransport(notFound, (_path, fields) => {
    sent.push(fields["token"]!);
    return { status: 200, data: {} };
  });
  await new Context(store, started, ok, {}, { env: {}, stderr: sinks().stderr }).logout();
  assert.deepEqual(sent, ["agw_ort_newer"]);

  const other = memoryStore(started);
  other.held = { ...started, active: { ...started.active!, login: { ...started.active!.login!, id: "login_2", refreshToken: "agw_ort_other" } } };
  const never = fakeTransport(notFound, () => assert.fail("nothing is revoked"));
  await assert.rejects(new Context(other, started, never, {}, { env: {}, stderr: sinks().stderr }).logout(), hasCode("login_changed"));
  assert.equal(other.held.active?.login?.id, "login_2");
});

test("renewal never adopts or clears another sign-in stored while the command ran", async () => {
  const clock = fakeClock();
  const started = signedInState(URL_, "agw_oat_old", new Date(clock.time + 10_000).toISOString());
  const store = memoryStore(started);
  store.held = {
    ...started,
    active: { ...started.active!, login: { ...started.active!.login!, id: "login_2", accessToken: "agw_oat_other", expiresAt: new Date(clock.time + 3_600_000).toISOString() } },
  };
  const transport = fakeTransport(notFound, () => assert.fail("nothing is refreshed"));
  const ctx = new Context(store, started, transport, {}, { env: {}, clock, stderr: sinks().stderr });
  await assert.rejects(ctx.credential(), hasCode("login_changed"));
  assert.equal(store.held.active?.login?.accessToken, "agw_oat_other");
});

test("a 401 on a token another command just renewed is tried once more with the renewed one", async () => {
  const started = signedInState(URL_, "agw_oat_old");
  const store = memoryStore(started);
  store.held = { ...started, active: { ...started.active!, login: { ...started.active!.login!, accessToken: "agw_oat_new", refreshToken: "agw_ort_new" } } };
  const keys: (string | undefined)[] = [];
  const transport = fakeTransport((_path, options) => {
    keys.push(options.key);
    if (options.key === "agw_oat_old") throw new CliError("auth_required", "no", "", 3, { status: 401 });
    return { data: SESSION };
  });
  const ctx = new Context(store, started, transport, {}, { env: {}, stderr: sinks().stderr });
  const { data } = await ctx.call("getAdminSession");
  assert.equal(data.session.account.id, "org_1");
  assert.deepEqual(keys, ["agw_oat_old", "agw_oat_new"]);

  // With nothing newer stored, the 401 stands.
  const alone = memoryStore(started);
  const refusing = fakeTransport(() => {
    throw new CliError("auth_required", "no", "", 3, { status: 401 });
  });
  await assert.rejects(new Context(alone, started, refusing, {}, { env: {}, stderr: sinks().stderr }).call("getAdminSession"), hasCode("auth_required"));
});

test("a 401 retry that finds another sign-in stored in its place answers login_changed and never uses its token", async () => {
  const started = signedInState(URL_, "agw_oat_old");
  const store = memoryStore(started);
  store.held = { ...started, active: { ...started.active!, login: { ...started.active!.login!, id: "login_2", accessToken: "agw_oat_other" } } };
  const keys: (string | undefined)[] = [];
  const transport = fakeTransport((_path, options) => {
    keys.push(options.key);
    throw new CliError("auth_required", "no", "", 3, { status: 401 });
  });
  const ctx = new Context(store, started, transport, {}, { env: {}, stderr: sinks().stderr });
  await assert.rejects(ctx.call("getAdminSession"), hasCode("login_changed"));
  assert.deepEqual(keys, ["agw_oat_old"]);
  assert.equal(ctx.active?.login?.id, "login_1");
});

test("a 401 retry that finds a sign-in to another gateway stored meanwhile answers login_changed and adopts nothing", async () => {
  const started = signedInState(URL_, "agw_oat_old");
  const store = memoryStore(started);
  store.held = signedInState("https://console.other.example", "agw_oat_elsewhere");
  store.held.active!.login!.id = "login_9";
  const keys: (string | undefined)[] = [];
  const transport = fakeTransport((_path, options) => {
    keys.push(options.key);
    throw new CliError("auth_required", "no", "", 3, { status: 401 });
  });
  const ctx = new Context(store, started, transport, {}, { env: {}, stderr: sinks().stderr });
  await assert.rejects(ctx.call("getAdminSession"), hasCode("login_changed"));
  assert.deepEqual(keys, ["agw_oat_old"]);
  assert.equal(ctx.url, URL_);

  // The same sign-in id, now stored for another gateway, is not this one either.
  const moved = memoryStore(started);
  moved.held = signedInState("https://console.other.example", "agw_oat_moved");
  const again = new Context(moved, started, transport, {}, { env: {}, stderr: sinks().stderr });
  await assert.rejects(again.call("getAdminSession"), hasCode("login_changed"));
  assert.equal(again.url, URL_);
});

test("a 401 retry after another command connected to another gateway with no sign-in answers login_changed", async () => {
  const started = signedInState(URL_, "agw_oat_old");
  const store = memoryStore(started);
  store.held = { schemaVersion: 1, active: { url: "https://console.other.example" } };
  const transport = fakeTransport(() => {
    throw new CliError("auth_required", "no", "", 3, { status: 401 });
  });
  const ctx = new Context(store, started, transport, {}, { env: {}, stderr: sinks().stderr });
  await assert.rejects(ctx.call("getAdminSession"), hasCode("login_changed"));
  assert.equal(ctx.url, URL_);
});

test("connecting with AGW_MANAGEMENT_KEY to a v1 gateway gets the agw 1.x message", async () => {
  const store = memoryStore();
  const transport = fakeTransport((path) => {
    if (path === "/v1/cli/capabilities") return { data: { serverVersion: "0.22.1" } };
    return notFound();
  });
  const ctx = new Context(store, store.held, transport, {}, { env: { AGW_MANAGEMENT_KEY: "agw_mgmt_env" }, stderr: sinks().stderr });
  await assert.rejects(ctx.connect(URL_), hasCode("gateway_v1"));
  assert.equal(store.held.active, null);
});

test("a browser launcher that exits unsuccessfully counts as no browser", { skip: process.platform === "win32" }, async () => {
  assert.equal(await launch("false", []), false);
  assert.equal(await launch("true", []), true);
  assert.equal(await launch("agw-no-such-launcher", []), false);
});

test("the loopback listener answers only the sign-in whose state matches, once", async () => {
  const loopback = await listenLoopback("the-state");
  try {
    const wrong = await fetch(`${loopback.redirect}?code=c&state=other`);
    assert.equal(wrong.status, 400);
    const missing = await fetch(`${loopback.redirect.replace("/callback", "/other")}`);
    assert.equal(missing.status, 404);
    const right = fetch(`${loopback.redirect}?code=c1&state=the-state&iss=${encodeURIComponent(ISSUER)}`);
    assert.deepEqual(await loopback.callback, { code: "c1", iss: ISSUER });
    loopback.answer(true);
    const page = await right;
    assert.equal(page.status, 200);
    assert.match(await page.text(), /signed in/);
    const again = await fetch(`${loopback.redirect}?code=c2&state=the-state`);
    assert.equal(again.status, 400);
  } finally {
    await loopback.close();
  }
});
