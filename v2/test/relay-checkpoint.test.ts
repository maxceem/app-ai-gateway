/**
 * `checkpoint`, the relay's third call (step 9a part 2; plan 4.2 and 5.1;
 * crash table rows 16–20): it prices a slice's measures, books it once in the
 * account's ledger object, and answers continue or stop. Replacement comes
 * from the end user's limiter, after the ledger side, for a live checkpoint
 * only (row 20).
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkpointBudgets, checkpointForRelay, priceSlice, sliceCharge, type SliceInput } from "../src/relay/checkpoint.ts";
import { decodeSessionPrice, encodeSessionPrice } from "../src/relay/session-price.ts";
import { ContractRefusal, openForRelay } from "../src/relay/contract.ts";
import { issueTicket, sessionRowOf, type TicketRequest } from "../src/relay/tickets.ts";
import { closeSession, openSession } from "../src/ledger/sessions.ts";
import { priceUnresolvedCharge } from "../src/ledger/corrections.ts";
import { runSweep } from "../src/ledger/sweep.ts";
import { userLimiterName } from "../src/limits/admission.ts";
import { listPrice, PRICE_LIST } from "../src/pricing/prices.ts";
import { priceTokens } from "../src/pricing/tokens.ts";
import type { SessionCheckpointAnswer, UserSessionAdmission } from "../src/do/EndUserLimiter.ts";
import type { SlotClaim } from "../src/do/session-slots.ts";
import type { AppRecord } from "../src/core/types.ts";
import { parseTicket, deadlineOf, type Ticket } from "../relay/src/ticket.js";
import { ACCOUNT_ID, ledger, seedAccount, seedApp } from "./helpers.ts";
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

const savedPrice = (sessionId: string) =>
  ledger().prepare("SELECT rates_json FROM session WHERE id = ?").bind(sessionId).first<{ rates_json: string | null }>().then((row) => row?.rates_json ?? null);

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

  /** A connection with its own rate for `house-realtime`: `input` nano-dollars per million tokens, in and out. */
  async function houseConnection(input: number | string): Promise<{ connectionId: string; setRates: (next: number | string) => Promise<unknown> }> {
    await seedAccount();
    const connectionId = `conn_${crypto.randomUUID().replaceAll("-", "")}`;
    const rates = (rate: number | string) => (typeof rate === "string" ? rate : JSON.stringify({ "house-realtime": { input: rate, output: rate } }));
    await env.DB.prepare(
      "INSERT INTO provider_connection (id, account_id, type, slug, name, status, rates_json, created_by, created_at, updated_at) VALUES (?, ?, 'openai', ?, 'T', 'active', ?, 't', ?, ?)",
    )
      .bind(connectionId, ACCOUNT_ID, connectionId.slice(0, 40), rates(input), Date.now(), Date.now())
      .run();
    return {
      connectionId,
      setRates: (next) => env.DB.prepare("UPDATE provider_connection SET rates_json = ? WHERE id = ?").bind(rates(next), connectionId).run(),
    };
  }

  it("books at the saved price A when a checkpoint proposes B, in one call to the ledger (Sol round 4)", async () => {
    const { connectionId, setRates } = await houseConnection(1_000_000_000);
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    // The first checkpoint, empty, saves price A: $1 per million tokens.
    await checkpointForRelay(env, text, live(null));
    expect(await savedPrice(ticket.sid)).toContain('"source":"customer_rate"');
    await setRates(5_000_000_000);
    const calls = vi.spyOn(env.ACCOUNT_LEDGER, "get");
    expect(await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 1_000 })))).toMatchObject({ decision: "continue", written: true });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: 1_000_000, price_source: "customer_rate" }]);
  });

  it("acknowledges a slice already booked, changing nothing, when its retry comes after a slow first commit (Sol round 4)", async () => {
    const { connectionId, setRates } = await houseConnection(1_000_000_000);
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    const one = slice(ticket, 1, { input_tokens: 1_000 });
    // The first commit lands; its reply is lost. Meanwhile the price changes.
    await checkpointForRelay(env, text, live(one));
    await setRates(5_000_000_000);
    const warned = vi.spyOn(console, "warn");
    expect(await checkpointForRelay(env, text, live(one))).toEqual({ version: 2, decision: "continue", reasons: [], written: true });
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: 1_000_000 }]);
    expect(warned.mock.calls.map((call) => String(call[0])).join()).not.toContain("price");
  });

  it("keeps a stop the ledger gives: there is no second call to lose it (Sol round 4)", async () => {
    const { connectionId, setRates } = await houseConnection(1_000_000_000);
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    await checkpointForRelay(env, text, live(null));
    await closeSession(ledger(), { session: sessionRowOf(ticket), finalSlice: 1, endReason: "time_cap", endedAt: Date.now(), now: Date.now() });
    // A new price is proposed, and the session has ended: the live checkpoint is booked at A and
    // stops, in one call to the ledger object.
    await setRates(5_000_000_000);
    const calls = vi.spyOn(env.ACCOUNT_LEDGER, "get");
    expect(await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 1_000 })))).toEqual({
      version: 2,
      decision: "stop",
      reasons: ["ended"],
      written: true,
    });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: 1_000_000 }]);
  });

  it("books unresolved, with a warning, when the saved price can't price the slice (a cost too large to store) (Fable round 1)", async () => {
    const { text, ticket } = await ticketFor();
    await openSession(ledger(), sessionRowOf(ticket), Date.now());
    const huge = { source: "list_rate", price: { ...listPrice("openai", "gpt-4o-mini")!, rates: { input: 9_000_000_000_000_000, output: 9_000_000_000_000_000 } } };
    await ledger().prepare("UPDATE session SET rates_json = ? WHERE id = ?").bind(JSON.stringify(huge), ticket.sid).run();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 1_000_000_000 })));
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: null, price_source: "unresolved" }]);
    expect(warned.mock.calls.map((call) => String(call[0])).join()).toContain("checkpoint_saved_price_unusable");
  });

  it("saves nothing while today's rates can't be read, booking unresolved; a later readable checkpoint saves the price (Sol round 4)", async () => {
    const { connectionId, setRates } = await houseConnection("{not json");
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 1_000 })));
    expect(await savedPrice(ticket.sid)).toBeNull();
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: null, price_source: "unresolved" }]);
    const logged = warned.mock.calls.map((call) => String(call[0])).join();
    expect(logged).toContain("checkpoint_price_unread");
    expect(logged).toContain("checkpoint_price_unsaved");
    await setRates(1_000_000_000);
    await checkpointForRelay(env, text, live(slice(ticket, 2, { input_tokens: 1_000 }, { from: ticket.start + 60_000, to: ticket.start + 120_000 })));
    expect(await savedPrice(ticket.sid)).toContain('"source":"customer_rate"');
    expect(await charges(ticket.sid)).toMatchObject([{ price_source: "unresolved" }, { cost_nano: 1_000_000, price_source: "customer_rate" }]);
  });

  it("a retry of a booked slice saves no price: only a new slice does (Sol round 5)", async () => {
    const { connectionId, setRates } = await houseConnection("{not json");
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Slice 1 is booked unresolved; its reply is lost.
    const one = slice(ticket, 1, { input_tokens: 1_000 });
    await checkpointForRelay(env, text, live(one));
    // The rates recover to A, and slice 1 is sent again: acknowledged, and nothing is saved.
    await setRates(1_000_000_000);
    expect(await checkpointForRelay(env, text, live(one))).toMatchObject({ written: true });
    expect(await savedPrice(ticket.sid)).toBeNull();
    // The rates change to B; slice 2 saves B and is booked at it.
    await setRates(3_000_000_000);
    await checkpointForRelay(env, text, live(slice(ticket, 2, { input_tokens: 1_000 })));
    expect(await charges(ticket.sid)).toMatchObject([{ price_source: "unresolved" }, { cost_nano: 3_000_000, price_source: "customer_rate" }]);
  });

  it("a booking that fails saves no price: the retry's price is the one saved (Sol round 5)", async () => {
    const { connectionId, setRates } = await houseConnection(1_000_000_000);
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    const one = slice(ticket, 1, { input_tokens: 1_000 });
    // The charge insert fails inside the ledger object's transaction.
    await ledger()
      .prepare(`CREATE TRIGGER fail_slice BEFORE INSERT ON charge WHEN NEW.id = '${ticket.sid}:slice:1' BEGIN SELECT RAISE(ABORT, 'forced'); END`)
      .run();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await checkpointForRelay(env, text, live(one))).toMatchObject({ decision: "continue", written: false });
    } finally {
      await ledger().prepare("DROP TRIGGER fail_slice").run();
    }
    expect(await savedPrice(ticket.sid)).toBeNull();
    // The rates change; the retry saves its own price and is booked at it.
    await setRates(2_000_000_000);
    expect(await checkpointForRelay(env, text, live(one))).toMatchObject({ written: true });
    expect(await savedPrice(ticket.sid)).toContain("2000000000");
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: 2_000_000 }]);
  });

  it("the sweep prices an unresolved slice at the session's saved price, not the current rate (Sol round 5)", async () => {
    const { connectionId, setRates } = await houseConnection("{not json");
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Slice 1 is unresolved; slice 2 saves A.
    await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 1_000 })));
    await setRates(1_000_000_000);
    await checkpointForRelay(env, text, live(slice(ticket, 2, { input_tokens: 1_000 })));
    // The connection changes to B; the sweep prices slice 1 at A.
    await setRates(4_000_000_000);
    expect(await priceUnresolvedCharge(ledger(), env.DB, { chargeId: `${ticket.sid}:slice:1`, now: Date.now() })).toMatchObject({
      status: "priced",
      correction: { costNano: 1_000_000, priceSource: "customer_rate" },
    });
  });

  it("the sweep books nothing when a checkpoint saves the session's price while it reads the current rate; the next sweep uses the saved price (Sol round 6)", async () => {
    const { connectionId, setRates } = await houseConnection("{not json");
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Slice 1 is unresolved, and nothing is saved.
    await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 1_000 })));
    await setRates(1_000_000_000);
    // The sweep reads no saved price; while it fetches today's rate (B), a checkpoint saves A.
    const settings = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            await checkpointForRelay(env, text, live(slice(ticket, 2, { input_tokens: 1_000 })));
            return { rates_json: JSON.stringify({ "house-realtime": { input: 4_000_000_000, output: 4_000_000_000 } }) };
          },
        }),
        sql,
      }),
    } as unknown as D1Database;
    expect(await priceUnresolvedCharge(ledger(), settings, { chargeId: `${ticket.sid}:slice:1`, now: Date.now() })).toEqual({ status: "price_changed" });
    expect(await ledger().prepare("SELECT COUNT(*) AS n FROM charge WHERE corrects_charge_id = ?").bind(`${ticket.sid}:slice:1`).first()).toEqual({ n: 0 });
    // The next sweep prices slice 1 at A, though the connection is at B now.
    await setRates(4_000_000_000);
    expect(await priceUnresolvedCharge(ledger(), env.DB, { chargeId: `${ticket.sid}:slice:1`, now: Date.now() })).toMatchObject({
      status: "priced",
      correction: { costNano: 1_000_000 },
    });
  });

  it("in a full sweep, keeps the queued work after price_changed, and removes it once the retry prices the slice (Fable round 1)", async () => {
    const { connectionId, setRates } = await houseConnection("{not json");
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 1_000 })));
    await setRates(1_000_000_000);
    const work = () => ledger().prepare("SELECT id FROM open_work WHERE id = ?").bind(`unresolved:${ticket.sid}:slice:1`).first();
    expect(await work()).not.toBeNull();
    // While the sweep reads this connection's rate (B), a checkpoint saves A.
    let fired = false;
    const racy = {
      ...env,
      DB: {
        prepare: (sql: string) => {
          const real = env.DB.prepare(sql);
          if (!sql.includes("FROM provider_connection")) return real;
          return {
            bind: (...params: unknown[]) => {
              const bound = real.bind(...params);
              if (params[0] !== connectionId || fired) return bound;
              return {
                first: async () => {
                  fired = true;
                  await checkpointForRelay(env, text, live(slice(ticket, 2, { input_tokens: 1_000 })));
                  return { rates_json: JSON.stringify({ "house-realtime": { input: 4_000_000_000, output: 4_000_000_000 } }) };
                },
              };
            },
          };
        },
        batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
      },
    } as unknown as Env;
    const later = Date.now() + 60 * 60_000;
    await runSweep(racy, ledger(), { now: later });
    expect(fired).toBe(true);
    expect(await work()).not.toBeNull();
    expect(await ledger().prepare("SELECT COUNT(*) AS n FROM charge WHERE corrects_charge_id = ?").bind(`${ticket.sid}:slice:1`).first()).toEqual({ n: 0 });
    // The retry, a day on, prices slice 1 at A and removes the work.
    await runSweep(env, ledger(), { now: later + 86_400_000 });
    expect(await work()).toBeNull();
    expect(await ledger().prepare("SELECT cost_nano FROM charge WHERE corrects_charge_id = ?").bind(`${ticket.sid}:slice:1`).first()).toEqual({ cost_nano: 1_000_000 });
  });

  it("dates a slice by its start: one that crosses midnight UTC counts on the day, and in the plan period, it began (D18, Fable round 1)", async () => {
    const midnight = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const { ticket } = await ticketFor();
    // A session that started 30 s before midnight: its first minute crosses it.
    const started = { ...ticket, start: midnight - 30_000 };
    const charge = sliceCharge(started, slice(started, 1, { input_tokens: 10 }), priceSlice({ input_tokens: 10 }, null), Date.now());
    expect(charge.usageDay).toBe(new Date(midnight - 30_000).toISOString().slice(0, 10));
  });

  it("books every slice at the price the first checkpoint saved: a new price list mid-session changes nothing (Sol rounds 2 to 4)", async () => {
    const { text, ticket } = await ticketFor();
    await checkpointForRelay(env, text, live(null));
    const usage = { input_tokens: 1_000, output_tokens: 200 };
    const before = listPrice("openai", "gpt-4o-mini")!;
    const expected = priceTokens(before, { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 })!.cost;
    // A new release ships a price list where the model costs five times as much.
    const models = PRICE_LIST.get("openai") as unknown as Map<string, unknown>;
    const fivefold = Object.fromEntries(Object.entries(before.rates).map(([name, rate]) => [name, (rate as number) * 5]));
    models.set("gpt-4o-mini", { ...before, rates: fivefold } as never);
    try {
      expect(listPrice("openai", "gpt-4o-mini")).not.toEqual(before);
      await checkpointForRelay(env, text, live(slice(ticket, 1, usage)));
    } finally {
      models.set("gpt-4o-mini", before);
    }
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: expected, price_source: "list_rate" }]);
  });

  it("saves no price at open: the first checkpoint does (Sol round 3)", async () => {
    const { text, ticket } = await ticketFor();
    await openSession(ledger(), sessionRowOf(ticket), Date.now());
    await openForRelay(env, text);
    expect(await savedPrice(ticket.sid)).toBeNull();
  });

  for (const [what, saved] of [
    ["isn't JSON", "{not json"],
    ["has rates: null", JSON.stringify({ source: "list_rate", price: { rates: null, raw: {} } })],
  ] as const) {
    it(`books unresolved, with a warning, when the saved price ${what}: the sweep prices it (Fable round 1)`, async () => {
      const { text, ticket } = await ticketFor();
      await openSession(ledger(), sessionRowOf(ticket), Date.now());
      await ledger().prepare("UPDATE session SET rates_json = ? WHERE id = ?").bind(saved, ticket.sid).run();
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 1_000, output_tokens: 200 })))).toMatchObject({ written: true });
      expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: null, price_source: "unresolved" }]);
      expect(warned.mock.calls.map((call) => String(call[0])).join()).toContain("checkpoint_saved_price_unusable");
      expect(await ledger().prepare("SELECT kind FROM open_work WHERE charge_id = ?").bind(`${ticket.sid}:slice:1`).first()).toEqual({ kind: "unresolved" });
    });
  }

  it("reads back a saved price: JSON with a known source, or '' for no price", () => {
    const good = encodeSessionPrice({ source: "list_rate", price: listPrice("openai", "gpt-4o-mini")! });
    expect(decodeSessionPrice(good)?.source).toBe("list_rate");
    expect(decodeSessionPrice("")).toBeNull();
    for (const bad of ["{not json", "null", "7", JSON.stringify({ source: "free", price: { rates: {} } })]) expect(() => decodeSessionPrice(bad)).toThrow();
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
    expect(priceSlice({}, null)).toMatchObject({ costNano: 0, priceSource: "list_rate" });
  });

  it("writes the session row on an empty checkpoint, with the provider's call id, and books a gap alone as unknown cost (rows 13, 14; Gemini Neon round 1)", async () => {
    // Its own app, so the day's unpriced count is this slice's alone.
    const { text, ticket } = await ticketFor({ appId: `app_gap_${crypto.randomUUID().slice(0, 8)}` });
    await checkpointForRelay(env, text, { ...live(null), providerCallId: "call_9" });
    expect(await ledger().prepare("SELECT state, provider_call_id FROM session WHERE id = ?").bind(ticket.sid).first()).toEqual({ state: "active", provider_call_id: "call_9" });
    await checkpointForRelay(env, text, live(slice(ticket, 1, {}, { sessionMs: 0, gapMs: 30_000, gaps: 1 })));
    expect(await ledger().prepare("SELECT gaps FROM session WHERE id = ?").bind(ticket.sid).first()).toEqual({ gaps: 1 });
    // A gap alone is an unknown cost, never $0 (plan 4.2, 5.2), and has no tokens for the sweep to price.
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: null, price_source: "unresolved", measured: "partial", session_ms: 0 }]);
    const day = await ledger().prepare("SELECT usage_day FROM charge WHERE id = ?").bind(`${ticket.sid}:slice:1`).first<{ usage_day: string }>();
    const unpriced = await ledger()
      .prepare("SELECT SUM(unpriced_charges) AS n FROM usage_day WHERE account_id = ? AND app_id = ? AND day = ?")
      .bind(ACCOUNT_ID, ticket.app, day!.usage_day)
      .first();
    expect(unpriced).toEqual({ n: 1 });
    expect(await ledger().prepare("SELECT id FROM open_work WHERE charge_id = ?").bind(`${ticket.sid}:slice:1`).first()).toBeNull();
  });

  /** Rates for the house model, saved form: nano-dollars, per minute of connection or per token. */
  const perMinute = (nanoPerMinute: number) => JSON.stringify({ "house-realtime": { per_minute: nanoPerMinute } });
  const booked = (id: string) =>
    ledger().prepare("SELECT cost_nano, price_source, measured, measures_json FROM charge WHERE id = ?").bind(id).first<{ cost_nano: number | null; price_source: string; measured: string; measures_json: string }>();
  const queued = (id: string) => ledger().prepare("SELECT kind FROM open_work WHERE charge_id = ?").bind(id).first();

  it("bills connection time at a price's time rate, through the checkpoint: the wall clock meter (step 9a part 3)", async () => {
    // $0.0043 a minute, as a provider billed by connection time states it: one minute is 4,300,000 nano-dollars.
    const { connectionId } = await houseConnection(perMinute(4_300_000));
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    await checkpointForRelay(env, text, live(slice(ticket, 1)));
    await checkpointForRelay(env, text, live(slice(ticket, 2, {}, { sessionMs: 90_000 })));
    // A gap in a slice billed by time keeps the price of the time it knows, marked partial, never $0.
    await checkpointForRelay(env, text, live(slice(ticket, 3, {}, { sessionMs: 30_000, gapMs: 30_000, gaps: 1 })));
    expect(await charges(ticket.sid)).toMatchObject([
      { cost_nano: 4_300_000, price_source: "customer_rate", measured: "complete", session_ms: MINUTE },
      { cost_nano: 6_450_000, measured: "complete" },
      { cost_nano: 2_150_000, measured: "partial" },
    ]);
    // The billed time is kept as the slice's usage.
    expect(JSON.parse((await booked(`${ticket.sid}:slice:1`))!.measures_json)).toMatchObject({ units_session_seconds: MINUTE });
  });

  it("never books connection time as $0 when the price can't be read: unresolved and queued, and the sweep prices the seconds (Sol round 1)", async () => {
    // Today's rates can't be read (as when the settings read times out): no price is saved.
    const { connectionId, setRates } = await houseConnection("{not json");
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await checkpointForRelay(env, text, live(slice(ticket, 1)));
    const id = `${ticket.sid}:slice:1`;
    expect(await booked(id)).toMatchObject({ cost_nano: null, price_source: "unresolved" });
    expect(await queued(id)).toEqual({ kind: "unresolved" });
    expect(warned.mock.calls.map((call) => String(call[0])).join()).toContain("checkpoint_price_unsaved");
    // The rates come back, billed by time: the sweep prices the minute.
    await setRates(perMinute(4_300_000));
    expect(await priceUnresolvedCharge(ledger(), env.DB, { chargeId: id, now: Date.now() })).toMatchObject({
      status: "priced",
      correction: { costNano: 4_300_000, priceSource: "customer_rate", unit: "session_seconds" },
    });
  });

  it("the sweep keeps a cut-off slice's correction partial (Sol round 2)", async () => {
    const { connectionId, setRates } = await houseConnection("{not json");
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // An answer cut off at the end: its known tokens, and a gap with no gap time.
    await checkpointForRelay(env, text, live(slice(ticket, 1, { input_tokens: 1_000 }, { gaps: 1 })));
    await setRates(1_000_000_000);
    expect(await priceUnresolvedCharge(ledger(), env.DB, { chargeId: `${ticket.sid}:slice:1`, now: Date.now() })).toMatchObject({
      status: "priced",
      correction: { costNano: 1_000_000, measured: "partial" },
    });
  });

  it("the sweep books connection time at $0 when the price turns out to bill tokens only, but a slice with a gap stays an unknown cost (Sol round 1)", async () => {
    const { connectionId, setRates } = await houseConnection("{not json");
    const { text, ticket } = await ticketFor({ connectionId, model: "house-realtime" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await checkpointForRelay(env, text, live(slice(ticket, 1)));
    await checkpointForRelay(env, text, live(slice(ticket, 2, {}, { sessionMs: 30_000, gapMs: 30_000, gaps: 1 })));
    // Time with no price is queued, even with a gap; a gap with no known time is not.
    await checkpointForRelay(env, text, live(slice(ticket, 3, {}, { sessionMs: 0, gapMs: 60_000, gaps: 1 })));
    expect(await queued(`${ticket.sid}:slice:2`)).toEqual({ kind: "unresolved" });
    expect(await queued(`${ticket.sid}:slice:3`)).toBeNull();
    await setRates(1_000_000_000);
    expect(await priceUnresolvedCharge(ledger(), env.DB, { chargeId: `${ticket.sid}:slice:1`, now: Date.now() })).toMatchObject({
      status: "priced",
      correction: { costNano: 0 },
    });
    expect(await priceUnresolvedCharge(ledger(), env.DB, { chargeId: `${ticket.sid}:slice:2`, now: Date.now() })).toEqual({ status: "already" });
    expect(await booked(`${ticket.sid}:slice:2`)).toMatchObject({ cost_nano: null, price_source: "unresolved", measured: "partial" });
  });

  it("books a clean slice with no tokens and no gap at $0, complete (Gemini Neon round 1)", async () => {
    const { text, ticket } = await ticketFor();
    await checkpointForRelay(env, text, live(slice(ticket, 1)));
    expect(await charges(ticket.sid)).toMatchObject([{ cost_nano: 0, price_source: "list_rate", measured: "complete", session_ms: 60_000 }]);
    expect(await ledger().prepare("SELECT id FROM open_work WHERE charge_id = ?").bind(`${ticket.sid}:slice:1`).first()).toBeNull();
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
    const down = { ...env, ACCOUNT_LEDGER: { idFromName: (name: string) => name, get: () => ({ checkpoint: () => Promise.reject(new Error("ledger down")) }) } } as unknown as Env;
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
