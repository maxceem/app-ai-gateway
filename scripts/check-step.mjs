import { execFileSync, spawn } from "node:child_process";

// Runs one step of `scripts/check.mjs` and stops it if it freezes.
//
// A test run can freeze: it uses no CPU and never ends. The Workers test pool
// does this when a message from inside the runtime to Vitest is lost, and
// Vitest then waits for it forever. Without a limit, `verify` would wait too.
//
// So a step that prints nothing for a while is treated as frozen. Its whole
// process tree is stopped, and the step fails with a message that says so.
// Every step prints well within the limit while it works: Vitest reports each
// test file as it finishes, and the slowest file takes about a minute.

/** Overrides the limit, in minutes. `0` turns the watchdog off. */
export const SILENCE_ENV = "CHECK_SILENCE_MINUTES";
const DEFAULT_SILENCE_MINUTES = 5;

/** How long a step may print nothing, in milliseconds, or `0` for no limit. */
export function silenceLimitMs(env = process.env) {
  const raw = env[SILENCE_ENV];
  const minutes = raw === undefined || raw.trim() === "" ? DEFAULT_SILENCE_MINUTES : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`${SILENCE_ENV} must be a number of minutes, or 0 to turn the limit off (got "${raw}")`);
  }
  return minutes * 60_000;
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
 */
export function runStep(name, command, args, { cwd, silenceMs = silenceLimitMs() } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd });

    let output = "";
    let watchdog = null;
    const stopFrozen = () => {
      const minutes = Math.round((silenceMs / 60_000) * 100) / 100;
      const file = lastTestFile(output);
      const message =
        `${name} printed nothing for ${minutes} minute${minutes === 1 ? "" : "s"}, so it was stopped. ` +
        `This is a frozen run, not a failing test.` +
        (file ? ` The last test file in its output was ${file}.` : "") +
        ` (Set ${SILENCE_ENV} to change the limit.)`;
      console.error(`STOP ${message}`);
      output += `\n${message}\n`;
      stopTree(child.pid);
    };
    if (silenceMs > 0) watchdog = setTimeout(stopFrozen, silenceMs);
    const keep = (chunk) => {
      output += chunk;
      watchdog?.refresh();
    };

    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => {
      clearTimeout(watchdog);
      resolve({ name, ok: false, output: String(error), seconds: 0 });
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`${code === 0 ? "PASS" : "FAIL"} ${name} (${seconds}s)`);
      resolve({ name, ok: code === 0, output, seconds });
    });
  });
}

/**
 * Stops a process and everything it started. The test pools start the Workers
 * runtime as a grandchild, and stopping only the direct child would leave it
 * running and holding the output pipe open, so the step would never end.
 * Only this step's own processes are touched.
 */
function stopTree(pid) {
  const pids = [pid, ...descendants(pid)];
  const signal = (name) => {
    for (const one of pids) {
      try {
        process.kill(one, name);
      } catch {
        // Already gone.
      }
    }
  };
  signal("SIGTERM");
  // A frozen process may ignore the polite request.
  setTimeout(() => signal("SIGKILL"), 5_000).unref();
}

function descendants(pid) {
  let table;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return []; // No `ps` here: only the direct child is stopped.
  }
  const children = new Map();
  for (const line of table.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}
