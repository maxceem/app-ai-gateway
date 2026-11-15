// Which side of a change a file is on, for the ledger's two digests. A test
// that went red and then green with only "test" files changed was fixed by
// editing the test; with only "code" files changed, it caught a real problem.
// Files that are neither (docs, examples, workflows) are left out of both, so
// editing them never looks like either.

const TEST = [/^test\//, /^smoke\//, /^cli\/test\//, /^console\/src\/test\//, /\.test\.[cm]?[jt]sx?$/];

const CODE_DIRS = [/^src\//, /^cli\/src\//, /^console\/src\//, /^migrations\//, /^scripts\//, /^openapi\//];

const CODE_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "wrangler.jsonc",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.suites.config.ts",
  "worker-configuration.d.ts",
  "cli/package.json",
  "console/package.json",
  "console/vite.config.ts",
]);

/** @returns {"test" | "code" | null} */
export function classifyPath(file) {
  if (TEST.some((pattern) => pattern.test(file))) return "test";
  if (CODE_FILES.has(file) || CODE_DIRS.some((pattern) => pattern.test(file))) return "code";
  return null;
}
