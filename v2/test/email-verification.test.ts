/**
 * Email verification and the account gate (v1's `email-verification.test.ts`,
 * ported). Where the deployment sends email, the app traffic of an account a
 * password sign-up made waits for its owner's verified address; reading and
 * configuring never does. Every other account serves, so turning email on
 * later refuses none.
 *
 * No email leaves the test: the `EMAIL` binding is a stand-in that keeps what
 * it is handed.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { confirmEmailVerification, consoleReturnPath, sendVerificationEmail, VERIFICATION_LINK_TTL_MS } from "../src/auth/email-verification.ts";
import { VERIFICATION_TOKEN_MAX_LENGTH } from "../src/contracts/access.ts";
import { readAccountPending } from "../src/core/account-standing.ts";
import { appCache } from "../src/apps/app-records.ts";
import { clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedAppKey, seedHuman } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const CONSOLE = "https://console.gateway.test";
const API = "https://gateway.test";

type Sent = { from: { email: string; name: string }; to: string; subject: string; text: string; html: string };

/** A deployment that sends email (or not), and what its stand-in sender was handed. */
function deployment(options: { email?: boolean; from?: string | null; consoleOrigin?: string } = {}) {
  const sent: Sent[] = [];
  const binding = {
    send: vi.fn(async (message: Sent) => {
      sent.push(message);
      return { messageId: `message-${sent.length}` };
    }),
  };
  const values: Record<string, unknown> = { ALLOWED_REGISTRATION_EMAILS: "*" };
  if (options.consoleOrigin !== undefined) values.CONSOLE_ORIGIN = options.consoleOrigin;
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
  const url = new URL(link);
  // The token travels in the fragment, never the query, so no request log keeps it.
  expect(url.search).toBe("");
  return new URLSearchParams(url.hash.slice(1)).get("token")!;
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.clone().json().catch(() => undefined)) as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

/** A person whose address is not verified, owning an account that is not marked as waiting. */
async function unverifiedPerson() {
  const human = await seedHuman(`owner-${crypto.randomUUID().slice(0, 8)}@example.test`);
  await env.DB.prepare("UPDATE mgmt_user SET email_verified = 0 WHERE id = ?").bind(human.userId).run();
  return human;
}

/** A person whose address is not verified, owning an account waiting for it, as a password sign-up makes one. */
async function unverifiedOwner() {
  const human = await unverifiedPerson();
  await env.DB.prepare("INSERT INTO email_pending_verification(email) VALUES (lower(?))").bind(human.email).run();
  return human;
}

/** Clears every owner's mark on the account. */
const unmark = (accountId: string) =>
  env.DB.prepare(
    "DELETE FROM email_pending_verification WHERE email IN (SELECT lower(u.email) FROM mgmt_organization_user m JOIN mgmt_user u ON u.id = m.user_id WHERE m.organization_id = ?)",
  ).bind(accountId).run();

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
  it("refuses a waiting account's app traffic with email_unverified until it is verified, and only where the deployment sends email", async () => {
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

    // Confirming the address removes the mark.
    await unmark(owner.accountId);
    clearCaches();
    expect((await me(verifying, app)).status).toBe(200);
  });

  it("serves every account not marked as waiting, whatever its owner's email: turning email on later refuses none", async () => {
    const owner = await unverifiedPerson();
    const app = await serverApp(owner.accountId);
    expect((await me(deployment().env, app)).status).toBe(200);
    // The deployment starts sending email: the account made before keeps serving.
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
    await unmark(owner.accountId);
    clearCaches();
    expect(await pending(deployment({ email: true }).env, owner.cookie)).toBeUndefined();
  });

  it("clears once the owner's address is verified any other way, such as a linked Google sign-in: apps, banner and resend agree (Sol 7b-7 round 4)", async () => {
    const owner = await unverifiedOwner();
    const app = await serverApp(owner.accountId);
    const verifying = deployment({ email: true }).env;
    expect(await errorCode(await me(verifying, app))).toBe("email_unverified");
    // Google sets the address verified; the mark stays, and no longer matters.
    await env.DB.prepare("UPDATE mgmt_user SET email_verified = 1 WHERE id = ?").bind(owner.userId).run();
    clearCaches();
    expect((await me(verifying, app)).status).toBe(200);
    const session = await asConsole(verifying, owner.cookie, "/v2/admin/session");
    expect(((await session.json()) as { session: { account: { verificationPending?: boolean } } }).session.account.verificationPending).toBeUndefined();
    const resend = await asConsole(verifying, owner.cookie, "/v2/console/email-verification/send", {});
    expect(await resend.json()).toMatchObject({ status: "already_verified" });
  });

  it("clears after a sign-in with the owner's linked Google account, at most 10 s late on an isolate that cached the refusal (Sol 7b-7 round 5)", async () => {
    const owner = await unverifiedOwner();
    const app = await serverApp(owner.accountId);
    const subject = `google-${crypto.randomUUID().slice(0, 8)}`;
    const linkedAt = Date.now();
    // Linked earlier: Better Auth leaves the address unverified on linking; a later sign-in with it may verify it.
    await env.DB.prepare(
      "INSERT INTO mgmt_user_account(id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, 'google', ?, ?, ?)",
    ).bind(`acct_${subject}`, subject, owner.userId, linkedAt, linkedAt).run();
    const verifying = { ...deployment({ email: true }).env, GOOGLE_CLIENT_ID: "client.test", GOOGLE_CLIENT_SECRET: "secret.test" } as Env;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"], now: linkedAt });
    try {
      // This isolate caches the refusal, as one that never hears of the sign-in would.
      expect(await errorCode(await me(verifying, app))).toBe("email_unverified");

      const started = await call("/v2/auth/sign-in/social", { environment: verifying, headers: { origin: CONSOLE }, json: { provider: "google", callbackURL: "/v2/apps" } });
      expect(started.status, await started.clone().text()).toBe(200);
      const state = new URL(((await started.json()) as { url: string }).url).searchParams.get("state")!;
      const cookie = started.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      // Google's token endpoint, answering with an ID token for the linked subject and a verified address.
      const encode = (value: object) => btoa(JSON.stringify(value)).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
      const seconds = Math.floor(linkedAt / 1000);
      const idToken = `${encode({ alg: "RS256", kid: "test" })}.${encode({
        iss: "https://accounts.google.com", aud: "client.test", sub: subject, email: owner.email, email_verified: true, name: "Owner", iat: seconds, exp: seconds + 3600,
      })}.signature`;
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input instanceof Request ? input.url : input).startsWith("https://oauth2.googleapis.com/token")) return new Response("{}", { status: 404 });
        return Response.json({ access_token: "access.test", token_type: "Bearer", expires_in: 3600, id_token: idToken });
      }));
      const back = await call(`/v2/auth/callback/google?code=code.test&state=${encodeURIComponent(state)}`, { environment: verifying, headers: { cookie } });
      vi.unstubAllGlobals();
      expect(back.status, await back.clone().text()).toBe(302);
      expect(back.headers.get("location") ?? "").not.toContain("error");
      expect(await env.DB.prepare("SELECT email_verified AS v FROM mgmt_user WHERE id = ?").bind(owner.userId).first("v")).toBe(1);

      // Still the cached refusal for up to its 10 s, then the fresh read serves.
      expect(await errorCode(await me(verifying, app))).toBe("email_unverified");
      vi.setSystemTime(linkedAt + 10_001);
      expect((await me(verifying, app)).status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("serves an account with any owner who is not waiting", async () => {
    const owner = await unverifiedOwner();
    const app = await serverApp(owner.accountId);
    const verifying = deployment({ email: true }).env;
    expect(await errorCode(await me(verifying, app))).toBe("email_unverified");
    const other = await seedHuman(`co-owner-${crypto.randomUUID().slice(0, 8)}@example.test`);
    await env.DB.prepare(
      "INSERT INTO mgmt_organization_user(id, organization_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
    ).bind(`mem_co_${other.userId}`, owner.accountId, other.userId, new Date().toISOString()).run();
    clearCaches();
    expect((await me(verifying, app)).status).toBe(200);
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
    expect(sent[0]!.text).toContain(`${CONSOLE}/v2/verify-email#token=`);
    const token = tokenFrom(sent[0]!);

    const confirm = () => call("/v2/console/email-verification/confirm", { environment: verifying, headers: { origin: CONSOLE }, json: { token } });
    const first = await confirm();
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({ email: owner.email, returnTo: "/v2/apps" });
    expect(await env.DB.prepare("SELECT email_verified AS v FROM mgmt_user WHERE id = ?").bind(owner.userId).first("v")).toBe(1);
    expect(await readAccountPending(verifying, owner.accountId)).toBe(false);

    // Opened again, it answers the same and does nothing more: this isolate's
    // cached apps of the account are left alone (Sol 7b-7).
    const app = await serverApp(owner.accountId);
    expect((await me(verifying, app)).status).toBe(200);
    expect(appCache.peek(app.appId)).toBeDefined();
    const again = await confirm();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ email: owner.email, returnTo: "/v2/apps" });
    expect(appCache.peek(app.appId)).toBeDefined();
  });

  it("let the account's apps serve at once in the isolate that confirmed, without waiting for the cache (Sol 7b-7)", async () => {
    const owner = await unverifiedOwner();
    const { env: verifying, sent } = deployment({ email: true });
    const app = await serverApp(owner.accountId);
    expect(await errorCode(await me(verifying, app))).toBe("email_unverified");
    await sendVerificationEmail(verifying, CONSOLE, { id: owner.userId, email: owner.email }, null);
    await confirmEmailVerification(verifying, tokenFrom(sent[0]!));
    expect((await me(verifying, app)).status).toBe(200);
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

  it("always fit what the confirmation takes, however long the path to continue at (Sol 7b-7 round 2)", async () => {
    const owner = await unverifiedOwner();
    const { env: verifying, sent } = deployment({ email: true });
    // The longest path allowed, in bytes, made of characters JSON escapes, so the signed claims are as long as they get.
    const longest = `/${'"'.repeat(511)}`;
    expect(consoleReturnPath(longest)).toBe(longest);
    // Bounded in bytes, not characters: 200 emoji are 800 bytes.
    expect(consoleReturnPath(`/${"😀".repeat(200)}`)).toBeNull();
    await sendVerificationEmail(verifying, CONSOLE, { id: owner.userId, email: owner.email }, longest);
    const token = tokenFrom(sent[0]!);
    expect(token.length).toBeLessThanOrEqual(VERIFICATION_TOKEN_MAX_LENGTH);
    const confirmed = await call("/v2/console/email-verification/confirm", { environment: verifying, json: { token }, headers: { origin: CONSOLE, "x-console-request": "1" } });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect(await confirmed.json()).toMatchObject({ returnTo: longest });
  });

  it("are neither signed nor confirmed without a signing secret of at least 32 bytes (Neon 7b-7)", async () => {
    const owner = await unverifiedOwner();
    const { env: verifying, sent } = deployment({ email: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await sendVerificationEmail(verifying, CONSOLE, { id: owner.userId, email: owner.email }, null);
    const token = tokenFrom(sent[0]!);
    for (const secret of [undefined, "", "too short"]) {
      const weak = { ...verifying, BETTER_AUTH_SECRET: secret } as unknown as Env;
      await expect(confirmEmailVerification(weak, token)).rejects.toMatchObject({ status: 503, code: "service_unavailable" });
      await expect(sendVerificationEmail(weak, CONSOLE, { id: owner.userId, email: owner.email }, null))
        .rejects.toMatchObject({ status: 503 });
      // A link signed with empty key material, which anyone could compute, verifies nothing either.
      const confirmed = await call("/v2/console/email-verification/confirm", { environment: weak, json: { token }, headers: { origin: CONSOLE, "x-console-request": "1" } });
      expect(confirmed.status).toBe(503);
    }
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

describe("the gate on the request path", () => {
  it("reads whether the account is waiting in the app's own query, with no separate read (Sol 7b-7)", async () => {
    const owner = await unverifiedPerson();
    const app = await serverApp(owner.accountId);
    const statements: string[] = [];
    const db = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            statements.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const verifying = { ...deployment({ email: true }).env, DB: db } as Env;
    expect((await me(verifying, app)).status).toBe(200);
    const gate = statements.filter((query) => query.includes("email_pending_verification"));
    expect(gate.length).toBeGreaterThan(0);
    // Every statement that asks about the mark is the one that loads the app.
    for (const query of gate) expect(query).toMatch(/from "app"/u);
  });

  it("never touches the mark's table where the deployment does not verify addresses (Fable 7b-7)", async () => {
    const owner = await unverifiedPerson();
    const app = await serverApp(owner.accountId);
    const statements: string[] = [];
    const db = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            statements.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect((await me({ ...deployment().env, DB: db } as Env, app)).status).toBe(200);
    expect(statements.some((query) => query.includes("from \"app\""))).toBe(true);
    expect(statements.filter((query) => query.includes("email_pending_verification"))).toEqual([]);
  });
});

describe("accounts made with a management key", () => {
  it("serve, since nothing marks them: their owner is a key, with no address to verify", async () => {
    const accountId = `acc_boot_${crypto.randomUUID().slice(0, 8)}`;
    const userId = `svc_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const iso = new Date(now).toISOString();
    // What `scripts/management-key.ts --create-account` writes.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO mgmt_user (id, name, email, kind, email_verified, created_at, updated_at) VALUES (?, 'Management key owner', NULL, 'service', 0, ?, ?)").bind(userId, now, now),
      env.DB.prepare("INSERT INTO mgmt_organization (id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Bootstrapped', ?, ?, ?)").bind(accountId, userId, iso, iso),
      env.DB.prepare("INSERT INTO mgmt_organization_user (id, organization_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'owner', 'active', ?)").bind(`mem_${userId}`, accountId, userId, iso),
    ]);
    const app = await serverApp(accountId);
    expect((await me(deployment({ email: true }).env, app)).status).toBe(200);
  });

  it("never clear a waiting account's mark when a key is added to it", async () => {
    const owner = await unverifiedOwner();
    const verifying = deployment({ email: true }).env;
    const created = await asConsole(verifying, owner.cookie, "/v2/admin/management-keys", { name: "CI", grant: "read" });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await readAccountPending(verifying, owner.accountId)).toBe(true);
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

  it("sends at most five links an hour to one sign-in, and never calls the sender for a sixth (Sol 7b-7)", async () => {
    const owner = await unverifiedOwner();
    const { env: verifying, binding } = deployment({ email: true });
    for (let sent = 1; sent <= 5; sent += 1) {
      const response = await send(verifying, owner.cookie);
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const sixth = await send(verifying, owner.cookie);
    expect(sixth.status).toBe(429);
    expect(binding.send).toHaveBeenCalledTimes(5);
  });

  it("spends none of the hourly sends while the email settings are incomplete (Neon 7b-7)", async () => {
    const owner = await unverifiedOwner();
    const { env: broken, binding } = deployment({ email: true, from: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const refused = await send(broken, owner.cookie);
      expect(refused.status).toBe(503);
      expect(await errorCode(refused)).toBe("email_unavailable");
    }
    expect(binding.send).not.toHaveBeenCalled();
    // The settings fixed, the person still has every send of the hour.
    const { env: fixed } = deployment({ email: true });
    const sent = await send(fixed, owner.cookie);
    expect(sent.status, await sent.clone().text()).toBe(200);
  });

  it("sends a link the confirmation takes, dropping a return path longer than it allows in bytes (Sol 7b-7 round 3)", async () => {
    const owner = await unverifiedOwner();
    const { env: verifying, sent } = deployment({ email: true });
    // 301 characters, so the request accepts it; 601 bytes, more than a link may carry.
    const multibyte = `/${"😀".repeat(150)}`;
    const resent = await send(verifying, owner.cookie, { returnTo: multibyte });
    expect(resent.status, await resent.clone().text()).toBe(200);
    const confirmed = await call("/v2/console/email-verification/confirm", {
      environment: verifying,
      json: { token: tokenFrom(sent[0]!) },
      headers: { origin: CONSOLE, "x-console-request": "1" },
    });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect(await confirmed.json()).toEqual({ email: owner.email, returnTo: null });
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
  // Each sign-up comes from its own client address, so the per-address sign-up limit never trips.
  let client = 0;
  const signUp = (environment: Env, email: string, extra: Record<string, unknown> = {}) =>
    call("/v2/auth/sign-up/email", {
      environment,
      headers: { origin: CONSOLE, "cf-connecting-ip": `203.0.113.${(client++ % 250) + 1}` },
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
    expect(await readAccountPending(verifying, accountId)).toBe(true);
    const { returnTo } = await confirmEmailVerification(verifying, tokenFrom(sent[0]!));
    expect(returnTo).toBe("/v2/apps");
    clearCaches();
    expect(await readAccountPending(verifying, accountId)).toBe(false);
  });

  it("marks the address before the person, so their account is never visible unmarked (Sol 7b-7 round 4)", async () => {
    const email = `ordered-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { env: verifying } = deployment({ email: true });
    const order: string[] = [];
    const watch = (query: string) => {
      if (/insert or ignore into email_pending_verification/iu.test(query)) order.push("mark");
      else if (/insert into "?mgmt_user"?\s*\(/iu.test(query)) order.push("person");
      else if (/insert into "?mgmt_organization_user"?/iu.test(query)) order.push("membership");
    };
    const db = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            watch(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const created = await signUp({ ...verifying, DB: db } as Env, email);
    expect(created.status, await created.clone().text()).toBe(200);
    expect(order[0]).toBe("mark");
    expect(order).toContain("person");
    expect(await readAccountPending(verifying, await accountOf(email))).toBe(true);
  });

  it("never marks an address that already belongs to someone: a sign-up attempt with it holds nobody back", async () => {
    const owner = await unverifiedPerson();
    const app = await serverApp(owner.accountId);
    const { env: verifying } = deployment({ email: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const attempt = await signUp(verifying, owner.email);
    expect(attempt.status).not.toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM email_pending_verification WHERE email = lower(?)").bind(owner.email).first()).toBeNull();
    expect((await me(verifying, app)).status).toBe(200);
  });

  it("clears a mark a failed sign-up left, so the next sign-up with the address serves even once email is turned on (Sol 7b-7 round 5)", async () => {
    const email = `retried-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { env: verifying } = deployment({ email: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The address is marked, then the person cannot be written.
    const failing = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            if (/insert into "?mgmt_user"?\s*\(/iu.test(query)) throw new Error("D1 is down");
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect((await signUp({ ...verifying, DB: failing } as Env, email)).status).not.toBe(200);
    expect(await env.DB.prepare("SELECT 1 AS one FROM email_pending_verification WHERE email = lower(?)").bind(email).first("one")).toBe(1);
    // The person signs up again where nothing is verified: the stale mark goes with it.
    const created = await signUp(deployment().env, email);
    expect(created.status, await created.clone().text()).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM email_pending_verification WHERE email = lower(?)").bind(email).first()).toBeNull();
    // Email is turned on later: the account keeps serving.
    const app = await serverApp(await accountOf(email));
    expect((await me(verifying, app)).status).toBe(200);
  });

  it("refuses a sign-up whose stale mark cannot be cleared, so no account inherits it (Sol 7b-7 round 6)", async () => {
    const email = `uncleared-${crypto.randomUUID().slice(0, 8)}@example.test`;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A mark a failed sign-up left behind.
    await env.DB.prepare("INSERT INTO email_pending_verification(email) VALUES (lower(?))").bind(email).run();
    const failing = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            if (query.includes("DELETE FROM email_pending_verification")) throw new Error("D1 is down");
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    // Nothing is verified here, and the mark cannot be cleared: the person is not made.
    // A retryable 503, not Better Auth's 422 for a person it could not make.
    expect((await signUp({ ...deployment().env, DB: failing } as Env, email)).status).toBe(503);
    expect(await env.DB.prepare("SELECT id FROM mgmt_user WHERE email = ?").bind(email).first()).toBeNull();
    // Once D1 answers, the same sign-up clears the mark and goes through.
    const created = await signUp(deployment().env, email);
    expect(created.status, await created.clone().text()).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM email_pending_verification WHERE email = lower(?)").bind(email).first()).toBeNull();
  });

  it("continues the first link where the sign-up form was headed (Sol 7b-7 round 2)", async () => {
    const email = `deep-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { env: verifying, sent } = deployment({ email: true });
    const created = await signUp(verifying, email, { callbackURL: "/v2/apps/my-app?tab=usage" });
    expect(created.status, await created.clone().text()).toBe(200);
    const { returnTo } = await confirmEmailVerification(verifying, tokenFrom(sent[0]!));
    expect(returnTo).toBe("/v2/apps/my-app?tab=usage");
  });

  it("is refused with email_unavailable, making no account, where links could not open: no console origin (Sol 7b-7)", async () => {
    const email = `no-console-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { env: broken, sent } = deployment({ email: true, consoleOrigin: "" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const refused = await signUp(broken, email);
    expect(refused.status).toBe(503);
    expect(await errorCode(refused)).toBe("email_unavailable");
    expect(sent).toHaveLength(0);
    expect(await env.DB.prepare("SELECT id FROM mgmt_user WHERE email = ?").bind(email).first()).toBeNull();
    const health = await call("/v2/healthz", { environment: broken, base: API });
    expect(await health.json()).toMatchObject({ email: "misconfigured" });
  });

  it("marks nothing where the deployment sends no email, so a sender added later stops none of it", async () => {
    const email = `trusted-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { env: trusting, sent } = deployment();
    const created = await signUp(trusting, email);
    expect(created.status, await created.clone().text()).toBe(200);
    expect(sent).toHaveLength(0);
    expect(await readAccountPending(deployment({ email: true }).env, await accountOf(email))).toBe(false);
  });

  it("leaves the account serving, and logs it, when the mark cannot be written", async () => {
    const email = `unmarked-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { env: verifying } = deployment({ email: true });
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            if (query.includes("INSERT OR IGNORE INTO email_pending_verification")) throw new Error("D1 is down");
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const created = await signUp({ ...verifying, DB: db } as Env, email);
    expect(created.status, await created.clone().text()).toBe(200);
    expect(await readAccountPending(verifying, await accountOf(email))).toBe(false);
    expect(warned.some((line) => line.includes('"message":"email_pending_mark_failed"'))).toBe(true);
  });
});
