#!/usr/bin/env node
// Reads test-ledger runs (written by reporter.mjs) and writes a report of
// which tests earn their cost. Deterministic: the same records, repository and
// `--now` always give the same report. It decides nothing on its own; it
// proposes candidates with their evidence, and a person or an agent checks
// each one before a test is changed.
//
//   node scripts/test-ledger/analyze.mjs --records <dir> [--records <dir>...]
//        [--repo <checkout>] [--out <dir>] [--now <iso>] [--window-days 56]
//
// See README.md beside this file for what each signal means.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const DAY = 24 * 60 * 60 * 1000;

export const RULES = {
  windowDays: 56,
  // Below this much history no test is called idle: it has not had the
  // chance to fail yet.
  idleAfterDays: 28,
  idleMinRuns: 20,
  slowTestMs: 1000,
  slowMinRuns: 3,
  editedMinTimes: 2,
  // A run where this many tests failed broke as a whole (a syntax error, a
  // crashed runtime), so its failures say nothing about any one test.
  brokenRunMinFailures: 10,
  brokenRunShare: 0.2,
  perKind: 5,
  quietDays: 8,
};

// ---------------------------------------------------------------- loading

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".jsonl.gz")) yield full;
  }
}

export function parseRun(text) {
  const lines = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const [run, ...rest] = lines;
  if (run?.kind !== "run" || run.v !== 1) return null;
  return { ...run, modules: rest.filter((l) => l.kind === "module"), tests: rest.filter((l) => l.kind === "test") };
}

export function loadRuns(dirs) {
  const runs = new Map();
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      try {
        const run = parseRun(gunzipSync(readFileSync(file)).toString("utf8"));
        // The same run can arrive by two routes; its id makes it count once.
        if (run) runs.set(run.runId, run);
      } catch {
        // A damaged file is skipped, not fatal: the rest still tell the story.
      }
    }
  }
  return [...runs.values()];
}

// ---------------------------------------------------- the repository side

// The whole-suite run executes barrels (test/suites/*.suite.ts) that import
// the real test files, so its results name the barrel. This finds the member
// file that declares a test, by its name, so a test has one identity whether
// it ran on its own or inside a barrel.
export function repoView(repo) {
  const sources = new Map();
  const read = (file) => {
    if (!sources.has(file)) {
      const full = path.join(repo, file);
      sources.set(file, existsSync(full) ? readFileSync(full, "utf8") : null);
    }
    return sources.get(file);
  };
  const members = (barrel) =>
    [...(read(barrel) ?? "").matchAll(/^import "\.\.\/(.+)\.test";$/gm)].map(([, name]) => `test/${name}.test.ts`);
  const declares = (source, segment) => [`"${segment}"`, `'${segment}'`, `\`${segment}\``].some((s) => source.includes(s));
  let keep = { files: {}, tests: {} };
  const keepFile = read("scripts/test-ledger/keep.json");
  if (keepFile) keep = { files: {}, tests: {}, ...JSON.parse(keepFile) };
  return {
    keep,
    exists: (file) => read(file) !== null,
    resolve(file, name) {
      if (!/^test\/suites\/.+\.suite\.ts$/.test(file)) return file;
      // The member that spells out the most of the test's name wins: its own
      // name first, then the describe blocks around it, which also covers
      // test names built from a variable or by `it.each`.
      const segments = name.split(" > ");
      let best = file;
      let bestScore = 0;
      for (const member of members(file)) {
        const source = read(member);
        if (!source) continue;
        const score = segments.reduce((total, segment, i) => total + (declares(source, segment) ? (i === segments.length - 1 ? 100 : 1) : 0), 0);
        if (score > bestScore) [best, bestScore] = [member, score];
      }
      return best;
    },
  };
}

// ---------------------------------------------------------------- analysis

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

// What a test ran against, on the tests' side: its own file, plus the shared
// helpers and setup of its area (but not the barrels, which only list files).
// Another test file changing does not change it.
const AREAS = ["test/", "console/src/", "cli/", "smoke/"];
const areaOf = (file) => AREAS.find((area) => file.startsWith(area)) ?? "";
const isTestFile = (file) => /\.test\.[cm]?[jt]sx?$/.test(file);

function testInputs(run) {
  const support = new Map();
  for (const [file, blob] of Object.entries(run.testFiles ?? {})) {
    if (isTestFile(file) || file.startsWith("test/suites/")) continue;
    const area = areaOf(file);
    support.set(area, `${support.get(area) ?? ""}${file} ${blob}\n`);
  }
  const digests = new Map([...support].map(([area, text]) => [area, createHash("sha256").update(text).digest("hex").slice(0, 12)]));
  return (file) => `${run.testFiles?.[file] ?? "-"}:${digests.get(areaOf(file)) ?? "-"}`;
}

function isBroken(run) {
  const failed = run.tests.filter((t) => t.state === "failed").length;
  return failed >= RULES.brokenRunMinFailures && failed / Math.max(1, run.tests.length) >= RULES.brokenRunShare;
}

export function analyze(allRuns, { now = new Date(), repo, rules = RULES } = {}) {
  const nowMs = now.getTime();
  const since = nowMs - rules.windowDays * DAY;
  const view = repo ?? { keep: { files: {}, tests: {} }, exists: () => true, resolve: (file) => file };
  const runs = allRuns
    .filter((run) => Date.parse(run.startedAt) >= since && Date.parse(run.startedAt) <= nowMs)
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.runId < b.runId ? -1 : 1));

  const tests = new Map();
  const stat = (id, file, name) => {
    if (!tests.has(id)) {
      tests.set(id, { id, file, name, runs: 0, fails: 0, caught: 0, redGreen: 0, testEdited: 0, mixed: 0, flaky: 0, ciMs: [], ms: [], first: null, last: null, outcomes: new Map() });
    }
    return tests.get(id);
  };

  // Each test's history per checkout, in order: a failure is explained by the
  // checkout's next passing run of the same test.
  const sequences = new Map();
  let brokenRuns = 0;
  for (const run of runs) {
    const broken = isBroken(run);
    if (broken) brokenRuns++;
    const inputsOf = testInputs(run);
    for (const t of run.tests) {
      const file = view.resolve(t.file, t.name);
      const id = `${file} > ${t.name}`;
      const s = stat(id, file, t.name);
      s.runs++;
      s.first ??= run.startedAt;
      s.last = run.startedAt;
      if (t.state === "passed") (run.source === "ci" ? s.ciMs : s.ms).push(t.ms);
      if (broken) continue;
      if (t.state === "failed") s.fails++;
      const inputs = inputsOf(file);
      const pair = `${run.code}:${inputs}`;
      if (!s.outcomes.has(pair)) s.outcomes.set(pair, new Set());
      s.outcomes.get(pair).add(t.state);
      const key = `${run.host}|${run.checkout}|${id}`;
      if (!sequences.has(key)) sequences.set(key, []);
      sequences.get(key).push({ state: t.state, code: run.code, test: inputs });
    }
  }

  for (const [key, events] of sequences) {
    const s = tests.get(key.slice(key.indexOf("|", key.indexOf("|") + 1) + 1));
    let lastPass = null;
    let firstFailure = null;
    let lastFailure = null;
    for (const event of events) {
      if (event.state === "failed") {
        firstFailure ??= event;
        lastFailure = event;
        continue;
      }
      if (event.state !== "passed") continue;
      if (lastFailure) {
        // What turned it red: only a change to the code, with the test as it
        // was when it last passed, makes it a regression the test caught. A
        // test that went red because it was new or just rewritten is ordinary
        // red-green work and says nothing about its value.
        const brokenByCode = lastPass && lastPass.test === firstFailure.test && lastPass.code !== firstFailure.code;
        const sameAsBefore = lastPass && lastPass.test === firstFailure.test && lastPass.code === firstFailure.code;
        // What turned it green again.
        const codeFix = lastFailure.code !== event.code;
        const testFix = lastFailure.test !== event.test;
        if (!codeFix && !testFix) {
          // Same code, same test, different result: a flake, counted below.
        } else if (sameAsBefore) {
          // Failed on the inputs it had passed with: also a flake.
        } else if (!brokenByCode) s.redGreen++;
        else if (codeFix && !testFix) s.caught++;
        else if (testFix && !codeFix) s.testEdited++;
        else s.mixed++;
      }
      lastPass = event;
      firstFailure = lastFailure = null;
    }
  }
  for (const s of tests.values()) {
    s.flaky = [...s.outcomes.values()].filter((states) => states.has("passed") && states.has("failed")).length;
    s.medianMs = median(s.ciMs.length >= 3 ? s.ciMs : [...s.ciMs, ...s.ms]);
  }

  // Only tests that still exist and ran lately are judged.
  const current = [...tests.values()].filter(
    (s) => view.exists(s.file) && nowMs - Date.parse(s.last) <= rules.quietDays * 2 * DAY,
  );
  const firstRecord = runs[0]?.startedAt ?? null;
  const historyDays = firstRecord ? Math.floor((nowMs - Date.parse(firstRecord)) / DAY) : 0;
  const kept = (s) => Boolean(view.keep.files[s.file] || view.keep.tests[s.id]);
  const evidence = (s) => ({
    runs: s.runs,
    fails: s.fails,
    caught: s.caught,
    testEdited: s.testEdited,
    flaky: s.flaky,
    medianMs: s.medianMs,
    firstSeen: s.first.slice(0, 10),
  });
  const pick = (list, order) => list.sort(order).slice(0, rules.perKind);
  const byId = (a, b) => (a.id < b.id ? -1 : 1);

  const candidates = [];
  for (const s of pick(current.filter((s) => s.flaky > 0), (a, b) => b.flaky - a.flaky || byId(a, b))) {
    candidates.push({ kind: "flaky", ...ref(s), evidence: evidence(s), reason: `passed and failed on the same code and tests ${s.flaky} time(s)` });
  }
  for (const s of pick(
    current.filter((s) => !kept(s) && s.testEdited >= rules.editedMinTimes && s.testEdited > s.caught),
    (a, b) => b.testEdited - a.testEdited || byId(a, b),
  )) {
    candidates.push({
      kind: "edited-not-caught",
      ...ref(s),
      evidence: evidence(s),
      reason: `went red ${s.testEdited} times and was made green by editing the test, but caught a code change only ${s.caught} time(s)`,
    });
  }
  for (const s of pick(current.filter((s) => s.medianMs >= rules.slowTestMs && s.runs >= rules.slowMinRuns), (a, b) => b.medianMs - a.medianMs || byId(a, b))) {
    candidates.push({ kind: "slow", ...ref(s), evidence: evidence(s), reason: `takes ${(s.medianMs / 1000).toFixed(1)}s per run (median)` });
  }

  // Idle: never failed for a long stretch of runs. Most tests are idle by
  // nature (they guard something that rarely breaks), so only the costliest
  // are proposed each week, whole files first, and keep.json remembers the
  // ones already looked at.
  let idleNote = null;
  if (historyDays < rules.idleAfterDays) {
    idleNote = `Idle tests are not judged yet: the ledger holds ${historyDays} day(s) of history and needs ${rules.idleAfterDays}.`;
  } else {
    const idle = current.filter(
      (s) => !kept(s) && s.fails === 0 && s.runs >= rules.idleMinRuns && nowMs - Date.parse(s.first) >= rules.idleAfterDays * DAY,
    );
    const byFile = new Map();
    for (const s of current) {
      if (!byFile.has(s.file)) byFile.set(s.file, { all: 0, idle: [] });
      byFile.get(s.file).all++;
    }
    for (const s of idle) byFile.get(s.file).idle.push(s);
    const files = [...byFile]
      .filter(([, f]) => f.idle.length === f.all && f.all > 0)
      .map(([file, f]) => ({ file, tests: f.all, ms: f.idle.reduce((sum, s) => sum + s.medianMs, 0), runs: Math.min(...f.idle.map((s) => s.runs)) }))
      .sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : 1));
    const idleFiles = new Set(files.slice(0, rules.perKind).map((f) => f.file));
    for (const f of files.slice(0, rules.perKind)) {
      candidates.push({
        kind: "idle-file",
        file: f.file,
        evidence: { tests: f.tests, runs: f.runs, fails: 0, medianMs: f.ms },
        reason: `none of its ${f.tests} test(s) failed in ${f.runs}+ runs over ${rules.idleAfterDays}+ days`,
      });
    }
    for (const s of pick(
      idle.filter((s) => !idleFiles.has(s.file) && s.medianMs >= rules.slowTestMs / 4),
      (a, b) => b.medianMs - a.medianMs || byId(a, b),
    )) {
      candidates.push({ kind: "idle-test", ...ref(s), evidence: evidence(s), reason: `never failed in ${s.runs} runs over ${rules.idleAfterDays}+ days, and costs ${s.medianMs}ms a run` });
    }
  }

  // Files by what they cost to run, from whole-suite runs in CI, where the
  // machine is the same every time.
  const moduleMs = new Map();
  for (const run of runs) {
    if (run.source !== "ci") continue;
    for (const m of run.modules) {
      if (!moduleMs.has(m.file)) moduleMs.set(m.file, { ms: [], loadMs: [] });
      moduleMs.get(m.file).ms.push(m.ms);
      moduleMs.get(m.file).loadMs.push(m.loadMs);
    }
  }
  const costliestFiles = [...moduleMs]
    .map(([file, m]) => ({ file, medianMs: median(m.ms), medianLoadMs: median(m.loadMs), runs: m.ms.length }))
    .sort((a, b) => b.medianMs - a.medianMs || (a.file < b.file ? -1 : 1))
    .slice(0, 12);

  const lastBySource = (source) => runs.filter((r) => r.source === source).at(-1)?.startedAt ?? null;
  const warnings = [];
  for (const source of ["ci", "local"]) {
    const last = lastBySource(source);
    if (!last || nowMs - Date.parse(last) > rules.quietDays * DAY) {
      warnings.push(`No ${source === "ci" ? "CI" : "local"} test runs recorded in the last ${rules.quietDays} days${last ? ` (last: ${last.slice(0, 10)})` : ""}.`);
    }
  }

  const valuable = current
    .filter((s) => s.caught > 0)
    .sort((a, b) => b.caught - a.caught || byId(a, b))
    .slice(0, 10)
    .map((s) => ({ ...ref(s), caught: s.caught, runs: s.runs }));

  return {
    version: 1,
    generatedAt: now.toISOString(),
    windowDays: rules.windowDays,
    history: {
      firstRecord,
      days: historyDays,
      runs: { ci: runs.filter((r) => r.source === "ci").length, local: runs.filter((r) => r.source === "local").length },
      brokenRuns,
      testsTracked: current.length,
      totals: {
        caught: sum(current, "caught"),
        testEdited: sum(current, "testEdited"),
        redGreen: sum(current, "redGreen"),
        mixed: sum(current, "mixed"),
        flaky: sum(current, "flaky"),
      },
    },
    warnings,
    idleNote,
    candidates,
    valuable,
    costliestFiles,
    actionable: candidates.length > 0 || warnings.length > 0,
  };
}

const ref = (s) => ({ id: s.id, file: s.file, name: s.name });
const sum = (list, field) => list.reduce((total, s) => total + s[field], 0);

// ---------------------------------------------------------------- output

const KIND_TITLE = {
  flaky: "Flaky: fix first",
  "edited-not-caught": "Fails only when edited: rewrite or remove",
  slow: "Slow: speed up",
  "idle-file": "Idle files: check whether they are redundant",
  "idle-test": "Idle and costly tests: check whether they are redundant",
};

export function renderMarkdown(report) {
  const h = report.history;
  const out = [
    `# Test ledger report, ${report.generatedAt.slice(0, 10)}`,
    "",
    `Last ${report.windowDays} days: ${h.runs.ci} CI runs and ${h.runs.local} local runs (${h.days} day(s) of history), ${h.testsTracked} tests tracked.`,
    `Regressions caught: ${h.totals.caught}. Failures fixed by editing the test: ${h.totals.testEdited}. New or rewritten tests made to pass: ${h.totals.redGreen}. Fixed by changing both: ${h.totals.mixed}. Flaky outcomes: ${h.totals.flaky}. Runs that broke as a whole and were ignored: ${h.brokenRuns}.`,
    "",
  ];
  if (report.warnings.length) out.push("## Warnings", "", ...report.warnings.map((w) => `- ${w}`), "");
  const kinds = Object.keys(KIND_TITLE).filter((k) => report.candidates.some((c) => c.kind === k));
  if (kinds.length === 0) out.push("No candidates this week.", "");
  for (const kind of kinds) {
    out.push(`## ${KIND_TITLE[kind]}`, "", "| Test | Why | Runs | Fails | Caught | Median |", "|---|---|---|---|---|---|");
    for (const c of report.candidates.filter((c) => c.kind === kind)) {
      const e = c.evidence;
      const what = c.name ? `\`${c.file}\` › ${c.name}` : `\`${c.file}\``;
      out.push(`| ${what.replaceAll("|", "\\|")} | ${c.reason} | ${e.runs} | ${e.fails} | ${e.caught ?? "–"} | ${e.medianMs}ms |`);
    }
    out.push("");
  }
  if (report.idleNote) out.push(`_${report.idleNote}_`, "");
  if (report.valuable.length) {
    out.push("## Tests that caught regressions", "", "| Test | Caught | Runs |", "|---|---|---|");
    for (const v of report.valuable) out.push(`| \`${v.file}\` › ${v.name.replaceAll("|", "\\|")} | ${v.caught} | ${v.runs} |`);
    out.push("");
  }
  if (report.costliestFiles.length) {
    out.push("## Costliest files in CI", "", "| File | Median | Of which loading | Runs |", "|---|---|---|---|");
    for (const f of report.costliestFiles) out.push(`| \`${f.file}\` | ${(f.medianMs / 1000).toFixed(1)}s | ${(f.medianLoadMs / 1000).toFixed(1)}s | ${f.runs} |`);
    out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { records: [], repo: null, out: null, now: null, windowDays: RULES.windowDays };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--records": args.records.push(value); i++; break;
      case "--repo": args.repo = value; i++; break;
      case "--out": args.out = value; i++; break;
      case "--now": args.now = value; i++; break;
      case "--window-days": args.windowDays = Number(value); i++; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (args.records.length === 0) throw new Error("at least one --records <dir> is required");
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const report = analyze(loadRuns(args.records), {
    now: args.now ? new Date(args.now) : new Date(),
    repo: repoView(repo),
    rules: { ...RULES, windowDays: args.windowDays },
  });
  const markdown = renderMarkdown(report);
  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(path.join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(path.join(args.out, "report.md"), markdown + "\n");
    console.log(`${report.candidates.length} candidate(s), ${report.warnings.length} warning(s), actionable: ${report.actionable}`);
  } else {
    console.log(markdown);
  }
}
