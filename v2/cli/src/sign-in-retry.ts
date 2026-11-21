/**
 * What a failed sign-in tells the person to do next.
 *
 * Every hint says to run the same command again, in those words. It never
 * rebuilds the command: until a sign-in succeeds its gateway is not stored,
 * so a rebuilt `agw account login` could reach another gateway than the one
 * `agw deployment connect --url …` was signing in to, and quoting a URL that
 * pastes the same in every shell is not possible.
 */

import { CliError } from "./common.ts";

/** Run the same command again. */
export const AGAIN = "Run the same command again.";

/** The hints one sign-in gives. */
export class SignInRetry {
  /** The person asked for a code (`--device` or `--no-open`). */
  private readonly usedCode: boolean;
  /** Whether the gateway offers sign-in with a code; unknown counts as yes. */
  private readonly deviceAvailable: boolean;

  constructor(usedCode = false, deviceAvailable = true) {
    this.usedCode = usedCode;
    this.deviceAvailable = deviceAvailable;
  }

  /** The same sign-in, for a gateway whose code endpoint is now known. */
  withDevice(available: boolean): SignInRetry {
    return new SignInRetry(this.usedCode, available);
  }

  /** The same sign-in, now with a code: `--device` is no longer offered. */
  asCode(): SignInRetry {
    return new SignInRetry(true, this.deviceAvailable);
  }

  again(): string {
    return AGAIN;
  }

  startOver(): string {
    return "Run the same command again to start over.";
  }

  /** Run it again, offering `--device` where the gateway has it and it was not used. */
  againOrCode(): string {
    return this.deviceAvailable && !this.usedCode ? "Run the same command again, or add --device to sign in with a code." : AGAIN;
  }

  newCode(): string {
    return "Run the same command again for a new code.";
  }

  /**
   * For a gateway that offers no sign-in with a code. Another machine has no
   * stored gateway, so the hint names it: the address is on its own line, as
   * plain text, rather than inside a command that would need quoting.
   */
  onBrowserMachine(url: string): string {
    return `On a machine with a browser, run agw deployment connect --url with this gateway's address:\n${url}`;
  }
}

/** The default for code that starts a sign-in on its own. */
export const ACCOUNT_LOGIN = new SignInRetry();

/**
 * A failure during a sign-in, with a next step that never sends the person to
 * another gateway. Specific guidance (a v1 gateway, a wrong URL) is kept; a
 * generic one, or one that names `agw account login`, becomes "run the same
 * command again".
 */
export function signInFailure(error: unknown): unknown {
  if (!(error instanceof CliError)) return error;
  const status = error.details?.status;
  let next: string | null = null;
  if (error.code === "connection_failed") next = "Check connectivity and the URL, then run the same command again.";
  else if (error.code === "redirect_refused") next = "Fix the gateway's address, then run the same command again.";
  else if (error.code === "invalid_state" || error.code === "unsafe_storage")
    next = "Move the connection state file aside, then run the same command again.";
  // Picked from the status, whatever the body was: an HTML page from a proxy
  // in front of the gateway says as much as the gateway's own JSON.
  else if (status === 401 || status === 403) next = "Fix access to the gateway, then run the same command again.";
  else if (typeof status === "number" && status >= 500)
    next = "Wait until the gateway is available, then run the same command again.";
  else if (/agw account login|agw --help/.test(error.nextAction)) next = AGAIN;
  if (next === null) return error;
  const replaced = new CliError(error.code, error.message, next, error.exitCode, error.details);
  if (error.headers) replaced.headers = error.headers;
  return replaced;
}
