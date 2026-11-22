/**
 * Email verification and the account gate (v1's `email-verification.test.ts`,
 * ported). Where the deployment sends email, an account's app traffic waits
 * for an owner's verified address; reading and configuring never does. A
 * deployment that sends no email activates every account it makes.
 *
 * No email leaves the test: the `EMAIL` binding is a stand-in that keeps what
 * it is handed.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { confirmEmailVerification, sendVerificationEmail, VERIFICATION_LINK_TTL_MS } from "../src/auth/email-verification.ts";
import { accountActivated } from "../src/core/account-standing.ts";
import { clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedAppKey, seedHuman } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const CONSOLE = "https://console.gateway.test";
const API = "https://gateway.test";

type Sent = { from: { email: string; name: string }; to: string; subject: string; text: string; html: string };

/** A deployment that sends email (or not), and what its stand-in sender was handed. */
function deployment(options: { email?: boolean; from?: string | null } = {}) {
  const sent: Sent[] = [];
  const binding = {
    send: vi.fn(async (message: Sent) => {
      sent.push(message);
      return { messageId: `message-${sent.length}` };
    }),
  };
  const values: Record<string, unknown> = { ALLOWED_REGISTRATION_EMAILS: "*" };
  if (options.email) {
    values.EMAIL = binding;
    if (options.from !== null) values.EMAIL_FROM = options.from ?? "gateway@example.test";
  }
  return { env: { ...env, ...values } as Env, sent, binding };
}

async function call(path: string, init: { environment: Env; base?: string; method?: string; headers?: Record<string, string>; json?: unknown }): Promise<Response> {
  const headers = new Headers(init.headers);
  let body: string | undefined;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${init.base ?? CONSOLE}${path}`, { method: init.method ?? (body === undefined ? "GET" : "POST"), headers, body }),
    init.environment,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** A console page's call: the console's origin, the person's cookie, `x-console-request`. */
const asConsole = (environment: Env, cookie: string, path: string, json?: unknown) =>
  call(path, { environment, json, headers: { cookie, "x-console-request": "1", origin: CONSOLE } });

function tokenFrom(message: Sent): string {
  const link = /https?:\/\/\S+/u.exec(message.text)?.[0];
  if (!link) throw new Error("The email carried no link");
  return new URL(link).searchParams.get("token")!;
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.clone().json().catch(() => undefined)) as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

/** A person owning an account that was neither activated nor verified. */
async function unverifiedOwner() {
  const human = await seedHuman(`owner-${crypto.randomUUID().slice(0, 8)}@example.test`);
  await env.DB.batch([
    env.DB.prepare("UPDATE mgmt_user SET email_verified = 0 WHERE id = ?").bind(human.userId),
    env.DB.prepare("DELETE FROM account_activation WHERE account_id = ?").bind(human.accountId),
  ]);
  return human;
}

/** A server app of the owner's account, with a key, whose users come from a header. */
async function serverApp(accountId: string): Promise<{ appId: string; key: string }> {
  const appId = `app_verify_${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const config = { authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } } };
  await env.DB.prepare(
    "INSERT INTO app(id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)",
  ).bind(appId, accountId, appId, JSON.stringify(config), now, now).run();
  return { appId, key: (await seedAppKey(appId)).key };
}

const me = (environment: Env, app: { appId: string; key: string }) =>
  call(`/v2/apps/${app.appId}/me`, { environment, base: API, headers: { authorization: `Bearer ${app.key}`, "x-end-user-id": "u1" } });

beforeEach(() => clearCaches());
afterEach(() => vi.restoreAllMocks());

describe("the account gate", () => {
  it("refuses app traffic with email_unverified until an owner verifies, and only where the deployment sends email", async () => {
    const owner = await unverifiedOwner();
    const app = await serverApp(owner.accountId);
    const verifying = deployment({ email: true }).env;

    const refused = await me(verifying, app);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("email_unverified");
    // A provider request is refused the same way, before anything else is asked.
    const proxied = await call(`/v2/apps/${app.appId}/proxy/openai/v1/chat/completions`, {
      environment: verifying,
      base: API,
      headers: { authorization: `Bearer ${app.key}`, "x-end-user-id": "u1", "content-type": "application/json" },
      json: { model: "gpt-4o-mini", messages: [] },
    });
    expect(await errorCode(proxied)).toBe("email_unverified");
    // Without a sender, nothing waits for an address nobody can verify.
    expect((await me(deployment().env, app)).status).toBe(200);

    await env.DB.prepare("UPDATE mgmt_user SET email_verified = 1 WHERE id = ?").bind(owner.userId).run();
    clearCaches();
    expect((await me(verifying, app)).status).toBe(200);
  });

  it("serves an account activated without a verified owner", async () => {
    const owner = await unverifiedOwner();
    await env.DB.prepare("INSERT INTO account_activation(account_id, activated_at) VALUES (?, ?)").bind(owner.accountId, Date.now()).run();
    const app = await serverApp(owner.accountId);
    expect((await me(deployment({ email: true }).env, app)).status).toBe(200);
  });

  it("never stops reading or configuring the account", async () => {
    const owner = await unverifiedOwner();
    const verifying = deployment({ email: true }).env;
    const apps = await asConsole(verifying, owner.cookie, "/v2/admin/apps");
    expect(apps.status, await apps.clone().text()).toBe(200);
  });

  it("tells the console the apps are refused only where they are", async () => {
    const pending = async (environment: Env, cookie: string) => {
      const response = await asConsole(environment, cookie, "/v2/admin/session");
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { session: { account: { verificationPending?: boolean } } }).session.account.verificationPending;
    };
    const owner = await unverifiedOwner();
    expect(await pending(deployment({ email: true }).env, owner.cookie)).toBe(true);
    // Written only when true.
    expect(await pending(deployment().env, owner.cookie)).toBeUndefined();
    await env.DB.prepare("INSERT INTO account_activation(account_id, activated_at) VALUES (?, ?)").bind(owner.accountId, Date.now()).run();
    clearCaches();
    expect(await pending(deployment({ email: true }).env, owner.cookie)).toBeUndefined();
  });

  it("says in the console's capabilities whether addresses are verified", async () => {
    const read = async (environment: Env) =>
      ((await (await call("/v2/console/capabilities", { environment })).json()) as { emailVerification?: boolean }).emailVerification;
    expect(await read(deployment({ email: true }).env)).toBe(true);
    expect(await read(deployment().env)).toBe(false);
  });
});

describe("verification links", () => {
  it("verify the address they were sent to, once or again, and continue where they were asked from", async () => {
    const owner = await unverifiedOwner();
    const { env: verifying, sent } = deployment({ email: true });
    await sendVerificationEmail(verifying, CONSOLE, { id: owner.userId, email: owner.email }, "/v2/apps");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: owner.email, from: { email: "gateway@example.test", name: "App AI Gateway" } });
    expect(sent[0]!.text).toContain(`${CONSOLE}/v2/verify-email?token=`);
    const token = tokenFrom(sent[0]!);

    const confirm = () => call("/v2/console/email-verification/confirm", { environment: verifying, headers: { origin: CONSOLE }, json: { token } });
    const first = await confirm();
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({ email: owner.email, returnTo: "/v2/apps" });
    expect(await env.DB.prepare("SELECT email_verified AS v FROM mgmt_user WHERE id = ?").bind(owner.userId).first("v")).toBe(1);
    expect(await accountActivated(verifying, owner.accountId)).toBe(true);
    expect((await confirm()).status).toBe(200);
  });

  it("are refused when tampered with, expired, or sent to an address the sign-in no longer has", async () => {
    const owner = await unverifiedOwner();
    const { env: verifying, sent } = deployment({ email: true });
    const now = Date.now();
    await sendVerificationEmail(verifying, CONSOLE, { id: owner.userId, email: owner.email }, null, now);
    const token = tokenFrom(sent[0]!);
    const [payload, signature] = token.split(".");
    const forged = `${btoa(JSON.stringify({ u: "someone-else", e: owner.email, x: now + 60_000 })).replaceAll("=", "")}.${signature}`;
    for (const bad of [forged, `${payload}.${signature}x`, "garbage", `${payload}`]) {
      await expect(confirmEmailVerification(verifying, bad, now)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    await expect(confirmEmailVerification(verifying, token, now + VERIFICATION_LINK_TTL_MS)).rejects.toMatchObject({ status: 400 });
    await env.DB.prepare("UPDATE mgmt_user SET email = ? WHERE id = ?").bind(`changed-${owner.email}`, owner.userId).run();
    await expect(confirmEmailVerification(verifying, token, now)).rejects.toMatchObject({ status: 400 });
    expect(await env.DB.prepare("SELECT email_verified AS v FROM mgmt_user WHERE id = ?").bind(owner.userId).first("v")).toBe(0);
  });

  it("are not sent where the deployment has no sender address, which health reports", async () => {
    const owner = await unverifiedOwner();
    const { env: broken, binding } = deployment({ email: true, from: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(sendVerificationEmail(broken, CONSOLE, { id: owner.userId, email: owner.email }, null))
      .rejects.toMatchObject({ status: 503, code: "email_unavailable" });
    expect(binding.send).not.toHaveBeenCalled();
    const health = await call("/v2/healthz", { environment: broken, base: API });
    expect(await health.json()).toMatchObject({ email: "misconfigured" });
    // A verifying deployment whose sender cannot send still verifies: nothing quietly stops being checked.
    expect((await me(broken, await serverApp(owner.accountId))).status).toBe(403);
  });
});

describe("sending a link from the console", () => {
  const send = (environment: Env, cookie: string, json: unknown = {}) =>
    asConsole(environment, cookie, "/v2/console/email-verification/send", json);

  it("sends to an unverified person, answers a verified one, and refuses without a sender or a sign-in", async () => {
    const owner = await unverifiedOwner();
    const { env: verifying, sent } = deployment({ email: true });
    const first = await send(verifying, owner.cookie, { returnTo: "/v2/apps" });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({ status: "sent", email: owner.email });
    expect(sent).toHaveLength(1);

    expect((await send(verifying, owner.cookie, { returnTo: "//evil.test/" })).status).toBe(400);

    const verified = await seedHuman(`verified-${crypto.randomUUID().slice(0, 8)}@example.test`);
    const answered = await send(verifying, verified.cookie);
    expect(await answered.json()).toEqual({ status: "already_verified", email: verified.email });
    expect(sent).toHaveLength(1);

    expect((await send(deployment().env, owner.cookie)).status).toBe(409);
    expect((await send(verifying, "")).status).toBe(401);
  });

  it("is served only on the console's own page", async () => {
    const owner = await unverifiedOwner();
    const { env: verifying } = deployment({ email: true });
    const elsewhere = await call("/v2/console/email-verification/send", {
      environment: verifying,
      headers: { cookie: owner.cookie, "x-console-request": "1", origin: "https://evil.test" },
      json: {},
    });
    expect(elsewhere.status).toBe(403);
  });
});

describe("sign-up", () => {
  const signUp = (environment: Env, email: string, extra: Record<string, unknown> = {}) =>
    call("/v2/auth/sign-up/email", {
      environment,
      headers: { origin: CONSOLE, "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 200) + 1}` },
      json: { name: "Person", email, password: "correct horse battery staple", ...extra },
    });

  const accountOf = async (email: string) =>
    (await env.DB.prepare(
      "SELECT m.organization_id AS id FROM mgmt_organization_user m JOIN mgmt_user u ON u.id = m.user_id WHERE u.email = ?",
    ).bind(email).first<string>("id"))!;

  it("sends the first link where the deployment verifies, and leaves the account waiting for it", async () => {
    const email = `verify-me-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { env: verifying, sent } = deployment({ email: true });
    const created = await signUp(verifying, email, { callbackURL: "/v2/apps" });
    expect(created.status, await created.clone().text()).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    const accountId = await accountOf(email);
    expect(await accountActivated(verifying, accountId)).toBe(false);
    const { returnTo } = await confirmEmailVerification(verifying, tokenFrom(sent[0]!));
    expect(returnTo).toBe("/v2/apps");
    clearCaches();
    expect(await accountActivated(verifying, accountId)).toBe(true);
  });

  it("activates the account as it is made where the deployment sends no email, so a sender added later stops none of it", async () => {
    const email = `trusted-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { env: trusting, sent } = deployment();
    const created = await signUp(trusting, email);
    expect(created.status, await created.clone().text()).toBe(200);
    expect(sent).toHaveLength(0);
    expect(await accountActivated(deployment({ email: true }).env, await accountOf(email))).toBe(true);
  });
});
