/**
 * What this CLI keeps on this machine: the selected gateway and its sign-in,
 * in one private file, and the app keys it creates, each in a private file of
 * its own.
 *
 * The file is `<state>/agw/v2/connection.json`, apart from the one agw 1.x
 * writes beside it, so neither release ever reads the other's credential.
 *
 * Every write runs under a lock and starts from what is on disk, because an
 * OAuth refresh token is good for one use only: two commands refreshing at
 * once from the same stale copy would present it twice, and the gateway
 * treats that as a stolen token and ends the sign-in.
 */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { CliError, LocalDirectoryError, LocalStateError, fail, randomToken } from "./common.ts";

/** Whether POSIX ownership and mode bits mean anything here (not on Windows). */
const posixPermissions = (): boolean => process.platform !== "win32";

/** An OAuth sign-in of this CLI: a short-lived access token and a one-use refresh token. */
export const OAuthLoginSchema = z.object({
  /**
   * This sign-in's own id, made when it starts and kept through every
   * renewal, so a command can tell its sign-in from a newer one another
   * command stored in its place.
   */
  id: z.string().min(1),
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** When the access token stops working, as an ISO date. */
  expiresAt: z.string().min(1),
  grant: z.enum(["read", "manage"]),
});
export type OAuthLogin = z.infer<typeof OAuthLoginSchema>;

export const ActiveConnectionSchema = z.object({
  /** The gateway's console origin, which every request goes to. */
  url: z.string().min(1),
  login: OAuthLoginSchema.optional(),
  /** The account the sign-in acts in, as the gateway last said. */
  account: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type ActiveConnection = z.infer<typeof ActiveConnectionSchema>;

export const CliStateSchema = z.object({
  schemaVersion: z.literal(1),
  active: ActiveConnectionSchema.nullable(),
});
export type CliState = z.infer<typeof CliStateSchema>;

export const emptyState = (): CliState => ({ schemaVersion: 1, active: null });

export function stateDirectory(): string {
  if (platform() === "win32") return join(process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local"), "agw", "v2");
  return join(process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state"), "agw", "v2");
}

/** Where reproducible things live, such as the gateway's tool list. */
export function cacheDirectory(): string {
  if (platform() === "win32") return join(process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local"), "agw", "v2", "cache");
  return join(process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "agw", "v2");
}

export async function protectedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  // Moving the state file aside would not help here, so the hint names the directory itself.
  const replace = `Replace this directory with a private directory you own, then run the same command again:\n${path}`;
  if (!s.isDirectory() || s.isSymbolicLink())
    throw new LocalDirectoryError("unsafe_storage", "CLI storage must be a real directory.", replace, 4);
  if (!posixPermissions()) return;
  if (process.getuid && s.uid !== process.getuid())
    throw new LocalDirectoryError("unsafe_storage", "CLI storage belongs to another user.", replace, 4);
  await chmod(path, 0o700);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/** Longer than a token request may take (30 s), since a renewal holds the lock across one. */
const LOCK_TIMEOUT_MS = 45_000;
/** A lock older than this was left by a command that died; no write takes that long. */
const LOCK_STALE_MS = 60_000;

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** Removes a lock its owner can no longer be inside: a dead process on this host, or an old file. */
async function breakAbandonedLock(path: string): Promise<boolean> {
  const held = await lstat(path).catch(() => null);
  if (!held) return true;
  let owner: { pid?: unknown; host?: unknown } = {};
  try {
    owner = JSON.parse(await readFile(path, "utf8")) as typeof owner;
  } catch {
    // Judged by its age alone.
  }
  const dead = typeof owner.pid === "number" && owner.host === hostname() && !running(owner.pid);
  if (!dead && Date.now() - held.mtimeMs <= LOCK_STALE_MS) return false;
  const current = await lstat(path).catch(() => null);
  if (current && current.ino === held.ino && current.mtimeMs === held.mtimeMs) await unlink(path).catch(() => {});
  return true;
}

// The file that held the selected gateway cannot be read, so its address is
// unknown here: the hint covers both kinds of gateway rather than sending a
// self-hosted user to the hosted one.
const RECOVER_STATE =
  "Move the connection state file aside. For a self-hosted gateway, then run agw deployment connect --url with its address; for the hosted one, run the same command again.";

/**
 * For `account logout`: moving the state file aside would hide its sign-in,
 * which would then never be revoked. So the hint repairs the file, or ends
 * the sign-in from the console. A directory failure keeps its own hint.
 */
export function logoutStateFailure(error: unknown, store: object): unknown {
  if (!(error instanceof LocalStateError) || error instanceof LocalDirectoryError) return error;
  const path = "path" in store && typeof store.path === "string" ? store.path : "the connection state file";
  return new LocalStateError(
    error.code,
    error.message,
    `Restore the file's mode to 0600 (chmod 600 ${path}), then run agw account logout again. If the file cannot be recovered, revoke the sign-in in the console under Access.`,
    error.exitCode,
    error.details,
  );
}

/** A failure of this machine's own storage, tagged so sign-in hints can tell it from a gateway's answer. */
function stateFail(code: string, message: string, nextAction?: string, exitCode?: number): never {
  throw new LocalStateError(code, message, nextAction, exitCode);
}

export class StateStore {
  readonly directory: string;
  readonly path: string;
  private readonly lockPath: string;

  constructor(directory: string = stateDirectory()) {
    this.directory = directory;
    this.path = join(directory, "connection.json");
    this.lockPath = join(directory, "connection.lock");
  }

  /** The state on disk, or an empty one when there is no file. A file that cannot be read is refused. */
  async read(): Promise<CliState> {
    const held = await lstat(this.path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      stateFail("invalid_state", "Cannot read the connection state.", RECOVER_STATE, 4);
    });
    if (!held) return emptyState();
    if (
      !held.isFile() ||
      held.isSymbolicLink() ||
      (posixPermissions() && ((process.getuid && held.uid !== process.getuid()) || (held.mode & 0o077) !== 0))
    )
      stateFail("unsafe_storage", "The connection state must be a file owned by you with mode 0600.", RECOVER_STATE, 4);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      stateFail("invalid_state", "The connection state is not readable JSON.", RECOVER_STATE, 4);
    }
    const state = CliStateSchema.safeParse(parsed);
    if (!state.success) stateFail("invalid_state", "The connection state has a shape this agw does not know.", RECOVER_STATE, 4);
    return state.data;
  }

  /**
   * Changes the state under the lock: `change` gets what is on disk now, and
   * whatever it leaves is written back. What it returns is returned.
   */
  async update<T>(change: (state: CliState) => Promise<T> | T): Promise<{ state: CliState; result: T }> {
    return this.locked(async () => {
      const state = await this.read();
      const result = await change(state);
      await this.persist(state);
      return { state, result };
    });
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await protectedDirectory(this.directory);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let handle: FileHandle | undefined;
    while (!handle) {
      try {
        handle = await open(this.lockPath, "wx", 0o600);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (await breakAbandonedLock(this.lockPath)) continue;
        if (Date.now() > deadline)
          fail(
            "state_locked",
            "Another agw command is writing the connection state.",
            "Run the command again. If it keeps failing, check the PID in connection.lock before removing that file.",
            4,
          );
        await delay(50);
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }));
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await unlink(this.lockPath).catch(() => {});
    }
  }

  private async persist(state: CliState): Promise<void> {
    const temp = `${this.path}.${randomToken().slice(0, 12)}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state, null, 2) + "\n");
      await handle.sync();
      await handle.close();
      await rename(temp, this.path);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  /**
   * A private file holding a browser step's link, whose fragment is the
   * page's proof: printed, it would reach terminal logs. Returns its path.
   */
  async handoffFile(id: string, url: string): Promise<string> {
    const dir = join(this.directory, "handoffs");
    await protectedDirectory(dir);
    const name = /^[A-Za-z0-9._-]{1,128}$/u.test(id) ? id : randomToken().slice(0, 16);
    const path = join(dir, `${name}.url`);
    await unlink(path).catch(() => {});
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(url + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return path;
  }

  /**
   * A new private file for an app key: the path given, or a fresh one under
   * `app-keys/`. Created now, empty and exclusive, before the key exists, so
   * a path that is taken or unwritable fails before anything is created.
   */
  async keyOutput(path: string | undefined): Promise<KeyOutput> {
    if (path) return reserveKeyFile(resolve(path));
    const dir = join(this.directory, "app-keys");
    await protectedDirectory(dir);
    return reserveKeyFile(join(dir, `${randomToken().slice(0, 16)}.key`));
  }
}

/** A key file reserved before its key exists. */
export interface KeyOutput {
  readonly path: string;
  write(text: string): Promise<void>;
  /** Removes the file, if nothing was written to it. */
  cancel(): Promise<void>;
}

async function reserveKeyFile(path: string): Promise<KeyOutput> {
  let handle: FileHandle | null;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail(
      "output_unavailable",
      `Cannot create ${path}: it exists, or its folder is not writable.`,
      "Choose a new --key-output path; no existing file is ever overwritten.",
      4,
    );
  }
  let written = false;
  return {
    path,
    async write(text) {
      if (!handle) throw new Error("The key file is closed");
      await handle.writeFile(text);
      await handle.sync();
      await handle.close();
      handle = null;
      written = true;
    },
    async cancel() {
      await handle?.close().catch(() => {});
      handle = null;
      if (!written) await unlink(path).catch(() => {});
    },
  };
}
