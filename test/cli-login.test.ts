import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { createIdentityAuth, operationSweepStatements } from "../src/auth/identity";
import { operationSweepStatementCount } from "@maxceem/cf-auth";
import { pruneExpiredAuthorizations } from "../src/core/account-lifecycle";
import { QueryBudget } from "../src/core/query-budget";
import { resolveDeployment } from "../src/policy/deployment";
import { pageRefusal } from "../src/routes/cli/identity-handoff";
import type { CliContext } from "../src/routes/cli/types";
import { clearIsolateCaches, seedHuman, seedUnaffiliatedHuman } from "./helpers";

const ORIGIN = "https://example.test";

function fakeBilling(): NonNullable<Env["BILLING"]> {
  const none = { plan: null, subscription: null };
  return {
    getTenantAccess: async () => ({
      plan: { planKey: "free", planName: "Free", isDefault: true, limits: { maxRequestsPerMonth: 1000 } },
      subscription: null,
    }),
    listPlans: async () => ({ plans: [] }),
    createCheckout: async () => ({ url: "https://checkout.test" }),
    changePlan: async () => ({ ok: true }),
    resumeSubscription: async () => ({ ok: true }),
    cancelSubscription: async () => ({ ok: true }),
    startTrial: async () => none,
    handleLemonWebhook: async () => ({ ok: true, duplicate: false, stale: false }),
  } as unknown as NonNullable<Env["BILLING"]>;
}

/** A deployment with a public identity, hosted or self-hosted. */
function runtime(cloud = true): Env {
  const values: Partial<Env> = {
    DEPLOYMENT_ID: "cli-login-deployment",
    CLI_CONSOLE_ORIGIN: ORIGIN,
    ...(cloud ? { BILLING: fakeBilling() } : {}),
  };
  return new Proxy(env, {
    get: (target, key, receiver) =>
      key === "BILLING"
        ? values.BILLING
        : key in values
          ? Reflect.get(values, key)
          : Reflect.get(target, key, receiver),
  });
}

const token = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
let address = crypto.randomUUID();

async function send(
  testEnv: Env,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return worker.request(
    `${ORIGIN}/v1/cli${path}`,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "cf-connecting-ip": address,
        "user-agent": "agw-test/1.0",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    testEnv,
  );
}

interface OpenedLogin {
  id: string;
  kind: string;
  state: string;
  url: string | null;
  userCode: string | null;
  expiresAt: string;
}

/** Opens a login, and binds the browser and poll calls to it. */
async function openLogin(testEnv: Env, extra: Record<string, unknown> = {}) {
  const pollToken = token();
  const response = await send(testEnv, "POST", "/login", {
    token: pollToken,
    client: { label: "CLI on test-host", os: "darwin" },
    ...extra,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const login = (await response.json()) as OpenedLogin;
  const proof = new URL(login.url!).hash.slice(1);
  const browser = (step: string, body: Record<string, unknown>, cookie?: string) =>
    send(testEnv, "POST", `/browser/${encodeURIComponent(login.id)}/${step}`, body, {
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    });
  const poll = () =>
    send(testEnv, "GET", `/operations/${encodeURIComponent(login.id)}`, undefined, {
      authorization: `Bearer ${pollToken}`,
    });
  const redeem = (redeemCode: string) =>
    send(testEnv, "POST", `/login/${encodeURIComponent(login.id)}/redeem`, { redeemCode }, {
      authorization: `Bearer ${pollToken}`,
    });
  return { ...login, pollToken, proof, browser, poll, redeem };
}

/** Polls a completed login and answers its credential and account. */
async function collected(poll: () => Promise<Response>) {
  const response = await poll();
  expect(response.status).toBe(200);
  return (await response.json()) as {
    state: string;
    denied?: boolean;
    result?: { credential?: { token: string }; accountId?: string };
    account?: { id: string };
  };
}

beforeEach(() => {
  address = crypto.randomUUID();
  clearIsolateCaches();
});

describe("CLI browser login", () => {
  it("opens a login with an approval link on the console and a code to type", async () => {
    const testEnv = runtime();
    const login = await openLogin(testEnv);
    expect(login).toMatchObject({ kind: "login", state: "pending" });
    // The id the CLI already knows: `op:` and its token's digest.
    expect(login.id).toMatch(/^op:[0-9a-f]{64}$/u);
    const url = new URL(login.url!);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(`/cli/approve/${encodeURIComponent(login.id)}`);
    expect(url.search).toBe("");
    expect(login.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);

    // The same token answers with the same login.
    const again = await send(testEnv, "POST", "/login", {
      token: login.pollToken,
      client: { label: "CLI on test-host" },
    });
    await expect(again.json()).resolves.toMatchObject({ id: login.id, url: login.url, userCode: login.userCode });

    // Only an exact loopback callback is accepted as a redirect.
    for (const loopbackRedirect of [
      "http://127.0.0.1:0/callback",
      "http://127.0.0.1:65536/callback",
      "http://localhost:4000/callback",
      "https://127.0.0.1:4000/callback",
      "http://127.0.0.1:4000/elsewhere",
    ]) {
      const refused = await send(testEnv, "POST", "/login", {
        token: token(),
        client: { label: "CLI" },
        loopbackRedirect,
      });
      expect(refused.status, loopbackRedirect).toBe(400);
    }
    const unlabelled = await send(testEnv, "POST", "/login", { token: token(), client: { label: " " } });
    expect(unlabelled.status).toBe(400);

    const capabilities = await send(testEnv, "GET", "/capabilities");
    await expect(capabilities.json()).resolves.toMatchObject({ protocolVersion: 1, features: { browserLogin: true } });
  });

  it("shows the request to nobody in particular, and asks for a sign-in", async () => {
    const testEnv = runtime();
    const login = await openLogin(testEnv);
    const response = await login.browser("details", { submissionToken: login.proof });
    expect(response.status).toBe(200);
    const details = await response.json();
    expect(details).toMatchObject({
      kind: "login",
      account: null,
      viewer: null,
      blockedBy: "registration_required",
      // Shown whichever way the page was reached, so a person can compare it
      // with the terminal before approving.
      userCode: login.userCode,
      hasLoopbackRedirect: false,
      organizations: [],
      client: { label: "CLI on test-host", os: "darwin", ip: address },
    });
    expect(Date.parse((details as { client: { requestedAt: string } }).client.requestedAt)).not.toBeNaN();

    // Pressing Approve without a sign-in is refused, and nothing is issued.
    const refused = await login.browser("submit", { submissionToken: login.proof, approve: true });
    expect(refused.status).toBe(401);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "session_required" } });
    await expect(collected(login.poll)).resolves.toMatchObject({ state: "pending" });
  });

  it("logs the CLI in with the link's proof and hands the key over exactly once", async () => {
    const testEnv = runtime();
    const human = await seedHuman();
    const login = await openLogin(testEnv);

    const details = await (await login.browser("details", { submissionToken: login.proof }, human.cookie)).json();
    expect(details).toMatchObject({
      viewer: { email: human.email },
      blockedBy: null,
      organizations: [{ id: human.organizationId, role: "owner" }],
    });

    const approved = await login.browser("submit", { submissionToken: login.proof, approve: true }, human.cookie);
    expect(approved.status, await approved.clone().text()).toBe(200);
    const body = await approved.json();
    expect(body).toMatchObject({ state: "completed", continueTo: "cli" });
    expect(body).not.toHaveProperty("redirectUrl");

    const first = await collected(login.poll);
    expect(first).toMatchObject({
      state: "completed",
      result: { accountId: human.organizationId },
      account: { id: human.organizationId },
    });
    const key = first.result!.credential!.token;
    expect(key).toMatch(/^agw_mgmt_/u);
    // Once collected, it is never handed over again.
    const second = await collected(login.poll);
    expect(second).toMatchObject({ state: "completed", account: { id: human.organizationId } });
    expect(second.result?.credential).toBeUndefined();

    // The key works, and says where it came from.
    const account = await send(testEnv, "GET", "/account", undefined, { authorization: `Bearer ${key}` });
    expect(account.status).toBe(200);
    const keys = await worker.request(
      `${ORIGIN}/v1/admin/keys`,
      { headers: { cookie: human.cookie, "x-console-request": "1" } },
      testEnv,
    );
    expect(keys.status).toBe(200);
    expect((await keys.json()) as { keys: unknown[] }).toMatchObject({
      keys: expect.arrayContaining([expect.objectContaining({ source: "cli", label: "CLI on test-host" })]),
    });

    // Sent again, it answers where it stands and hands nothing over.
    const resent = await send(testEnv, "POST", "/login", { token: login.pollToken, client: { label: "CLI on test-host" } });
    await expect(resent.json()).resolves.toMatchObject({ id: login.id, state: "completed", url: null, userCode: null });

    // Approving again answers as approved, and issues nothing more.
    expect((await login.browser("submit", { submissionToken: login.proof, approve: true }, human.cookie)).status)
      .toBe(200);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_api_key WHERE user_id=? AND source='cli'")
        .bind(human.userId)
        .first("n"),
    ).toBe(1);
  });

  it("finds a login by its typed code and approves with the code alone", async () => {
    const testEnv = runtime();
    const human = await seedHuman();
    const login = await openLogin(testEnv);
    const typed = login.userCode!.toLowerCase().replace("-", "");

    const lookup = (userCode: string, origin = ORIGIN) =>
      send(testEnv, "POST", "/browser/lookup", { userCode }, { origin });
    await expect((await lookup(typed)).json()).resolves.toEqual({
      found: true,
      id: login.id,
      kind: "login",
      expiresAt: login.expiresAt,
    });
    await expect((await lookup("ZZZZ-ZZZZ")).json()).resolves.toEqual({ found: false });
    expect((await lookup(typed, "https://elsewhere.test")).status).toBe(403);

    const details = await (await login.browser("details", { submissionToken: typed }, human.cookie)).json();
    // Reached by the code, so the page can show it back.
    expect(details).toMatchObject({ userCode: login.userCode, blockedBy: null });
    expect((await login.browser("details", { submissionToken: "ABCD-EFGH" }, human.cookie)).status).toBe(403);

    const approved = await login.browser("submit", { submissionToken: login.userCode, approve: true }, human.cookie);
    expect(approved.status, await approved.clone().text()).toBe(200);
    const result = await collected(login.poll);
    expect(result.result?.credential?.token).toMatch(/^agw_mgmt_/u);
    // No longer pending, so the code names nothing.
    await expect((await lookup(typed)).json()).resolves.toEqual({ found: false });
  });

  it("caps pending logins per address even when no edge names one", async () => {
    const testEnv = runtime();
    const open = () =>
      worker.request(
        `${ORIGIN}/v1/cli/login`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: token(), client: { label: "CLI without an edge" } }),
        },
        testEnv,
      );
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++) statuses.push((await open()).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    // The engine counts them against the key it was given, never the client's own meta.
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_operation WHERE opener_key='key:local'").first("n"),
    ).toBe(10);
    await env.DB.prepare("DELETE FROM mgmt_operation WHERE opener_key='key:local'").run();
  });

  it("shows a verdict it does not know as a request to sign in as someone who may approve", () => {
    // Only the verdict names are read for these, never the context.
    const c = {} as CliContext;
    expect(pageRefusal(c, "some_future_verdict")).toBe("registration_required");
    expect(pageRefusal(c, "session_required")).toBe("registration_required");
    expect(pageRefusal(c, "sign_out_required")).toBe("sign_out_required");
    expect(pageRefusal(c, null)).toBeNull();
  });

  it("limits how many logins one address asks for, however quickly it declines them", async () => {
    const testEnv = runtime();
    // Asked for and declined straight away, so the cap on waiting logins
    // never fills: only the hourly count stands in the way.
    let last: Awaited<ReturnType<typeof openLogin>> | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      last = await openLogin(testEnv);
      expect((await last.browser("deny", { submissionToken: last.proof })).status, `deny ${attempt}`).toBe(200);
    }
    const refused = await send(testEnv, "POST", "/login", { token: token(), client: { label: "One too many" } });
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "rate_limited", data: { scope: "login" } } });
    // A login already asked for is still answered: a resend is not counted.
    const resent = await send(testEnv, "POST", "/login", { token: last!.pollToken, client: { label: "CLI on test-host" } });
    expect(resent.status).toBe(200);
    await expect(resent.json()).resolves.toMatchObject({ id: last!.id, state: "denied" });
    // And what each one leaves behind is swept a day after it was asked for.
    const kept = await env.DB.prepare("SELECT retain_until - created_at AS kept FROM mgmt_operation WHERE id=?")
      .bind(last!.id)
      .first<number>("kept");
    expect(kept).toBe(86_400_000);
  });

  it("withdraws a login's key revoked before the CLI collected it", async () => {
    const testEnv = runtime();
    const human = await seedHuman();
    const revokeIssued = async () => {
      const id = await env.DB.prepare(
        "SELECT id FROM mgmt_api_key WHERE user_id=? AND source='cli' AND revoked_at IS NULL",
      ).bind(human.userId).first<string>("id");
      const revoked = await worker.request(
        `${ORIGIN}/v1/admin/keys/${id}/revoke`,
        { method: "POST", headers: { cookie: human.cookie, "x-console-request": "1", origin: ORIGIN } },
        testEnv,
      );
      expect(revoked.status, await revoked.clone().text()).toBe(200);
    };

    // Detached: approved, then revoked in the console before `operation wait`.
    const detached = await openLogin(testEnv);
    expect((await detached.browser("submit", { submissionToken: detached.proof, approve: true }, human.cookie)).status)
      .toBe(200);
    await revokeIssued();
    // The engine refuses to release it, and the CLI is told it is over, every time it asks.
    const identity = await createIdentityAuth(resolveDeployment(testEnv), testEnv, ORIGIN);
    await expect(identity.operations.poll({ id: detached.id, token: detached.pollToken }))
      .rejects.toMatchObject({ code: "operation_expired" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const polled = await collected(detached.poll);
      expect(polled.state).toBe("expired");
      expect(polled.result).toBeUndefined();
    }

    // With a loopback listener: the redeem code no longer buys anything.
    const loopback = await openLogin(testEnv, { loopbackRedirect: "http://127.0.0.1:53683/callback" });
    const approved = await loopback.browser("submit", { submissionToken: loopback.proof, approve: true }, human.cookie);
    const code = new URL(((await approved.json()) as { redirectUrl: string }).redirectUrl).searchParams.get("code")!;
    await revokeIssued();
    const redeemed = await loopback.redeem(code);
    expect(redeemed.status).toBe(410);
    await expect(redeemed.json()).resolves.toMatchObject({ error: { code: "operation_expired" } });
    await expect(collected(loopback.poll)).resolves.toMatchObject({ state: "expired" });
  });

  it("rate limits code lookups per network address", async () => {
    const testEnv = runtime();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++)
      statuses.push((await send(testEnv, "POST", "/browser/lookup", { userCode: "AAAA-AAAA" }, { origin: ORIGIN })).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });

  it("releases a loopback login's key only to the redeem code, once", async () => {
    const testEnv = runtime();
    const human = await seedHuman();
    const login = await openLogin(testEnv, { loopbackRedirect: "http://127.0.0.1:53682/callback" });
    await expect((await login.browser("details", { submissionToken: login.proof }, human.cookie)).json())
      .resolves.toMatchObject({ hasLoopbackRedirect: true });

    const approved = await login.browser("submit", { submissionToken: login.proof, approve: true }, human.cookie);
    expect(approved.status, await approved.clone().text()).toBe(200);
    const { redirectUrl } = (await approved.json()) as { redirectUrl: string };
    const redirect = new URL(redirectUrl);
    expect(`${redirect.origin}${redirect.pathname}`).toBe("http://127.0.0.1:53682/callback");
    const code = redirect.searchParams.get("code")!;

    // Polling never carries it.
    const polled = await collected(login.poll);
    expect(polled.state).toBe("completed");
    expect(polled.result?.credential).toBeUndefined();

    // The code alone is useless without the operation's token.
    const stranger = await send(testEnv, "POST", `/login/${encodeURIComponent(login.id)}/redeem`, { redeemCode: code }, {
      authorization: `Bearer ${token()}`,
    });
    expect(stranger.status).toBe(403);

    const redeemed = await login.redeem(code);
    expect(redeemed.status, await redeemed.clone().text()).toBe(200);
    const body = (await redeemed.json()) as { credential: { token: string }; account: { id: string } };
    expect(body.credential.token).toMatch(/^agw_mgmt_/u);
    expect(body.account.id).toBe(human.organizationId);

    const twice = await login.redeem(code);
    expect(twice.status).toBe(409);
    await expect(twice.json()).resolves.toMatchObject({ error: { code: "already_completed" } });
  });

  it("lets whoever holds the link decline, signed in or not", async () => {
    const testEnv = runtime();
    const login = await openLogin(testEnv);
    const denied = await login.browser("deny", { submissionToken: login.proof });
    expect(denied.status, await denied.clone().text()).toBe(200);
    await expect(collected(login.poll)).resolves.toMatchObject({ state: "expired", denied: true });
  });

  it("lets the person decline, and tells the CLI", async () => {
    const testEnv = runtime();
    const human = await seedHuman();
    const login = await openLogin(testEnv);
    const denied = await login.browser("deny", { submissionToken: login.proof }, human.cookie);
    expect(denied.status, await denied.clone().text()).toBe(200);
    await expect(denied.json()).resolves.toMatchObject({ state: "denied" });
    // Declining twice answers the same.
    expect((await login.browser("deny", { submissionToken: login.proof }, human.cookie)).status).toBe(200);

    await expect(collected(login.poll)).resolves.toMatchObject({ state: "expired", denied: true });
    const approved = await login.browser("submit", { submissionToken: login.proof, approve: true }, human.cookie);
    expect(approved.status).toBe(409);
    await expect(approved.json()).resolves.toMatchObject({ error: { code: "operation_denied" } });
    expect((await login.browser("deny", { submissionToken: token() }, human.cookie)).status).toBe(403);
  });

  it("asks which account when the approver belongs to two", async () => {
    const testEnv = runtime();
    const human = await seedHuman();
    const other = await seedHuman();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO mgmt_organization_user(id,organization_id,user_id,role,status,joined_at) VALUES (?,?,?,'member','active',?)",
    ).bind(crypto.randomUUID(), other.organizationId, human.userId, now).run();
    const login = await openLogin(testEnv);

    const details = (await (await login.browser("details", { submissionToken: login.proof }, human.cookie)).json()) as {
      organizations: { id: string; role: string }[];
    };
    expect(details.organizations).toHaveLength(2);
    expect(details.organizations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: human.organizationId, role: "owner" }),
      expect.objectContaining({ id: other.organizationId, role: "member" }),
    ]));

    const unchosen = await login.browser("submit", { submissionToken: login.proof, approve: true }, human.cookie);
    expect(unchosen.status).toBe(400);
    const foreign = await login.browser(
      "submit",
      { submissionToken: login.proof, approve: true, organizationId: "not-theirs" },
      human.cookie,
    );
    expect(foreign.status).toBe(403);

    const chosen = await login.browser(
      "submit",
      { submissionToken: login.proof, approve: true, organizationId: other.organizationId },
      human.cookie,
    );
    expect(chosen.status, await chosen.clone().text()).toBe(200);
    const result = await collected(login.poll);
    expect(result.account?.id).toBe(other.organizationId);
    // A member's key: it reads, and it may not write.
    const key = result.result!.credential!.token;
    expect((await send(testEnv, "GET", "/account", undefined, { authorization: `Bearer ${key}` })).status).toBe(200);
  });

  it("gives an approver with no account one where registering would", async () => {
    const hosted = runtime(true);
    const person = await seedUnaffiliatedHuman();
    const login = await openLogin(hosted);
    await expect((await login.browser("details", { submissionToken: login.proof }, person.cookie)).json())
      .resolves.toMatchObject({ blockedBy: null, organizations: [] });
    const approved = await login.browser("submit", { submissionToken: login.proof, approve: true }, person.cookie);
    expect(approved.status, await approved.clone().text()).toBe(200);
    const result = await collected(login.poll);
    expect(result.result?.credential?.token).toMatch(/^agw_mgmt_/u);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_organization_user WHERE user_id=? AND role='owner'")
        .bind(person.userId)
        .first("n"),
    ).toBe(1);
  });

  it("refuses an approver with no account where nobody is given one", async () => {
    const selfHosted = runtime(false);
    const person = await seedUnaffiliatedHuman();
    const login = await openLogin(selfHosted);
    await expect((await login.browser("details", { submissionToken: login.proof }, person.cookie)).json())
      .resolves.toMatchObject({ blockedBy: "no_eligible_organization" });
    const refused = await login.browser("submit", { submissionToken: login.proof, approve: true }, person.cookie);
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "no_eligible_organization" } });
  });

  it("lets a CLI revoke the key it holds, and only that key", async () => {
    const testEnv = runtime();
    const human = await seedHuman();
    const login = await openLogin(testEnv);
    expect((await login.browser("submit", { submissionToken: login.proof, approve: true }, human.cookie)).status)
      .toBe(200);
    const key = (await collected(login.poll)).result!.credential!.token;
    const auth = { authorization: `Bearer ${key}` };

    const revoked = await send(testEnv, "DELETE", "/credential", undefined, auth);
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ revoked: true });
    expect((await send(testEnv, "GET", "/account", undefined, auth)).status).toBe(401);
    expect((await send(testEnv, "DELETE", "/credential", undefined, auth)).status).toBe(401);

    // A browser session signs out instead.
    const session = await send(testEnv, "DELETE", "/credential", undefined, {
      cookie: human.cookie,
      origin: ORIGIN,
      "x-console-request": "1",
    });
    expect(session.status).toBe(403);
  });

  it("marks the key a bootstrap delivers as the bootstrap's", async () => {
    const testEnv = runtime();
    const response = await send(testEnv, "POST", "/bootstrap", { token: token() });
    expect(response.status, await response.clone().text()).toBe(200);
    const { account } = (await response.json()) as { account: { id: string } };
    expect(
      await env.DB.prepare("SELECT source FROM mgmt_api_key WHERE organization_id=?").bind(account.id).first("source"),
    ).toBe("bootstrap");
  });

  it("sweeps expired logins and one-time secrets past their window at night", async () => {
    const testEnv = runtime();
    const login = await openLogin(testEnv);
    const bootstrap = await send(testEnv, "POST", "/bootstrap", { token: token() });
    const { account } = (await bootstrap.json()) as { account: { id: string } };
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE mgmt_operation SET expires_at=? WHERE id=?").bind(now - 1000, login.id),
      env.DB.prepare(
        "UPDATE mgmt_operation SET sealed_until=? WHERE kind='bootstrap' AND json_extract(outcome,'$.accountId')=?",
      ).bind(now - 1000, account.id),
    ]);
    // Issued through the run's budgeted view of the database, and counted there.
    const budget = new QueryBudget(50);
    const db = budget.database(env.DB);
    await pruneExpiredAuthorizations(db, await operationSweepStatements(resolveDeployment(testEnv), testEnv, db, now));
    expect(budget.spent).toBe(operationSweepStatementCount);
    expect(await env.DB.prepare("SELECT state FROM mgmt_operation WHERE id=?").bind(login.id).first("state"))
      .toBe("expired");
    const bootstrapRow = await env.DB.prepare(
      "SELECT outcome,sealed_outcome FROM mgmt_operation WHERE kind='bootstrap' AND json_extract(outcome,'$.accountId')=?",
    ).bind(account.id).first<{ outcome: string; sealed_outcome: string | null }>();
    expect(JSON.parse(bootstrapRow!.outcome)).toMatchObject({ accountId: account.id });
    expect(bootstrapRow!.sealed_outcome).toBeNull();
  });
});
