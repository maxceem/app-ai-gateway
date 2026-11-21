/**
 * What a failed sign-in tells the person to do next.
 *
 * Every hint says to run the same command again, in those words. It never
 * rebuilds the command: until a sign-in succeeds its gateway is not stored,
 * so a rebuilt `agw account login` could reach another gateway than the one
 * `agw deployment connect --url …` was signing in to, and quoting a URL that
 * pastes the same in every shell is not possible.
 */

import { CliError, LocalDirectoryError, LocalStateError } from "./common.ts";

export const AGAIN = "Run the same command again.";
export const START_OVER = "Run the same command again to start over.";
/** After a browser sign-in, when the gateway also offers sign-in with a code. */
export const AGAIN_OR_CODE = "Run the same command again, or add --device to sign in with a code.";
export const NEW_CODE = "Run the same command again for a new code.";

/**
 * For a gateway that offers no sign-in with a code. Another machine has no
 * stored gateway, so the hint names it: the address is on its own line, as
 * plain text, rather than inside a command that would need quoting.
 */
export function onBrowserMachine(url: string): string {
  return `On a machine with a browser, run agw deployment connect --url with this gateway's address:\n${url}`;
}

/** Moving an unreadable or unsafe connection state file aside, then signing in again. */
export function recoverState(gateway: string | null): string {
  if (gateway)
    return `Move the connection state file aside, then run agw deployment connect --url with this gateway's address:\n${gateway}`;
  return "Move the connection state file aside, then run the same command again.";
}

/**
 * A failure during a sign-in, with a next step that never sends the person to
 * another gateway. The sign-in's own failures already say what to do; this
 * replaces only the hints that come from the status or the connection.
 *
 * The HTTP status decides first, whatever the body said: a 403 with
 * `access_denied` is still about access, a 429 says to wait a moment, and a
 * 503 with `connection_failed` still means the gateway is not available yet.
 * Only without a deciding status do the codes count. The status changes only
 * the hint: the error code and the exit code stay as the failure set them.
 *
 * `gateway` is the self-hosted gateway the sign-in was for, when it is known:
 * after the state file is moved aside, the same command would no longer find
 * it, so the hint names it.
 */
export function signInFailure(error: unknown, gateway: string | null = null): unknown {
  if (!(error instanceof CliError)) return error;
  // A state directory that is not the person's own: its own hint names the directory.
  if (error instanceof LocalDirectoryError) return error;
  const status = error.details?.status;
  let next: string | null = null;
  if (status === 401 || status === 403) next = "Fix access to the gateway, then run the same command again.";
  else if (status === 429) next = "Wait a moment, then run the same command again.";
  else if (typeof status === "number" && status >= 500)
    next = "Wait until the gateway is available, then run the same command again.";
  else if (error.code === "connection_failed") next = "Check connectivity and the URL, then run the same command again.";
  else if (error.code === "redirect_refused") next = "Fix the gateway's address, then run the same command again.";
  // Only this machine's own storage, never a gateway's answer.
  else if (error instanceof LocalStateError) next = recoverState(gateway);
  if (next === null) return error;
  const replaced = new CliError(error.code, error.message, next, error.exitCode, error.details);
  if (error.headers) replaced.headers = error.headers;
  return replaced;
}
