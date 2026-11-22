/**
 * Email verification, where the deployment sends email (v1's, ported).
 *
 * A link is self-contained: it names the sign-in, the address it was sent to,
 * when it lapses and where the console continues, signed with a key derived
 * from `BETTER_AUTH_SECRET` for this purpose alone. Nothing is stored for it,
 * because confirming one twice is harmless — it sets a flag that is already
 * set — and because it is bound to the address, a link for an address the
 * sign-in no longer has verifies nothing.
 *
 * Verifying is all a link does. What waits for it is the account gate in
 * `../core/account-standing.ts`: an account's app traffic.
 */
import { invalidateAccountStanding } from "../core/account-standing.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { enforceEndpointRateLimit } from "../core/flood-limit.ts";
import { log } from "../core/log.ts";
import { emailSender, emailSetup } from "../email/sender.ts";
import { V2_PATH } from "./settings.ts";

/** How long a verification link works. */
export const VERIFICATION_LINK_TTL_MS = 24 * 3_600_000;

/** The console page a link opens. */
export const VERIFICATION_PAGE_PATH = `${V2_PATH}/verify-email`;

const LINK_KEY_INFO = "app-ai-gateway v2 email verification link";
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
 * Whether this deployment can send a verification email, as `/v2/healthz`
 * reports it: `off` with no transport configured, `misconfigured` with one that
 * cannot send yet, `ok` otherwise. Which transport, and what is wrong with it,
 * stay out of a public answer; a failed send logs the setting to fix.
 */
export function emailDeliveryStatus(env: Env): "off" | "ok" | "misconfigured" {
  return emailSetup(env).state;
}

/**
 * A console path a link may continue at: one beginning with a single `/`, so
 * no link can send the browser off the console. Anything else is dropped.
 */
export function consoleReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  return /^\/(?![/\\])[^\\\s]*$/u.test(value) ? value : null;
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

/** The link key: HKDF over `BETTER_AUTH_SECRET`, for this purpose alone. */
async function linkKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(env.BETTER_AUTH_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(LINK_KEY_INFO) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
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
  const valid = await crypto.subtle.verify("HMAC", await linkKey(env), signatureBytes, encoder.encode(payload));
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
  ) return null;
  return read.x > nowMs ? (read as LinkClaims) : null;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Sends `person` a link that verifies their address, opening the console at
 * `consoleOrigin` and continuing at `returnTo` once it is opened.
 *
 * Refuses where the deployment sends no email, and answers `email_unavailable`
 * where it should but cannot: its configuration is incomplete, or the
 * transport refused the message. Only the setting to fix or the failure's kind
 * is logged, never the address — an SMTP refusal quotes it.
 */
export async function sendVerificationEmail(
  env: Env,
  consoleOrigin: string,
  person: { id: string; email: string },
  returnTo: string | null,
  nowMs = Date.now(),
): Promise<void> {
  const setup = emailSetup(env);
  if (setup.state === "off") throw new GatewayError(409, "conflict", "This deployment does not verify email addresses");
  if (setup.state === "misconfigured") {
    log("error", "verification_email_unconfigured", { reason: setup.problem });
    throw new GatewayError(503, "email_unavailable", "This deployment cannot send email yet: its email settings are incomplete");
  }
  const sender = emailSender(env)!;
  const { from, replyTo } = setup;
  const token = await signLink(env, {
    u: person.id,
    e: person.email,
    x: nowMs + VERIFICATION_LINK_TTL_MS,
    ...(returnTo === null ? {} : { r: returnTo }),
  });
  const link = new URL(VERIFICATION_PAGE_PATH, consoleOrigin);
  link.searchParams.set("token", token);
  const href = link.toString();
  try {
    await sender.send({
      from: { email: from, name: SENDER_NAME },
      ...(replyTo === null ? {} : { replyTo }),
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
    log("error", "verification_email_failed", { transport: sender.transport, error: errorFacts(error) });
    throw new GatewayError(503, "email_unavailable", "The verification email could not be sent. Try again in a few minutes.");
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
  consoleOrigin: string,
  response: Response,
  returnTo: string | null,
): Promise<void> {
  if (!response.ok || emailSetup(env).state === "off") return;
  const body = (await response.clone().json().catch(() => undefined)) as
    | { user?: { id?: unknown; email?: unknown; emailVerified?: unknown } }
    | undefined;
  const user = body?.user;
  if (typeof user?.id !== "string" || typeof user.email !== "string" || user.emailVerified !== false) return;
  try {
    await enforceEndpointRateLimit(env, "verification_email", user.id);
    await sendVerificationEmail(env, consoleOrigin, { id: user.id, email: user.email }, returnTo);
  } catch (error) {
    log("warn", "verification_email_not_sent", { error: errorFacts(error) });
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
    new GatewayError(400, "invalid_request", "This verification link is not valid any more. Send a new one from the console.");
  if (!claims) throw invalid();
  const person = "id = ?1 AND email = ?2 AND kind = 'human'";
  const [, verified, owned] = await env.DB.batch([
    env.DB.prepare(`UPDATE mgmt_user SET email_verified = 1, updated_at = ?3 WHERE ${person} AND email_verified = 0`)
      .bind(claims.u, claims.e, nowMs),
    env.DB.prepare(`SELECT id FROM mgmt_user WHERE ${person} AND email_verified = 1`).bind(claims.u, claims.e),
    env.DB.prepare("SELECT organization_id FROM mgmt_organization_user WHERE user_id = ?1 AND role = 'owner'").bind(claims.u),
  ]);
  if ((verified?.results.length ?? 0) === 0) throw invalid();
  for (const row of (owned?.results ?? []) as { organization_id: string }[]) invalidateAccountStanding(row.organization_id);
  return { email: claims.e, returnTo: claims.r ?? null };
}
