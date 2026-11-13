// A Vitest reporter that keeps a ledger of test results: one compressed file
// per run, with every test's outcome and duration and a fingerprint of the
// code and the tests it ran against. `analyze.mjs` reads a pile of these and
// works out which tests catch regressions, which are flaky, which fail only
// because they were edited, and which cost time without ever failing. See
// README.md beside this file.
//
// It writes nothing unless a ledger directory is chosen, so contributors and
// ordinary runs are unaffected:
//   TEST_LEDGER_DIR=<dir>          write there (CI sets this)
//   ~/.local/state/test-ledger/    write there if the directory exists
//   TEST_LEDGER=0                  never write
//
// A reporter must never be the reason a run fails, so every step is guarded
// and a problem is reported as one line on stderr.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { classifyPath } from "./paths.mjs";

export const LEDGER_VERSION = 1;

function ledgerDir() {
  if (process.env.TEST_LEDGER === "0") return null;
  if (process.env.TEST_LEDGER_DIR) return process.env.TEST_LEDGER_DIR;
  const state = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  const dir = path.join(state, "test-ledger");
  return existsSync(dir) ? dir : null;
}

function git(cwd, args, input) {
  return execFileSync("git", args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], maxBuffer: 64 << 20 });
}

const short = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

// The working tree as it is right now, committed or not: one digest over all
// the code, and the blob of every test file. Comparing them between a failing
// run and the next passing one tells what changed to make the test pass: the
// code, or that test's own file.
export function treeState(root) {
  const entries = new Map();
  for (const line of git(root, ["ls-files", "-s", "-z"]).split("\0")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    entries.set(line.slice(tab + 1), line.split(" ")[1]);
  }
  const dirty = git(root, ["ls-files", "-m", "-o", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const present = dirty.filter((file) => existsSync(path.join(root, file)));
  for (const file of dirty) if (!present.includes(file)) entries.delete(file);
  if (present.length > 0) {
    const hashes = git(root, ["hash-object", "--stdin-paths"], present.join("\n")).trim().split("\n");
    present.forEach((file, i) => entries.set(file, hashes[i]));
  }
  const code = [];
  const testFiles = {};
  for (const [file, blob] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const kind = classifyPath(file);
    if (kind === "code") code.push(`${file} ${blob}`);
    else if (kind === "test") testFiles[file] = blob.slice(0, 12);
  }
  return { code: short(code.join("\n")), testFiles };
}

export default class TestLedgerReporter {
  constructor(options = {}) {
    this.suite = options.suite ?? "vitest";
  }

  onInit(vitest) {
    this.dir = ledgerDir();
    if (!this.dir) return;
    this.started = Date.now();
    try {
      this.root = git(vitest.config.root, ["rev-parse", "--show-toplevel"]).trim();
      this.head = git(this.root, ["rev-parse", "HEAD"]).trim();
      this.branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git(this.root, ["branch", "--show-current"]).trim();
      this.tree = treeState(this.root);
    } catch (error) {
      console.error(`test-ledger: not recording this run (${error.message.split("\n")[0]})`);
      this.dir = null;
    }
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    if (!this.dir) return;
    try {
      this.write(testModules, unhandledErrors, reason);
    } catch (error) {
      console.error(`test-ledger: could not record this run (${error.message.split("\n")[0]})`);
    }
  }

  write(testModules, unhandledErrors, reason) {
    const relative = (file) => path.relative(this.root, file).split(path.sep).join("/");
    const ci = process.env.GITHUB_ACTIONS === "true";
    const runId = `${new Date(this.started).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(4).toString("hex")}`;
    const lines = [
      {
        kind: "run",
        v: LEDGER_VERSION,
        runId,
        suite: this.suite,
        source: ci ? "ci" : "local",
        // Hashed: the ledger groups runs by machine and checkout, and never
        // needs to know what they are called.
        host: short(ci ? "github-actions" : hostname()),
        // In CI, one branch's runs follow each other the way one checkout's do.
        checkout: short(ci ? `ci:${this.branch}` : this.root),
        branch: this.branch,
        head: this.head,
        code: this.tree.code,
        testFiles: this.tree.testFiles,
        startedAt: new Date(this.started).toISOString(),
        ms: Date.now() - this.started,
        reason,
        unhandledErrors: unhandledErrors.length,
        modules: testModules.length,
      },
    ];
    for (const module of testModules) {
      const file = relative(module.moduleId);
      const diagnostic = module.diagnostic();
      lines.push({
        kind: "module",
        file,
        state: module.state(),
        ms: Math.round(diagnostic.duration),
        loadMs: Math.round(diagnostic.collectDuration + diagnostic.setupDuration + diagnostic.environmentSetupDuration + diagnostic.prepareDuration),
      });
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (result.state === "skipped" || result.state === "pending") continue;
        const diagnostic = test.diagnostic();
        lines.push({
          kind: "test",
          file,
          name: test.fullName,
          state: result.state,
          ms: Math.round(diagnostic?.duration ?? 0),
          retries: diagnostic?.retryCount ?? 0,
        });
      }
    }
    const day = lines[0].startedAt.slice(0, 10);
    const dir = path.join(this.dir, "runs", day);
    mkdirSync(dir, { recursive: true });
    // Written under a temporary name and renamed, so whatever copies these
    // files elsewhere never picks up half of one.
    const target = path.join(dir, `${runId}.jsonl.gz`);
    writeFileSync(`${target}.tmp`, gzipSync(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"));
    renameSync(`${target}.tmp`, target);
  }
}
