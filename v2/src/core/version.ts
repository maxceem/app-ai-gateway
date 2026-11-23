// `v2/package.json` is the one place the gateway's release is written. The
// bundler keeps only the named field, so the Worker carries the string and
// nothing else. The CLI is released with it under the same number
// (`cli/package.json`), which a test checks.
import { version } from "../../package.json";

/**
 * The gateway release this Worker is, as `GET /v2/console/capabilities`
 * reports it. The CLI compares it with its own release after a failure the
 * gateway answered (`version_mismatch`).
 */
export const SERVER_VERSION: string = version;
