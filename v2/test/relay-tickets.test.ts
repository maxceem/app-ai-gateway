/**
 * Session tickets (plan step 9a; 8j "Session tickets"; crash table rows 1, 4,
 * 5, 6, 24 and 25): the main Worker signs them, and the vault's relay
 * entrypoint and `open` check them on their own. Runs with split keys off and
 * on: the ticket carries the session seal in both.
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeForRelay, CONTRACT_VERSION, openForRelay } from "../src/relay/contract.ts";
import { issueTicket, MAX_SESSION_CAP_MS, SEAL_GRACE_MS, sessionRowOf, signTicket, TICKET_TTL_MS, type TicketRequest } from "../src/relay/tickets.ts";
import { LEDGER_LATE_BOOKING_DAYS } from "../src/ledger/late-booking.ts";
import { ledgerDb } from "../src/ledger/database.ts";
import { openSession, settleSession, STALE_SESSION_GRACE_MS } from "../src/ledger/sessions.ts";
import { MAX_STORED_COPY_MS } from "../vault/src/call.js";
import { sessionKey } from "../vault/src/relay.js";
import { connectProvider } from "../relay/src/provider.js";
import { ProviderRefused, SessionCore } from "../relay/src/start.js";
import { base64url, parseTicket } from "../relay/src/ticket.js";
import { TEST_VAULT_ENV } from "./local-vault.ts";
import { TEST_TICKET_PUBLIC_KEY } from "./relay-keys.ts";
import { ACCOUNT_ID } from "./helpers.ts";
import { sealForTest, splitKeysOn, testShare } from "./split-keys.ts";

const KEY = "sk-session-key-0123456789";
const VAULT_ENV = { ...TEST_VAULT_ENV, RELAY_TICKET_PUBLIC_KEY: TEST_TICKET_PUBLIC_KEY };
const relayKeys = () => (env as unknown as { VAULT_RELAY: { sessionKey(ticket: string, options: { restart?: boolean }): Promise<Record<string, unknown>> } }).VAULT_RELAY;

/** A ticket request for an OpenAI realtime session on a connection to OpenAI's own address. */
async function request(overrides: Partial<TicketRequest> = {}, baseUrl = ""): Promise<TicketRequest> {
  const identity: [string, string, string, string, string, string] = [ACCOUNT_ID, "conn_live", "openai", baseUrl, "", ""];
  const blob = await sealForTest("providerKey", identity, KEY);
  const share = await testShare(ACCOUNT_ID);
  return {
    accountId: ACCOUNT_ID,
    appId: "app_live",
    endUserId: "user_1",
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    providerType: "openai",
    connectionId: "conn_live",
    operation: "openai.realtime",
    model: "gpt-realtime",
    mode: "relayed",
    slot: "conversational",
    sessionTotal: false,
    url: "https://api.openai.com/v1/realtime?model=gpt-realtime",
    capMs: 30 * 60_000,
    credentials: { providerKey: { blob, identity }, cloudflareToken: null, ...(share === null ? {} : { credential: share.forVault() }) },
    keyPlacement: { header: "authorization", format: "Bearer {key}" },
    ...overrides,
  };
}

/** The ticket with one character of its signature changed. */
function forged(ticket: string): string {
  const [signed, signature = ""] = ticket.split(".");
  const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
  return `${signed}.${flipped}`;
}

/** A ticket whose payload was changed after signing: the signature no longer matches. */
function edited(ticket: string, change: (payload: Record<string, unknown>) => void): string {
  const parsed = parseTicket(ticket)!;
  const payload = { ...parsed.payload } as Record<string, unknown>;
  change(payload);
  return `${base64url(new TextEncoder().encode(JSON.stringify(payload)))}.${ticket.split(".")[1]}`;
}

afterEach(() => vi.useRealTimers());

describe(`session tickets (split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("carry the session's seal, never the key or the app's share, and a deadline of start plus cap", async () => {
    const now = Date.now();
    const issued = await issueTicket(env, await request(), now);
    const { payload } = parseTicket(issued.ticket)!;
    expect(issued.ticket).not.toContain(KEY);
    expect(JSON.stringify(payload)).not.toContain(KEY);
    expect(JSON.stringify(payload)).not.toContain("credential");
    expect(payload.exp).toBe(now + TICKET_TTL_MS);
    expect(issued.deadline).toBe(now + 30 * 60_000);
    // A copy bound to its own expiry: a few minutes past the deadline (8j).
    expect(payload.seal.providerKey?.identity).toHaveLength(7);
    expect(Number(payload.seal.providerKey?.identity[6])).toBe(payload.exp + payload.cap + SEAL_GRACE_MS);
    expect(sessionRowOf(payload)).toMatchObject({ id: issued.sessionId, accountId: ACCOUNT_ID, timeCapMs: 30 * 60_000, startedAt: now });
  });

  it("keep the longest session inside the vault's limit on a copy and the ledger's late-booking window (plan 5.1)", () => {
    expect(TICKET_TTL_MS + MAX_SESSION_CAP_MS + SEAL_GRACE_MS).toBeLessThanOrEqual(MAX_STORED_COPY_MS);
    expect(MAX_SESSION_CAP_MS + SEAL_GRACE_MS).toBeLessThan(LEDGER_LATE_BOOKING_DAYS * 24 * 60 * 60_000);
  });

  it("are opened by the vault's relay entrypoint, through the binding, at the one address the seal allows", async () => {
    const { ticket } = await issueTicket(env, await request());
    const answer = await relayKeys().sessionKey(ticket, {});
    expect(answer).toMatchObject({ key: { value: KEY, header: "authorization", format: "Bearer {key}" }, target: "https://api.openai.com/v1/realtime?model=gpt-realtime" });
  });

  it("are refused by the vault when forged, edited, cut or expired; a restart goes on past the ticket's expiry, never past the seal's", async () => {
    const issued = await issueTicket(env, await request(), Date.now());
    const { payload } = parseTicket(issued.ticket)!;
    await expect(sessionKey(VAULT_ENV, forged(issued.ticket))).rejects.toThrow("ticket_refused");
    await expect(sessionKey(VAULT_ENV, edited(issued.ticket, (p) => (p.account = "acct_other")))).rejects.toThrow("ticket_refused");
    await expect(sessionKey(VAULT_ENV, issued.ticket.slice(0, 40))).rejects.toThrow("ticket_refused");
    await expect(sessionKey(VAULT_ENV, issued.ticket, { now: payload.exp })).rejects.toThrow("ticket_expired");
    expect(await sessionKey(VAULT_ENV, issued.ticket, { restart: true, now: payload.exp + 1 })).toMatchObject({ key: { value: KEY } });
    // The seal's own expiry holds whatever the caller says (crash table row 24).
    vi.useFakeTimers({ toFake: ["Date"], now: payload.exp + payload.cap + SEAL_GRACE_MS + 1 });
    await expect(sessionKey(VAULT_ENV, issued.ticket, { restart: true })).rejects.toThrow("credential_unavailable");
  });

  it("send the key only to the sealed address: a ticket for another address is refused, whatever the settings say later", async () => {
    // A connection to a custom address: its seal is bound there.
    const custom = await request({ url: "https://llm.example.com/proxy/v1/realtime" }, "https://llm.example.com/proxy/");
    expect(await sessionKey(VAULT_ENV, (await issueTicket(env, custom)).ticket)).toMatchObject({ target: "https://llm.example.com/proxy/v1/realtime" });
    // Signed for an address the seal does not allow: refused, and no key comes back.
    const elsewhere = await request({ url: "https://evil.example.com/v1/realtime" }, "https://llm.example.com/proxy/");
    await expect(sessionKey(VAULT_ENV, (await issueTicket(env, elsewhere)).ticket)).rejects.toThrow("destination_refused");
    // A built-in type's seal ("") goes only to its own hosts.
    const offHost = await request({ url: "https://llm.example.com/v1/realtime" });
    await expect(sessionKey(VAULT_ENV, (await issueTicket(env, offHost)).ticket)).rejects.toThrow("destination_refused");
  });

  it("put the credential only on the sealed address when open and the seal disagree: the relay dials what the vault names (Sol round 1)", async () => {
    const sealed = "https://llm.example.com/proxy/";
    const issued = await issueTicket(env, await request({ url: `${sealed}v1/realtime` }, sealed), Date.now());
    const { payload } = parseTicket(issued.ticket)!;
    const dialed: { url: string; authorization: string | null }[] = [];
    const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
      dialed.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      const [client] = Object.values(new WebSocketPair());
      return new Response(null, { status: 101, webSocket: client });
    }) as typeof fetch;
    const data = new Map<string, unknown>();
    const core = new SessionCore({
      log: () => undefined,
      store: {
        get: async (keys) => new Map(keys.filter((key) => data.has(key)).map((key) => [key, data.get(key)])),
        put: async (entries) => {
          for (const [key, value] of Object.entries(entries)) data.set(key, value);
        },
        putJournal: async (journal) => void data.set("journal", journal),
        deleteAll: async () => data.clear(),
      },
      vault: { sessionKey: (ticket, options) => sessionKey(VAULT_ENV, ticket, options) },
      // `open` names another address than the seal's: the relay never uses it.
      main: {
        open: async (ticket) => ({ ...(await openForRelay(env, ticket)), url: "https://evil.example.com/v1/realtime", upstream: "https://evil.example.com/" }) as never,
        checkpoint: async () => ({ decision: "continue", reasons: [], written: true }),
        close: async () => ({ version: 1 }),
      },
      provider: { connect: async (key) => ({ callId: (await connectProvider(key, send)).callId }) },
    });
    expect(await core.start(issued.ticket, payload)).toMatchObject({ ok: true });
    expect(dialed).toEqual([{ url: `${sealed}v1/realtime`, authorization: `Bearer ${KEY}` }]);
  });

  it("open only a session seal, and only for the ticket's own account, even when the ticket is signed (wrong account)", async () => {
    const plain = await request();
    const { ticket } = await issueTicket(env, plain);
    const { payload } = parseTicket(ticket)!;
    // A connection's own key, not a session copy with its expiry: never opened here.
    const notACopy = await signTicket(env, { ...payload, seal: { providerKey: { ...plain.credentials.providerKey!, identity: [...plain.credentials.providerKey!.identity], header: "authorization", format: "Bearer {key}" } } });
    await expect(sessionKey(VAULT_ENV, notACopy)).rejects.toThrow("bad_seal");
    // A seal of one account in a ticket for another.
    await expect(sessionKey(VAULT_ENV, await signTicket(env, { ...payload, account: "acct_other" }))).rejects.toThrow("bad_seal");
  });
});

describe("the provider connection's time limit (T12, first run)", () => {
  const key = { key: { value: "sk", header: "authorization", format: "Bearer {key}" }, target: "https://provider.test/v1/realtime" };

  it("covers only the handshake: once connected, the limit passing never aborts the open session", async () => {
    let signal: AbortSignal | undefined;
    const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      const [client] = Object.values(new WebSocketPair());
      return new Response(null, { status: 101, webSocket: client });
    }) as typeof fetch;
    let elapse: () => void = () => undefined;
    await connectProvider(key, send, () => new Promise<void>((resolve) => (elapse = resolve)));
    // The limit's time passes after the handshake: the session's signal stays as it was.
    elapse();
    await Promise.resolve();
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
  });

  it("aborts a handshake that is still waiting when the limit passes: an unknown outcome, not a refusal", async () => {
    const send = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    const error = await connectProvider(key, send, () => Promise.resolve()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderRefused);
    // The limit given here, not a fixed 15 s signal: the test's own short limit ends it.
  }, 2_000);
});

describe("open and close (the relay's contract)", () => {
  it("open answers the same settings each time, never a key, and refuses a forged or expired ticket (rows 5, 6)", async () => {
    const issued = await issueTicket(env, await request(), Date.now());
    const first = await openForRelay(env, issued.ticket);
    expect(first).toEqual(await openForRelay(env, issued.ticket));
    expect(first).toMatchObject({ version: CONTRACT_VERSION, sessionId: issued.sessionId, deadline: issued.deadline, mode: "relayed" });
    expect(JSON.stringify(first)).not.toContain(KEY);
    await expect(openForRelay(env, forged(issued.ticket))).rejects.toThrow("ticket_refused");
    await expect(openForRelay(env, issued.ticket, issued.expiresAt)).rejects.toThrow("ticket_expired");
  });

  it("close writes the session row, ended, when no checkpoint did; a repeated close keeps the first reason (rows 3, 25)", async () => {
    const issued = await issueTicket(env, await request(), Date.now());
    // Long after the ticket expired: close checks only the signature.
    const later = issued.expiresAt + 60_000;
    await closeForRelay(env, issued.ticket, { finalSlice: 0, endReason: "error", endedAt: later, providerCallId: "call_1" }, later);
    await closeForRelay(env, issued.ticket, { finalSlice: 0, endReason: "client_closed", endedAt: later + 1, providerCallId: null }, later + 1);
    const row = await ledgerDb(env, ACCOUNT_ID).prepare("SELECT state, end_reason, final_slice, provider_call_id FROM session WHERE id = ?").bind(issued.sessionId).first();
    expect(row).toEqual({ state: "ended", end_reason: "error", final_slice: 0, provider_call_id: "call_1" });
    await expect(closeForRelay(env, forged(issued.ticket), { finalSlice: 0, endReason: "error", endedAt: later })).rejects.toThrow("ticket_refused");
    await expect(closeForRelay(env, issued.ticket, { finalSlice: 0, endReason: "made_up", endedAt: later })).rejects.toThrow("bad_request");
  });

  it("close never dates an end past the session's deadline", async () => {
    const issued = await issueTicket(env, await request({ capMs: 60_000 }), Date.now());
    await closeForRelay(env, issued.ticket, { finalSlice: 0, endReason: "time_cap", endedAt: issued.deadline + 3_600_000 });
    const row = await ledgerDb(env, ACCOUNT_ID).prepare("SELECT ended_at FROM session WHERE id = ?").bind(issued.sessionId).first<{ ended_at: number }>();
    expect(row?.ended_at).toBe(issued.deadline);
  });

  it("a session row left starting, never closed, ends with error at the stale step, not time_cap (rows 2, 4–6)", async () => {
    const issued = await issueTicket(env, await request({ capMs: 60_000 }), Date.now());
    const ledger = ledgerDb(env, ACCOUNT_ID);
    await openSession(ledger, issued.session, Date.now());
    const after = issued.deadline + STALE_SESSION_GRACE_MS;
    expect(await settleSession(ledger, { sessionId: issued.sessionId, now: after })).toBe("settled");
    const row = await ledger.prepare("SELECT state, end_reason FROM session WHERE id = ?").bind(issued.sessionId).first();
    expect(row).toEqual({ state: "ended", end_reason: "error" });
  });
});
