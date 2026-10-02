// The root `package.json` is the one place this repository's version is
// written, as it is for the Worker (`src/core/version.ts`). The console ships
// as that Worker's static assets in the same deployment, so the version it was
// built with is the version it is served by. Vite tree-shakes a named JSON
// import to the one field, so the bundle carries the string and nothing else.
import { version } from "../../../package.json";

/** The gateway release this console was built from, without a leading `v`. */
export const CONSOLE_VERSION: string = version;
