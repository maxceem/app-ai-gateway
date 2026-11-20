import { createRequire } from "node:module";

/**
 * The CLI's version, from its own `package.json`.
 *
 * `esbuild` inlines it through `define` when the bundle is built, so the
 * published `dist/agw.mjs` reads no file. Running the sources straight from
 * the repository, as the tests do, reads the same file instead.
 */
declare const __AGW_VERSION__: string | undefined;

function fromPackageJson(): string {
  const packaged = createRequire(import.meta.url)("../package.json") as { version?: unknown };
  if (typeof packaged.version !== "string") throw new Error("v2/cli/package.json must declare a version");
  return packaged.version;
}

export const VERSION: string = typeof __AGW_VERSION__ === "string" ? __AGW_VERSION__ : fromPackageJson();
