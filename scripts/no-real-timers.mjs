// Refuses real timers in v2's tests: no `setTimeout`, `setInterval`,
// `scheduler.wait`, `AbortSignal.timeout` or sleep helper. A test uses fake timers, or waits on the
// event itself (a promise the fake resolves, `waitFor`, a fake the test
// releases). Real timers make tests slower and flaky.
//
// A line that truly needs one says why: `// real-timer: <reason>`.
//
// Smoke checks (`v2/smoke`) are not scanned. They run against a live
// deployment and may pause between polls, inside a loop with a deadline that
// checks the real result.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Vitest's own default test file pattern, which the console uses. */
const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** Test helpers: anything under a `test` folder. */
const helperFile = /(^|\/)test\/.+\.[cm]?[jt]sx?$/;

const scopes = ["v2/test", "v2/console", "v2/cli/test"];
const skipped = new Set(["node_modules", "dist"]);

// Whitespace and newlines may sit before `(`, and around the `.` in
// `scheduler.wait` and `AbortSignal.timeout`.
const timer = /\b(?:setTimeout|setInterval|sleep|scheduler\s*\.\s*wait|AbortSignal\s*\.\s*timeout)\s*\(/g;
const allowed = /\/\/\s*real-timer:\s*\S/;

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (skipped.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/** The source with comments blanked out, keeping every line where it was. */
function withoutComments(source) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const found = [];
for (const scope of scopes) {
  for (const path of files(join(root, scope))) {
    const name = relative(root, path).split(sep).join("/");
    if (!testFile.test(name) && !helperFile.test(name)) continue;
    const source = readFileSync(path, "utf8");
    const lines = source.split("\n");
    const code = withoutComments(source);
    for (const match of code.matchAll(timer)) {
      const line = code.slice(0, match.index).split("\n").length;
      if (allowed.test(lines[line - 1])) continue;
      found.push(`${name}:${line}: ${lines[line - 1].trim()}`);
    }
  }
}

if (found.length > 0) {
  console.error("Real timers in tests. Use fake timers, or wait on the event itself:");
  for (const line of found) console.error(`  ${line}`);
  console.error("A line that truly needs one says why: // real-timer: <reason>");
  process.exit(1);
}
console.log("No real timers in v2 tests.");
