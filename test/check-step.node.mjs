import assert from "node:assert/strict";
import { test } from "node:test";
import { lastTestFile, runStep, silenceLimitMs } from "../scripts/check-step.mjs";

// A fake step that prints once and then hangs. Like the Workers test pool, it
// starts a grandchild that hangs too and keeps the output pipe open, so the
// step ends only when the whole tree is stopped.
const HANGS = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "inherit" });
console.log(" ✓ test/first.test.ts (3 tests) 120ms");
console.log("stdout | test/hangs.test.ts > waits forever");
setInterval(() => undefined, 1000);
`;

// Without the watchdog the step never ends, so this limit fails the test.
test("a step that prints once and then hangs is stopped and fails, naming the last test file", { timeout: 20_000 }, async () => {
  const result = await runStep("fake:test", process.execPath, ["-e", HANGS], { silenceMs: 500 });
  assert.equal(result.ok, false);
  assert.match(result.output, /fake:test printed nothing for 0\.01 minutes, so it was stopped/);
  assert.match(result.output, /a frozen run, not a failing test/);
  assert.match(result.output, /The last test file in its output was test\/hangs\.test\.ts\./);
});

test("a step that keeps printing is never stopped, however long it runs in all", { timeout: 20_000 }, async () => {
  const slow = `let n = 0; const t = setInterval(() => { console.log("tick " + n); if (++n === 6) clearInterval(t); }, 150);`;
  const result = await runStep("fake:slow", process.execPath, ["-e", slow], { silenceMs: 500 });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.output, /stopped/);
});

test("a step that fails on its own is reported as it is", async () => {
  const result = await runStep("fake:fails", process.execPath, ["-e", "console.log('FAIL test/a.test.ts'); process.exit(1)"], { silenceMs: 500 });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.output, /stopped/);
});

test("the limit is five minutes unless the environment changes it, and 0 turns it off", () => {
  assert.equal(silenceLimitMs({}), 5 * 60_000);
  assert.equal(silenceLimitMs({ CHECK_SILENCE_MINUTES: "" }), 5 * 60_000);
  assert.equal(silenceLimitMs({ CHECK_SILENCE_MINUTES: "15" }), 15 * 60_000);
  assert.equal(silenceLimitMs({ CHECK_SILENCE_MINUTES: "0" }), 0);
  assert.throws(() => silenceLimitMs({ CHECK_SILENCE_MINUTES: "five" }), /must be a number of minutes/);
});

test("the last test file is found in Vitest's and node's output, or none", () => {
  assert.equal(lastTestFile(" ✓ |v2| test/a.test.ts (3 tests)\nstdout | test/jobs.test.ts > x\n"), "test/jobs.test.ts");
  assert.equal(lastTestFile("✓ test/suites/registry.suite.ts\n"), "test/suites/registry.suite.ts");
  assert.equal(lastTestFile("src/app.test.tsx > renders"), "src/app.test.tsx");
  assert.equal(lastTestFile("> node --test test/indexnow.node.mjs"), "test/indexnow.node.mjs");
  assert.equal(lastTestFile("building...\n"), null);
});
