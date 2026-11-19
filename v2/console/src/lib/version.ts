// The root `package.json` is the one place this repository's version is
// written. The console ships as the v2 Worker's static assets in the same
// deployment, so the version it was built with is the version it is served
// by. Vite tree-shakes a named JSON import to the one field.
import { version } from "../../../../package.json";

/** The gateway release this console was built from, without a leading `v`. */
export const CONSOLE_VERSION: string = version;
