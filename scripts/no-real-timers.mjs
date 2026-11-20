// Refuses real timers in v2's tests: no `setTimeout`, `setInterval` or sleep
// helper. A test uses fake timers, or waits on the event itself (a promise the
// fake resolves, `waitFor`, a fake the test releases). Real timers make tests
// slower and flaky.
//
// A line that truly needs one says why: `// real-timer: <reason>`.
//
// Smoke checks (`v2/smoke`) are not scanned. They run against a live
// deployment and may pause between polls, inside a loop with a deadline that
// checks the real result.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Where tests live, and which files in there count as tests. */
const scopes = [
  { dir: "v2/test", file: /\.tsx?$/ },
  { dir: "v2/console/src", file: /(\.test\.tsx?$)|(\/test\/[^/]+\.tsx?$)/ },
  { dir: "v2/cli/test", file: /\.tsx?$/ },
];

const timer = /\b(?:setTimeout|setInterval|sleep|scheduler\.wait)\s*\(/;
const allowed = /\/\/\s*real-timer:\s*\S/;

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

const found = [];
for (const scope of scopes) {
  for (const path of files(join(root, scope.dir))) {
    const name = relative(root, path);
    if (!scope.file.test(name)) continue;
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const code = line.trimStart();
        if (code.startsWith("//") || code.startsWith("*")) return;
        if (timer.test(line) && !allowed.test(line)) found.push(`${name}:${index + 1}: ${code}`);
      });
  }
}

if (found.length > 0) {
  console.error("Real timers in tests. Use fake timers, or wait on the event itself:");
  for (const line of found) console.error(`  ${line}`);
  console.error("A line that truly needs one says why: // real-timer: <reason>");
  process.exit(1);
}
console.log("No real timers in v2 tests.");
