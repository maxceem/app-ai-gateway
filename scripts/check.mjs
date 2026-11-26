import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { runStep, silenceLimitMs } from "./check-step.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// Every step is a package.json script, run exactly as `pnpm run <name>` would
// run it. This file only decides what runs alongside what; the commands
// themselves live in package.json and are not repeated here.
//
// One scheduler behind three entry points, so each tier gets the same pooling:
//
//   check   the type checks and the generated-document check, a few seconds
//   test    both suites, a couple of minutes, because every Vitest worker boots
//           the Workers runtime and replays the D1 migrations
//   verify  everything, and no slower than `test` alone: the checks finish
//           inside the shadow of the suites rather than after them
//
// Declared longest-first, which is the order the scheduler starts them in, so
// the two slow suites claim a slot before the short steps can crowd them out.
// `verify` is every step rather than a third list, so a step added here reaches
// it without being named twice.
const steps = [
  { name: "cli:check", tier: "check" },
  { name: "cli:test", tier: "test" },
  { name: "test:worker", tier: "test" },
  { name: "console:test", tier: "test" },
  { name: "docs:typecheck", tier: "check" },
  { name: "typecheck:bindings", tier: "check" },
  { name: "openapi:check", tier: "check" },
  { name: "suites:check", tier: "check" },
  { name: "typecheck:worker", tier: "check" },
  { name: "console:typecheck", tier: "check" },
  { name: "test:deploy-script", tier: "test" },
  { name: "test:swift-publish", tier: "test" },
  { name: "test:release-script", tier: "test" },
  { name: "test:prices-deploy", tier: "test" },
  { name: "test:price-update", tier: "test" },
  { name: "test:indexnow", tier: "test" },
  { name: "test:test-ledger", tier: "test" },
  { name: "test:check-script", tier: "test" },
  { name: "smoke:check", tier: "check" },
  { name: "smoke:test", tier: "test" },
  { name: "v2:check", tier: "check" },
  { name: "v2:test", tier: "test" },
  { name: "v2:console:check", tier: "check" },
  { name: "v2:console:test", tier: "test" },
  { name: "v2:cli:check", tier: "check" },
  { name: "v2:cli:test", tier: "test" },
  { name: "v2:timers:check", tier: "check" },
  // Last: it starts Wrangler's local runtime several times, which would slow
  // the suites beside it, so it takes a slot only once the rest have one.
  { name: "v2:scripts:test", tier: "test" },
];

const tier = process.argv[2];
if (tier !== "check" && tier !== "test" && tier !== "verify") {
  console.error("usage: node scripts/check.mjs <check|test|verify>");
  process.exit(2);
}
const selected = steps
  .filter((step) => tier === "verify" || step.tier === tier)
  .map((step) => step.name);

const pnpm = process.env.npm_execpath ?? "pnpm";
const runsUnderNode = pnpm.endsWith(".cjs") || pnpm.endsWith(".js") || pnpm.endsWith(".mjs");

// A step that prints nothing for this long is frozen and gets stopped
// (`scripts/check-step.mjs`).
let silenceMs;
try {
  silenceMs = silenceLimitMs();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

function run(name) {
  const args = ["run", name];
  return runsUnderNode
    ? runStep(name, process.execPath, [pnpm, ...args], { cwd: projectRoot, silenceMs })
    : runStep(name, pnpm, args, { cwd: projectRoot, silenceMs });
}

// A pool rather than fixed lanes: the steps differ in cost by more than an
// order of magnitude, so hand-pairing them into lanes leaves one idle. Three
// slots is the useful width — the two test suites already run their own worker
// pools underneath, and a fourth concurrent step only makes them contend.
const slots = Math.max(2, Math.min(3, Math.floor(availableParallelism() / 4)));

for (const name of selected) console.log(`  ... ${name}`);

const started = Date.now();
const queue = [...selected];
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
  const skipped = selected.length - results.length;
  console.error(
    `\n${tier} failed in ${total}s: ${failures.map((f) => f.name).join(", ")}` +
      (skipped > 0 ? ` (${skipped} step${skipped === 1 ? "" : "s"} not run)` : ""),
  );
  process.exit(1);
}
console.log(`\n${tier} passed in ${total}s`);
