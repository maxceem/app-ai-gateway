import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// Lanes run in parallel; the steps inside a lane run in order. The split pairs
// the slowest step with the fastest so both lanes finish at about the same
// time. The two Vitest suites do briefly overlap and slow each other down,
// because each drives its own worker pool, but filling the second lane still
// beats leaving it idle: measured end to end, this ordering runs in ~100s
// against ~230s for the old fully serial chain.
const lanes = [
  [
    { name: "test", args: ["run", "test"] },
    { name: "openapi:check", args: ["run", "openapi:check"] },
  ],
  [
    { name: "typecheck", args: ["run", "typecheck"] },
    { name: "console:test", args: ["run", "console:test"] },
  ],
];

const pnpm = process.env.npm_execpath ?? "pnpm";
const runsUnderNode = pnpm.endsWith(".cjs") || pnpm.endsWith(".js") || pnpm.endsWith(".mjs");

function run(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = runsUnderNode
      ? spawn(process.execPath, [pnpm, ...step.args], { cwd: projectRoot })
      : spawn(pnpm, step.args, { cwd: projectRoot });

    // Buffered, not streamed: parallel lanes would otherwise interleave their
    // output line by line and make a failure impossible to read.
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ ...step, ok: false, output: String(error), seconds: 0 }));
    child.on("close", (code) => {
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`${code === 0 ? "PASS" : "FAIL"} ${step.name} (${seconds}s)`);
      resolve({ ...step, ok: code === 0, output, seconds });
    });
  });
}

async function runLane(steps) {
  const results = [];
  for (const step of steps) {
    const result = await run(step);
    results.push(result);
    // Stop the lane at the first failure: later steps in it would only add
    // noise to a run that already has to be fixed and repeated.
    if (!result.ok) break;
  }
  return results;
}

for (const step of lanes.flat()) console.log(`  ... ${step.name}`);

const started = Date.now();
const results = (await Promise.all(lanes.map(runLane))).flat();
const failures = results.filter((result) => !result.ok);

for (const failure of failures) {
  console.error(`\n${"=".repeat(70)}\n${failure.name} failed\n${"=".repeat(70)}\n${failure.output}`);
}

const total = Math.round((Date.now() - started) / 1000);
if (failures.length > 0) {
  console.error(`\ncheck failed in ${total}s: ${failures.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
console.log(`\ncheck passed in ${total}s`);
