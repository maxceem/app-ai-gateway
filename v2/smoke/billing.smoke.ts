/**
 * Hosted billing against a live deployment whose `BILLING` binding is the
 * billing mock (`smoke/billing-mock/`), which moves no money: its checkout is
 * a URL on `.invalid`, and its changes are acknowledged and do nothing.
 *
 *   V2_BASE_URL=… V2_ALLOWANCE_MANAGEMENT_KEY=<a key for smoke-allowance> \
 *   V2_CONSOLE_URL=… V2_BILLING_MOCK=1 pnpm run smoke
 *
 * The first check needs the allowance account's key. The second signs up a
 * person at a random `example.test` address (a sign-up no API can delete, as
 * the email check does) and needs `V2_BILLING_MOCK=1`, to say the deployment's
 * billing is the mock and not a real one.
 */
import { test } from "node:test";
import { check, expectCode, expectResponse, readJson, same, send, TEST_TIMEOUT_MS } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const allowanceKey = process.env.V2_ALLOWANCE_MANAGEMENT_KEY ?? "";
const consoleUrl = process.env.V2_CONSOLE_URL ?? "";
const mock = process.env.V2_BILLING_MOCK === "1";

const skipKey = base === "" || allowanceKey === "" ? "V2_BASE_URL and V2_ALLOWANCE_MANAGEMENT_KEY are needed" : false;
const skipConsole =
  base === "" || consoleUrl === "" || !mock ? "V2_BASE_URL, V2_CONSOLE_URL and V2_BILLING_MOCK=1 are needed" : false;

/** Every billing operation, as the console calls it. */
const OPERATIONS = [
  ["GET", "/v2/admin/billing/plans"],
  ["GET", "/v2/admin/billing/status"],
  ["POST", "/v2/admin/billing/checkout", { planKey: "smoke-pro", billingPeriod: "month", accountId: "any" }],
  ["POST", "/v2/admin/billing/change", { planKey: "smoke-pro", billingPeriod: "month", accountId: "any", subscriptionId: null }],
  ["POST", "/v2/admin/billing/resume", { planKey: "smoke-pro", billingPeriod: "month", accountId: "any", subscriptionId: null }],
  ["POST", "/v2/admin/billing/cancel", { accountId: "any", subscriptionId: null }],
  ["POST", "/v2/admin/billing/trial", { planKey: "smoke-pro", accountId: "any" }],
] as const;

test("account status shows the plan and this period's allowance; billing operations are a person's alone", { skip: skipKey, timeout: TEST_TIMEOUT_MS }, async () => {
  const headers = { authorization: `Bearer ${allowanceKey}`, "content-type": "application/json" };
  const response = await send("/v2/admin/session", base, { headers });
  await expectResponse(response, 200, "the session");
  const billing = (await readJson(response)).session.billing;
  check(billing !== undefined && billing !== null, "the session carries no billing on a hosted deployment");
  same(billing.state, "billed", "the session's billing is not billed");
  same(billing.planName, "Smoke", "the session does not name the mock's plan");
  check(billing.allowance !== null, "the session carries no allowance for a plan with a monthly limit");
  same(billing.allowance.limit, 3, "the allowance is not the mock plan's limit");
  check(Number.isInteger(billing.allowance.used) && billing.allowance.used >= 0, "the allowance's count is not a count");
  check(!Number.isNaN(Date.parse(billing.allowance.resetAt)), "the allowance's reset is not a time");

  // A key that could buy or cancel would hand over more than itself.
  for (const [method, path, body] of OPERATIONS) {
    const refused = await send(path, base, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    await expectResponse(refused, 403, "a billing operation with a management key");
    expectCode(await readJson(refused), "session_required", "a billing operation with a management key");
  }
});

test("a person reads the plans and the plan held, and starts a checkout that returns to the console", { skip: skipConsole, timeout: TEST_TIMEOUT_MS }, async () => {
  const origin = new URL(consoleUrl).origin;
  const signedUp = await send("/v2/auth/sign-up/email", consoleUrl, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Smoke billing", email: `smoke-billing-${crypto.randomUUID()}@example.test`, password: `smoke-${crypto.randomUUID()}` }),
  });
  await expectResponse(signedUp, 200, "the sign-up");
  const cookie = signedUp.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  check(cookie.includes("session_token="), "the sign-up set no session cookie");
  const asConsole = (path: string, json?: unknown) =>
    send(path, consoleUrl, {
      method: json === undefined ? "GET" : "POST",
      headers: { cookie, "x-console-request": "1", origin, "content-type": "application/json" },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });

  const plans = await asConsole("/v2/admin/billing/plans");
  await expectResponse(plans, 200, "the plans");
  const offers = (await readJson(plans)).plans as { planKey: string }[];
  check(offers.some((offer) => offer.planKey === "smoke-pro"), "the plans do not include the mock's paid plan");

  // A new account is on the mock's default plan, with no ceiling and every feature.
  const status = await asConsole("/v2/admin/billing/status");
  await expectResponse(status, 200, "the billing status");
  const read = await readJson(status);
  same(read.access.state, "billed", "the status is not billed");
  same(read.access.plan.planKey, "free", "a new account is not on the default plan");
  same(read.allowance, null, "a plan with no monthly limit reports an allowance");
  same(read.features.conversationStorage, true, "a plan with no feature list does not include conversations");
  same(read.actions, { cancel: false, resume: false, manual: false }, "an account with no subscription is offered actions");

  // Every write names the account the console showed.
  const session = await asConsole("/v2/admin/session");
  await expectResponse(session, 200, "the session");
  const accountId = (await readJson(session)).session.account.id as string;
  check(typeof accountId === "string" && accountId !== "", "the session names no account");

  // A return page the caller sends is ignored: the gateway picks the console's own.
  const checkout = await asConsole("/v2/admin/billing/checkout", {
    planKey: "smoke-pro",
    billingPeriod: "month",
    accountId,
    successUrl: "https://elsewhere.invalid/thanks",
  });
  await expectResponse(checkout, 200, "the checkout");
  same((await readJson(checkout)).url, "https://checkout.invalid/smoke/smoke-pro", "the checkout is not the mock's");

  // While it is open, the same plan answers the same page, and another is refused.
  const again = await asConsole("/v2/admin/billing/checkout", { planKey: "smoke-pro", billingPeriod: "month", accountId });
  await expectResponse(again, 200, "the same checkout again");
  same((await readJson(again)).url, "https://checkout.invalid/smoke/smoke-pro", "the same checkout again is another page");
  const other = await asConsole("/v2/admin/billing/checkout", { planKey: "smoke-pro", billingPeriod: "year", accountId });
  await expectResponse(other, 409, "a checkout for another period while one is open");
  expectCode(await readJson(other), "checkout_open", "a checkout for another period while one is open");

  // A write for an account other than the one selected is refused.
  const elsewhere = await asConsole("/v2/admin/billing/checkout", { planKey: "smoke-pro", billingPeriod: "month", accountId: "another-account" });
  await expectResponse(elsewhere, 409, "a checkout for another account");
  expectCode(await readJson(elsewhere), "account_changed", "a checkout for another account");

  // A plan the billing service does not sell is its refusal, in the gateway's words.
  const unknown = await asConsole("/v2/admin/billing/change", { planKey: "no-such-plan", billingPeriod: "month", accountId, subscriptionId: null });
  await expectResponse(unknown, 404, "a change to an unknown plan");
  expectCode(await readJson(unknown), "billing_not_found", "a change to an unknown plan");
});
