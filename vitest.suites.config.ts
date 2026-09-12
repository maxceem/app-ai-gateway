import base from "./vitest.config";

// The suite costs about nine seconds per test file before a single test runs:
// each file gets its own module registry, and filling it means pulling the app's
// whole module graph over the pool's RPC module loader. Measured against an
// empty `beforeAll`, so it is the loading, not the work. Nothing makes that
// cheaper, so the only lever is paying it fewer times.
//
// The barrels under `test/suites` each import a group of test files, so Vitest
// sees six files rather than thirty-nine and pays the nine seconds six times.
// The test files themselves are untouched and still run on their own against
// the base config, which is what `pnpm exec vitest run test/<name>.test.ts`
// does — this config exists only for the whole-suite run.
//
// One consequence worth knowing: a barrel's members share one storage
// environment and one set of file-level hooks, where separate files would each
// get their own. `scripts/check-suites.mjs` keeps every test file in exactly one
// barrel; grouping is by domain so that whatever state members do share, they
// already share a subject.
export default {
  ...base,
  test: { ...(base as { test: Record<string, unknown> }).test, include: ["test/suites/*.suite.ts"] },
};
