/**
 * One command's view of this machine and the selected gateway: the stored
 * connection, the credential every request carries, and signing in and out.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { OperationResponse } from "../../src/contracts/catalog.ts";
import { GatewayClient, type CallOptions, type CallResult, type OperationName } from "./client.ts";
import { CLOUD, fail, MANAGEMENT_KEY_ENV, origin, VERSION } from "./common.ts";
import { browserAvailable, listenLoopback, type Loopback } from "./login.ts";
import type { OutputSink } from "./main.ts";
import {
  authorizeUrl,
  deviceLogin,
  discover,
  exchangeCode,
  pkce,
  refresh,
  revoke,
  type DeviceClock,
  type DevicePrompt,
  type OAuthServer,
  type OAuthTransport,
} from "./oauth.ts";
import type { Flags } from "./parser.ts";
import type { ActiveConnection, CliState, OAuthLogin, StateStore } from "./state.ts";
import { styleFor } from "./style.ts";

export type { CallOptions, CallResult, OperationName };

/** How long a browser sign-in is waited for. */
const LOGIN_TIMEOUT_MS = 300_000;
/** An access token this close to its end is renewed before it is sent. */
const RENEW_EARLY_MS = 60_000;

/** What the context reaches outside itself for; replaced in tests. */
export interface ContextIo {
  stderr: OutputSink;
  /** Resolves false when no browser could be started. */
  openBrowser(url: string): Promise<boolean>;
  /** Whether a browser opened here would be in front of the person at this terminal. */
  browserAvailable(): boolean;
  listen(state: string): Promise<Loopback>;
  env: Record<string, string | undefined>;
  /** The device flow's clock, and the clock tokens expire by. */
  clock: DeviceClock;
}

const defaultIo = (): ContextIo => ({
  stderr: process.stderr,
  openBrowser,
  browserAvailable: () => browserAvailable(),
  listen: listenLoopback,
  env: process.env,
  clock: { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
});

/** The subset of a state store the context uses; the real one is `state.ts`. */
export type ContextStore = Pick<StateStore, "update" | "keyOutput">;

/**
 * Something a command wants the person running it to know without it being
 * the command's answer: printed to stderr as it happens, and carried in the
 * `--json` envelope as `notices`.
 */
export interface Notice {
  code: "newer_gateway";
  message: string;
  /** Where in the documents involved the notice applies. */
  paths?: string[];
}

const NOTICE_PATHS = 5;

/** A notice as a terminal shows it: the message, then the settings it names. */
export function noticeText(notice: Notice, style: Pick<ReturnType<typeof styleFor>, "warn" | "dim">): string {
  const paths = notice.paths ?? [];
  const shown = paths.slice(0, NOTICE_PATHS).join(", ");
  const more = paths.length > NOTICE_PATHS ? ` and ${paths.length - NOTICE_PATHS} more` : "";
  return `${style.warn(`Note: ${notice.message}`)}\n${paths.length ? `${style.dim(`  Settings: ${shown}${more}`)}\n` : ""}`;
}

/** What `account login` and `deployment connect` answer with. */
export interface LoginResult {
  connected: true;
  url: string;
  /** How this CLI is signed in: its own OAuth sign-in, or the environment's key. */
  credential: "oauth" | "environment";
  user: { id: string; email: string | null; name: string | null };
  account: { id: string; name: string };
  role: string;
  grant: string;
}

export interface LogoutResult {
  loggedOut: true;
  /** Whether the gateway accepted the revocation; the sign-in is forgotten here either way. */
  revoked: boolean;
}

export class Context {
  readonly store: ContextStore;
  state: CliState;
  readonly client: GatewayClient;
  readonly transport: OAuthTransport;
  readonly flags: Flags;
  readonly io: ContextIo;
  readonly notices: Notice[] = [];

  constructor(store: ContextStore, state: CliState, transport: OAuthTransport, flags: Flags, io: Partial<ContextIo> = {}) {
    this.store = store;
    this.state = state;
    this.transport = transport;
    this.flags = flags;
    this.io = { ...defaultIo(), ...io };
    this.client = new GatewayClient(transport, {
      url: () => this.url,
      credential: () => this.credential(),
      environmentKey: () => this.environmentKey,
    });
  }

  get active(): ActiveConnection | null {
    return this.state.active;
  }

  get url(): string {
    return this.active?.url || CLOUD;
  }

  /** `AGW_MANAGEMENT_KEY`, when it is set to anything. */
  get environmentKey(): string | undefined {
    const value = this.io.env[MANAGEMENT_KEY_ENV]?.trim();
    return value ? value : undefined;
  }

  /**
   * The credential every call carries: the environment's key, which always
   * wins, or the stored sign-in's access token, renewed first when it is
   * about to expire.
   */
  async credential(): Promise<string | undefined> {
    if (this.environmentKey) return this.environmentKey;
    const login = this.active?.login;
    if (!login) return undefined;
    if (Date.parse(login.expiresAt) - this.io.clock.now() > RENEW_EARLY_MS) return login.accessToken;
    return this.renew(login);
  }

  /**
   * Renews the access token under the state lock. Another command may have
   * renewed it meanwhile: then its new token is used, and the one-use refresh
   * token this command holds is never presented again.
   */
  private async renew(stale: OAuthLogin): Promise<string> {
    const url = this.url;
    const { state, result } = await this.store.update(async (disk) => {
      const current = disk.active?.url === url ? disk.active.login : undefined;
      if (!current) return null;
      if (current.refreshToken !== stale.refreshToken && Date.parse(current.expiresAt) - this.io.clock.now() > RENEW_EARLY_MS)
        return current.accessToken;
      const renewed = await refresh(this.transport, url, current, () => this.io.clock.now());
      if (!renewed) {
        // Revoked, expired or already used: nothing it holds works any more.
        delete disk.active!.login;
        return null;
      }
      disk.active!.login = renewed;
      return renewed.accessToken;
    });
    this.state = state;
    if (result === null)
      fail("login_required", "This CLI's sign-in has ended.", `Run agw account login, or set ${MANAGEMENT_KEY_ENV}.`, 4);
    return result;
  }

  /** One documented operation, sent with only the credential `options` names. */
  async publicCall<K extends OperationName>(name: K, options: CallOptions<K> = {}): Promise<CallResult<OperationResponse<K>>> {
    return this.noticed(await this.client.publicCall(name, options));
  }

  /** The same call, with the selected credential attached. */
  async call<K extends OperationName>(name: K, options: CallOptions<K> = {}): Promise<CallResult<OperationResponse<K>>> {
    return this.noticed(await this.client.call(name, options));
  }

  /**
   * Says, once per run, that the gateway answered with settings this release
   * does not know. Later answers add their paths to the same notice.
   */
  private noticed<T>(result: CallResult<T>): CallResult<T> {
    if (!result.newer?.length) return result;
    const existing = this.notices.find((notice) => notice.code === "newer_gateway");
    if (existing) {
      const paths = (existing.paths ??= []);
      for (const path of result.newer) if (!paths.includes(path)) paths.push(path);
      return result;
    }
    this.notice({
      code: "newer_gateway",
      message: `This gateway is newer than agw ${VERSION} and has settings this agw does not understand. They are kept unchanged when agw saves, but are not explained or checked. Update agw: npm install -g @maxceem/agw`,
      paths: [...result.newer],
    });
    return result;
  }

  /** Records a notice, and prints it to stderr unless stdout is one `--json` document. */
  notice(notice: Notice): void {
    this.notices.push(notice);
    if (this.flags.json) return;
    this.io.stderr.write(noticeText(notice, styleFor(this.io.stderr)));
  }

  /** A line for the person at the terminal, on stderr whatever the output mode. */
  say(line: string): void {
    this.io.stderr.write(line + "\n");
  }

  /** Refuses a sign-in the environment's key would override on every command. */
  private assertNoEnvironmentKey(): void {
    if (this.environmentKey)
      fail(
        "environment_credential",
        `${MANAGEMENT_KEY_ENV} is set, so it is the credential for every command and a stored sign-in would never be used.`,
        `Unset ${MANAGEMENT_KEY_ENV} to sign in, or keep using it as it is.`,
        4,
      );
  }

  /** Who the credential is, as the gateway says. */
  private async whoAmI(url: string, key: string): Promise<Omit<LoginResult, "connected" | "url" | "credential">> {
    const { data } = await this.publicCall("getAdminSession", { url, key });
    const { user, account, role, grant } = data.session;
    return { user: { id: user.id, email: user.email, name: user.name }, account, role, grant };
  }

  /**
   * `account login`: signs this CLI in to `url` through the gateway's OAuth
   * server, and stores the sign-in. A browser on this machine is used when
   * there is one; otherwise, or with `--device`, a link and a short code that
   * any browser can approve.
   */
  async login(url: string = this.url): Promise<LoginResult> {
    this.assertNoEnvironmentKey();
    const target = origin(url);
    const server = await discover(this.transport, target);
    const useBrowser = !this.flags.device && !this.flags["no-open"] && this.io.browserAvailable();
    const login = useBrowser ? await this.browserLogin(target, server) : await this.deviceSignIn(target, server);
    const who = await this.whoAmI(target, login.accessToken);
    const { state } = await this.store.update((disk) => {
      disk.active = { url: target, login, account: who.account };
    });
    this.state = state;
    return { connected: true, url: target, credential: "oauth", ...who };
  }

  /** The authorization code with PKCE, back to a listener on this machine. */
  private async browserLogin(url: string, server: OAuthServer): Promise<OAuthLogin> {
    const { verifier, challenge } = pkce();
    const state = randomBytes(24).toString("base64url");
    const loopback = await this.io.listen(state);
    try {
      const address = authorizeUrl(url, server, { redirect: loopback.redirect, challenge, state, grant: "manage" });
      if (!(await this.io.openBrowser(address))) {
        // Only a browser here could finish this one, so a code takes its place.
        this.say("The browser could not be opened, so sign in with a code instead.");
        await loopback.close();
        return await this.deviceSignIn(url, server);
      }
      this.say(`Approve the sign-in in your browser. If it did not open, go to:\n${address}`);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          LOGIN_TIMEOUT_MS,
        );
        timer.unref();
      });
      let answer;
      try {
        answer = await Promise.race([loopback.callback, timeout]);
      } catch {
        fail("login_expired", "The sign-in was not approved in time.", "Run agw account login again, or add --device to sign in with a code.", 4);
      } finally {
        clearTimeout(timer);
      }
      if ("error" in answer) {
        loopback.answer(false);
        if (answer.error === "access_denied") fail("login_denied", "The sign-in was declined in the browser.", "Run agw account login again to start over.", 4);
        fail("login_failed", `The gateway refused the sign-in (${answer.error.replace(/\p{C}/gu, " ").slice(0, 80)}).`, "Run agw account login again.", 3);
      }
      // RFC 9207: an answer naming another issuer is not this gateway's.
      if (answer.iss !== null && answer.iss !== server.issuer) {
        loopback.answer(false);
        fail("login_failed", "The sign-in came back from another issuer than this gateway.", "Run agw account login again.", 3);
      }
      try {
        const login = await exchangeCode(this.transport, url, server, { code: answer.code, redirect: loopback.redirect, verifier }, () => this.io.clock.now());
        loopback.answer(true);
        return login;
      } catch (error) {
        loopback.answer(false);
        throw error;
      }
    } finally {
      await loopback.close();
    }
  }

  /** The device flow, with its code shown on stderr. */
  private deviceSignIn(url: string, server: OAuthServer): Promise<OAuthLogin> {
    const style = styleFor(this.io.stderr);
    return deviceLogin(
      this.transport,
      url,
      server,
      "manage",
      (prompt: DevicePrompt) => {
        this.say(
          [
            `To sign in, open ${prompt.verificationUri} in any browser and enter the code:`,
            `  ${style.headline(prompt.userCode)}`,
            ...(prompt.verificationUriComplete ? [`Or open: ${prompt.verificationUriComplete} and check it shows the same code.`] : []),
            `The code works for ${Math.round(prompt.expiresIn / 60)} minutes. Waiting for approval…`,
          ].join("\n"),
        );
      },
      this.io.clock,
    );
  }

  /**
   * `deployment connect`: selects a gateway. With the environment's key set,
   * it checks the key there and stores no credential; otherwise it signs in.
   */
  async connect(url: string): Promise<LoginResult> {
    const target = origin(url);
    if (!this.environmentKey) return this.login(target);
    const who = await this.whoAmI(target, this.environmentKey);
    const { state } = await this.store.update((disk) => {
      disk.active = { url: target, account: who.account };
    });
    this.state = state;
    this.say(`${MANAGEMENT_KEY_ENV} is set, so it stays the credential for every command; nothing was stored.`);
    return { connected: true, url: target, credential: "environment", ...who };
  }

  /** `account logout`: revokes this CLI's sign-in and forgets it. */
  async logout(): Promise<LogoutResult> {
    const url = this.url;
    const { state, result: login } = await this.store.update((disk) => {
      const held = disk.active?.url === url ? disk.active.login : undefined;
      if (disk.active) delete disk.active.login;
      return held;
    });
    this.state = state;
    if (!login) return { loggedOut: true, revoked: false };
    let revoked = false;
    try {
      revoked = await revoke(this.transport, url, login);
    } catch {
      // Forgotten here already; an unrevoked sign-in still ends within its lifetime.
      revoked = false;
    }
    if (!revoked) this.say("The gateway could not be told; the sign-in is forgotten here and ends on its own. You can also revoke it in the console, under Access.");
    return { loggedOut: true, revoked };
  }
}

export async function openBrowser(url: string): Promise<boolean> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
