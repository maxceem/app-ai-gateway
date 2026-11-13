# Test ledger

Which tests earn their cost? A test is worth its run time and upkeep when it
catches regressions. It is a cost when it fails at random, when it fails only
because someone changed the code on purpose and then edited the test to match,
or when it is slow. The ledger records every test run, and the analyzer turns
the history into a short list of candidates, each with its evidence.

## Recording

`reporter.mjs` is a Vitest reporter in both the Worker suite
(`vitest.config.ts`) and the console suite (`console/vite.config.ts`). It
writes one gzipped JSON Lines file per run under `runs/<day>/`, and nothing at
all unless a ledger directory is chosen:

| Setting | Effect |
|---|---|
| `TEST_LEDGER_DIR=<dir>` | write there (CI sets this and uploads the files as the `test-ledger` artifact) |
| `~/.local/state/test-ledger/` exists | write there, for every run on this machine |
| `TEST_LEDGER=0` | never write |

A run records each test's outcome and duration, and what it ran against: a
digest of the code (`paths.mjs` says which files count as code) and the blob of
every test file. Machine and checkout are hashed. Branch names and commits stay
in the files but never reach the report.

## Analyzing

```sh
node scripts/test-ledger/analyze.mjs --records <dir> [--records <dir>...] --out <dir>
```

The analyzer reads runs from the last 56 days. It writes `report.json`, plus a
`report.md` that is written to be pasted into a pull request. For each failure,
it looks at the next passing run of the same test in the same checkout, and at
what changed in between:

| Changed to make it pass | It counts as |
|---|---|
| only the code, and the test had passed before on older code | a **regression caught** |
| only the test's own file or its helpers | **fixed by editing the test** |
| nothing (same inputs, different result) | **flaky** |
| the test was new or had just been rewritten | ordinary red-green work, ignored |

A run where at least 10 tests and 20% of all tests failed broke as a whole,
for example from a syntax error. Its failures are ignored.

Candidates, at most five of each kind a week:

- **flaky**: any flaky outcome. Fix it first.
- **edited-not-caught**: fixed by editing the test at least twice, and more
  often than it caught anything. Usually a test of implementation details.
  Rewrite it to assert behaviour, or remove it.
- **slow**: a median of 1s or more, measured in CI where the machine is the
  same every time.
- **idle-file / idle-test**: never failed in 20 or more runs over 28 or more
  days. Most good tests look like this, so only the costliest are proposed.
  The question for each is whether another test would catch the same breakage,
  not whether it failed.

`keep.json` lists files and tests that stay on purpose with a reason. These
are guards for rare, expensive mistakes, and they are left out of the idle and
edited candidates. When a proposed test is kept after review, add it there, so
it is not proposed again.
