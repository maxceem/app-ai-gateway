import { identityAuthFor, relaySocialSignIn } from "../../auth/identity";
import { GatewayError } from "../../core/errors";
import { handoffKind } from "./handoff-kinds";
import { derive, digest, proofMatches } from "./security";
import { deploymentMeta } from "./bootstrap";
import { browserPath } from "./operations";
import { verifiedSubmission } from "./browser";
import type { CliContext } from "./types";
export const CLAIM_OAUTH_COOKIE = "cli_claim_oauth";

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
    const data = JSON.parse(atob(encoded!)) as { id: string; expires: number };
    if (
      !data.id ||
      !Number.isSafeInteger(data.expires) ||
      data.expires <= Date.now() ||
      data.expires > Date.now() + 15 * 60000
    )
      return false;
    const expected = await derive(env.BETTER_AUTH_SECRET, `claim-oauth:${encoded}`);
    if (!(await proofMatches(signature, await digest(expected)))) return false;
    const row = await env.DB.prepare(
      "SELECT id FROM mgmt_handoff WHERE id=? AND kind='claim' AND consumed_at IS NULL AND expires_at>?",
    )
      .bind(data.id, Date.now())
      .first();
    return Boolean(row);
  } catch {
    return false;
  }
}
export async function browserGoogle(c: CliContext): Promise<Response> {
  const { row } = await verifiedSubmission(c);
  if (handoffKind(row.kind).view !== "claim" || row.consumed_at)
    throw new GatewayError(403, "forbidden", "Google registration requires a pending claim");
  const meta = deploymentMeta(c);
  const encoded = btoa(JSON.stringify({ id: row.id, expires: row.expires_at }));
  const signature = await derive(c.env.BETTER_AUTH_SECRET, `claim-oauth:${encoded}`);
  const rawResult = await identityAuthFor(c, { claimRegistration: true }).auth.api.signInSocial({
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
    `${CLAIM_OAUTH_COOKIE}=${encoded}.${signature}; Path=/v1/auth/callback/google; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((row.expires_at - Date.now()) / 1000))}${meta.consoleOrigin.startsWith("https:") ? "; Secure" : ""}`,
  );
  return new Response(relayed.body, { status: relayed.status, headers });
}
