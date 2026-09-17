import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  lstat,
  chmod,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, hostname, platform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { CliAccount, CliDeployment } from "../../src/contracts/cli.ts";
import { CliError, fail, randomToken, origin } from "./common.ts";

/**
 * Whether POSIX ownership and permission bits mean anything here.
 *
 * Windows reports 0666 for every file and has no `getuid`, so the mode checks
 * below would refuse every file the CLI itself just wrote. There the private
 * state is protected by the user profile's own ACL instead.
 */
const posixPermissions = (): boolean => process.platform !== "win32";

/** The connection the commands act on, as it is written to disk. */
export interface ActiveConnection {
  url: string;
  authenticated: boolean;
  credential?: string;
  account?: CliAccount;
  deployment?: CliDeployment & { mode: CliDeployment["mode"] };
}

export interface OperationRecord {
  url: string;
  pollToken: string;
  kind: string;
  phase?: "initiating" | "pending";
  payload?: Record<string, unknown>;
  generation?: number;
  completed?: boolean;
}

/** Where a reserved key output lives, identified so a swap cannot go unnoticed. */
export interface OutputReservation {
  path: string;
  device: string;
  inode: string;
}

export interface StoredKeyMetadata {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  storagePath: string;
  contentHash: string;
}

export interface MutationFailure {
  appId: string;
  keyId: string;
  revoked: boolean;
}

/** One in-flight or completed idempotent creation, kept until stdout flushes. */
export interface MutationRecord {
  id: string;
  proof: string;
  requestHash: string;
  url: string;
  accountId: string | null;
  path: string;
  createdAt: string;
  completedAt?: string;
  /** The original one-time server response, held only until output succeeds. */
  response?: unknown;
  result?: unknown;
  keyMetadata?: StoredKeyMetadata;
  output?: OutputReservation;
  failure?: MutationFailure;
}

export interface InstallationJournal {
  id: string;
  name: string;
  accountId: string;
  databaseId?: string;
  databaseName?: string;
  version: string;
  phase: "prepared" | "deployed" | "ready";
  url?: string;
  vars?: Record<string, string>;
  domains?: string[];
  pendingDomain?: string;
  bootstrap?: { idempotencyKey: string; pollToken: string };
  secrets?: Record<string, string>;
}

export interface CliState {
  schemaVersion: 1;
  active: ActiveConnection | null;
  previous?: ActiveConnection;
  operations: Record<string, OperationRecord>;
  generation?: number;
  bootstrap?: { createdAt?: string; idempotencyKey: string; pollToken: string };
  mutations?: Record<string, MutationRecord>;
  installations?: Record<string, InstallationJournal>;
}

export function stateDirectory(): string {
  if (platform() === "win32")
    return join(
      process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local"),
      "agw",
    );
  return join(
    process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state"),
    "agw",
  );
}

/**
 * Where downloaded, verified copies of things live.
 *
 * Separate from the state directory because the contents are reproducible: the
 * gateway release cached under `releases/<version>` can be deleted at any time
 * and the next deployment command fetches and verifies it again, while nothing
 * in the state directory can be recovered that way.
 */
export function cacheDirectory(): string {
  if (platform() === "win32")
    return join(
      process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local"),
      "agw",
    );
  return join(process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "agw");
}

export async function protectedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink())
    fail("unsafe_storage", "CLI storage must be a real directory.");
  if (!posixPermissions()) return;
  if (process.getuid && s.uid !== process.getuid())
    fail("unsafe_storage", "CLI storage belongs to another user.");
  await chmod(path, 0o700);
}

export interface ReservedOutput {
  path: string;
  reservation: OutputReservation;
  contentHash(): Promise<string>;
  write(value: string | unknown): Promise<void>;
  cancel(): Promise<void>;
}

export async function reserveOutput(
  path: string,
  { reservation, retain = false }: { reservation?: OutputReservation | undefined; retain?: boolean } = {},
): Promise<ReservedOutput> {
  const absolute = resolve(path);
  let handle: FileHandle | null = null;
  let confirmed: OutputReservation;
  try {
    handle = reservation
      ? await open(absolute, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      // Read-write even though a new reservation starts empty: `write` reads it
      // back before it truncates, and `contentHash` reads it after, so a
      // write-only handle would fail the first delivery into a fresh file.
      : await open(absolute, "wx+", 0o600);
    const info = await handle.stat();
    if (!info.isFile() ||
        (posixPermissions() && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) ||
        (reservation && (reservation.path !== absolute || reservation.device !== String(info.dev) || reservation.inode !== String(info.ino)))) {
      await handle.close(); handle = null;
      fail("output_changed", "The reserved output file was replaced or its permissions changed.", "Choose a new --key-output path; no existing file was overwritten.", 4);
    }
    confirmed = { path: absolute, device: String(info.dev), inode: String(info.ino) };
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("output_unavailable", `Cannot exclusively create or resume ${absolute}. Choose a new file in an existing writable directory.`);
  }
  let completed = false;
  const live = handle;
  return {
    path: absolute,
    reservation: confirmed,
    async contentHash() {
      if (!live) throw new Error("The reserved output is closed");
      return createHash("sha256").update(await live.readFile()).digest("hex");
    },
    async write(value) {
      if (!handle) throw new Error("The reserved output is closed");
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
      try {
        if (retain) {
          const existing = await handle.readFile("utf8");
          if (existing && !text.startsWith(existing)) fail("output_changed", "The reserved output contains different data.", "Choose a new --key-output path; no existing data was overwritten.", 4);
          await handle.truncate(0);
          await handle.write(text, 0, "utf8");
        } else await handle.writeFile(text);
        await handle.sync();
        await handle.close(); handle = null;
        completed = true;
      } catch (error) {
        await handle?.close().catch(() => {}); handle = null;
        if (!retain) await unlink(absolute).catch(() => {});
        throw error;
      }
    },
    async cancel() {
      await handle?.close().catch(() => {}); handle = null;
      if (!completed && !retain) await unlink(absolute).catch(() => {});
    },
  };
}

/**
 * Removes a reservation the receipt that owned it no longer needs.
 *
 * Only ever called for a creation the deployment refused outright, so there is
 * nothing to recover and leaving the file behind would make the next attempt at
 * the same `--key-output` path fail on a file the CLI itself left. It is still
 * confirmed against the recorded device and inode and an empty length first: a
 * file that was replaced, or that holds a delivered key, is not this
 * reservation and is left exactly where it is.
 */
export async function releaseOutput(reservation: OutputReservation): Promise<void> {
  const held = await lstat(reservation.path).catch(() => null);
  if (
    !held ||
    !held.isFile() ||
    held.isSymbolicLink() ||
    held.size !== 0 ||
    String(held.dev) !== reservation.device ||
    String(held.ino) !== reservation.inode
  )
    return;
  await unlink(reservation.path).catch(() => {});
}

/** The `errno` a failed filesystem call carries, without asserting a shape. */
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** How long to keep trying for the lock before reporting a busy state file. */
const LOCK_TIMEOUT_MS = 10000;
/** The age past which a held lock is treated as abandoned by its owner. */
const LOCK_STALE_MS = 60000;

/** Whether a process still exists, which `signal 0` answers without touching it. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Owned by another user: alive, just not ours to signal.
    return errorCode(error) === "EPERM";
  }
}

/** What the holder of a lock writes about itself, as far as it can be trusted. */
interface LockOwner {
  pid?: unknown;
  host?: unknown;
}

/**
 * Removes a lock no live writer can still be inside, so a killed command does
 * not strand the state file for good.
 *
 * A lock is abandoned when the process that recorded it on this host is gone,
 * or when it is older than any single state write could take. Removal is
 * confirmed against the same file that was judged, so a lock taken in between
 * is left to its new owner.
 */
async function breakAbandonedLock(path: string): Promise<boolean> {
  const held = await lstat(path).catch(() => null);
  if (!held) return true;
  let owner: LockOwner = {};
  try {
    owner = JSON.parse(await readFile(path, "utf8")) as LockOwner;
  } catch {
    // A lock with no readable owner is judged by its age alone.
  }
  const dead =
    typeof owner.pid === "number" &&
    owner.host === hostname() &&
    !running(owner.pid);
  if (!dead && Date.now() - held.mtimeMs <= LOCK_STALE_MS) return false;
  const current = await lstat(path).catch(() => null);
  if (current && current.ino === held.ino && current.mtimeMs === held.mtimeMs)
    await unlink(path).catch(() => {});
  return true;
}

/** JSON equality, the only comparison the values in this state need. */
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** One record map as it was found on disk, where anything could have been. */
const records = <T>(value: unknown): Record<string, T> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};

/**
 * Merges one record map three ways: what this command started from, what it
 * holds now, and what is on disk.
 *
 * An entry this command changed wins, an entry only another command changed is
 * taken from disk, and an entry this command dropped stays dropped. Ties keep
 * the live object rather than the copy just parsed off disk, because the
 * command that is mid-creation still holds a reference to it.
 */
function mergeRecords<T>(
  baseline: Record<string, T>,
  local: Record<string, T>,
  disk: Record<string, T>,
): Record<string, T> {
  const merged: Record<string, T> = { ...disk };
  for (const [id, value] of Object.entries(local)) {
    const changedHere = !(id in baseline) || !same(baseline[id], value);
    const changedElsewhere = id in disk && !same(baseline[id], disk[id]);
    merged[id] = changedHere || !changedElsewhere ? value : disk[id]!;
  }
  for (const id of Object.keys(baseline)) if (!(id in local)) delete merged[id];
  return merged;
}

/**
 * The state to persist when another command wrote while this one was running.
 *
 * The lock is held for a write rather than for a whole command, so a poll that
 * waits for minutes cannot block an unrelated command — which means a write
 * has to assume the file moved under it. Overwriting it wholesale would drop a
 * receipt or a poll token another command had just recorded, so the record maps
 * merge per entry and the connection is only replaced by the command that
 * actually changed it.
 */
function mergeState(
  baseline: CliState | undefined,
  local: CliState,
  disk: CliState | null,
): CliState {
  // Anything this cannot recognise is not something to merge into: the state
  // this command validated on the way in is written as it stands.
  if (
    !disk ||
    disk.schemaVersion !== 1 ||
    typeof disk.operations !== "object" ||
    disk.operations === null ||
    Array.isArray(disk.operations)
  )
    return local;
  const connection =
    baseline &&
    same(baseline.active, local.active) &&
    same(baseline.previous, local.previous) &&
    same(baseline.generation, local.generation) &&
    same(baseline.bootstrap, local.bootstrap)
      ? disk
      : local;
  const merged: CliState = {
    schemaVersion: 1,
    active: connection.active ?? null,
    operations: mergeRecords(
      baseline?.operations ?? {},
      local.operations,
      disk.operations,
    ),
  };
  if (connection.previous) merged.previous = connection.previous;
  if (connection.generation !== undefined)
    merged.generation = connection.generation;
  if (connection.bootstrap) merged.bootstrap = connection.bootstrap;
  const mutations = mergeRecords(
    baseline?.mutations ?? {},
    local.mutations ?? {},
    records(disk.mutations),
  );
  if (Object.keys(mutations).length) merged.mutations = mutations;
  const installations = mergeRecords(
    baseline?.installations ?? {},
    local.installations ?? {},
    records(disk.installations),
  );
  if (Object.keys(installations).length) merged.installations = installations;
  return merged;
}

/** Brings one live record map in line with what the merge actually persisted. */
function adoptRecords<T>(
  local: Record<string, T>,
  merged: Record<string, T>,
): void {
  for (const id of Object.keys(local)) if (!(id in merged)) delete local[id];
  Object.assign(local, merged);
}

export class StateStore {
  readonly directory: string;
  readonly path: string;
  private readonly lockPath: string;
  /** The state as this process last saw it, which is what a write merges from. */
  private baseline: CliState | undefined;

  constructor(path: string = stateDirectory()) {
    this.directory = path;
    this.path = join(path, "connection.json");
    this.lockPath = join(path, "connection.lock");
  }

  /**
   * Runs `fn` while holding the write lock.
   *
   * Only a state write is guarded, never a whole command: `agw operation wait`
   * polls for minutes, and nothing about that should stop `agw app list` from
   * running beside it. A lock left behind by a killed command is broken rather
   * than waited out.
   */
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
            "Another CLI command is writing the connection state.",
            "Retry the command. If it keeps failing, verify the PID in connection.lock before removing that lock.",
            4,
          );
        await delay(50);
      }
    }
    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          createdAt: new Date().toISOString(),
        }),
      );
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await unlink(this.lockPath).catch(() => {});
    }
  }

  async read(): Promise<CliState> {
    try {
      const s = await lstat(this.path);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        (posixPermissions() &&
          ((process.getuid && s.uid !== process.getuid()) ||
            (s.mode & 0o077) !== 0))
      )
        fail(
          "unsafe_storage",
          "Connection state must be owned by you with mode 0600.",
        );
      const state = JSON.parse(await readFile(this.path, "utf8")) as CliState;
      if (
        state.schemaVersion !== 1 ||
        !Object.hasOwn(state, "active") ||
        !state.operations ||
        typeof state.operations !== "object" ||
        Array.isArray(state.operations)
      )
        fail("invalid_state", "Unsupported or malformed connection state.");
      if (state.active !== null) {
        const a: ActiveConnection | null = state.active;
        if (
          !a ||
          typeof a !== "object" ||
          typeof a.url !== "string" ||
          typeof a.authenticated !== "boolean" ||
          (a.authenticated && typeof a.credential !== "string")
        )
          fail(
            "invalid_state",
            "Malformed prior connection; recovery is required.",
          );
        origin(a.url);
      }
      for (const op of Object.values(state.operations)) {
        if (
          !op ||
          typeof op.url !== "string" ||
          typeof op.pollToken !== "string" ||
          typeof op.kind !== "string"
        )
          fail(
            "invalid_state",
            "Malformed operation state; recovery is required.",
          );
        origin(op.url);
      }
      this.baseline = structuredClone(state);
      return state;
    } catch (e) {
      if (errorCode(e) === "ENOENT") {
        const empty: CliState = { schemaVersion: 1, active: null, operations: {} };
        this.baseline = structuredClone(empty);
        return empty;
      }
      if (e instanceof CliError) throw e;
      fail(
        "invalid_state",
        "Cannot read connection state.",
        "Recover the state file; it will not be treated as a new account.",
        4,
      );
    }
  }

  /**
   * Persists the state, merged with whatever another command wrote meanwhile.
   *
   * The caller's own object is brought back in line with what landed on disk,
   * so the records it goes on to touch are the records that were kept.
   */
  async write(state: CliState): Promise<void> {
    await this.locked(() => this.persist(state));
  }

  /**
   * Claims a proof no two commands may hold at once.
   *
   * Everything else may merge after the fact, but a claim cannot: two commands
   * started side by side must not create two accounts, or send one creation
   * twice under two idempotency proofs. Here the look and the write happen
   * under one lock, so the second command adopts the first command's proof
   * instead of minting one beside it.
   */
  async reserve<T>(
    state: CliState,
    find: (state: CliState) => T | undefined,
    create: (state: CliState) => T,
  ): Promise<T> {
    return this.locked(async () => {
      this.absorb(state, mergeState(this.baseline, state, await this.stored()));
      const existing = find(state);
      if (existing !== undefined) return existing;
      const claimed = create(state);
      await this.persist(state);
      return claimed;
    });
  }

  private async persist(state: CliState): Promise<void> {
    const merged = mergeState(this.baseline, state, await this.stored());
    await this.replace(merged);
    this.absorb(state, merged);
    this.baseline = structuredClone(state);
  }

  /** Brings the caller's live state in line with the merge, records first. */
  private absorb(state: CliState, merged: CliState): void {
    adoptRecords(state.operations, merged.operations);
    if (merged.mutations) adoptRecords((state.mutations ??= {}), merged.mutations);
    else delete state.mutations;
    if (merged.installations)
      adoptRecords((state.installations ??= {}), merged.installations);
    else delete state.installations;
    if (merged.bootstrap) state.bootstrap = merged.bootstrap;
    else delete state.bootstrap;
    // A command holding no connection adopts the one another command
    // established while it ran — which is what keeps a first run started twice
    // from creating two accounts. A command already acting on a connection is
    // never moved off it.
    if (!state.active && merged.active) {
      state.active = merged.active;
      if (merged.generation === undefined) delete state.generation;
      else state.generation = merged.generation;
    }
  }

  /** The state file as it stands, or null when there is nothing to merge with. */
  private async stored(): Promise<CliState | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as CliState;
    } catch {
      return null;
    }
  }

  private async replace(state: CliState): Promise<void> {
    const temp = join(this.directory, `.state-${randomToken()}`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
      await handle.close();
      await rename(temp, this.path);
      // Windows cannot open a directory to flush its entry; the rename is durable.
      if (posixPermissions()) {
        const d = await open(this.directory, "r");
        await d.sync();
        await d.close();
      }
    } catch (e) {
      await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw e;
    }
  }

  async keyOutput(
    path: string | undefined,
    options: { reservation?: OutputReservation | undefined; retain?: boolean } = {},
  ): Promise<ReservedOutput> {
    if (path) return reserveOutput(path, options);
    const dir = join(this.directory, "app-keys");
    await protectedDirectory(dir);
    return reserveOutput(join(dir, `${randomToken()}.key`), options);
  }

  /**
   * A self-hosted deployment's vault key, in a file of its own.
   *
   * It is the one installation secret worth keeping: losing it makes every
   * stored provider credential unreadable, while the Worker's auth secrets are
   * already where they are needed and are dropped once the install is ready.
   * Keeping it out of `connection.json` keeps it away from the management
   * credential that file carries, and out of anything that reads state.
   */
  async vaultKey(deploymentId: string, adopt?: string): Promise<string> {
    const dir = join(this.directory, "vault-keys");
    await protectedDirectory(dir);
    const name = /^[A-Za-z0-9._-]{1,64}$/.test(deploymentId)
      ? deploymentId
      : createHash("sha256").update(deploymentId).digest("hex");
    const path = join(dir, `${name}.key`);
    const held = await lstat(path).catch(() => null);
    if (held) {
      if (
        !held.isFile() ||
        held.isSymbolicLink() ||
        (posixPermissions() &&
          ((process.getuid && held.uid !== process.getuid()) ||
            (held.mode & 0o077) !== 0))
      )
        fail("unsafe_storage", "The stored vault key must be owned by you with mode 0600.");
      const existing = (await readFile(path, "utf8")).trim();
      // Never replace a key that is merely unreadable: provider credentials
      // encrypted under it would become undecryptable.
      if (!existing)
        fail(
          "unsafe_storage",
          "The stored vault key file is empty.",
          "Restore it from your backup before deploying this installation again.",
          4,
        );
      return existing;
    }
    const key = adopt?.trim() || randomBytes(32).toString("base64");
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(key);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  }
}
