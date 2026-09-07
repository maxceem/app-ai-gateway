import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// Every step is a package.json script, run exactly as `pnpm run <name>` would
// run it. This file only decides what runs alongside what; the commands
// themselves live in package.json and are not repeated here.
//
// Sorted longest-first: the scheduler starts them in this order, so the two
// slow suites claim a slot before the short steps can crowd them out.
const steps = [
  "test:worker",
  "console:test",
  "docs:typecheck",
  "typecheck:bindings",
  "openapi:check",
  "typecheck:worker",
  "console:typecheck",
  "test:deploy-script",
];

const pnpm = process.env.npm_execpath ?? "pnpm";
const runsUnderNode = pnpm.endsWith(".cjs") || pnpm.endsWith(".js") || pnpm.endsWith(".mjs");

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = ["run", name];
    const child = runsUnderNode
      ? spawn(process.execPath, [pnpm, ...args], { cwd: projectRoot })
      : spawn(pnpm, args, { cwd: projectRoot });

    // Buffered, not streamed: parallel steps would otherwise interleave their
    // output line by line and make a failure impossible to read.
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ name, ok: false, output: String(error), seconds: 0 }));
    child.on("close", (code) => {
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`${code === 0 ? "PASS" : "FAIL"} ${name} (${seconds}s)`);
      resolve({ name, ok: code === 0, output, seconds });
    });
  });
}

// A pool rather than fixed lanes: the steps differ in cost by more than an
// order of magnitude, so hand-pairing them into lanes leaves one idle. Three
// slots is the useful width — the two test suites already run their own worker
// pools underneath, and a fourth concurrent step only makes them contend.
const slots = Math.max(2, Math.min(3, Math.floor(availableParallelism() / 4)));

for (const name of steps) console.log(`  ... ${name}`);

const started = Date.now();
const queue = [...steps];
const results = [];
let failed = false;

await Promise.all(
  Array.from({ length: slots }, async () => {
    // Stop taking work once something has failed: the run already has to be
    // fixed and repeated, so later steps would only add noise and delay.
    while (queue.length > 0 && !failed) {
      const result = await run(queue.shift());
      results.push(result);
      if (!result.ok) failed = true;
    }
  }),
);

const failures = results.filter((result) => !result.ok);
for (const failure of failures) {
  console.error(`\n${"=".repeat(70)}\n${failure.name} failed\n${"=".repeat(70)}\n${failure.output}`);
}

const total = Math.round((Date.now() - started) / 1000);
if (failures.length > 0) {
  const skipped = steps.length - results.length;
  console.error(
    `\ncheck failed in ${total}s: ${failures.map((f) => f.name).join(", ")}` +
      (skipped > 0 ? ` (${skipped} step${skipped === 1 ? "" : "s"} not run)` : ""),
  );
  process.exit(1);
}
console.log(`\ncheck passed in ${total}s`);
