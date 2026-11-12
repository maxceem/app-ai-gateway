// The root `package.json` is the one place this repository's version is
// written. Wrangler's esbuild bundles a JSON import and tree-shakes it to the
// named field, so the deployed Worker carries the string and nothing else.
import { version } from "../../package.json";

/**
 * The gateway release this Worker is, as `GET /v1/cli/capabilities` reports it.
 *
 * The CLI compares it against the release it bundles before it will update a
 * deployment, so it has to be the repository's own version rather than a
 * literal that can be forgotten. `cli/scripts/release.mjs` refuses to build a
 * release while `cli/package.json` disagrees with it.
 */
export const SERVER_VERSION: string = version;

// Replaced at bundle time by the release builds (`--define`, from
// scripts/prices-revision.mjs); left undefined in any other build, such as a
// deploy that bundles from source or the tests, so read only through `typeof`.
declare const PRICES_REVISION: string | undefined;
declare const PRICES_UPDATED: string | undefined;

/**
 * The model price list this Worker bills with: the commit that last changed
 * `src/usage/models.json` and its day, or null when the build did not say.
 * A prices deploy changes it without changing `SERVER_VERSION`.
 */
export const PRICES: { revision: string; updated: string | null } | null =
  typeof PRICES_REVISION === "string"
    ? { revision: PRICES_REVISION, updated: typeof PRICES_UPDATED === "string" ? PRICES_UPDATED : null }
    : null;
