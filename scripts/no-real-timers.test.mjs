import assert from "node:assert/strict";
import { test } from "node:test";
import { timerLines } from "./no-real-timers.mjs";

test("a timer on a line with a URL is still found", () => {
  const source = 'await fetch("https://example.test", { signal: AbortSignal.timeout(5000) });\n';
  assert.deepEqual(timerLines(source), [1]);
});

test("a timer name only inside a string is still found, which is fine", () => {
  assert.deepEqual(timerLines('const label = "setTimeout(x)";\n'), [1]);
});

test("timers in comments are not found, and a marked line is allowed", () => {
  const source = [
    "// setTimeout(() => undefined, 1)",
    "/* sleep(5) */ const a = 1;",
    "const b = `a // b` + setInterval(() => undefined, 1);",
    "const c = setTimeout(() => undefined, 1); // real-timer: the runtime's own clock",
    'const d = "it\\"s // not a comment"; sleep(1);',
  ].join("\n");
  assert.deepEqual(timerLines(source), [3, 5]);
});

test("a timer split over lines is found on its first line", () => {
  assert.deepEqual(timerLines("const a = scheduler\n  .wait\n  (5);\n"), [1]);
});
