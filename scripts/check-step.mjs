import { spawn } from "node:child_process";
import { constants } from "node:os";

// Runs one step of `scripts/check.mjs`, and stops a watched step that goes
// silent for too long.
//
// A Worker test run can freeze: it uses no CPU and never ends. The Workers
// test pool does this when a message from inside the runtime to Vitest is
// lost, and Vitest then waits for it forever. Without a limit, `verify` would
// wait too. So a watched step that prints nothing for a while is killed, with
// every process it started, and fails with a message that says so.
//
// Only the Worker test steps are watched (see `check.mjs`). They print as each
// test file finishes, and the slowest file takes about a minute. A type check
// can be silent for its whole run, so it is not watched.

/** Overrides the limit, in minutes. `0` turns the watchdog off. */
export const SILENCE_ENV = "CHECK_SILENCE_MINUTES";
const DEFAULT_SILENCE_MINUTES = 5;
// The longest delay a Node timer accepts. A longer one fires after 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1;

/** How long a watched step may print nothing, in milliseconds, or `0` for no limit. */
export function silenceLimitMs(env = process.env) {
  const raw = env[SILENCE_ENV];
  const minutes = raw === undefined || raw.trim() === "" ? DEFAULT_SILENCE_MINUTES : Number(raw);
  const ms = minutes * 60_000;
  if (!Number.isFinite(minutes) || minutes < 0 || ms > MAX_TIMER_MS) {
    const most = Math.floor(MAX_TIMER_MS / 60_000);
    throw new Error(`${SILENCE_ENV} must be a number of minutes from 0 to ${most}, where 0 turns the limit off (got "${raw}")`);
  }
  return ms;
}

/** The last test file named in a step's output, such as `test/jobs.test.ts`. */
export function lastTestFile(output) {
  const names = output.match(/[\w@./-]+\.(?:test|spec|suite|node)\.[cm]?[jt]sx?\b/g);
  return names ? names[names.length - 1] : null;
}

/**
 * Runs `command` and resolves with `{ name, ok, output, seconds }`. Output is
 * buffered, not streamed: parallel steps would otherwise interleave their
 * output line by line and make a failure impossible to read.
 *
 * With `silenceMs` above 0, the step runs in its own process group, and the
 * whole group gets SIGKILL once it prints nothing for that long: a frozen
 * step has nothing to save. That needs process groups, so on Windows no step
 * is watched.
 */
export function runStep(name, command, args, { cwd, silenceMs = 0 } = {}) {
  const watched = silenceMs > 0 && process.platform !== "win32";
  return new Promise((resolve) => {
    const started = Date.now();
    // `detached` makes the child the leader of a new process group, so the
    // group holds everything it starts, even what outlives it.
    const child = spawn(command, args, { cwd, detached: watched });
    if (watched) trackGroup(child.pid);

    let output = "";
    let timedOut = false;
    let watchdog = null;
    const stopSilent = () => {
      // Fires once: output still on its way must not start it again.
      watchdog = null;
      timedOut = true;
      const minutes = Math.round((silenceMs / 60_000) * 100) / 100;
      const file = lastTestFile(output);
      const message =
        `${name} hit its silence timeout: it printed nothing for ${minutes} minute${minutes === 1 ? "" : "s"}, so it was stopped. ` +
        `This most likely means the run froze, not that a test failed.` +
        (file ? ` The last test file in its output was ${file}.` : "") +
        ` (${SILENCE_ENV} changes the limit.)`;
      console.error(`STOP ${message}`);
      output += `\n${message}\n`;
      killGroup(child.pid);
    };
    if (watched) watchdog = setTimeout(stopSilent, silenceMs);
    const keep = (chunk) => {
      output += chunk;
      watchdog?.refresh();
    };

    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => {
      clearTimeout(watchdog);
      groups.delete(child.pid);
      resolve({ name, ok: false, output: String(error), seconds: 0 });
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      groups.delete(child.pid);
      const seconds = Math.round((Date.now() - started) / 1000);
      const ok = code === 0 && !timedOut;
      console.log(`${ok ? "PASS" : "FAIL"} ${name} (${seconds}s)`);
      resolve({ name, ok, output, seconds });
    });
  });
}

// The process group of every watched step that is still running.
const groups = new Set();
let listening = false;

// A watched step is in its own process group, so Ctrl-C in the terminal no
// longer reaches it. When this process is told to stop, it sends SIGKILL to
// every watched group, then exits with the signal's usual code. A SIGKILL to
// this process itself cannot be caught, so it leaves watched steps running:
// that is the cost of giving them their own groups.
function trackGroup(pid) {
  groups.add(pid);
  if (listening) return;
  listening = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      for (const group of groups) killGroup(group);
      process.exit(128 + constants.signals[signal]);
    });
  }
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}
