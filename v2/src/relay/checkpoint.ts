/**
 * `checkpoint`, the relay's third call into the main Worker (plan sections
 * 4.2 and 5.1; crash table rows 16–20). It books one slice of a session's
 * usage and answers continue or stop.
 *
 * - The relay sends measures, never dollars (plan 5.2): token counts, the
 *   connection time and any crash gap. This sends them to the account's
 *   ledger object with today's price (`./session-price.ts`). There, in one
 *   transaction, the session's saved price prices them, as a live call is
 *   priced, and the slice is booked (`AccountLedger.checkpoint`). A
 *   slice whose model has no price yet is booked `unresolved`, and the sweep
 *   prices it later.
 * - The slice's id comes from the ticket's session id and the slice number,
 *   so a retry books nothing twice (S1) and still gets the stop decision (S14).
 * - A slice's input transcription (OpenAI, 9e) is billed at its own model's
 *   price, today's, as a second charge in the same transaction
 *   (`transcriptionCharges`).
 * - The ledger side runs first. Only a live checkpoint with no explicit stop
 *   asks the end user's limiter whether the session was replaced (row 20).
 *   Streaming sessions, sessions with no end user, and accounting-only
 *   deliveries from a relay that has ended never ask.
 * - Counting trouble never ends a session (AGENTS.md "Serving requests"):
 *   anything that cannot be read in time is skipped, with a warning, and a
 *   failed write answers "continue" with `written: false`, unless a stop is
 *   already known.
 *
 * It must answer before the relay's own 5 s timeout: the reads before the
 * ledger run together under one short deadline, the ledger and the limiter
 * each have their own.
 */
import { billingBinding } from "../billing/contract.ts";
import { APP_TRAFFIC_BILLING_DEADLINE_MS, getAppTrafficBillingAccess } from "../billing/access.ts";
import { sessionQuotaFor } from "../billing/quota.ts";
import { configuredBudgetScope } from "../contracts/app-config.ts";
import { withDeadline } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import type { AppRecord } from "../core/types.ts";
import { loadApp } from "../apps/app-records.ts";
import { ledgerObject } from "../ledger/database.ts";
import type { Measured, PriceSource } from "../ledger/labels.ts";
import {
  checkpointStanding,
  knownStops,
  type CheckpointAnswer,
  type CheckpointBudget,
  type CheckpointPlanMinutes,
  type CheckpointStanding,
  type LedgerCheckpointWrite,
  type SliceAtSavedPrice,
  type StopReason,
} from "../ledger/sessions.ts";
import { utcDay, type ChargeRow } from "../ledger/write.ts";
import type { ModalityCounts, UsageObservation } from "../usage/observation.ts";
import { replacementAtCheckpoint } from "../limits/session-admission.ts";
import { nano, type NanoDollars } from "../money.ts";
import { billingForCharge, priceSources, type ResolvedPrice } from "../pricing/billability.ts";
import { priceInServedMode } from "../pricing/tokens.ts";
import { usageMeasures } from "../usage/measures.ts";
import { STANDARD_MODE } from "../usage/service-modes.ts";
import { deadlineOf } from "../../relay/src/ticket.js";
import { CONTRACT_VERSION, ContractRefusal, checkedTicket } from "./contract.ts";
import { sessionRowOf, SEAL_GRACE_MS, type Ticket } from "./tickets.ts";
import { decodeSessionPrice, sessionBillsTime, sliceUsage, todaySessionPrice } from "./session-price.ts";

/** The token counts a slice may carry, as the relay's adapters report them. */
export const SLICE_MEASURES = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_tokens"] as const;
/** The other counts a slice may carry, each a unit of its own: xAI's text messages, which the relay counts itself (9b). */
export const SLICE_UNITS = ["text_messages"] as const;
/**
 * A slice's input transcription (OpenAI, 9e), measures of its own: its model is not the session's, so it
 * is booked apart (`transcriptionCharges`). Tokens for a model billed by them, the audio's length for one
 * billed by time.
 */
export const SLICE_TRANSCRIPTION = [
  "transcription_input_tokens",
  "transcription_input_audio_tokens",
  "transcription_output_tokens",
  "transcription_audio_ms",
] as const;
/**
 * A slice's tokens by modality, in the names a charge keeps them under (`../usage/measures.ts`), and the
 * tokens it estimated: Gemini Live (9d). `<side>_split` counts the turns that broke a side down; the
 * modality counts are shares of `input_tokens` and `output_tokens`, never more tokens; `estimated_tokens`
 * are the share worked out from an answer cut before its usage came.
 */
export const SLICE_BREAKDOWN = [
  "input_split",
  "output_split",
  "input_audio_tokens",
  "input_image_tokens",
  "input_video_tokens",
  "input_unknown_tokens",
  "output_audio_tokens",
  "output_unknown_tokens",
  "estimated_tokens",
  // The cached input's audio share, at its own cached rate (OpenAI Realtime, 9e).
  "cached_input_audio_tokens",
] as const;
const MODALITY_KINDS = ["audio", "image", "video", "unknown"] as const;
/** Every measure name a relay's slice may carry. */
const RELAY_MEASURES: readonly string[] = [...SLICE_MEASURES, ...SLICE_UNITS, ...SLICE_BREAKDOWN];
/** A model name, as a slice may name its transcription's: short, with no spaces or controls (the relay's `transcriptionModel` reads it so). */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;
/** The most billed time one slice may carry: a day, far above any real session's audio. */
const BILLED_MS_MAX = 24 * 60 * 60_000;
/** The largest count one measure of one slice may hold: far above any real minute of a session. */
const MAX_MEASURE = 1_000_000_000;
/** How long the reads before the ledger (settings, the app, the plan) may take together. */
export const CHECKPOINT_READS_DEADLINE_MS = 1_000;
/** How long the ledger transaction may take: with the reads and the limiter, inside the relay's 5 s. */
export const CHECKPOINT_LEDGER_DEADLINE_MS = 2_500;

/** One slice of usage, as the relay journaled it. */
export interface SliceInput {
  readonly seq: number;
  readonly measures: Readonly<Record<string, number>>;
  /** Connection time in the slice (plan minutes, D8). */
  readonly sessionMs: number;
  /**
   * The time a provider billed by time bills in this slice, when it differs
   * from the connection time: xAI's, the larger of the relay's clock and its
   * own audio total (plan 5.2 rule 3). Billed instead of `sessionMs`. A relay
   * before it sends none, and its slices bill the connection time.
   */
  readonly billedMs?: number;
  /** Time after a crash with no journal: an "unknown cost" gap (plan 5.2 rule 3). */
  readonly gapMs: number;
  /** The slice's input transcriptions by model (`SLICE_TRANSCRIPTION` measures), each billed at its model's price. */
  readonly transcriptions?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly gaps: number;
  readonly from: number;
  readonly to: number;
}

export interface CheckpointInput {
  /** Null for an empty checkpoint. */
  readonly slice: SliceInput | null;
  /** The sticky proof that the session is real: a client message (relayed), side-channel usage (observed). Row 20. */
  readonly connected: boolean;
  /** A delivery from a relay that has ended: it books the slice, asks no limiter, and ignores "ended". */
  readonly accounting: boolean;
  readonly providerCallId?: string | null;
  /** The contract version the relay speaks. */
  readonly relayVersion?: number;
}

export interface CheckpointReply {
  readonly version: number;
  readonly decision: "continue" | "stop";
  readonly reasons: readonly StopReason[];
  readonly written: boolean;
}

const isCount = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

/** The input, checked: anything else is refused, so nothing the relay sends is booked unchecked. */
function checkedInput(input: unknown, ticket: Ticket): CheckpointInput {
  const bad = () => new ContractRefusal("bad_request");
  if (typeof input !== "object" || input === null) throw bad();
  const fields = input as Record<string, unknown>;
  if (typeof fields.connected !== "boolean" || typeof fields.accounting !== "boolean") throw bad();
  const callId = fields.providerCallId;
  if (callId !== undefined && callId !== null && (typeof callId !== "string" || callId.length > 256)) throw bad();
  if (fields.relayVersion !== undefined && !isCount(fields.relayVersion, 1_000)) throw bad();
  let slice: SliceInput | null = null;
  if (fields.slice !== null && fields.slice !== undefined) {
    if (typeof fields.slice !== "object") throw bad();
    const raw = fields.slice as Record<string, unknown>;
    // The longest a slice can last: the session's cap, and the seal's grace for a late delivery.
    const longest = ticket.cap + SEAL_GRACE_MS;
    if (!isCount(raw.seq, 1_000_000) || raw.seq < 1) throw bad();
    if (!isCount(raw.sessionMs, longest) || !isCount(raw.gapMs, longest) || !isCount(raw.gaps, 10_000)) throw bad();
    // Generated audio can run faster than the clock (an answer asked by text): a day's worth is the bound.
    if (raw.billedMs !== undefined && !isCount(raw.billedMs, BILLED_MS_MAX)) throw bad();
    if (!isCount(raw.from, Number.MAX_SAFE_INTEGER) || !isCount(raw.to, Number.MAX_SAFE_INTEGER) || raw.from > raw.to) throw bad();
    if (typeof raw.measures !== "object" || raw.measures === null || Array.isArray(raw.measures)) throw bad();
    const measures: Record<string, number> = {};
    for (const [name, value] of Object.entries(raw.measures)) {
      if (!RELAY_MEASURES.includes(name) || !isCount(value, MAX_MEASURE)) throw bad();
      measures[name] = value;
    }
    // The transcriptions by model, checked as any measure is: the relay sends only names it read as models.
    let transcriptions: Record<string, Record<string, number>> | undefined;
    if (raw.transcriptions !== undefined) {
      if (typeof raw.transcriptions !== "object" || raw.transcriptions === null || Array.isArray(raw.transcriptions)) throw bad();
      transcriptions = {};
      for (const [model, counts] of Object.entries(raw.transcriptions)) {
        if (!MODEL_NAME.test(model) || typeof counts !== "object" || counts === null || Array.isArray(counts)) throw bad();
        const kept: Record<string, number> = {};
        for (const [name, value] of Object.entries(counts)) {
          if (!(SLICE_TRANSCRIPTION as readonly string[]).includes(name) || !isCount(value, MAX_MEASURE)) throw bad();
          kept[name] = value;
        }
        transcriptions[model] = kept;
      }
    }
    slice = {
      seq: raw.seq,
      measures,
      sessionMs: raw.sessionMs,
      gapMs: raw.gapMs,
      gaps: raw.gaps,
      from: raw.from,
      to: raw.to,
      ...(raw.billedMs === undefined ? {} : { billedMs: raw.billedMs as number }),
      ...(transcriptions === undefined ? {} : { transcriptions }),
    };
  }
  return {
    slice,
    connected: fields.connected,
    accounting: fields.accounting,
    providerCallId: (callId as string | null | undefined) ?? null,
    ...(fields.relayVersion === undefined ? {} : { relayVersion: fields.relayVersion as number }),
  };
}

/** A slice's price: from its tokens, as a live call is priced. */
interface SlicePrice {
  readonly costNano: NanoDollars | null;
  readonly priceSource: PriceSource;
  readonly estimated: boolean;
  readonly measured: Exclude<Measured, "pending">;
  readonly rates: Readonly<Record<string, number>> | null;
  readonly unit: string | null;
  readonly units: number | null;
}

/**
 * Prices a slice with the session's price (`./session-price.ts`): the
 * connection's own rate, else ours, as they were when it opened. Tokens are
 * priced by their rates. A price with a time rate (the wall clock meter: a
 * provider billed per minute of connection) also bills the slice's connection
 * time, `sessionMs`, as session seconds (`sliceUsage`), and what it bills on
 * top (`SLICE_UNITS`: xAI's text messages). A slice with neither
 * (connection time on a model billed by tokens) costs nothing: there is no
 * usage to price. With no price, tokens and connection time are booked
 * `unresolved`, priced later by the sweep, never billed as free (AGENTS.md):
 * the model may bill time.
 */
export function priceSlice(measures: Readonly<Record<string, number>>, resolved: ResolvedPrice | null, sessionMs = 0): SlicePrice {
  const hasTokens = SLICE_MEASURES.some((name) => (measures[name] ?? 0) > 0);
  const units = { ...(sessionMs > 0 ? { session_seconds: sessionMs } : {}), ...unitsOf(measures) };
  const free: SlicePrice = { costNano: nano(0), priceSource: "list_rate", estimated: false, measured: "complete", rates: null, unit: null, units: null };
  const unresolved: SlicePrice = { costNano: null, priceSource: "unresolved", estimated: false, measured: "complete", rates: null, unit: null, units: null };
  if (resolved === null) return hasTokens || Object.keys(units).length > 0 ? unresolved : free;
  const usage = sliceUsage(
    {
      inputTokens: measures.input_tokens ?? 0,
      cachedInputTokens: measures.cached_input_tokens ?? 0,
      cacheWriteTokens: measures.cache_write_tokens ?? 0,
      outputTokens: measures.output_tokens ?? 0,
      ...breakdownOf(measures),
      // Session seconds are stored at the milli scale: a millisecond count is the unit count.
      ...(Object.keys(units).length > 0 ? { units } : {}),
    },
    resolved.price,
  );
  if (!hasTokens && usage.units === undefined) return free;
  const priced = priceInServedMode(resolved.price, usage);
  if (priced === null) return unresolved;
  return {
    costNano: priced.cost,
    priceSource: resolved.source,
    estimated: priced.estimated,
    measured: priced.measured,
    rates: priced.rates,
    unit: priced.unit,
    units: priced.units,
  };
}

/**
 * A slice's modalities and estimate as a usage's: each side a turn broke down is split, so its text bills
 * at the side's rate and anything no breakdown covered at the model's highest; tokens worked out from a
 * cut answer make the price an estimate, never below the model's own (`priceInServedMode`).
 */
function breakdownOf(measures: Readonly<Record<string, number>>): Pick<UsageObservation, "modalityTokens" | "reportMissing" | "tokenVariants"> {
  const modalityTokens: { input?: ModalityCounts; output?: ModalityCounts } = {};
  for (const side of ["input", "output"] as const) {
    if ((measures[`${side}_split`] ?? 0) === 0) continue;
    const counts: Partial<Record<(typeof MODALITY_KINDS)[number], number>> = {};
    for (const kind of MODALITY_KINDS) if ((measures[`${side}_${kind}_tokens`] ?? 0) > 0) counts[kind] = measures[`${side}_${kind}_tokens`] as number;
    modalityTokens[side] = counts;
  }
  const cachedAudio = measures.cached_input_audio_tokens ?? 0;
  return {
    ...(modalityTokens.input !== undefined || modalityTokens.output !== undefined ? { modalityTokens } : {}),
    ...((measures.estimated_tokens ?? 0) > 0 ? { reportMissing: true as const } : {}),
    // The cached input's audio share, at its own cached rate (`cached_input_audio`).
    ...(cachedAudio > 0 ? { tokenVariants: { cached_input: { audio: cachedAudio } } } : {}),
  };
}

/** A slice's breakdown as a charge's measures, so the sweep prices it the same way (`usageFromMeasures`). */
function breakdownMeasures(measures: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const side of ["input", "output"] as const) {
    if ((measures[`${side}_split`] ?? 0) === 0) continue;
    out[`${side}_split`] = 1;
    for (const kind of MODALITY_KINDS) if ((measures[`${side}_${kind}_tokens`] ?? 0) > 0) out[`${side}_${kind}_tokens`] = measures[`${side}_${kind}_tokens`] as number;
  }
  if ((measures.estimated_tokens ?? 0) > 0) out.report_missing = 1;
  if ((measures.cached_input_audio_tokens ?? 0) > 0) out.cached_input_audio_tokens = measures.cached_input_audio_tokens as number;
  return out;
}

/** The time a slice bills: what the provider billed by time bills (`billedMs`), else its connection time. */
export function billedTime(slice: SliceInput): number {
  return slice.billedMs ?? slice.sessionMs;
}

/** A slice's counts in units of their own (`SLICE_UNITS`), as a usage's units: only those above zero. */
function unitsOf(measures: Readonly<Record<string, number>>): Partial<Record<(typeof SLICE_UNITS)[number], number>> {
  return Object.fromEntries(SLICE_UNITS.filter((unit) => (measures[unit] ?? 0) > 0).map((unit) => [unit, measures[unit] as number]));
}

/**
 * The slice's charge row. Its id and usage date come from the ticket and the
 * slice number, never from the relay alone. A gap is never booked as zero
 * cost (plan 4.2 and 5.2): a slice with a gap and no tokens has an unknown
 * cost, `unresolved` with no tokens for the sweep to price.
 */
export function sliceCharge(ticket: Ticket, slice: SliceInput, price: SlicePrice, now: number): ChargeRow {
  const gap = slice.gapMs > 0 || slice.gaps > 0;
  // Connection time that may be billed is kept as usage, so the sweep can price it later: time the
  // price billed, or time with no price yet. A gap with no such time stays an unknown cost.
  const timeMs = sessionBillsTime(ticket.operation) ? billedTime(slice) : 0;
  const billableMs = timeMs > 0 && (price.unit === "session_seconds" || price.priceSource === "unresolved") ? timeMs : 0;
  // A slice billed by time, or by its text messages alone, keeps the price of what it knows, marked `partial` below.
  if (gap && price.unit !== "session_seconds" && price.unit !== "text_messages" && !SLICE_MEASURES.some((name) => (slice.measures[name] ?? 0) > 0)) {
    price = { ...price, costNano: null, priceSource: "unresolved", estimated: false };
  }
  // Dated by its start (D18), inside the session's own time: never before its start, never after
  // its deadline. A slice that crosses midnight counts on the day, and in the period, it began.
  const usedAt = Math.min(Math.max(slice.from, ticket.start), deadlineOf(ticket));
  // The token columns: zero filled, so the sweep can price an `unresolved` slice from its measures.
  const tokens = {
    input_tokens: slice.measures.input_tokens ?? 0,
    output_tokens: slice.measures.output_tokens ?? 0,
    cached_input_tokens: slice.measures.cached_input_tokens ?? 0,
    cache_write_tokens: slice.measures.cache_write_tokens ?? 0,
  };
  return {
    id: `${ticket.sid}:slice:${slice.seq}`,
    kind: "slice",
    accountId: ticket.account,
    appId: ticket.app,
    endUserId: ticket.endUser,
    installId: ticket.install,
    appleAccountId: ticket.appleAccount,
    appKeyId: ticket.appKey,
    ownerType: "session",
    ownerId: ticket.sid,
    seq: slice.seq,
    providerType: ticket.providerType,
    providerConnectionId: ticket.connection,
    operation: ticket.operation,
    preset: null,
    model: ticket.model,
    status: "ok",
    httpStatus: null,
    errorCode: null,
    costNano: price.costNano,
    // A gap means some usage may be missing: never `complete` (plan 4.2).
    measured: gap ? "partial" : price.measured,
    priceSource: price.priceSource,
    priceIsEstimate: price.estimated,
    inputTokens: tokens.input_tokens,
    cachedInputTokens: tokens.cached_input_tokens,
    cacheWriteTokens: tokens.cache_write_tokens,
    outputTokens: tokens.output_tokens,
    unit: price.unit,
    units: price.units,
    measures: {
      ...tokens,
      ...breakdownMeasures(slice.measures),
      ...(billableMs > 0 ? { units_session_seconds: billableMs } : {}),
      // Kept whether priced or not, so the sweep prices an `unresolved` slice with them too.
      ...Object.fromEntries(Object.entries(unitsOf(slice.measures)).map(([unit, count]) => [`units_${unit}`, count])),
      ...(slice.gapMs > 0 ? { gap_ms: slice.gapMs } : {}),
    },
    rates: price.rates,
    sessionMs: slice.sessionMs,
    correctionKind: null,
    correctsChargeId: null,
    latencyMs: null,
    appVersion: null,
    authMethod: null,
    clientTraceId: null,
    usedAt,
    usageDay: utcDay(usedAt),
    writtenAt: now,
  };
}

/**
 * A slice's input transcriptions as charges of their own (OpenAI, 9e; plan, the provider table: billed
 * separately), one for each model OpenAI transcribed with: `<slice id>:transcription:<model>`, priced
 * today at that model's price, the connection's own rate, else ours (`billingForCharge`). With no price,
 * or none that can be read (the relay's `unknown`, when OpenAI never stated a model), a charge is
 * `unresolved`, and the sweep prices it, never as free. None holds connection time: the session's slice
 * has that. Their ids come from the slice's, so a retry books nothing twice.
 */
export function transcriptionCharges(ticket: Ticket, slice: SliceInput, standing: CheckpointStanding | null, now: number): ChargeRow[] {
  const charges: ChargeRow[] = [];
  for (const model of Object.keys(slice.transcriptions ?? {}).sort()) {
    const charge = transcriptionCharge(ticket, slice, model, slice.transcriptions?.[model] ?? {}, standing, now);
    if (charge !== null) charges.push(charge);
  }
  return charges;
}

/** One model's transcription charge, or null when it has no usage. */
function transcriptionCharge(
  ticket: Ticket,
  slice: SliceInput,
  model: string,
  measures: Readonly<Record<string, number>>,
  standing: CheckpointStanding | null,
  now: number,
): ChargeRow | null {
  const input = measures.transcription_input_tokens ?? 0;
  const output = measures.transcription_output_tokens ?? 0;
  const audio = Math.min(input, measures.transcription_input_audio_tokens ?? 0);
  const ms = measures.transcription_audio_ms ?? 0;
  if (input + output + ms === 0) return null;
  const usage: UsageObservation = {
    inputTokens: input,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: output,
    ...(audio > 0 ? { modalityTokens: { input: { audio } } } : {}),
    // The audio's length, at the milli scale, for a model billed by time.
    ...(ms > 0 ? { units: { audio_seconds: ms } } : {}),
    ...(input + output === 0 ? { noTokens: true as const } : {}),
  };
  let price: SlicePrice = { costNano: null, priceSource: "unresolved", estimated: false, measured: "complete", rates: null, unit: null, units: null };
  if (standing !== null && standing.ratesJson !== undefined) {
    try {
      const resolved = billingForCharge(priceSources({ type: ticket.providerType, rates_json: standing.ratesJson ?? null }), model);
      const priced = resolved === null ? null : priceInServedMode(resolved.price, usage);
      if (resolved !== null && priced !== null) {
        price = {
          costNano: priced.cost,
          priceSource: resolved.source,
          estimated: priced.estimated,
          measured: priced.measured,
          rates: priced.rates,
          unit: priced.unit,
          units: priced.units,
        };
      }
    } catch {
      // Unreadable rates, or a cost too large to store: `unresolved`, for the sweep.
    }
  }
  const row = sliceCharge(ticket, { seq: slice.seq, measures: {}, sessionMs: 0, gapMs: 0, gaps: 0, from: slice.from, to: slice.to }, price, now);
  return {
    ...row,
    id: `${row.id}:transcription:${model}`,
    model,
    inputTokens: input,
    outputTokens: output,
    measures: usageMeasures(usage, STANDARD_MODE),
  };
}

/** The dollar budgets the app sets: the end user's month and the app's own (as admission measures them). */
export function checkpointBudgets(app: AppRecord, ticket: Ticket): CheckpointBudget[] {
  const budgets: CheckpointBudget[] = [];
  const perUser = app.limits.per_user.spending.monthly_nano;
  if (perUser !== null && perUser !== undefined) {
    if (ticket.install !== null) {
      // An App Attest install: the configured scope, as admission's `endUserCaller`.
      const scope = configuredBudgetScope(app.authentication, app.limits);
      if (scope === "user" && ticket.endUser !== null) budgets.push({ scope: "user", scopeId: ticket.endUser, limitNano: perUser as NanoDollars });
      else if (scope === "apple_account" && ticket.appleAccount !== null) budgets.push({ scope: "apple_account", scopeId: ticket.appleAccount, limitNano: perUser as NanoDollars });
      else budgets.push({ scope: "install", scopeId: ticket.install, limitNano: perUser as NanoDollars });
    } else if (ticket.endUser !== null) {
      budgets.push({ scope: "user", scopeId: ticket.endUser, limitNano: perUser as NanoDollars });
    }
  }
  const perApp = app.limits.per_app.spending.monthly_nano;
  if (perApp !== null && perApp !== undefined) budgets.push({ scope: "app", scopeId: app.id, limitNano: perApp as NanoDollars });
  return budgets;
}

/** The plan's live-session minutes, hosted only. Null when there are none, or they can't be read in time. */
async function checkpointPlanMinutes(env: Env, ticket: Ticket, now: number, waitUntil: (p: Promise<unknown>) => void): Promise<CheckpointPlanMinutes | null> {
  if (billingBinding(env) === null) return null;
  const access = await getAppTrafficBillingAccess(env, ticket.account, waitUntil, APP_TRAFFIC_BILLING_DEADLINE_MS);
  // The last known plan, served while billing cannot answer, never stops a session.
  if (access.state === "billed" && access.stale === true) return null;
  const quota = await sessionQuotaFor(access, env, ticket.account, now);
  if (quota.kind === "unmetered") return null;
  return { fromDay: quota.period.periodStart.slice(0, 10), toDay: quota.period.periodEnd.slice(0, 10), limitMs: quota.limitMs };
}

/**
 * One of the reads before the ledger, bounded: past the deadline, or on any
 * failure, its check is skipped with a warning, and the slice is still booked.
 */
async function bounded<T>(read: () => Promise<T>, fallback: T, message: string, facts: Record<string, unknown>, waitUntil: (p: Promise<unknown>) => void): Promise<T> {
  const pending = Promise.resolve().then(read);
  try {
    return await withDeadline(pending, CHECKPOINT_READS_DEADLINE_MS, message);
  } catch (error) {
    waitUntil(pending.catch(() => undefined));
    log("warn", message, { ...facts, error: errorFacts(error) });
    return fallback;
  }
}

/** What the main Worker sends the account's ledger object for one checkpoint (`AccountLedger.checkpoint`). */
export interface LedgerCheckpointInput {
  readonly ticket: Ticket;
  readonly slice: SliceInput | null;
  /** Today's price, saved form (`./session-price.ts`); null when it couldn't be read. */
  readonly today: string | null;
  readonly budgets: readonly CheckpointBudget[];
  readonly planMinutes: CheckpointPlanMinutes | null;
  readonly now: number;
  readonly providerCallId: string | null;
  readonly standing: CheckpointStanding | null;
}

/**
 * The slice at the session's saved price, priced inside the ledger
 * transaction (plan 4.2). Its tokens are never billed as free: with no price
 * saved, or one that can't be read or can't price them (a cost too large to
 * store), the slice is booked `unresolved`, with a warning, and the sweep
 * prices it. A saved "no price" ('') is `unresolved` too, without a warning.
 */
function sliceAtSavedPrice(ticket: Ticket, slice: SliceInput, now: number): SliceAtSavedPrice {
  const facts = { app: ticket.app, session: ticket.sid };
  // A session billed by tokens alone (OpenAI Realtime) bills no connection time: it counts for plan minutes only.
  const timeMs = sessionBillsTime(ticket.operation) ? billedTime(slice) : 0;
  const unpriced = priceSlice(slice.measures, null, timeMs);
  return {
    id: `${ticket.sid}:slice:${slice.seq}`,
    priceAt: (saved) => {
      let price = unpriced;
      if (saved === null) {
        if (unpriced.priceSource === "unresolved") log("warn", "checkpoint_price_unsaved", facts);
      } else if (saved !== "") {
        try {
          price = priceSlice(slice.measures, decodeSessionPrice(saved), timeMs);
        } catch {
          price = unpriced;
        }
        if (price.priceSource === "unresolved") log("warn", "checkpoint_saved_price_unusable", facts);
      }
      return sliceCharge(ticket, slice, price, now);
    },
  };
}

/** What the ledger object writes for one checkpoint (`AccountLedger.checkpoint`, `writeCheckpointIn`). */
export function checkpointWrite(input: LedgerCheckpointInput): LedgerCheckpointWrite {
  return {
    session: sessionRowOf(input.ticket),
    slice: input.slice === null ? null : sliceAtSavedPrice(input.ticket, input.slice, input.now),
    transcriptions: input.slice === null ? [] : transcriptionCharges(input.ticket, input.slice, input.standing, input.now),
    budgets: input.budgets,
    planMinutes: input.planMinutes,
    now: input.now,
    providerCallId: input.providerCallId,
    standing: input.standing,
    gaps: input.slice?.gaps ?? 0,
    ...(input.today === null ? {} : { price: input.today }),
  };
}

/** The order a stop's reasons are told in: the first is the end reason the relay records. */
const STOP_ORDER: readonly StopReason[] = ["replaced", "user_blocked", "key_removed", "budget_stop", "allowance_used_up", "ended"];

/** `checkpoint`: books the slice and answers continue or stop. Safe to repeat. */
export async function checkpointForRelay(
  env: Env,
  ticketText: unknown,
  rawInput: unknown,
  now: number = Date.now(),
  waitUntil: (promise: Promise<unknown>) => void = () => undefined,
): Promise<CheckpointReply> {
  // Only the signature: a session checkpoints long after its start ticket expired.
  const ticket = await checkedTicket(env, ticketText);
  const input = checkedInput(rawInput, ticket);
  const session = sessionRowOf(ticket);

  // The reads before the ledger, together: each has its own short deadline, and none can fail the checkpoint.
  const facts = { app: ticket.app, session: ticket.sid };
  const [standing, budgets, planMinutes] = await Promise.all([
    // Its own 1 s deadline inside; null when D1 can't answer, and both checks are skipped.
    checkpointStanding(env.DB, session),
    bounded(async () => checkpointBudgets(await loadApp(env, ticket.app), ticket), [], "checkpoint_budgets_unchecked", facts, waitUntil),
    bounded(() => checkpointPlanMinutes(env, ticket, now, waitUntil), null, "checkpoint_allowance_unchecked", facts, waitUntil),
  ]);

  // Today's price goes with the slice; the ledger prices the slice with the session's saved one,
  // and saves today's on the first checkpoint (plan 4.2; `./session-price.ts`). One call.
  const today = todaySessionPrice(ticket, standing === null ? undefined : (standing.ratesJson ?? null));
  if (today === null) log("warn", "checkpoint_price_unread", facts);

  let answer: CheckpointAnswer;
  try {
    // RPC stub types wrap the answer; it is the plain `CheckpointAnswer`.
    const booking = ledgerObject(env, ticket.account).checkpoint({
      ticket,
      slice: input.slice,
      today,
      budgets,
      planMinutes,
      now,
      providerCallId: input.providerCallId ?? null,
      standing,
    });
    answer = await withDeadline(booking as unknown as Promise<CheckpointAnswer>, CHECKPOINT_LEDGER_DEADLINE_MS, "booking the checkpoint");
  } catch (error) {
    // The ledger can't be reached: the session continues, and the relay sends the slice again.
    log("warn", "checkpoint_unchecked", { app: ticket.app, session: ticket.sid, error: errorFacts(error) });
    const known = knownStops(standing);
    answer = known.length > 0 ? { decision: "stop" as const, reasons: known, written: false } : { decision: "continue" as const, written: false };
  }

  let reasons: StopReason[] = answer.decision === "stop" ? [...answer.reasons] : [];
  if (input.accounting) {
    // An ended relay only delivers: "ended" is not news to it, and no limiter is asked (row 16).
    reasons = reasons.filter((reason) => reason !== "ended");
  } else if (reasons.length === 0 && session.slot === "conversational") {
    // The ledger side first; only with no explicit stop is the user's limiter asked (row 20).
    const replaced = await replacementAtCheckpoint(
      env,
      { appId: ticket.app, installId: ticket.install, endUserId: ticket.endUser },
      { sessionId: ticket.sid, connected: input.connected, now },
      waitUntil,
    );
    if (replaced === "replaced") reasons = ["replaced"];
  }
  reasons.sort((a, b) => STOP_ORDER.indexOf(a) - STOP_ORDER.indexOf(b));
  return { version: CONTRACT_VERSION, decision: reasons.length > 0 ? "stop" : "continue", reasons, written: answer.written };
}
