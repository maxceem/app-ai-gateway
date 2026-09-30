import { z } from "zod";
import { and, eq, gt } from "drizzle-orm";
import { identityAuthFor, relaySocialSignIn } from "../../auth/identity";
import { database } from "../../db";
import { mgmtOperation } from "../../db/schema";
import { GatewayError } from "../../core/errors";
import { deploymentMeta } from "../../management/deployment-meta";
import { derive, digest, proofMatches } from "./security";
import { browserPath } from "../../management/operation-links";
import { relayedSubmission } from "./browser";
import { CliBrowserProofSchema } from "../../contracts/cli";
import type { CliContext } from "./types";
export const CLAIM_OAUTH_COOKIE = "cli_claim_oauth";

/** What the claim's OAuth cookie signs: the pending claim, and when the cookie stops counting. */
const ClaimOAuthCookieSchema = z.object({ id: z.string().min(1), expires: z.number().int() });

export async function claimOAuthAuthorized(env: Env, request: Request): Promise<boolean> {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(CLAIM_OAUTH_COOKIE + "="))
    ?.slice(CLAIM_OAUTH_COOKIE.length + 1);
  if (!raw) return false;
  try {
    const [encoded, signature] = raw.split(".");
    if (encoded === undefined) return false;
    const parsed = ClaimOAuthCookieSchema.safeParse(JSON.parse(atob(encoded)));
    if (!parsed.success) return false;
    const data = parsed.data;
    if (data.expires <= Date.now() || data.expires > Date.now() + 15 * 60000) return false;
    const expected = await derive(env.BETTER_AUTH_SECRET, `claim-oauth:${encoded}`);
    if (!(await proofMatches(signature, await digest(expected)))) return false;
    // Asked of the row directly, because it is asked on every Google callback
    // that carries the cookie, before the identity instance that serves the
    // callback is chosen. The signature is this server's own, so the id in it
    // was one a proof had already been checked for; all that is left to know
    // is whether that claim is still waiting.
    const row = await database(env.DB)
      .select({ id: mgmtOperation.id })
      .from(mgmtOperation)
      .where(and(
        eq(mgmtOperation.id, data.id),
        eq(mgmtOperation.kind, "claim"),
        eq(mgmtOperation.state, "pending"),
        gt(mgmtOperation.expiresAt, new Date()),
      ))
      .get();
    return row !== undefined;
  } catch {
    return false;
  }
}
export async function browserGoogle(c: CliContext): Promise<Response> {
  const { step } = await relayedSubmission(c, CliBrowserProofSchema);
  const { details } = step;
  if ((step.entry.type !== "claim" && step.entry.type !== "login") || details.state !== "pending")
    throw new GatewayError(403, "forbidden", "Google registration requires a pending claim or login");
  const expiresAt = Date.parse(details.expiresAt);
  const meta = deploymentMeta(c.get("deployment"));
  // A login's approver signs in or registers exactly as on the console's own
  // sign-in page, so it needs no grant: the callback treats it as any other.
  // Only a claim carries the cookie that lets its one person in where
  // registration is closed.
  if (step.entry.type === "login") {
    const started = await (await identityAuthFor(c, { provisionRegistration: true })).auth.api.signInSocial({
      body: {
        provider: "google",
        callbackURL: `${meta.consoleOrigin}${browserPath(details.id)}`,
        errorCallbackURL: `${meta.consoleOrigin}${browserPath(details.id)}`,
      },
      headers: c.req.raw.headers,
      asResponse: true,
    });
    return relaySocialSignIn(c.env, c.req.url, started);
  }
  const encoded = btoa(JSON.stringify({ id: details.id, expires: expiresAt }));
  const signature = await derive(c.env.BETTER_AUTH_SECRET, `claim-oauth:${encoded}`);
  const rawResult = await (await identityAuthFor(c, { claimRegistration: true })).auth.api.signInSocial({
    body: {
      provider: "google",
      callbackURL: `${meta.consoleOrigin}${browserPath(details.id)}`,
      // A refusal — a declined consent, or an email that already signs in with
      // a password, which is never linked to a Google login — belongs back on
      // the approval page, where the claim can still be finished with a
      // password. Without this Better Auth sends the browser to its own error
      // document on the gateway, which says nothing and leads nowhere.
      errorCallbackURL: `${meta.consoleOrigin}${browserPath(details.id)}`,
    },
    headers: c.req.raw.headers,
    asResponse: true,
  });
  const relayed = await relaySocialSignIn(c.env, c.req.url, rawResult);
  const headers = new Headers(relayed.headers);
  headers.append(
    "Set-Cookie",
    `${CLAIM_OAUTH_COOKIE}=${encoded}.${signature}; Path=/v1/auth/callback/google; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))}${meta.consoleOrigin.startsWith("https:") ? "; Secure" : ""}`,
  );
  return new Response(relayed.body, { status: relayed.status, headers });
}
