// @ts-check
// The relay's fixed values. They live here, not in index.js: workerd treats
// every named export of the main module as an entrypoint, and refuses one
// that is not a handler.

/** The paths this Worker answers. Everything else is a 404. */
export const HEALTH_PATH = "/v2/relay/healthz";
export const ECHO_PATH = "/v2/relay/echo";

/** An echo frame larger than this closes the socket. */
export const MAX_ECHO_FRAME_BYTES = 64 * 1024;

/** An echo session ends by itself after this long. */
export const ECHO_LIFETIME_MS = 60_000;
