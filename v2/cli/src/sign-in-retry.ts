/**
 * What a failed sign-in tells the person to run next.
 *
 * Until a sign-in succeeds, its target gateway is not stored. So the hint
 * names the exact command that started the sign-in, with its own flags:
 * a plain `agw account login` could reach another gateway than the one
 * `agw deployment connect --url …` was signing in to.
 */

/** The command that started a sign-in, and the flags it was run with. */
export interface SignInStart {
  command: "account login" | "deployment connect";
  /** `deployment connect` only: the gateway's origin. */
  url?: string;
  /** `deployment connect --cloud`. */
  cloud?: boolean;
  /** `--device` was given. */
  device?: boolean;
  /** `--no-open` was given. */
  noOpen?: boolean;
}

/**
 * A value pasted into a shell as one word. A value with only characters no
 * shell treats specially is left as it is. Anything else is put in double
 * quotes, which zsh, bash and Windows `cmd.exe` all read the same way, so a
 * URL such as `http://[::1]:8787` is not read as a pattern. A value holding a
 * character double quotes don't protect everywhere (`" $ \` ! %`) falls back
 * to POSIX single quotes; a gateway origin never holds one.
 */
export function shellWord(value: string): string {
  if (/^[A-Za-z0-9_@+=:,./-]+$/.test(value)) return value;
  if (!/["$\\`!%]/.test(value)) return `"${value}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command as it was run. `browser` drops `--device` and `--no-open`, for a
 * gateway that offers no sign-in with a code.
 */
function commandLine(start: SignInStart, browser = false): string {
  const words = ["agw", start.command];
  if (start.command === "deployment connect") {
    if (start.cloud) words.push("--cloud");
    else if (start.url) words.push("--url", shellWord(start.url));
  }
  if (!browser && start.device) words.push("--device");
  if (!browser && start.noOpen) words.push("--no-open");
  return words.join(" ");
}

/** The hints one sign-in gives, all naming the command that started it. */
export class SignInRetry {
  readonly start: SignInStart;
  /** Whether the gateway offers sign-in with a code; unknown counts as yes. */
  private readonly deviceAvailable: boolean;

  constructor(start: SignInStart, deviceAvailable = true) {
    this.start = start;
    this.deviceAvailable = deviceAvailable;
  }

  /** The same sign-in, for a gateway whose code endpoint is now known. */
  withDevice(available: boolean): SignInRetry {
    return new SignInRetry(this.start, available);
  }

  /**
   * The same sign-in as a sign-in with a code, for the hints of the device
   * flow: it keeps `--device` or `--no-open`, or adds `--device`, so running
   * the hint again asks for a new code instead of opening a browser.
   */
  asCode(): SignInRetry {
    const device = this.start.device || !this.start.noOpen;
    return new SignInRetry({ ...this.start, device }, this.deviceAvailable);
  }

  /** The command as it was run. */
  get command(): string {
    return commandLine(this.start);
  }

  /** Rerun the same command. */
  again(): string {
    return `Run ${this.command} again.`;
  }

  /** Rerun the same command, from the start. */
  startOver(): string {
    return `Run ${this.command} again to start over.`;
  }

  /**
   * Rerun the same command, offering `--device` where it would help: the
   * gateway has a code endpoint and the person did not already ask for it.
   */
  againOrCode(): string {
    const offer = this.deviceAvailable && !this.start.device && !this.start.noOpen;
    return offer ? `Run ${this.command} again, or add --device to sign in with a code.` : this.again();
  }

  /** Rerun the same command, for a new code. */
  newCode(): string {
    return `Run ${this.command} again for a new code.`;
  }

  /** Rerun in a browser, for a gateway that offers no sign-in with a code. */
  onBrowserMachine(): string {
    return `Run ${commandLine(this.start, true)} on a machine with a browser.`;
  }
}

/** The default for code that starts a sign-in on its own: `agw account login`. */
export const ACCOUNT_LOGIN = new SignInRetry({ command: "account login" });
