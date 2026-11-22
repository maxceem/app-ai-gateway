/**
 * Email verification against a live deployment that sends email (v1's
 * contract): a password sign-up is sent a link, the account's app traffic is
 * refused with `email_unverified` until the link is opened, and served after.
 *
 *   V2_BASE_URL=https://api.example.com \
 *   V2_CONSOLE_URL=https://console.example.com \
 *   V2_MAIL_URL=https://mail-mock.example.workers.dev \
 *   node --experimental-strip-types --test smoke/email.smoke.ts
 *
 * Needs a deployment whose `EMAIL` binding is the mail mock
 * (`smoke/mail-mock/`), which sends nothing and keeps mail only for
 * `example.test` addresses; skipped without V2_MAIL_URL. It signs up a new
 * person at a random `example.test` address, which no API can delete, and
 * deletes the app it makes.
 */
import { test } from "node:test";
import {
  check,
  cleanUp,
  expectCode,
  expectResponse,
  poll,
  readJson,
  same,
  send,
  TEST_TIMEOUT_MS,
} from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const consoleUrl = process.env.V2_CONSOLE_URL ?? "";
const mailUrl = process.env.V2_MAIL_URL ?? "";
const skip = base === "" || consoleUrl === "" || mailUrl === "" ? "V2_BASE_URL, V2_CONSOLE_URL and V2_MAIL_URL are needed" : false;

/** A console page's call, with the person's cookie. */
function asConsole(cookie: string, path: string, init: { method?: string; json?: unknown } = {}): Promise<Response> {
  const origin = new URL(consoleUrl).origin;
  return send(path, consoleUrl, {
    method: init.method ?? (init.json === undefined ? "GET" : "POST"),
    headers: { cookie, "x-console-request": "1", origin, "content-type": "application/json" },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
}

test("a sign-up is sent a verification link, and its apps serve requests once it is opened", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const health = await readJson(await send("/v2/healthz", base));
  same(health.email, "ok", "the deployment does not report email as ok");

  const email = `smoke-${crypto.randomUUID()}@example.test`;
  const origin = new URL(consoleUrl).origin;
  const signedUp = await send("/v2/auth/sign-up/email", consoleUrl, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Smoke", email, password: `smoke-${crypto.randomUUID()}` }),
  });
  await expectResponse(signedUp, 200, "the sign-up");
  const cookie = signedUp.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  check(cookie.includes("session_token="), "the sign-up set no session cookie");

  // The link arrives at the mail mock: the deployment's own console, its verify page, one token.
  const message = await poll(async () => {
    const outbox = await readJson(await send(`/outbox?to=${encodeURIComponent(email)}`, mailUrl));
    return (outbox.messages as { subject: string; text: string }[] | undefined)?.at(-1);
  }, "no verification email reached the mail mock within a minute");
  same(message.subject, "Verify your email address", "the email's subject is not the verification one");
  const link = /https:\/\/\S+/u.exec(message.text)?.[0];
  check(link !== undefined, "the email carried no link");
  const url = new URL(link);
  same(url.origin, origin, "the link does not open the console");
  same(url.pathname, "/v2/verify-email", "the link does not open the verify page");
  // The token travels in the fragment, which no request carries, so no log keeps it.
  same(url.search, "", "the link carries a query string");
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  check(token !== null && token.length > 0, "the link carries no token in its fragment");

  const session = async () => {
    const response = await asConsole(cookie, "/v2/admin/session");
    await expectResponse(response, 200, "the session");
    return (await readJson(response)).session;
  };
  const before = await session();
  same(before.account.verificationPending, true, "the session does not say verification is pending");
  same(before.user.emailVerified, false, "the new sign-in is already verified");

  const created = await asConsole(cookie, "/v2/admin/apps", {
    json: { name: "Smoke email", config: { authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } } } },
  });
  await expectResponse(created, 201, "the app");
  const app = await readJson(created);
  const appId = String(app.app.id);
  const appKey = String(app.api_key.key);
  try {
    const me = () => send(`/v2/apps/${encodeURIComponent(appId)}/me`, base, { headers: { authorization: `Bearer ${appKey}`, "x-end-user-id": "smoke-user" } });
    const refused = await me();
    await expectResponse(refused, 403, "the app's /me before verifying");
    expectCode(await readJson(refused), "email_unverified", "the app's /me before verifying");

    const confirmed = await send("/v2/console/email-verification/confirm", consoleUrl, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    await expectResponse(confirmed, 200, "confirming the link");
    same((await readJson(confirmed)).email, email, "the confirmation names another address");

    const after = await session();
    same(after.user.emailVerified, true, "the address is not verified after confirming");
    same(after.account.verificationPending, undefined, "the session still says verification is pending");
    // Other isolates catch up within ten seconds.
    await poll(async () => ((await me()).status === 200 ? true : undefined), "the app was not served within a minute of verifying");
  } finally {
    await cleanUp([() => asConsole(cookie, `/v2/admin/apps/${encodeURIComponent(appId)}?confirm=${encodeURIComponent(appId)}`, { method: "DELETE" })]);
  }
});
