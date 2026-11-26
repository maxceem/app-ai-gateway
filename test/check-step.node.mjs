import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lastTestFile, runStep, silenceLimitMs } from "../scripts/check-step.mjs";

// Every fixture process exits on its own after this long, so none outlives the
// test even when the watchdog fails to stop it. It is longer than any limit
// below, and shorter than each test's own timeout.
const FIXTURE_LIFE_MS = 15_000;
const TEST_TIMEOUT_MS = 25_000;
// Long enough for a fixture to start and print on a loaded machine.
const SILENCE_MS = 3_000;

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

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const wrapperExits of [false, true]) {
  const what = wrapperExits ? "exits at once and leaves its child hanging" : "prints once and then hangs";
  // Without the watchdog the step never ends, so the timeout fails the test.
  test(`a step that ${what} is stopped with its whole group, and fails`, { timeout: TEST_TIMEOUT_MS, skip: noGroups }, async () => {
    const result = await runStep("fake:test", process.execPath, ["-e", step({ wrapperExits })], { silenceMs: SILENCE_MS });
    assert.equal(result.ok, false, "a step stopped by the watchdog never passes, even when it exited 0");
    assert.match(result.output, /fake:test hit its silence timeout: it printed nothing for 0\.05 minutes, so it was stopped/);
    assert.match(result.output, /most likely means the run froze, not that a test failed/);
    assert.match(result.output, /The last test file in its output was test\/hangs\.test\.ts\./);
    const child = Number(result.output.match(/child-pid:(\d+)/)?.[1]);
    assert.ok(child > 0, "the child printed its pid");
    assert.equal(alive(child), false, "the child that held the output pipe was stopped too");
  });
}

// A child that ignores SIGTERM and prints when it gets one, as a busy test
// runner might. Its output must not start the watchdog again, and it still
// ends: SIGKILL follows once the grace period is over.
const STUBBORN = `
const { spawn } = require("node:child_process");
const child = \`console.log("child-pid:" + process.pid); process.on("SIGTERM", () => console.log("child got SIGTERM, staying")); setInterval(() => undefined, 1000); setTimeout(() => process.exit(0), ${FIXTURE_LIFE_MS});\`;
spawn(process.execPath, ["-e", child], { stdio: "inherit" });
console.log("stdout | test/hangs.test.ts > waits forever");
setInterval(() => undefined, 1000);
setTimeout(() => process.exit(0), ${FIXTURE_LIFE_MS});
`;

test("a child that ignores SIGTERM and prints on it gets one timeout and is then killed", { timeout: TEST_TIMEOUT_MS, skip: noGroups }, async () => {
  // The grace period is longer than the silence limit, so a watchdog started
  // again by the child's answer would fire a second time before SIGKILL.
  const result = await runStep("fake:stubborn", process.execPath, ["-e", STUBBORN], { silenceMs: SILENCE_MS, graceMs: SILENCE_MS + 1_500 });
  assert.equal(result.ok, false);
  assert.match(result.output, /child got SIGTERM, staying/);
  assert.equal(result.output.match(/hit its silence timeout/g)?.length, 1, "the watchdog fired exactly once");
  const child = Number(result.output.match(/child-pid:(\d+)/)?.[1]);
  assert.ok(child > 0, "the child printed its pid");
  assert.equal(alive(child), false, "SIGKILL ended the child that ignored SIGTERM");
});

test("Ctrl-C stops a watched step's group, even a process that ignores SIGTERM, and then exits 130", { timeout: TEST_TIMEOUT_MS, skip: noGroups }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-step-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "pid");
  const fixture = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000); setTimeout(() => process.exit(0), ${FIXTURE_LIFE_MS});`;
  const runner = `
import { runStep } from ${JSON.stringify(new URL("../scripts/check-step.mjs", import.meta.url).href)};
await runStep("fake:interrupted", process.execPath, ["-e", ${JSON.stringify(fixture)}], { silenceMs: 60_000, graceMs: 1_000 });
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
  assert.equal(await exited, 130);
  assert.equal(alive(child), false, "the process that ignored SIGTERM was killed before the runner exited");
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
