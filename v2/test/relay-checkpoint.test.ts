/**
 * `checkpoint`, the relay's third call (step 9a part 2; plan 4.2 and 5.1;
 * crash table rows 16–20): it prices a slice's measures, books it once in the
 * account's ledger object, and answers continue or stop. Replacement comes
 * from the end user's limiter, after the ledger side, for a live checkpoint
 * only (row 20).
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkpointBudgets, checkpointForRelay, priceSlice, type SliceInput } from "../src/relay/checkpoint.ts";
import { ContractRefusal } from "../src/relay/contract.ts";
import { issueTicket, type TicketRequest } from "../src/relay/tickets.ts";
import { closeSession } from "../src/ledger/sessions.ts";
import { userLimiterName } from "../src/limits/admission.ts";
import { listPrice } from "../src/pricing/prices.ts";
import { priceTokens } from "../src/pricing/tokens.ts";
import type { SessionCheckpointAnswer, UserSessionAdmission } from "../src/do/EndUserLimiter.ts";
import type { SlotClaim } from "../src/do/session-slots.ts";
import type { AppRecord } from "../src/core/types.ts";
import { parseTicket, deadlineOf, type Ticket } from "../relay/src/ticket.js";
import { ACCOUNT_ID, ledger, seedAccount, seedApp, withLedgerDb } from "./helpers.ts";
import { sealForTest, splitKeysOn, testShare } from "./split-keys.ts";

const MINUTE = 60_000;

/** A ticket request on OpenAI's own address, for `endUserId` (a fresh one per test keeps limiters apart). */
async function request(overrides: Partial<TicketRequest> = {}): Promise<TicketRequest> {
  const identity: [string, string, string, string, string, string] = [ACCOUNT_ID, "conn_live", "openai", "", "", ""];
  const blob = await sealForTest("providerKey", identity, "sk-checkpoint-key");
  const share = await testShare(ACCOUNT_ID);
  return {
    accountId: ACCOUNT_ID,
    appId: "app_cp",
    endUserId: `user_${crypto.randomUUID().slice(0, 8)}`,
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    providerType: "openai",
    connectionId: null,
    operation: "openai.realtime",
    model: "gpt-4o-mini",
    mode: "relayed",
    slot: "conversational",
    sessionTotal: false,
    url: "https://api.openai.com/v1/realtime",
    capMs: 30 * MINUTE,
    credentials: { providerKey: { blob, identity }, cloudflareToken: null, ...(share === null ? {} : { credential: share.forVault() }) },
    keyPlacement: { header: "authorization", format: "Bearer {key}" },
    ...overrides,
  };
}

/** A signed ticket; `earlier` moves its start back, to order sessions by age. */
async function ticketFor(overrides: Partial<TicketRequest> = {}, earlier = 0): Promise<{ text: string; ticket: Ticket }> {
  const issued = await issueTicket(env, await request(overrides), Date.now() - earlier);
  return { text: issued.ticket, ticket: parseTicket(issued.ticket)!.payload };
}

function slice(ticket: Ticket, seq: number, measures: Record<string, number> = {}, fields: Partial<SliceInput> = {}): SliceInput {
  return { seq, measures, sessionMs: MINUTE, gapMs: 0, gaps: 0, from: ticket.start + (seq - 1) * MINUTE, to: ticket.start + seq * MINUTE, ...fields };
}

const live = (s: SliceInput | null, connected = true) => ({ slice: s, connected, accounting: false, relayVersion: 2 });

const charges = (sessionId: string) =>
  ledger().prepare("SELECT id, cost_nano, price_source, session_ms, measured FROM charge WHERE owner_id = ? ORDER BY seq").bind(sessionId).all().then((r) => r.results);

interface UserLimiter {
  admitSession(input: Record<string, unknown>): Promise<UserSessionAdmission>;
  activateSession(claim: SlotClaim, now: number): Promise<void>;
  sessionCheckpoint(input: { sessionId: string; connected: boolean; now: number }): Promise<SessionCheckpointAnswer>;
}
const limiterOf = (ticket: Ticket) => env.END_USER_LIMITER.getByName(userLimiterName(ticket.app, ticket.endUser!)) as unknown as UserLimiter;

/** Takes and activates the ticket's slot, as the session endpoint and `open` do. */
async function slotFor(ticket: Ticket): Promise<void> {
  const claim: SlotClaim = { sessionId: ticket.sid, kind: ticket.slot, ticketStart: ticket.start, expiresAt: ticket.exp, deadline: deadlineOf(ticket) };
  const limiter = limiterOf(ticket);
  expect(await limiter.admitSession({ ...claim, now: ticket.start, budgetNano: null, spend: null, takesOver: null })).toMatchObject({ admitted: true });
  await limiter.activateSession(claim, ticket.start + 1);
}

afterEach(() => vi.restoreAllMocks());

describe(`checkpoint (split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("prices a slice's tokens at our list rate and books it once: a retry books nothing and still answers (S1, S14)", async () => {
    const { text, ticket } = await ticketFor();
    const one = slice(ticket, 1, { input_tokens: 1_000, output_tokens: 200 });
    expect(await checkpointForRelay(env, text, live(one))).toEqual({ version: 2, decision: "continue", reasons: [], written: true });
    expect(await checkpointForRelay(env, text, live(one))).toEqual({ version: 2, decision: "continue", reasons: [], written: true });
    const expected = priceTokens(listPrice("openai", "gpt-4o-mini")!, { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 })!.cost;
    expect(await charges(ticket.sid)).toEqual([{ id: `${ticket.sid}:slice:1`, cost_nano: expected, price_source: "list_rate", session_ms: MINUTE, measured: "complete" }]);
  });

  it("books a slice once when two calls for it overlap, as a retry racing a slow first call would", async () => {
    const { text, ticket } = await ticketFor();
    const one = slice(ticket, 1, { output_tokens: 50 });
    const answers = await Promise.all([checkpointForRelay(env, text, live(one)), checkpointForRelay(env, text, live(one))]);
    expect(answers.map((a) => a.decision)).toEqual(["continue", "continue"]);
    expect(await charges(ticket.sid)).toHaveLength(1);
  });

  it("prices every slice at the rates the session started with: a rate change mid-session reprices nothing (Sol round 1)", async () => {
    await seedAccount();
    const connectionId = `conn_${crypto.randomUUID().replaceAll("-", "")}`;
    const rates = (input: number) => JSON.stringify({ "house-realtime": { input, output: input } });
    await env.DB.prepare(
      "INSERT INTO provider_connection (id, account_id, type, slug, name, status, rates_json, created_by, created_at, updated_at) VALUES (?, ?, 'openai', ?, 'T', 'active', ?, 't', ?, ?)",
    )
      .bind(connectionId, ACCOUNT_ID, connectionId.slice(0, 40), rates(1_000_000_000), Date.now(), Date.now())
      .run();
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    // The first checkpoint fixes the rates: $1 per million tokens.
    await checkpointForRelay(env, text, live(null));
    await env.DB.prepare("UPDATE provider_connection SET rates_json = ? WHERE id = ?").bind(rates(5_000_000_000), connectionId).run();
    await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 1_000 })));
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: 1_000_000, price_source: "customer_rate" }]);
  });

  it("never books a slice with a gap as complete, even one with no gap time (Sol round 1)", async () => {
    const { text, ticket } = await ticketFor();
    await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 5 }, { gaps: 1, gapMs: 0 })));
    expect(await charges(ticket.sid)).toMatchObject([{ measured: "partial" }]);
  });

  it("books tokens of a model with no price yet as unresolved, never as free, and queues them for pricing (AGENTS.md)", async () => {
    const { text, ticket } = await ticketFor({ model: "made-up-realtime-model" });
    await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 10, output_tokens: 10 })));
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: null, price_source: "unresolved" }]);
    expect(await ledger().prepare("SELECT kind FROM open_work WHERE charge_id = ?").bind(`${ticket.sid}:slice:1`).first()).toEqual({ kind: "unresolved" });
    // Connection time alone costs nothing: there is no usage to price.
    expect(priceSlice(ticket, {}, null)).toMatchObject({ costNano: 0, priceSource: "list_rate" });
  });

  it("writes the session row on an empty checkpoint, with the provider's call id, and marks a gap's slice partial (rows 13, 14)", async () => {
    const { text, ticket } = await ticketFor();
    await checkpointForRelay(env, text, { ...live(null), providerCallId: "call_9" });
    expect(await ledger().prepare("SELECT state, provider_call_id FROM session WHERE id = ?").bind(ticket.sid).first()).toEqual({ state: "active", provider_call_id: "call_9" });
    await checkpointForRelay(env, text, live(slice(ticket, 1, {}, { sessionMs: 0, gapMs: 30_000, gaps: 1 })));
    expect(await charges(ticket.sid)).toMatchObject([{ measured: "partial", session_ms: 0 }]);
    expect(await ledger().prepare("SELECT gaps FROM session WHERE id = ?").bind(ticket.sid).first()).toEqual({ gaps: 1 });
  });

  it("refuses a forged ticket and any input it would book unchecked", async () => {
    const { text, ticket } = await ticketFor();
    const [signed, signature = ""] = text.split(".");
    await expect(checkpointForRelay(env, `${signed}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`, live(null))).rejects.toThrow("ticket_refused");
    for (const bad of [
      live(slice(ticket, 0)),
      live(slice(ticket, 1, { dollars: 5 })),
      live(slice(ticket, 1, { input_tokens: -1 })),
      live(slice(ticket, 1, { input_tokens: 1.5 })),
      live(slice(ticket, 1, {}, { sessionMs: ticket.cap + 60 * MINUTE })),
      live(slice(ticket, 1, {}, { from: 10, to: 5 })),
      { slice: null, connected: "yes", accounting: false },
    ]) {
      await expect(checkpointForRelay(env, text, bad)).rejects.toBeInstanceOf(ContractRefusal);
    }
    expect(await charges(ticket.sid)).toEqual([]);
  });

  it("asks the end user's limiter after the ledger side: the oldest connected session is replaced, and learns it at its own next checkpoint (rows 17, 20)", async () => {
    const endUserId = `user_${crypto.randomUUID().slice(0, 8)}`;
    const a = await ticketFor({ endUserId }, 3_000);
    const b = await ticketFor({ endUserId }, 2_000);
    const c = await ticketFor({ endUserId }, 1_000);
    for (const one of [a, b, c]) await slotFor(one.ticket);
    expect(await checkpointForRelay(env, a.text, live(null))).toMatchObject({ decision: "continue" });
    expect(await checkpointForRelay(env, b.text, live(null))).toMatchObject({ decision: "continue" });
    // C connects: three connected over a limit of two, so the oldest by ticket time, A, is replaced.
    expect(await checkpointForRelay(env, c.text, live(null))).toMatchObject({ decision: "continue" });
    // A's next checkpoint, and its retry after a lost reply, both answer stop with `replaced`.
    expect(await checkpointForRelay(env, a.text, live(slice(a.ticket, 1)))).toEqual({ version: 2, decision: "stop", reasons: ["replaced"], written: true });
    expect(await checkpointForRelay(env, a.text, live(slice(a.ticket, 1)))).toMatchObject({ decision: "stop", reasons: ["replaced"] });
    expect(await checkpointForRelay(env, b.text, live(null))).toMatchObject({ decision: "continue" });
  });

  it("replaces nobody before the session proves it is real, and asks no limiter for a streaming session or an accounting delivery (row 20)", async () => {
    const endUserId = `user_${crypto.randomUUID().slice(0, 8)}`;
    const a = await ticketFor({ endUserId }, 3_000);
    const b = await ticketFor({ endUserId }, 2_000);
    const c = await ticketFor({ endUserId }, 1_000);
    for (const one of [a, b, c]) await slotFor(one.ticket);
    await checkpointForRelay(env, a.text, live(null));
    await checkpointForRelay(env, b.text, live(null));
    // C has no client message yet: ask-only, nothing changes.
    expect(await checkpointForRelay(env, c.text, live(null, false))).toMatchObject({ decision: "continue" });
    expect(await checkpointForRelay(env, a.text, live(null))).toMatchObject({ decision: "continue" });

    const streaming = await ticketFor({ slot: "streaming" });
    const asked = vi.spyOn(env.END_USER_LIMITER, "getByName");
    await checkpointForRelay(env, streaming.text, live(null));
    await checkpointForRelay(env, a.text, { ...live(slice(a.ticket, 1)), accounting: true });
    expect(asked).not.toHaveBeenCalled();
  });

  it("answers stop for a live checkpoint of a session the ledger ended, and books an accounting delivery as written with no stop (row 16)", async () => {
    const { text, ticket } = await ticketFor();
    await checkpointForRelay(env, text, live(null));
    await closeSession(ledger(), { session: { ...(await import("../src/relay/tickets.ts")).sessionRowOf(ticket) }, finalSlice: 1, endReason: "time_cap", endedAt: Date.now(), now: Date.now() });
    expect(await checkpointForRelay(env, text, { ...live(slice(ticket, 1)), accounting: true })).toEqual({ version: 2, decision: "continue", reasons: [], written: true });
    expect(await checkpointForRelay(env, text, live(slice(ticket, 2)))).toMatchObject({ decision: "stop", reasons: ["ended"] });
  });

  it("a lost stop: the user is blocked between two tries of one slice, and the retry answers user_blocked without asking the limiter (rows 16, 17)", async () => {
    const appId = await seedApp({ type: "api_key", end_user: { source: "header", header: "x-end-user-id" } });
    const { text, ticket } = await ticketFor({ appId });
    const one = slice(ticket, 1, { input_tokens: 5 });
    expect(await checkpointForRelay(env, text, live(one))).toMatchObject({ decision: "continue" });
    await env.DB.prepare("INSERT INTO app_end_user (app_id, id, status, created_at) VALUES (?, ?, 'blocked', ?)").bind(ticket.app, ticket.endUser, Date.now()).run();
    const asked = vi.spyOn(env.END_USER_LIMITER, "getByName");
    expect(await checkpointForRelay(env, text, live(one))).toEqual({ version: 2, decision: "stop", reasons: ["user_blocked"], written: true });
    expect(asked).not.toHaveBeenCalled();
    expect(await charges(ticket.sid)).toHaveLength(1);
  });

  it("continues when the end user's limiter can't answer (row 20)", async () => {
    const { text, ticket } = await ticketFor();
    vi.spyOn(env.END_USER_LIMITER, "getByName").mockReturnValue({
      sessionCheckpoint: () => Promise.reject(new Error("limiter down")),
    } as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await checkpointForRelay(env, text, live(slice(ticket, 1)))).toEqual({ version: 2, decision: "continue", reasons: [], written: true });
  });

  it("answers continue, not written, when the ledger can't be reached, so the relay sends the slice again (row 16)", async () => {
    const { text, ticket } = await ticketFor();
    const down = withLedgerDb(env, (real) => ({ prepare: (sql: string) => real.prepare(sql), batch: () => Promise.reject(new Error("ledger down")) }) as unknown as D1Database);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await checkpointForRelay(down, text, live(slice(ticket, 1)))).toEqual({ version: 2, decision: "continue", reasons: [], written: false });
    expect(await charges(ticket.sid)).toEqual([]);
  });

  it("measures the end user's budget as admission does, and the app's own", () => {
    const app = { id: "app_b", authentication: { type: "apple_app_attest" }, limits: { per_user: { spending: { monthly_nano: 500, scope: "install" } }, per_app: { spending: { monthly_nano: 900 } } } } as unknown as AppRecord;
    const ticket = { install: "inst_1", endUser: "u1", appleAccount: null } as Ticket;
    expect(checkpointBudgets(app, ticket)).toEqual([
      { scope: "install", scopeId: "inst_1", limitNano: 500 },
      { scope: "app", scopeId: "app_b", limitNano: 900 },
    ]);
    const server = { ...app, authentication: { type: "api_key" }, limits: { per_user: { spending: { monthly_nano: null } }, per_app: { spending: { monthly_nano: null } } } } as unknown as AppRecord;
    expect(checkpointBudgets(server, { install: null, endUser: "u1", appleAccount: null } as Ticket)).toEqual([]);
  });
});
