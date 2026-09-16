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
