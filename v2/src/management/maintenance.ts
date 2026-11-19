/**
 * The sign-in library's hourly clean-up: expired browser approvals (OAuth
 * consents and CLI device codes) and the tokens of ended OAuth connections.
 * Loaded by the scheduled handler only, like the rest of the management code.
 */
import { createIdentity } from "../auth/identity.ts";
import { consoleOrigin } from "../auth/settings.ts";

export async function sweepSignIn(env: Env): Promise<{ oauth: boolean }> {
  // The origin only names cookies and callbacks nothing here issues; the
  // sweeps read neither. The OAuth sweep is bound to the configured issuer.
  const identity = await createIdentity(env, consoleOrigin(env) ?? "https://maintenance.invalid");
  if (identity.config.operations.enabled) await identity.operations.sweep();
  if (identity.config.oauth !== null) await identity.oauth.sweep();
  return { oauth: identity.config.oauth !== null };
}
