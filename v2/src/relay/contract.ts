/**
 * The relay's calls into the main Worker (plan section 5.1): `open` and
 * `close` here; `checkpoint` comes with the journal (step 9a part 2). The
 * relay calls them over its service binding (`RelayContract` in
 * `./entrypoint.ts`); the main Worker never calls the relay.
 *
 * Fields are only ever added, and each answer carries `CONTRACT_VERSION`.
 *
 * - `open` checks the ticket again (its signature and its expiry) and answers
 *   the settings the relay stores. It never returns a key: the relay gets that
 *   from the vault. Its answer is a pure function of the ticket, so a repeated
 *   `open` for one session gets the same answer (crash table rows 5 and 6).
 * - `close` records the session's end in the account's ledger object. It is
 *   safe to repeat: the first close wins. It checks only the signature: a
 *   session closes long after its start ticket expired.
 *
 * Taking and freeing the session's lease in the limiters comes with the
 * leases (step 9a part 1, third review).
 */
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { errorFacts } from "../core/error-facts.ts";
import { SESSION_END_REASONS, type SessionEndReason } from "../ledger/labels.ts";
import { ledgerDb } from "../ledger/database.ts";
import { closeSession } from "../ledger/sessions.ts";
import { sessionRowOf, verifyTicket, type Ticket } from "./tickets.ts";
import { deadlineOf } from "../../relay/src/ticket.js";

/** The contract's version: the relay and the main Worker each say which they speak. */
export const CONTRACT_VERSION = 1;
/** How often the relay sends a checkpoint (plan section 5.1). */
export const CHECKPOINT_INTERVAL_MS = 60_000;
/** How long `close`'s ledger write may take. */
const CLOSE_DEADLINE_MS = 5_000;

/** What `open` answers: the settings the relay stores. Never a key. */
export interface OpenSettings {
  readonly version: number;
  readonly sessionId: string;
  readonly operation: string;
  readonly mode: Ticket["mode"];
  readonly slot: Ticket["slot"];
  readonly model: string | null;
  readonly deadline: number;
  readonly checkpointIntervalMs: number;
}

/** A refusal the relay can act on: its message is a code, never a value from the ticket. */
export class ContractRefusal extends Error {
  constructor(readonly code: "ticket_refused" | "ticket_expired" | "bad_request" | "unavailable") {
    super(code);
    this.name = "ContractRefusal";
  }
}

async function checkedTicket(env: Env, ticket: unknown): Promise<Ticket> {
  let payload: Ticket | null;
  try {
    payload = await verifyTicket(env, ticket);
  } catch (error) {
    // The signing key is missing or broken: a setup error, already logged.
    if (error instanceof GatewayError) throw new ContractRefusal("unavailable");
    throw error;
  }
  if (payload === null) {
    log("warn", "relay_ticket_refused", {});
    throw new ContractRefusal("ticket_refused");
  }
  return payload;
}

/** `open`: the settings for a session that may start. */
export async function openForRelay(env: Env, ticket: unknown, now: number = Date.now()): Promise<OpenSettings> {
  const payload = await checkedTicket(env, ticket);
  if (now >= payload.exp) throw new ContractRefusal("ticket_expired");
  return {
    version: CONTRACT_VERSION,
    sessionId: payload.sid,
    operation: payload.operation,
    mode: payload.mode,
    slot: payload.slot,
    model: payload.model,
    deadline: deadlineOf(payload),
    checkpointIntervalMs: CHECKPOINT_INTERVAL_MS,
  };
}

/** What the relay says when a session ends. */
export interface CloseInput {
  readonly finalSlice: number;
  readonly endReason: string;
  readonly endedAt: number;
  readonly providerCallId?: string | null;
}

/** `close`: records the session's end. Safe to repeat. */
export async function closeForRelay(env: Env, ticket: unknown, input: CloseInput, now: number = Date.now()): Promise<{ readonly version: number }> {
  const payload = await checkedTicket(env, ticket);
  if (
    !Number.isSafeInteger(input.finalSlice) ||
    input.finalSlice < 0 ||
    !(SESSION_END_REASONS as readonly string[]).includes(input.endReason) ||
    !Number.isSafeInteger(input.endedAt) ||
    (input.providerCallId !== undefined && input.providerCallId !== null && (typeof input.providerCallId !== "string" || input.providerCallId.length > 256))
  ) {
    throw new ContractRefusal("bad_request");
  }
  try {
    await closeSession(ledgerDb(env, payload.account, { deadlineMs: CLOSE_DEADLINE_MS }), {
      session: sessionRowOf(payload),
      finalSlice: input.finalSlice,
      endReason: input.endReason as SessionEndReason,
      // Never after the session's deadline: a late close still ends it there.
      endedAt: Math.min(input.endedAt, deadlineOf(payload)),
      now,
      providerCallId: input.providerCallId ?? null,
    });
  } catch (error) {
    log("warn", "relay_close_failed", { app: payload.app, session: payload.sid, error: errorFacts(error) });
    throw new ContractRefusal("unavailable");
  }
  return { version: CONTRACT_VERSION };
}
