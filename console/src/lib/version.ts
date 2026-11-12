// The root `package.json` is the one place this repository's version is
// written, as it is for the Worker (`src/core/version.ts`). The console ships
// as that Worker's static assets in the same deployment, so the version it was
// built with is the version it is served by. Vite tree-shakes a named JSON
// import to the one field, so the bundle carries the string and nothing else.
import { version } from "../../../package.json";

/** The gateway release this console was built from, without a leading `v`. */
export const CONSOLE_VERSION: string = version;

// Written by `console/vite.config.ts` at build time.
declare const __CATALOG_UPDATED__: string | null;

/**
 * The day the model prices this deployment bills with last changed, such as
 * "Nov 12, 2026", or null when the build could not tell. A catalog deploy
 * moves it without a new version.
 */
export const PRICES_UPDATED: string | null = __CATALOG_UPDATED__
  ? new Date(`${__CATALOG_UPDATED__}T00:00:00Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
  : null;
