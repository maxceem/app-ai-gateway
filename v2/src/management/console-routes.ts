/**
 * The console's own pages' API, under `/v2/console`: what the deployment
 * offers, the OAuth consent page, the page where a person enters the code a
 * CLI shows, and email verification.
 *
 * Except the capabilities, every call must be made from the console's own
 * pages: the URL must be on the console's origin (404 anywhere else) and the
 * browser's `Origin` must be that origin too (403). That is checked before
 * the body is read. Only the browser's sign-in cookie counts here: consenting
 * is a person's act, so a key or a token is nobody.
 *
 * cf-auth decides every security rule (the proof, the code, the client, the
 * session and membership re-read in the batch that completes an approval).
 */
import { pricesRevision, SERVER_VERSION } from "../core/version.ts";
import type { AuthState, CfAuth, CfAuthOAuth } from "@maxceem/cf-auth";
import { Hono, type Context } from "hono";
import { gatewayErrorOf, humanSession, identityFor } from "../auth/identity.ts";
import {
  consoleOrigin,
  googleAuthEnabled,
  hostedDeployment,
  oauthIssuer,
  registrationOpen,
  setting,
} from "../auth/settings.ts";
import {
  ConsentAllowRequestSchema,
  ConsentProofSchema,
  DeviceApproveRequestSchema,
  DeviceCodeRequestSchema,
  DeviceLookupRequestSchema,
  ConfirmEmailVerificationRequestSchema,
  SendVerificationEmailRequestSchema,
} from "../contracts/access.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { honoPath } from "../contracts/client-catalog.ts";
import { CATALOG, type OperationName } from "../contracts/catalog.ts";
import { GatewayError } from "../core/errors.ts";
import { clientAddress, enforceEndpointRateLimit } from "../core/flood-limit.ts";
import { activeAccounts } from "../admin/access.ts";
import { parseBody } from "../admin/apps.ts";
import { conversationsBucket } from "../conversations/storage.ts";
import { denyHandoff, getHandoff, submitHandoff } from "../admin/handoffs.ts";
import { confirmEmailVerification, sendVerificationEmail } from "../auth/email-verification.ts";
import { emailVerificationRequired } from "../core/account-standing.ts";
import { emailSetup } from "../email/sender.ts";
import { log } from "../core/log.ts";

type ConsoleEnv = { Bindings: Env; Variables: { identity: Promise<CfAuth>; authState: AuthState } };
type ConsoleContext = Context<ConsoleEnv>;

export const consoleRoutes = new Hono<ConsoleEnv>();

const path = (name: OperationName): string => honoPath(CATALOG[name].path);

consoleRoutes.get(path("getConsoleCapabilities"), async (c) =>
  c.json({
    billing: hostedDeployment(c.env),
    registrationOpen: registrationOpen(c.env),
    googleAuth: googleAuthEnabled(c.env),
    oauth: oauthIssuer(c.env) !== null,
    conversationStorage: conversationsBucket(c.env) !== null,
    emailVerification: emailVerificationRequired(c.env),
    ...(setting(c.env, "TERMS_OF_SERVICE_URL") === undefined ? {} : { termsOfServiceUrl: setting(c.env, "TERMS_OF_SERVICE_URL") }),
    ...(setting(c.env, "PRIVACY_POLICY_URL") === undefined ? {} : { privacyPolicyUrl: setting(c.env, "PRIVACY_POLICY_URL") }),
    serverVersion: SERVER_VERSION,
    prices: await pricesRevision(),
  } satisfies OperationResponse<"getConsoleCapabilities">),
);

/** Refuses a call that is not from the console's own page, before anything is read. */
function assertConsoleOrigin(c: ConsoleContext): void {
  const origin = consoleOrigin(c.env);
  if (origin === null || new URL(c.req.url).origin !== origin) {
    throw new GatewayError(404, "not_found", "Nothing is served at this path.");
  }
  if (c.req.header("origin") !== origin) throw new GatewayError(403, "forbidden", "Use the console's own page");
}

// Never cached, never handed on as a referrer, and only from the console's page.
consoleRoutes.use("/v2/console/oauth/*", async (c, next) => {
  assertConsoleOrigin(c);
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
});
consoleRoutes.use("/v2/console/device/*", async (c, next) => {
  assertConsoleOrigin(c);
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
});
consoleRoutes.use("/v2/console/email-verification/*", async (c, next) => {
  assertConsoleOrigin(c);
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
});
consoleRoutes.use("/v2/console/handoffs/*", async (c, next) => {
  assertConsoleOrigin(c);
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
});

/** The OAuth service, or 404 where the deployment runs none. */
async function oauthOf(c: ConsoleContext): Promise<CfAuthOAuth> {
  const identity = await identityFor(c);
  if (identity.config.oauth === null) throw new GatewayError(404, "not_found", "Nothing is served at this path.");
  return identity.oauth;
}

/** The person signed in to this browser, from the cookie alone; null for nobody. */
async function browserSession(c: ConsoleContext): Promise<AuthState | null> {
  const identity = await identityFor(c);
  await identity.middleware<ConsoleEnv>({ apiKeys: false, oauth: false, syncCurrentOrganizationCookie: false })(c, async () => {});
  return humanSession(c.get("authState"));
}

async function requireBrowserSession(c: ConsoleContext): Promise<AuthState> {
  const session = await browserSession(c);
  if (session === null) throw new GatewayError(401, "session_required", "Sign in to the console first");
  return session;
}

/** Refuses an account the person does not belong to, before cf-auth is asked. */
function assertMember(session: AuthState, accountId: string): void {
  if (!activeAccounts(session.memberships).some((account) => account.id === accountId)) {
    throw new GatewayError(403, "not_a_member", "Choose one of your own accounts");
  }
}

/** Runs a handler with cf-auth's refusals turned into the gateway's own errors. */
function handle(handler: (c: ConsoleContext) => Promise<Response>) {
  return async (c: ConsoleContext) => {
    try {
      return await handler(c);
    } catch (error) {
      throw gatewayErrorOf(error);
    }
  };
}

consoleRoutes.post(path("getOauthConsent"), handle(async (c) => {
  const { proof } = await parseBody(c, ConsentProofSchema);
  const oauth = await oauthOf(c);
  const viewer = await browserSession(c);
  const details = await oauth.authorizationDetails({ id: c.req.param("id") ?? "", proof, viewer });
  const accounts = details.viewer ? activeAccounts(details.viewer.memberships) : [];
  return c.json({
    id: details.id,
    state: details.state,
    client: details.client,
    redirectHost: details.redirectHost,
    requestedGrant: details.requestedGrant,
    expiresAt: details.expiresAt,
    viewer: details.viewer ? { name: details.viewer.user.name, email: details.viewer.user.email } : null,
    accounts,
    blockedBy: details.viewer === null ? "sign_in_required" : accounts.length === 0 ? "no_account" : null,
  } satisfies OperationResponse<"getOauthConsent">);
}));

consoleRoutes.post(path("allowOauthConsent"), handle(async (c) => {
  const { proof, accountId, grant } = await parseBody(c, ConsentAllowRequestSchema);
  const oauth = await oauthOf(c);
  const session = await requireBrowserSession(c);
  assertMember(session, accountId);
  const { redirect } = await oauth.approveAuthorization({
    id: c.req.param("id") ?? "",
    proof,
    actor: session,
    organizationId: accountId,
    grant,
  });
  return c.json({ redirect } satisfies OperationResponse<"allowOauthConsent">);
}));

consoleRoutes.post(path("denyOauthConsent"), handle(async (c) => {
  const { proof } = await parseBody(c, ConsentProofSchema);
  const oauth = await oauthOf(c);
  const { redirect } = await oauth.denyAuthorization({ id: c.req.param("id") ?? "", proof });
  return c.json({ redirect } satisfies OperationResponse<"denyOauthConsent">);
}));

consoleRoutes.post(path("lookupDeviceCode"), handle(async (c) => {
  const { userCode } = await parseBody(c, DeviceLookupRequestSchema);
  const oauth = await oauthOf(c);
  await requireBrowserSession(c);
  const found = await oauth.lookupDevice({
    userCode,
    // A code is eight characters, so looking one up is counted per network
    // address: the only way a guess can be tried.
    rateLimit: () => enforceEndpointRateLimit(c.env, "user_code", clientAddress(c.req.raw)),
  });
  if (found === null) throw new GatewayError(404, "not_found", "No sign-in is waiting for this code. Check it, or start again in the CLI.");
  return c.json(found satisfies OperationResponse<"lookupDeviceCode">);
}));

consoleRoutes.post(path("getDeviceRequest"), handle(async (c) => {
  const { userCode } = await parseBody(c, DeviceCodeRequestSchema);
  const oauth = await oauthOf(c);
  const session = await requireBrowserSession(c);
  const details = await oauth.deviceDetails({ id: c.req.param("id") ?? "", userCode, viewer: session });
  return c.json({
    id: details.id,
    state: details.state,
    client: details.client,
    requestedGrant: details.requestedGrant,
    userCode: details.userCode,
    expiresAt: details.expiresAt,
    accounts: details.viewer ? activeAccounts(details.viewer.memberships) : [],
  } satisfies OperationResponse<"getDeviceRequest">);
}));

consoleRoutes.post(path("approveDeviceRequest"), handle(async (c) => {
  const { userCode, accountId, grant } = await parseBody(c, DeviceApproveRequestSchema);
  const oauth = await oauthOf(c);
  const session = await requireBrowserSession(c);
  assertMember(session, accountId);
  const { state } = await oauth.approveDevice({ id: c.req.param("id") ?? "", userCode, actor: session, organizationId: accountId, grant });
  return c.json({ state } satisfies OperationResponse<"approveDeviceRequest">);
}));

consoleRoutes.post(path("denyDeviceRequest"), handle(async (c) => {
  const { userCode } = await parseBody(c, DeviceCodeRequestSchema);
  const oauth = await oauthOf(c);
  const { state } = await oauth.denyDevice({ id: c.req.param("id") ?? "", userCode, actor: await browserSession(c) });
  return c.json({ state } satisfies OperationResponse<"denyDeviceRequest">);
}));

// The approval page of a write an agent asked for. The link's proof is the
// whole authority, so nobody needs to be signed in.
consoleRoutes.post(path("getHandoff"), handle(getHandoff));
consoleRoutes.post(path("submitHandoff"), handle(submitHandoff));
consoleRoutes.post(path("denyHandoff"), handle(denyHandoff));

/*
 * Email verification. Sending needs a person signed in to this browser, and
 * nothing more: verifying is about the person, not an account. Confirming
 * needs only the link, which is the whole proof.
 */
consoleRoutes.post(path("sendVerificationEmail"), handle(async (c) => {
  const { returnTo } = await parseBody(c, SendVerificationEmailRequestSchema);
  const session = await requireBrowserSession(c);
  if (!emailVerificationRequired(c.env)) throw new GatewayError(409, "conflict", "This deployment does not verify email addresses");
  const user = session.user!;
  if (!user.email) throw new GatewayError(409, "conflict", "This sign-in has no email address");
  if (user.emailVerified) {
    return c.json({ status: "already_verified", email: user.email } satisfies OperationResponse<"sendVerificationEmail">);
  }
  // Settings still being fixed spend none of the person's hourly sends (Neon 7b-7).
  const setup = emailSetup(c.env);
  if (setup.state === "misconfigured") {
    // Names the setting to fix, as the sign-up's refusal does; never a value.
    log("error", "verification_email_unconfigured", { reason: setup.problem });
    throw new GatewayError(503, "email_unavailable", "This deployment cannot send email yet: its email settings are incomplete");
  }
  await enforceEndpointRateLimit(c.env, "verification_email", user.id);
  // `assertConsoleOrigin` has checked this origin is the console's.
  await sendVerificationEmail(c.env, new URL(c.req.url).origin, { id: user.id, email: user.email }, returnTo ?? null);
  return c.json({ status: "sent", email: user.email } satisfies OperationResponse<"sendVerificationEmail">);
}));

consoleRoutes.post(path("confirmEmailVerification"), handle(async (c) => {
  const { token } = await parseBody(c, ConfirmEmailVerificationRequestSchema);
  return c.json((await confirmEmailVerification(c.env, token)) satisfies OperationResponse<"confirmEmailVerification">);
}));
