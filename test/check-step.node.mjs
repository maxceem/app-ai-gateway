import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lastTestFile, runStep, silenceLimitMs } from "../scripts/check-step.mjs";

// Every fixture process exits on its own after this long, so none is left
// running for long even when the watchdog fails to stop it. It is far longer
// than any test may take, so a fixture's own exit never makes a test pass.
const FIXTURE_LIFE_MS = 60_000;
const TEST_TIMEOUT_MS = 25_000;
// Long enough for a fixture to start and print on a loaded machine.
const SILENCE_MS = 3_000;
// Slack on top of the silence limit, for the kill and the output to close.
const MARGIN_MS = 2_000;

/** `work`, or a failure once `ms` have passed. */
const within = (ms, work, what) => {
  let timer;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

// A child that hangs while holding the output pipe it inherited, as the
// Workers runtime does under the test pool. It prints its own pid first.
const GRANDCHILD = `console.log("child-pid:" + process.pid); setInterval(() => undefined, 1000); setTimeout(() => process.exit(0), ${FIXTURE_LIFE_MS});`;

// A fake step that starts that child, prints the test files it is on, and then
// either hangs or exits at once, leaving its child behind.
const step = ({ wrapperExits }) => `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD)}], { stdio: "inherit" });
console.log(" ✓ test/first.test.ts (3 tests) 120ms");
console.log("stdout | test/hangs.test.ts > waits forever");
${wrapperExits ? "process.exit(0);" : `setInterval(() => undefined, 1000); setTimeout(() => process.exit(0), ${FIXTURE_LIFE_MS});`}
`;

// The watchdog needs process groups, so it is off on Windows.
const noGroups = process.platform === "win32";

// Only the system's own answer proves a process is gone: `kill(pid, 0)`
// failing with ESRCH. Any other error is surfaced, never read as "gone".
const exists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

const running = (pid) => {
  if (!exists(pid)) return false;
  // A process that has ended (state Z) still answers until its parent
  // collects it. Once its own parent is gone, that parent is init, which may
  // take a moment.
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().startsWith("Z");
  } catch (error) {
    // `ps` finds nothing once the process was collected in the meantime.
    if (!exists(pid)) return false;
    throw error;
  }
};

/** Whether `pid` stops running within two seconds. */
const stops = async (pid) => {
  for (let waited = 0; running(pid) && waited < 2_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !running(pid);
};

for (const wrapperExits of [false, true]) {
  const what = wrapperExits ? "exits at once and leaves its child hanging" : "prints once and then hangs";
  // Without the watchdog the step never ends, so the timeout fails the test.
  test(`a step that ${what} is stopped with its whole group, and fails`, { timeout: TEST_TIMEOUT_MS, skip: noGroups }, async () => {
    const result = await within(
      SILENCE_MS + MARGIN_MS,
      runStep("fake:test", process.execPath, ["-e", step({ wrapperExits })], { silenceMs: SILENCE_MS }),
      "stopping the step",
    );
    assert.equal(result.ok, false, "a step stopped by the watchdog never passes, even when it exited 0");
    assert.match(result.output, /fake:test hit its silence timeout: it printed nothing for 0\.05 minutes, so it was stopped/);
    assert.match(result.output, /most likely means the run froze, not that a test failed/);
    assert.match(result.output, /The last test file in its output was test\/hangs\.test\.ts\./);
    const child = Number(result.output.match(/child-pid:(\d+)/)?.[1]);
    assert.ok(child > 0, "the child printed its pid");
    assert.equal(await stops(child), true, "the child that held the output pipe was stopped too");
  });
}

test("Ctrl-C sends SIGKILL to a watched step's group, so even a process that ignores SIGTERM goes, and exits 130", { timeout: TEST_TIMEOUT_MS, skip: noGroups }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-step-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "pid");
  // It writes its pid only once it ignores SIGTERM, so the test never signals it too early.
  const fixture = `process.on("SIGTERM", () => undefined); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => undefined, 1000); setTimeout(() => process.exit(0), ${FIXTURE_LIFE_MS});`;
  const runner = `
import { runStep } from ${JSON.stringify(new URL("../scripts/check-step.mjs", import.meta.url).href)};
await runStep("fake:interrupted", process.execPath, ["-e", ${JSON.stringify(fixture)}], { silenceMs: 60_000 });
`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", runner], { stdio: "ignore" });
  const exited = new Promise((resolve) => parent.on("exit", (code, signal) => resolve(code ?? signal)));
  let child = 0;
  for (let waited = 0; !child && waited < 10_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      child = Number(readFileSync(pidFile, "utf8"));
    } catch {
      // Not started yet.
    }
  }
  assert.ok(child > 0, "the watched step started");
  parent.kill("SIGINT");
  assert.equal(await within(MARGIN_MS, exited, "exiting on Ctrl-C"), 130);
  assert.equal(await stops(child), true, "the process that ignored SIGTERM got SIGKILL");
});

test("a step that keeps printing is never stopped, however long it runs in all", { timeout: TEST_TIMEOUT_MS }, async () => {
  const slow = `let n = 0; const t = setInterval(() => { console.log("tick " + n); if (++n === 12) clearInterval(t); }, 300);`;
  const result = await runStep("fake:slow", process.execPath, ["-e", slow], { silenceMs: 2_000 });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.output, /silence timeout/);
});

test("a step that fails on its own is reported as it is", { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await runStep("fake:fails", process.execPath, ["-e", "console.log('FAIL test/a.test.ts'); process.exit(1)"], { silenceMs: SILENCE_MS });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.output, /silence timeout/);
});

test("an unwatched step may stay silent", { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await runStep("fake:quiet", process.execPath, ["-e", "setTimeout(() => undefined, 300)"]);
  assert.equal(result.ok, true);
});

test("the limit is five minutes unless the environment changes it, and 0 turns it off", () => {
  assert.equal(silenceLimitMs({}), 5 * 60_000);
  assert.equal(silenceLimitMs({ CHECK_SILENCE_MINUTES: "" }), 5 * 60_000);
  assert.equal(silenceLimitMs({ CHECK_SILENCE_MINUTES: "15" }), 15 * 60_000);
  assert.equal(silenceLimitMs({ CHECK_SILENCE_MINUTES: "0" }), 0);
  assert.equal(silenceLimitMs({ CHECK_SILENCE_MINUTES: "35791" }), 35_791 * 60_000);
  assert.throws(() => silenceLimitMs({ CHECK_SILENCE_MINUTES: "five" }), /must be a number of minutes/);
  assert.throws(() => silenceLimitMs({ CHECK_SILENCE_MINUTES: "-1" }), /must be a number of minutes/);
  // Past Node's timer limit, which would otherwise fire after 1 ms.
  assert.throws(() => silenceLimitMs({ CHECK_SILENCE_MINUTES: "40000" }), /from 0 to 35791/);
});

test("the last test file is found in Vitest's and node's output, or none", () => {
  assert.equal(lastTestFile(" ✓ |v2| test/a.test.ts (3 tests)\nstdout | test/jobs.test.ts > x\n"), "test/jobs.test.ts");
  assert.equal(lastTestFile("✓ test/suites/registry.suite.ts\n"), "test/suites/registry.suite.ts");
  assert.equal(lastTestFile("src/app.test.tsx > renders"), "src/app.test.tsx");
  assert.equal(lastTestFile("> node --test test/indexnow.node.mjs"), "test/indexnow.node.mjs");
  assert.equal(lastTestFile("building...\n"), null);
});
