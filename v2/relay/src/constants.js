// @ts-check
// The relay's fixed values. They live here, not in index.js: workerd treats
// every named export of the main module as an entrypoint, and refuses one
// that is not a handler.

/** The paths this Worker answers. Everything else is a 404. */
export const HEALTH_PATH = "/v2/relay/healthz";
/** Where an app starts a live session, with its ticket in the `authorization` header. */
export const SESSION_PATH = "/v2/relay/session";

/** How long a reconnecting client has to send its reconnect secret, its first message. */
export const RECONNECT_FIRST_MESSAGE_MS = 10_000;
/** The longest reconnect message the relay reads: the secret is 43 characters, so this is plenty. */
export const RECONNECT_MESSAGE_MAX = 512;

/** How long a provider connect may take before its outcome counts as unknown. */
export const PROVIDER_CONNECT_TIMEOUT_MS = 15_000;
