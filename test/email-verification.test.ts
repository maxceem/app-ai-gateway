import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmEmailVerification,
  sendVerificationEmail,
  VERIFICATION_LINK_TTL_MS,
} from "../src/auth/email-verification";
import { claimRefusal } from "../src/auth/operation-kinds";
import { accountLifecycle } from "../src/core/account-lifecycle";
import worker from "../src/index";
import { accountAccessDenial } from "../src/policy/accounts";
import { resolveDeployment } from "../src/policy/deployment";
import { clearIsolateCaches, seedHuman, seedServerApp } from "./helpers";

vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "https://example.test";

type Sent = { from: { email: string; name: string }; to: string; subject: string; text: string; html: string };

/** A deployment as a test needs it: sending email or not, hosted or not. */
function runtime(options: { email?: boolean; from?: string | null; emails?: string; cloud?: boolean } = {}) {
  const sent: Sent[] = [];
  const binding = {
    send: vi.fn(async (message: Sent) => {
      sent.push(message);
      return { messageId: `message-${sent.length}` };
    }),
  };
  const testEnv = new Proxy(env, {
    get(target, property, receiver) {
      if (property === "EMAIL") return options.email ? binding : undefined;
      if (property === "EMAIL_FROM") return options.from === null ? undefined : options.from ?? "gateway@example.test";
      if (property === "BILLING") return options.cloud ? {} : undefined;
      if (property === "ALLOWED_REGISTRATION_EMAILS") return options.emails ?? "*";
      if (property === "GOOGLE_CLIENT_ID" || property === "GOOGLE_CLIENT_SECRET") return undefined;
      // The console's routes refuse a deployment without an identity.
      if (property === "DEPLOYMENT_ID") return "verification-test-deployment";
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
  return { env: testEnv, sent, binding };
}

function tokenFrom(message: Sent): string {
  const link = /https?:\/\/\S+/u.exec(message.text)?.[0];
  if (!link) throw new Error("The email carried no link");
  return new URL(link).searchParams.get("token")!;
}

async function proxied(testEnv: Env, appId: string, key: string) {
  return worker.fetch(
    new Request(`${ORIGIN}/v1/apps/${appId}/proxy/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "u1" },
      body: JSON.stringify({ model: "gpt-test", input: "hi" }),
    }),
    testEnv,
    createExecutionContext(),
  );
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.clone().json().catch(() => undefined)) as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

/** A person owning an account, with their address unverified. */
async function unverifiedOwner(email?: string) {
  const human = await seedHuman(email);
  await env.DB.prepare("UPDATE mgmt_user SET email_verified=0 WHERE id=?").bind(human.userId).run();
  return human;
}

beforeEach(() => clearIsolateCaches());
afterEach(() => vi.restoreAllMocks());

describe("the account gate", () => {
  it("refuses application traffic, and only that, until the owner verifies", async () => {
    const owner = await unverifiedOwner();
    const { env: testEnv } = runtime({ email: true });
    const deployment = resolveDeployment(testEnv);
    const account = await accountLifecycle(testEnv, owner.organizationId);
    expect(account).toMatchObject({ claimed: true, activated: false });
    expect(accountAccessDenial(deployment, account, "proxy", Date.now())).toBe("email_unverified");
    expect(accountAccessDenial(deployment, account, "setup", Date.now())).toBeNull();
    expect(accountAccessDenial(deployment, account, "read", Date.now())).toBeNull();
    // Without a sender the same account is served: nothing waits for an
    // address nobody can verify.
    expect(accountAccessDenial(resolveDeployment(runtime().env), account, "proxy", Date.now())).toBeNull();
  });

  it("answers a proxied request with email_unverified, on a self-host too, and serves it once verified", async () => {
    const owner = await unverifiedOwner();
    const key = await seedServerApp("verification-gate", { organizationId: owner.organizationId });
    const { env: testEnv } = runtime({ email: true });

    const refused = await proxied(testEnv, "verification-gate", key);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("email_unverified");

    await env.DB.prepare("UPDATE mgmt_user SET email_verified=1 WHERE id=?").bind(owner.userId).run();
    clearIsolateCaches();
    const served = await proxied(testEnv, "verification-gate", key);
    expect(await errorCode(served)).not.toBe("email_unverified");
  });

  it("serves an activated account whoever owns it", async () => {
    const owner = await unverifiedOwner();
    await env.DB.prepare("INSERT INTO account_activation(organization_id) VALUES (?)")
      .bind(owner.organizationId).run();
    const { env: testEnv } = runtime({ email: true });
    const account = await accountLifecycle(testEnv, owner.organizationId);
    expect(account.activated).toBe(true);
    expect(accountAccessDenial(resolveDeployment(testEnv), account, "proxy", Date.now())).toBeNull();
  });

  it("tells the console the apps are refused only where they are", async () => {
    const session = async (cookie: string, testEnv: Env) => {
      const response = await worker.request(`${ORIGIN}/v1/admin/session`, {
        headers: { cookie, "x-console-request": "1" },
      }, testEnv);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { session: { verificationPending: boolean } }).session.verificationPending;
    };
    const owner = await unverifiedOwner();
    expect(await session(owner.cookie, runtime({ email: true }).env)).toBe(true);
    expect(await session(owner.cookie, runtime().env)).toBe(false);
    // Activated before the deployment verified anything: an unverified owner
    // is reminded, but nothing is refused.
    await env.DB.prepare("INSERT INTO account_activation(organization_id) VALUES (?)")
      .bind(owner.organizationId).run();
    clearIsolateCaches();
    expect(await session(owner.cookie, runtime({ email: true }).env)).toBe(false);
  });

  it("reports the refusal in an app check rather than calling the app ready", async () => {
    const owner = await unverifiedOwner();
    await seedServerApp("verification-check", { organizationId: owner.organizationId });
    const { env: testEnv } = runtime({ email: true });
    const response = await worker.request(`${ORIGIN}/v1/admin/apps/verification-check/check`, {
      headers: { cookie: owner.cookie, "x-console-request": "1" },
    }, testEnv);
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ready: false, accountRefusal: "email_unverified" });
  });
});

describe("verification links", () => {
  it("verifies the address they were sent to, once or again, and continues where they were asked from", async () => {
    const owner = await unverifiedOwner();
    const { env: testEnv, sent } = runtime({ email: true });
    await sendVerificationEmail(
      testEnv,
      resolveDeployment(testEnv, ORIGIN),
      { id: owner.userId, email: owner.email },
      "/apps",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: owner.email, from: { email: "gateway@example.test" } });
    const token = tokenFrom(sent[0]!);
    expect(sent[0]!.text).toContain(`${ORIGIN}/verify-email?token=`);

    const confirm = (body: unknown) => worker.request(`${ORIGIN}/v1/console/email-verification/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-console-request": "1", origin: ORIGIN },
      body: JSON.stringify(body),
    }, testEnv);
    const first = await confirm({ token });
    expect(first.status, await first.clone().text()).toBe(200);
    await expect(first.json()).resolves.toEqual({ email: owner.email, returnTo: "/apps" });
    expect(await env.DB.prepare("SELECT email_verified AS v FROM mgmt_user WHERE id=?")
      .bind(owner.userId).first("v")).toBe(1);
    expect((await accountLifecycle(testEnv, owner.organizationId)).activated).toBe(true);

    const again = await confirm({ token });
    expect(again.status).toBe(200);
  });

  it("refuses a tampered, expired or outdated link", async () => {
    const owner = await unverifiedOwner();
    const { env: testEnv, sent } = runtime({ email: true });
    const now = Date.now();
    await sendVerificationEmail(
      testEnv,
      resolveDeployment(testEnv, ORIGIN),
      { id: owner.userId, email: owner.email },
      null,
      now,
    );
    const token = tokenFrom(sent[0]!);
    const [payload, signature] = token.split(".");

    const forged = `${btoa(JSON.stringify({ u: "someone-else", e: owner.email, x: now + 60_000 }))
      .replaceAll("=", "")}.${signature}`;
    for (const bad of [forged, `${payload}.${signature}x`, "garbage", `${payload}`]) {
      await expect(confirmEmailVerification(testEnv, bad, now)).rejects.toMatchObject({
        status: 400,
        code: "invalid_request",
      });
    }
    await expect(confirmEmailVerification(testEnv, token, now + VERIFICATION_LINK_TTL_MS)).rejects
      .toMatchObject({ status: 400 });

    // A link for an address the sign-in no longer has verifies nothing.
    await env.DB.prepare("UPDATE mgmt_user SET email='changed@example.test' WHERE id=?")
      .bind(owner.userId).run();
    await expect(confirmEmailVerification(testEnv, token, now)).rejects.toMatchObject({ status: 400 });
    expect(await env.DB.prepare("SELECT email_verified AS v FROM mgmt_user WHERE id=?")
      .bind(owner.userId).first("v")).toBe(0);
  });

  it("is not sent where the deployment has no sender address", async () => {
    const owner = await unverifiedOwner();
    const { env: testEnv, binding } = runtime({ email: true, from: null });
    await expect(sendVerificationEmail(
      testEnv,
      resolveDeployment(testEnv, ORIGIN),
      { id: owner.userId, email: owner.email },
      null,
    )).rejects.toMatchObject({ status: 503, code: "email_unavailable" });
    expect(binding.send).not.toHaveBeenCalled();
    const health = await worker.request(`${ORIGIN}/v1/healthz`, {}, testEnv);
    await expect(health.json()).resolves.toMatchObject({ email: "misconfigured" });
  });
});

describe("sending a link from the console", () => {
  const send = (testEnv: Env, cookie: string, body: unknown = {}) =>
    worker.request(`${ORIGIN}/v1/console/email-verification/send`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-console-request": "1", origin: ORIGIN },
      body: JSON.stringify(body),
    }, testEnv);

  it("sends to an unverified person, answers a verified one, and refuses without a sender", async () => {
    const owner = await unverifiedOwner();
    const { env: testEnv, sent } = runtime({ email: true });
    const first = await send(testEnv, owner.cookie, { returnTo: "/cli/approve/x" });
    expect(first.status, await first.clone().text()).toBe(200);
    await expect(first.json()).resolves.toEqual({ status: "sent", email: owner.email });
    expect(sent).toHaveLength(1);

    const offSite = await send(testEnv, owner.cookie, { returnTo: "//evil.test/" });
    expect(offSite.status).toBe(400);

    const verified = await seedHuman();
    const answered = await send(testEnv, verified.cookie);
    await expect(answered.json()).resolves.toEqual({ status: "already_verified", email: verified.email });
    expect(sent).toHaveLength(1);

    const off = await send(runtime().env, owner.cookie);
    expect(off.status).toBe(409);
    const anonymous = await send(testEnv, "");
    expect(anonymous.status).toBe(401);
  });
});

describe("sign-up", () => {
  const signUp = (testEnv: Env, email: string, address: string, extra: Record<string, unknown> = {}) =>
    worker.request(`${ORIGIN}/v1/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": address },
      body: JSON.stringify({ name: "Person", email, password: "correct-horse-42", ...extra }),
    }, testEnv);

  it("sends the first link where the deployment verifies, and activates the account where it does not", async () => {
    const verifying = runtime({ email: true });
    const created = await signUp(verifying.env, "verify-me@example.test", "203.0.113.10", { callbackURL: "/apps" });
    expect(created.status, await created.clone().text()).toBe(200);
    expect(verifying.sent).toHaveLength(1);
    expect(verifying.sent[0]!.to).toBe("verify-me@example.test");
    const { returnTo } = await confirmEmailVerification(verifying.env, tokenFrom(verifying.sent[0]!));
    expect(returnTo).toBe("/apps");
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM account_activation a JOIN mgmt_organization_user m ON m.organization_id=a.organization_id
       JOIN mgmt_user u ON u.id=m.user_id WHERE u.email='verify-me@example.test'`,
    ).first("n")).toBe(0);

    const trusting = runtime();
    const plain = await signUp(trusting.env, "trusted@example.test", "203.0.113.11");
    expect(plain.status, await plain.clone().text()).toBe(200);
    expect(trusting.sent).toHaveLength(0);
    // Activated as it was created, so a sender added later stops none of it.
    const organizationId = await env.DB.prepare(
      `SELECT m.organization_id AS id FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
       WHERE u.email='trusted@example.test'`,
    ).first<string>("id");
    clearIsolateCaches();
    const account = await accountLifecycle(verifying.env, organizationId!);
    expect(account.activated).toBe(true);
    expect(accountAccessDenial(resolveDeployment(verifying.env), account, "proxy", Date.now())).toBeNull();
  });

  it("is counted per network address, refused attempts included", async () => {
    // A closed self-host refuses each attempt before any password is hashed,
    // and every one of them still counts.
    const { env: testEnv } = runtime({ emails: "" });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const refused = await signUp(testEnv, `probe-${attempt}@example.test`, "198.51.100.7");
      expect(refused.status).toBe(403);
    }
    const limited = await signUp(testEnv, "probe-last@example.test", "198.51.100.7");
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "rate_limited", data: { scope: "sign_up_address" } },
    });
    const elsewhere = await signUp(testEnv, "probe-other@example.test", "198.51.100.8");
    expect(elsewhere.status).toBe(403);
  });
});

describe("claims", () => {
  it("wait for the approver's verified address where the deployment verifies addresses", async () => {
    const state = {
      authenticated: true,
      assurance: "interactive",
      actor: { type: "user", id: "u", kind: "human", credentialId: "session-1", actionSource: "web" },
      user: { id: "u", name: null, email: "p@example.test", kind: "human", emailVerified: false, image: null, createdAt: "" },
      memberships: [],
    } as unknown as Parameters<typeof claimRefusal>[0];
    expect(claimRefusal(state, "account-1", "required")).toBe("verification_required");
    expect(claimRefusal(state, "account-1", "off")).toBeNull();
    const verified = { ...state!, user: { ...state!.user!, emailVerified: true } };
    expect(claimRefusal(verified, "account-1", "required")).toBeNull();
  });
});
