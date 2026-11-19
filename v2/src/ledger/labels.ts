/**
 * The fixed value lists of the ledger (plan section 4.2).
 *
 * The schema's CHECK constraints and the code read the same lists, so a value
 * can be added in one place only.
 */

/** What a ledger row is. */
export const CHARGE_KINDS = [
  /** One upstream attempt of a call. A fallback chain writes one per attempt. */
  "attempt",
  /** One checkpoint slice of a session, with every turn inside it. */
  "slice",
  /** A job's charge at submit, before the job is final. */
  "estimate",
  /** The difference that settles or prices another charge, a session or a job. */
  "correction",
] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

/** What a charge belongs to. Settlement happens once per owner. */
export const OWNER_TYPES = ["call", "session", "job"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

/** How complete the usage behind a charge is. */
export const MEASURED = [
  /** The provider reported all of it. */
  "complete",
  /** Some usage was missed or worked out by the gateway. */
  "partial",
  /** There was no usage report. It was worked out from the request or the time. */
  "estimated",
  /** It waits for a later lookup (jobs, provider cost lookups). */
  "pending",
] as const;
export type Measured = (typeof MEASURED)[number];

/** Where a charge's price came from. */
export const PRICE_SOURCES = [
  /** The provider reported dollars. */
  "provider_usd",
  /** Our price file. */
  "list_rate",
  /** The customer's own rate. */
  "customer_rate",
  /** No price yet. The usage is stored, and a correction prices it later. */
  "unresolved",
  /** A passthrough path with no price. */
  "not_priced",
] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** The two kinds of correction from a provider's final figure, plus pricing an `unresolved` charge. */
export const CORRECTION_KINDS = [
  /** The provider's final units, priced with the rates stored on the original charge. */
  "units",
  /** The provider's final dollar figure, used as it is. */
  "dollars",
  /** An `unresolved` charge, priced with the first price that exists. */
  "pricing",
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

/**
 * How an upstream attempt ended. This list may grow, so the schema does not
 * CHECK it: in SQLite, changing a CHECK means rebuilding the table.
 */
export const CHARGE_STATUSES = [
  /** The provider answered with success. */
  "ok",
  /** The provider answered with an error. Its status and error code are on the row. */
  "provider_error",
  /** The provider did not answer in time. */
  "timeout",
  /** The connection to the provider failed. */
  "network_error",
  /** The app went away before the answer ended. */
  "client_aborted",
] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/** The kinds of open work the sweep handles. */
export const OPEN_WORK_KINDS = [
  /** A provider cost lookup that returns real dollars (Deepgram, ElevenLabs agents). */
  "provider_lookup",
  /** An `unresolved` charge waiting for a price. */
  "unresolved",
  /**
   * A session to settle: one that may have ended without `close`, or one that
   * closed and waits for its final slice (the settlement barrier).
   */
  "stale_session",
  /** A job to check, such as a fal job whose result must be read soon. */
  "job_check",
] as const;
export type OpenWorkKind = (typeof OPEN_WORK_KINDS)[number];

/** The end-user scopes that an app's dollar and minute budgets can count by. */
export const BUDGET_SCOPES = ["app", "user", "install", "apple_account"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** A live session's state (plan section 4.3). An ended session never reopens. */
export const SESSION_STATES = ["starting", "active", "ended"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** How the gateway carries a live session (D4). */
export const SESSION_MODES = ["relayed", "observed"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** Which slot a session takes (D15). */
export const SESSION_SLOTS = ["conversational", "streaming"] as const;
export type SessionSlot = (typeof SESSION_SLOTS)[number];

/**
 * Why a session ended, so the console can answer "why did my call end?"
 * (plan section 4.3). This list may grow, so the schema does not CHECK it.
 */
export const SESSION_END_REASONS = [
  "client_closed",
  "provider_closed",
  "time_cap",
  "budget_stop",
  "allowance_used_up",
  "user_blocked",
  "key_removed",
  "heartbeat_timeout",
  "client_too_slow",
  "replaced",
  "relay_deploy",
  "error",
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/**
 * Where a session's settlement stands (plan section 4.2, the settlement barrier).
 */
export const SETTLEMENT_STATES = [
  /** Still open, or closed and waiting for its final slice or its provider total. */
  "open",
  /** Settled: every slice is in, and the provider total, if any, is applied. */
  "settled",
  /** No provider total came after the set number of tries: the slices' estimate stays. */
  "estimate_kept",
] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];
