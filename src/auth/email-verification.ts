import { and, eq, sql } from "drizzle-orm";
import { invalidateAccountLifecycle } from "../core/account-lifecycle";
import { enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import { database } from "../db";
import { mgmtOrganizationUser, mgmtUser } from "../db/schema";
import { prepared } from "../db/sql";
import type { Deployment } from "../policy/deployment";
import { derive } from "../routes/cli/security";

/**
 * Email verification, where the deployment sends email.
 *
 * A link is self-contained: it names the sign-in, the address it was sent to,
 * when it lapses and where the console continues, signed with a key derived
 * from `BETTER_AUTH_SECRET` for this purpose alone. Nothing is stored for it,
 * because confirming one twice is harmless — it sets a flag that is already
 * set — and because it is bound to the address, a link for an address the
 * sign-in no longer has verifies nothing.
 *
 * Verifying is all a link does. What waits for it is decided elsewhere: the
 * account gate in `../policy/accounts`, and the claim's refusal in
 * `./operation-kinds`.
 */

/** How long a verification link works. */
export const VERIFICATION_LINK_TTL_MS = 24 * 3_600_000;

/** The console page a link opens. */
export const VERIFICATION_PAGE_PATH = "/verify-email";

const LINK_KEY_PURPOSE = "email-verification-link-v1";
const SENDER_NAME = "App AI Gateway";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a link says, in the short keys it is written with. */
interface LinkClaims {
  /** The sign-in's user id. */
  u: string;
  /** The address the link was sent to, as stored. */
  e: string;
  /** When it lapses, in epoch milliseconds. */
  x: number;
  /** The console path to continue at, if the link was asked for from one. */
  r?: string;
}

/**
 * Whether this deployment can send a verification email: `off` without an
 * `EMAIL` binding, `misconfigured` with one but no address to send from.
 */
export function emailDeliveryStatus(env: Env): "off" | "ok" | "misconfigured" {
  if (!env.EMAIL) return "off";
  return senderAddress(env) === null ? "misconfigured" : "ok";
}

function senderAddress(env: Env): string | null {
  const from = env.EMAIL_FROM?.trim();
  return from && /^[^\s@]+@[^\s@]+$/u.test(from) ? from : null;
}

/**
 * A console path a link may continue at: one beginning with a single `/`, so
 * no link can send the browser off the console. Anything else is dropped.
 */
export function consoleReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  return /^\/(?![/\\])[^\\\s]*$/.test(value) ? value : null;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function linkKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(await derive(env.BETTER_AUTH_SECRET, LINK_KEY_PURPOSE)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signLink(env: Env, claims: LinkClaims): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await linkKey(env), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/** The claims of a link this deployment signed and that has not lapsed, or null. */
async function readLink(env: Env, token: string, nowMs: number): Promise<LinkClaims | null> {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const signatureBytes = fromBase64url(signature);
  if (!signatureBytes) return null;
  // `verify` compares in constant time, so a forged link learns nothing from
  // how long it took to be refused.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await linkKey(env),
    signatureBytes,
    encoder.encode(payload),
  );
  if (!valid) return null;
  const payloadBytes = fromBase64url(payload);
  if (!payloadBytes) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  const read = claims as Partial<LinkClaims> | null;
  if (
    typeof read?.u !== "string"
    || typeof read.e !== "string"
    || typeof read.x !== "number"
    || (read.r !== undefined && consoleReturnPath(read.r) === null)
  )
    return null;
  return read.x > nowMs ? (read as LinkClaims) : null;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Sends `person` a link that verifies their address, continuing at `returnTo`
 * on the console once it is opened.
 *
 * Refuses where the deployment sends no email, and answers `email_unavailable`
 * where it should but cannot: no sender address, or Email Service refused the
 * message. Only the failure's kind is logged, never the address.
 */
export async function sendVerificationEmail(
  env: Env,
  deployment: Deployment,
  person: { id: string; email: string },
  returnTo: string | null,
  nowMs = Date.now(),
): Promise<void> {
  const sender = env.EMAIL;
  if (!sender || deployment.emailVerification === "off") {
    throw new GatewayError(409, "conflict", "This deployment does not verify email addresses");
  }
  const from = senderAddress(env);
  if (from === null) {
    log("error", "verification_email_unconfigured", { reason: "EMAIL_FROM is missing or not an address" });
    throw new GatewayError(
      503,
      "email_unavailable",
      "This deployment cannot send email yet: its sender address is not configured",
    );
  }
  const token = await signLink(env, {
    u: person.id,
    e: person.email,
    x: nowMs + VERIFICATION_LINK_TTL_MS,
    ...(returnTo === null ? {} : { r: returnTo }),
  });
  const link = new URL(VERIFICATION_PAGE_PATH, deployment.consoleOrigin());
  link.searchParams.set("token", token);
  const href = link.toString();
  try {
    await sender.send({
      from: { email: from, name: SENDER_NAME },
      to: person.email,
      subject: "Verify your email address",
      text: [
        "Open this link to verify your email address for App AI Gateway:",
        "",
        href,
        "",
        "Your apps serve requests once your address is verified. The link works for 24 hours.",
        "If you did not create a sign-in, you can ignore this email.",
      ].join("\n"),
      html: [
        "<p>Open this link to verify your email address for App AI Gateway:</p>",
        `<p><a href="${escapeHtml(href)}">Verify my email address</a></p>`,
        "<p>Your apps serve requests once your address is verified. The link works for 24 hours.</p>",
        "<p>If you did not create a sign-in, you can ignore this email.</p>",
      ].join(""),
    });
  } catch (error) {
    log("error", "verification_email_failed", {
      reason: error instanceof Error ? error.name : typeof error,
      ...(typeof (error as { code?: unknown } | null)?.code === "string"
        ? { code: (error as { code: string }).code }
        : {}),
    });
    throw new GatewayError(
      503,
      "email_unavailable",
      "The verification email could not be sent. Try again in a few minutes.",
    );
  }
}

/**
 * Sends the first verification link to a person who just created a sign-in
 * with a password, from the sign-up's own `response`, on a deployment that
 * verifies addresses. A sign-in that arrives verified — Google's — is never
 * sent one.
 *
 * A failure is logged and goes no further: the sign-in exists either way, and
 * the console offers to send the link again.
 */
export async function sendFirstVerificationEmail(
  env: Env,
  deployment: Deployment,
  response: Response,
  returnTo: string | null,
): Promise<void> {
  if (!response.ok || deployment.emailVerification === "off") return;
  const body = (await response.clone().json().catch(() => undefined)) as
    | { user?: { id?: unknown; email?: unknown; emailVerified?: unknown } }
    | undefined;
  const user = body?.user;
  if (typeof user?.id !== "string" || typeof user.email !== "string" || user.emailVerified !== false) return;
  try {
    await enforceEndpointRateLimit(env, "verification_email", user.id);
    await sendVerificationEmail(env, deployment, { id: user.id, email: user.email }, returnTo);
  } catch (error) {
    log("warn", "verification_email_not_sent", {
      reason: error instanceof GatewayError ? error.code : "unexpected",
    });
  }
}

/**
 * Verifies the address a link was sent to, and answers where to continue.
 *
 * Idempotent: a link confirmed again answers the same, for as long as it has
 * not lapsed and the sign-in still has that address. The accounts the person
 * owns may serve traffic from now on, so this isolate drops their cached
 * standing; every other isolate catches up within the cache's ten seconds.
 */
export async function confirmEmailVerification(
  env: Env,
  token: string,
  nowMs = Date.now(),
): Promise<{ email: string; returnTo: string | null }> {
  const claims = await readLink(env, token, nowMs);
  const invalid = () =>
    new GatewayError(
      400,
      "invalid_request",
      "This verification link is not valid any more. Send a new one from the console.",
    );
  if (!claims) throw invalid();
  const db = database(env.DB);
  const person = and(
    eq(mgmtUser.id, claims.u),
    eq(mgmtUser.email, claims.e),
    eq(mgmtUser.kind, "human"),
  );
  await db
    .update(mgmtUser)
    .set({ emailVerified: true, updatedAt: new Date(nowMs) })
    .where(and(person, eq(mgmtUser.emailVerified, false)));
  const verified = await db
    .select({ id: mgmtUser.id })
    .from(mgmtUser)
    .where(and(person, eq(mgmtUser.emailVerified, true)))
    .get();
  if (!verified) throw invalid();
  const owned = await db
    .select({ organizationId: mgmtOrganizationUser.organizationId })
    .from(mgmtOrganizationUser)
    .where(and(eq(mgmtOrganizationUser.userId, claims.u), eq(mgmtOrganizationUser.role, "owner")));
  for (const { organizationId } of owned) invalidateAccountLifecycle(organizationId);
  return { email: claims.e, returnTo: claims.r ?? null };
}

/**
 * Lets an account serve traffic whatever its owner's email: how a deployment
 * that sends no email activates each account it creates or a person claims, so
 * that adding a sender later stops none of them. Repeating it changes nothing,
 * and an account deleted meanwhile is skipped rather than refused.
 */
export async function activateAccount(db: D1Database, organizationId: string): Promise<void> {
  await prepared(db, sql`INSERT OR IGNORE INTO account_activation(organization_id)
    SELECT id FROM mgmt_organization WHERE id=${organizationId}`).run();
}
