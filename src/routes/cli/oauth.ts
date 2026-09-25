import { z } from "zod";
import { identityAuthFor, relaySocialSignIn } from "../../auth/identity";
import { GatewayError } from "../../core/errors";
import { derive, digest, proofMatches } from "./security";
import { browserPath, deploymentMeta } from "./operations";
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
    const row = await env.DB.prepare(
      "SELECT id FROM mgmt_operation WHERE id=? AND kind='claim' AND state='pending' AND expires_at>?",
    )
      .bind(data.id, Date.now())
      .first();
    return Boolean(row);
  } catch {
    return false;
  }
}
export async function browserGoogle(c: CliContext): Promise<Response> {
  const { row } = await relayedSubmission(c, CliBrowserProofSchema);
  if (row.family !== "claim" || row.state !== "pending")
    throw new GatewayError(403, "forbidden", "Google registration requires a pending claim");
  const meta = deploymentMeta(c);
  const encoded = btoa(JSON.stringify({ id: row.id, expires: row.expiresAt }));
  const signature = await derive(c.env.BETTER_AUTH_SECRET, `claim-oauth:${encoded}`);
  const rawResult = await (await identityAuthFor(c, { claimRegistration: true })).auth.api.signInSocial({
    body: {
      provider: "google",
      callbackURL: `${meta.consoleOrigin}${browserPath(row.id)}`,
      // A refusal — a declined consent, or an email that already signs in with
      // a password, which is never linked to a Google login — belongs back on
      // the approval page, where the claim can still be finished with a
      // password. Without this Better Auth sends the browser to its own error
      // document on the gateway, which says nothing and leads nowhere.
      errorCallbackURL: `${meta.consoleOrigin}${browserPath(row.id)}`,
    },
    headers: c.req.raw.headers,
    asResponse: true,
  });
  const relayed = await relaySocialSignIn(c.env, c.req.url, rawResult);
  const headers = new Headers(relayed.headers);
  headers.append(
    "Set-Cookie",
    `${CLAIM_OAUTH_COOKIE}=${encoded}.${signature}; Path=/v1/auth/callback/google; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((row.expiresAt - Date.now()) / 1000))}${meta.consoleOrigin.startsWith("https:") ? "; Secure" : ""}`,
  );
  return new Response(relayed.body, { status: relayed.status, headers });
}
