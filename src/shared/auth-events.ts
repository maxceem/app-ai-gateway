/**
 * What an application authentication event records: a `/auth/token` exchange,
 * a `/auth/register` key registration, or `challenge` — an issued App Attest
 * challenge that no exchange or registration spent, because the app reported
 * a failure on the device or the challenge expired unused.
 */
export const AUTH_EVENT_NAMES = ["token_exchange", "register", "challenge"] as const;

export type AuthEventName = (typeof AUTH_EVENT_NAMES)[number];
