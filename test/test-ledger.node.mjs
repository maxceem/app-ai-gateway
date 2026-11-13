import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { analyze, loadRuns, renderMarkdown, repoView } from "../scripts/test-ledger/analyze.mjs";
import { classifyPath } from "../scripts/test-ledger/paths.mjs";

const NOW = new Date("2026-06-01T12:00:00Z");
const FILE = "test/a.test.ts";
const NAME = "a > works";
const ID = `${FILE} > ${NAME}`;

let counter = 0;
function run({ day, source = "local", host = "h1", checkout = "c1", code = "A", files = {}, tests }) {
  counter++;
  const at = new Date(NOW.getTime() - day * 86_400_000 + counter * 1000).toISOString();
  return {
    kind: "run",
    v: 1,
    runId: `r${counter}`,
    suite: "worker",
    source,
    host,
    checkout,
    branch: "secret-branch-name",
    code,
    testFiles: { [FILE]: "t1", "test/helpers.ts": "h1", ...files },
    startedAt: at,
    modules: [],
    tests: tests.map(([state, file = FILE, name = NAME, ms = 5]) => ({ kind: "test", file, name, state, ms })),
  };
}

const one = (report, id = ID) => report.candidates.filter((c) => c.id === id).map((c) => c.kind);
const stats = (runs) => analyze(runs, { now: NOW });

test("a failure fixed by changing only the code is a caught regression", () => {
  const report = stats([
    run({ day: 3, code: "A", tests: [["passed"]] }),
    run({ day: 2, code: "B", tests: [["failed"]] }),
    run({ day: 1, code: "C", tests: [["passed"]] }),
  ]);
  assert.equal(report.history.totals.caught, 1);
  assert.deepEqual(report.valuable.map((v) => [v.id, v.caught]), [[ID, 1]]);
});

test("a failure fixed by editing the test counts against it, and twice makes it a candidate", () => {
  const report = stats([
    run({ day: 5, code: "A", tests: [["passed"]] }),
    run({ day: 4, code: "B", tests: [["failed"]] }),
    run({ day: 4, code: "B", files: { [FILE]: "t2" }, tests: [["passed"]] }),
    run({ day: 3, code: "C", files: { [FILE]: "t2" }, tests: [["failed"]] }),
    run({ day: 2, code: "C", files: { [FILE]: "t3" }, tests: [["passed"]] }),
  ]);
  assert.equal(report.history.totals.testEdited, 2);
  assert.deepEqual(one(report), ["edited-not-caught"]);
});

test("a new or just-rewritten test going red then green is ordinary work, not a catch", () => {
  const report = stats([
    // New: never passed before failing.
    run({ day: 6, code: "A", tests: [["failed"]] }),
    run({ day: 5, code: "B", tests: [["passed"]] }),
    // Rewritten, then the code made to match it.
    run({ day: 4, code: "B", files: { [FILE]: "t2" }, tests: [["failed"]] }),
    run({ day: 3, code: "C", files: { [FILE]: "t2" }, tests: [["passed"]] }),
  ]);
  assert.equal(report.history.totals.redGreen, 2);
  assert.equal(report.history.totals.caught, 0);
});

test("editing another test file does not hide a catch", () => {
  const report = stats([
    run({ day: 3, code: "A", tests: [["passed"]] }),
    run({ day: 2, code: "B", files: { "test/other.test.ts": "o2" }, tests: [["failed"]] }),
    run({ day: 1, code: "C", files: { "test/other.test.ts": "o3" }, tests: [["passed"]] }),
  ]);
  assert.equal(report.history.totals.caught, 1);
});

test("passing and failing on the same inputs is a flake, on any machine", () => {
  const report = stats([
    run({ day: 3, source: "ci", host: "ci", checkout: "x", code: "A", tests: [["passed"]] }),
    run({ day: 2, code: "A", tests: [["failed"]] }),
  ]);
  assert.deepEqual(one(report), ["flaky"]);
});

test("a run that broke as a whole says nothing about its tests", () => {
  const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const report = stats([
    run({ day: 3, code: "A", tests: many.map((name) => ["passed", FILE, name]) }),
    run({ day: 2, code: "B", tests: many.map((name) => ["failed", FILE, name]) }),
    run({ day: 1, code: "C", tests: many.map((name) => ["passed", FILE, name]) }),
  ]);
  assert.equal(report.history.brokenRuns, 1);
  assert.equal(report.history.totals.caught, 0);
  assert.equal(report.history.totals.flaky, 0);
});

test("slow tests are proposed for speeding up, preferring CI timings", () => {
  const report = stats([
    run({ day: 3, source: "ci", tests: [["passed", FILE, NAME, 1500]] }),
    run({ day: 2, source: "ci", tests: [["passed", FILE, NAME, 1600]] }),
    run({ day: 1, source: "ci", tests: [["passed", FILE, NAME, 1400]] }),
    run({ day: 1, tests: [["passed", FILE, NAME, 9000]] }),
  ]);
  const slow = report.candidates.find((c) => c.kind === "slow");
  assert.equal(slow.evidence.medianMs, 1500);
});

test("idle tests wait for enough history, then whole idle files are proposed unless kept", () => {
  const history = (days) =>
    Array.from({ length: 25 }, (_, i) => run({ day: days - (i * (days - 1)) / 24, source: i % 2 ? "ci" : "local", tests: [["passed"], ["passed", "test/b.test.ts", "b > works"]] }));
  const young = stats(history(20));
  assert.equal(young.candidates.filter((c) => c.kind.startsWith("idle")).length, 0);
  assert.match(young.idleNote, /needs 28/);

  const old = history(40);
  const proposed = analyze(old, { now: NOW, repo: { keep: { files: {}, tests: {} }, exists: () => true, resolve: (f) => f } });
  assert.deepEqual(proposed.candidates.filter((c) => c.kind === "idle-file").map((c) => c.file).sort(), [FILE, "test/b.test.ts"]);

  const kept = analyze(old, { now: NOW, repo: { keep: { files: { [FILE]: "guards migrations" }, tests: {} }, exists: () => true, resolve: (f) => f } });
  assert.deepEqual(kept.candidates.filter((c) => c.kind === "idle-file").map((c) => c.file), ["test/b.test.ts"]);
});

test("missing CI or local runs are reported", () => {
  const report = stats([run({ day: 1, tests: [["passed"]] })]);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /No CI test runs/);
  assert.equal(report.actionable, true);
});

test("a test run inside a barrel is attributed to the file that declares it", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "ledger-repo-"));
  mkdirSync(path.join(repo, "test/suites"), { recursive: true });
  writeFileSync(path.join(repo, "test/suites/x.suite.ts"), 'import "../one.test";\nimport "../two.test";\n');
  writeFileSync(path.join(repo, "test/one.test.ts"), 'describe("one", () => { it("works", () => {}); });');
  writeFileSync(path.join(repo, "test/two.test.ts"), 'describe("two", () => { it(`works`, () => {}); });');
  writeFileSync(path.join(repo, "test/three.test.ts"), 'describe("three", () => { for (const n of [1]) it(`case ${n}`, () => {}); });');
  writeFileSync(path.join(repo, "test/suites/x.suite.ts"), 'import "../one.test";\nimport "../two.test";\nimport "../three.test";\n');
  const view = repoView(repo);
  assert.equal(view.resolve("test/suites/x.suite.ts", "two > works"), "test/two.test.ts");
  assert.equal(view.resolve("test/suites/x.suite.ts", "one > works"), "test/one.test.ts");
  assert.equal(view.resolve("test/suites/x.suite.ts", "nobody > declares this"), "test/suites/x.suite.ts");
  assert.equal(view.resolve("test/suites/x.suite.ts", "three > case 1"), "test/three.test.ts");
  assert.equal(view.resolve("test/one.test.ts", "one > works"), "test/one.test.ts");
});

test("runs load from compressed files once each, and the report names no branch or machine", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-runs-"));
  const r = run({ day: 1, source: "ci", tests: [["passed"]] });
  const { modules, tests, ...header } = r;
  const text = [header, ...tests].map((line) => JSON.stringify(line)).join("\n");
  for (const copy of ["a", "b"]) {
    mkdirSync(path.join(dir, copy), { recursive: true });
    writeFileSync(path.join(dir, copy, "r.jsonl.gz"), gzipSync(text));
  }
  writeFileSync(path.join(dir, "a", "broken.jsonl.gz"), "not gzip");
  const runs = loadRuns([dir]);
  assert.equal(runs.length, 1);
  const markdown = renderMarkdown(analyze(runs, { now: NOW }));
  assert.doesNotMatch(markdown, /secret-branch-name|h1\b|c1\b/);
});

test("files are split into code and tests, and the rest is ignored", () => {
  assert.equal(classifyPath("src/index.ts"), "code");
  assert.equal(classifyPath("console/src/App.tsx"), "code");
  assert.equal(classifyPath("console/src/App.test.tsx"), "test");
  assert.equal(classifyPath("test/helpers.ts"), "test");
  assert.equal(classifyPath("cli/test/cli.test.ts"), "test");
  assert.equal(classifyPath("smoke/tests/monitor/x.smoke.ts"), "test");
  assert.equal(classifyPath("docs/content/docs/index.mdx"), null);
  assert.equal(classifyPath("README.md"), null);
});
