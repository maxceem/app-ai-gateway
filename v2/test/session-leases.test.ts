/**
 * Live-session leases and caps (plan D15 and section 6; step 9a part 1, third
 * review): the session slots in the end user's and the app's limiters, the
 * replacement decision (crash table row 20), and the client endpoint that
 * asks for a session. Rows: T1–T5, T7–T9, T11, T13, T14 of the admission
 * table; crash table rows 2, 4–8, 20 and 21.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { USER_STARTING_BOUND, USER_STREAMING_LIMIT, type SessionCheckpointAnswer, type UserSessionAdmission } from "../src/do/EndUserLimiter.ts";
import type { AppSessionAdmission } from "../src/do/AppLimiter.ts";
import type { SlotClaim } from "../src/do/session-slots.ts";
import { closeForRelay, openForRelay } from "../src/relay/contract.ts";
import { loadRequestApp } from "../src/apps/app-records.ts";
import { admitSession } from "../src/limits/session-admission.ts";
import { refusal } from "../src/proxy/serve.ts";
import { parseAppConfig } from "../src/admin/apps.ts";
import { parseTicket } from "../relay/src/ticket.js";
import { sealForTest } from "./split-keys.ts";
import { ACCOUNT_ID, clearCaches, ledger, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const RELAY_ENV = { ...env, RELAY_URL: "https://relay.test" } as unknown as Env;
const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// The limiters, called directly.

interface UserLimiter {
  admitSession(input: Record<string, unknown>): Promise<UserSessionAdmission>;
  activateSession(claim: SlotClaim, now: number): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  sessionCheckpoint(input: { sessionId: string; connected: boolean; now: number }): Promise<SessionCheckpointAnswer>;
}
interface AppLimiter {
  admitSession(input: Record<string, unknown>): Promise<AppSessionAdmission>;
  activateSession(claim: SlotClaim, now: number): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
}

const userLimiter = (name: string) => env.END_USER_LIMITER.getByName(name) as unknown as UserLimiter;
const appLimiter = (name: string) => env.APP_LIMITER.getByName(name) as unknown as AppLimiter;

let limiterCount = 0;
const freshName = () => `app_slots:user:${++limiterCount}_${crypto.randomUUID().slice(0, 8)}`;

const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);

function claim(sessionId: string, ticketStart: number, kind: "conversational" | "streaming" = "conversational"): SlotClaim {
  return { sessionId, kind, ticketStart, expiresAt: ticketStart + MINUTE, deadline: ticketStart + 30 * MINUTE };
}

const userAsk = (c: SlotClaim, now: number, takesOver: string | null = null) => ({ ...c, now, budgetNano: null, spend: null, takesOver });

/** Takes a slot and activates it, as a ticket and a successful `open` do. */
async function started(limiter: UserLimiter, c: SlotClaim): Promise<void> {
  expect(await limiter.admitSession(userAsk(c, c.ticketStart))).toMatchObject({ admitted: true });
  await limiter.activateSession(c, c.ticketStart + 1_000);
}

describe("the end user's session slots", () => {
  it("refuses a fifth conversational session starting or running, and a sixth stream, each with its own count (T14, T3)", async () => {
    const limiter = userLimiter(freshName());
    for (let i = 0; i < USER_STARTING_BOUND; i += 1) {
      expect(await limiter.admitSession(userAsk(claim(`ses_c${i}`, T0 + i), T0 + i))).toMatchObject({ admitted: true });
    }
    expect(await limiter.admitSession(userAsk(claim("ses_c4", T0 + 10), T0 + 10))).toEqual({ admitted: false, reason: "starting_bound" });
    // Streams have their own limit, and never count toward the conversational one.
    for (let i = 0; i < USER_STREAMING_LIMIT; i += 1) {
      expect(await limiter.admitSession(userAsk(claim(`ses_s${i}`, T0 + i, "streaming"), T0 + i))).toMatchObject({ admitted: true });
    }
    expect(await limiter.admitSession(userAsk(claim("ses_s5", T0 + 10, "streaming"), T0 + 10))).toEqual({ admitted: false, reason: "streaming_limit" });
    // A closed session frees its slot.
    await limiter.releaseSession("ses_c0");
    expect(await limiter.admitSession(userAsk(claim("ses_c5", T0 + 20), T0 + 20))).toMatchObject({ admitted: true });
  });

  it("frees a reservation at its ticket's expiry, but holds an activated lease until its deadline (T7, T9; crash rows 6 and 7)", async () => {
    const limiter = userLimiter(freshName());
    // Four reservations: one is activated (its reply may be lost), three stay reserved.
    await started(limiter, claim("ses_active", T0));
    for (const id of ["ses_r1", "ses_r2", "ses_r3"]) await limiter.admitSession(userAsk(claim(id, T0), T0));
    expect(await limiter.admitSession(userAsk(claim("ses_more", T0 + 1), T0 + 1))).toMatchObject({ admitted: false, reason: "starting_bound" });
    // Past the tickets' expiry: the reservations are gone, the activated lease is not.
    const later = T0 + MINUTE + 1;
    for (const id of ["ses_n1", "ses_n2", "ses_n3"]) expect(await limiter.admitSession(userAsk(claim(id, later), later))).toMatchObject({ admitted: true });
    expect(await limiter.admitSession(userAsk(claim("ses_n4", later), later))).toMatchObject({ admitted: false, reason: "starting_bound" });
  });

  it("frees an activated lease at its deadline and not before, with no close (T9; Sol 9a3 round 1)", async () => {
    // An app cap of one: the only seat is the activated lease's, so each answer is about it alone.
    const limiter = appLimiter(freshName());
    const lease = claim("ses_lease", T0);
    expect(await limiter.admitSession({ ...lease, now: T0, budgetNano: null, spend: null, cap: 1 })).toMatchObject({ admitted: true });
    await limiter.activateSession(lease, T0 + 1_000);
    const justBefore = lease.deadline - 1;
    expect(await limiter.admitSession({ ...claim("ses_before", justBefore), now: justBefore, budgetNano: null, spend: null, cap: 1 })).toMatchObject({ admitted: false, reason: "session_limit" });
    const atDeadline = lease.deadline;
    expect(await limiter.admitSession({ ...claim("ses_at", atDeadline), now: atDeadline, budgetNano: null, spend: null, cap: 1 })).toMatchObject({ admitted: true });
  });

  it("answers continue for an unknown or reserved slot, and changes nothing (row 20, rule 2)", async () => {
    const limiter = userLimiter(freshName());
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_unknown", connected: true, now: T0 })).toEqual({ decision: "continue", replaced: [] });
    await limiter.admitSession(userAsk(claim("ses_reserved", T0), T0));
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_reserved", connected: true, now: T0 + 1 })).toEqual({ decision: "continue", replaced: [] });
  });

  it("replaces the oldest connected session only once a third one counts as connected, and a failed newcomer touches nothing (row 20)", async () => {
    const limiter = userLimiter(freshName());
    await started(limiter, claim("ses_a", T0));
    await started(limiter, claim("ses_b", T0 + 1_000));
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_a", connected: true, now: T0 + 5_000 })).toEqual({ decision: "continue", replaced: [] });
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_b", connected: true, now: T0 + 5_000 })).toEqual({ decision: "continue", replaced: [] });
    // A third starts and fails before any checkpoint: nothing changes.
    await started(limiter, claim("ses_failed", T0 + 2_000));
    await limiter.releaseSession("ses_failed");
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_a", connected: true, now: T0 + 6_000 })).toEqual({ decision: "continue", replaced: [] });
    // A third that never proves a real session (ask-only checkpoints) replaces nobody.
    await started(limiter, claim("ses_c", T0 + 3_000));
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_c", connected: false, now: T0 + 7_000 })).toEqual({ decision: "continue", replaced: [] });
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_a", connected: true, now: T0 + 7_000 })).toEqual({ decision: "continue", replaced: [] });
    // Once it counts as connected, the oldest goes.
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_c", connected: true, now: T0 + 8_000 })).toEqual({ decision: "continue", replaced: ["ses_a"] });
    // The old session learns at its next checkpoint; a repeated call changes nothing.
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_a", connected: true, now: T0 + 9_000 })).toEqual({ decision: "replaced", replaced: [] });
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_c", connected: true, now: T0 + 9_000 })).toEqual({ decision: "continue", replaced: [] });
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_b", connected: true, now: T0 + 9_000 })).toEqual({ decision: "continue", replaced: [] });
  });

  it("cap 2: A connected, B stalls after open, C connects, then B resumes: A, the oldest, ends, and B and C stay (row 20)", async () => {
    const limiter = userLimiter(freshName());
    await started(limiter, claim("ses_a", T0));
    await started(limiter, claim("ses_b", T0 + 1_000));
    await started(limiter, claim("ses_c", T0 + 2_000));
    await limiter.sessionCheckpoint({ sessionId: "ses_a", connected: true, now: T0 + 5_000 });
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_c", connected: true, now: T0 + 6_000 })).toEqual({ decision: "continue", replaced: [] });
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_b", connected: true, now: T0 + 7_000 })).toEqual({ decision: "continue", replaced: ["ses_a"] });
    expect((await limiter.sessionCheckpoint({ sessionId: "ses_a", connected: true, now: T0 + 8_000 })).decision).toBe("replaced");
  });

  it("cap 2 with only C connected: B resumes, the total reaches the limit, and B stays (row 20)", async () => {
    const limiter = userLimiter(freshName());
    await started(limiter, claim("ses_b", T0));
    await started(limiter, claim("ses_c", T0 + 1_000));
    await limiter.sessionCheckpoint({ sessionId: "ses_c", connected: true, now: T0 + 5_000 });
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_b", connected: true, now: T0 + 6_000 })).toEqual({ decision: "continue", replaced: [] });
  });

  it("B gets a ticket first and stalls, A and C connect, then B connects: B is the oldest, and its own checkpoint answers replaced (row 20)", async () => {
    const limiter = userLimiter(freshName());
    await started(limiter, claim("ses_b", T0));
    await started(limiter, claim("ses_a", T0 + 1_000));
    await started(limiter, claim("ses_c", T0 + 2_000));
    await limiter.sessionCheckpoint({ sessionId: "ses_a", connected: true, now: T0 + 5_000 });
    await limiter.sessionCheckpoint({ sessionId: "ses_c", connected: true, now: T0 + 5_000 });
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_b", connected: true, now: T0 + 6_000 })).toEqual({ decision: "replaced", replaced: ["ses_b"] });
  });

  it("keeps a replaced record only to answer, never counting it; a new ticket after two replacements and their closes is admitted (row 20)", async () => {
    const limiter = userLimiter(freshName());
    for (const [id, at] of [["ses_1", T0], ["ses_2", T0 + 1_000], ["ses_3", T0 + 2_000], ["ses_4", T0 + 3_000]] as const) {
      await started(limiter, claim(id, at));
      await limiter.sessionCheckpoint({ sessionId: id, connected: true, now: at + 4_000 });
    }
    expect((await limiter.sessionCheckpoint({ sessionId: "ses_1", connected: true, now: T0 + 9_000 })).decision).toBe("replaced");
    expect((await limiter.sessionCheckpoint({ sessionId: "ses_2", connected: true, now: T0 + 9_000 })).decision).toBe("replaced");
    // The two replaced records don't count: two held, two more may start.
    expect(await limiter.admitSession(userAsk(claim("ses_5", T0 + 10_000), T0 + 10_000))).toMatchObject({ admitted: true });
    // Their closes release the records.
    await limiter.releaseSession("ses_1");
    await limiter.releaseSession("ses_2");
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_1", connected: true, now: T0 + 11_000 })).toEqual({ decision: "continue", replaced: [] });
    expect(await limiter.admitSession(userAsk(claim("ses_6", T0 + 12_000), T0 + 12_000))).toMatchObject({ admitted: true });
  });

  it("never counts or replaces a streaming session (row 20)", async () => {
    const limiter = userLimiter(freshName());
    await started(limiter, claim("ses_s", T0, "streaming"));
    await started(limiter, claim("ses_a", T0 + 1_000));
    await started(limiter, claim("ses_b", T0 + 2_000));
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_s", connected: true, now: T0 + 3_000 })).toEqual({ decision: "continue", replaced: [] });
    await limiter.sessionCheckpoint({ sessionId: "ses_a", connected: true, now: T0 + 4_000 });
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_b", connected: true, now: T0 + 4_000 })).toEqual({ decision: "continue", replaced: [] });
  });

  it("a named takeover ends its target first: cap 2, C names B, B ends, and A keeps running (row 21)", async () => {
    const limiter = userLimiter(freshName());
    await started(limiter, claim("ses_a", T0));
    await started(limiter, claim("ses_b", T0 + 1_000));
    await limiter.sessionCheckpoint({ sessionId: "ses_a", connected: true, now: T0 + 3_000 });
    await limiter.sessionCheckpoint({ sessionId: "ses_b", connected: true, now: T0 + 3_000 });
    const c = claim("ses_c", T0 + 4_000);
    expect(await limiter.admitSession(userAsk(c, c.ticketStart, "ses_b"))).toMatchObject({ admitted: true, takesOver: "ses_b" });
    await limiter.activateSession(c, c.ticketStart + 1_000);
    expect(await limiter.sessionCheckpoint({ sessionId: "ses_c", connected: true, now: T0 + 6_000 })).toEqual({ decision: "continue", replaced: ["ses_b"] });
    expect((await limiter.sessionCheckpoint({ sessionId: "ses_a", connected: true, now: T0 + 7_000 })).decision).toBe("continue");
    expect((await limiter.sessionCheckpoint({ sessionId: "ses_b", connected: true, now: T0 + 7_000 })).decision).toBe("replaced");
  });

  it("ignores a name that isn't an active conversational slot of the caller: the request is an ordinary new session (T11)", async () => {
    const limiter = userLimiter(freshName());
    await started(limiter, claim("ses_stream", T0, "streaming"));
    await started(limiter, claim("ses_closed", T0));
    await limiter.releaseSession("ses_closed");
    for (const name of ["ses_stream", "ses_closed", "ses_someone_elses"]) {
      expect(await limiter.admitSession(userAsk(claim(`ses_new_${name}`, T0 + 1), T0 + 1, name))).toMatchObject({ admitted: true, takesOver: null });
    }
  });
});

describe("the app's session seats", () => {
  const appAsk = (c: SlotClaim, now: number, cap: number) => ({ ...c, now, budgetNano: null, spend: null, cap });

  it("refuses at the app's cap, a named takeover too, and admits again once a different seat frees (T3, row 21)", async () => {
    const limiter = appLimiter(freshName());
    expect(await limiter.admitSession(appAsk(claim("ses_a", T0), T0, 2))).toEqual({ admitted: true, budget: "none" });
    expect(await limiter.admitSession(appAsk(claim("ses_b", T0), T0, 2))).toEqual({ admitted: true, budget: "none" });
    // The takeover of B is admitted like any new session: refused at a full app.
    expect(await limiter.admitSession(appAsk(claim("ses_c", T0), T0, 2))).toEqual({ admitted: false, reason: "session_limit", cap: 2 });
    // A, a different seat, frees while B stays: the takeover is admitted.
    await limiter.releaseSession("ses_a");
    expect(await limiter.admitSession(appAsk(claim("ses_c", T0), T0, 2))).toMatchObject({ admitted: true });
  });

  it("counts conversational sessions and streams apart", async () => {
    const limiter = appLimiter(freshName());
    expect(await limiter.admitSession(appAsk(claim("ses_a", T0), T0, 1))).toMatchObject({ admitted: true });
    expect(await limiter.admitSession(appAsk(claim("ses_s", T0, "streaming"), T0, 1))).toMatchObject({ admitted: true });
    expect(await limiter.admitSession(appAsk(claim("ses_s2", T0, "streaming"), T0, 1))).toMatchObject({ admitted: false, reason: "session_limit" });
  });
});

// ---------------------------------------------------------------------------
// The endpoint, end to end.

const SECRET = "sk-test-session-key-1234";

async function seedConnection(): Promise<{ id: string; slug: string }> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `openai-${id.slice(0, 6)}`;
  const blob = await sealForTest("providerKey", [ACCOUNT_ID, id, "openai", "", "", ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'openai', ?, 'OpenAI', 'active', ?, '1234', NULL, NULL, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, slug, blob, now, now)
    .run();
  return { id, slug };
}

async function setup(limits: Record<string, unknown> = {}, operations: string[] = ["openai.realtime"]) {
  const { slug } = await seedConnection();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: { operations } } },
  );
  if (Object.keys(limits).length > 0) {
    const row = await env.DB.prepare("SELECT config_json FROM app WHERE id = ?").bind(appId).first<{ config_json: string }>();
    const config = { ...JSON.parse(row!.config_json), limits };
    await env.DB.prepare("UPDATE app SET config_json = ? WHERE id = ?").bind(JSON.stringify(config), appId).run();
  }
  const key = await seedAppKey(appId);
  return { appId, slug, key: key.key };
}

async function start(appId: string, slug: string, key: string, body: Record<string, unknown>, user = "user-7", environment: Env = RELAY_ENV) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}/v2/apps/${appId}/sessions/${slug}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": user },
      body: JSON.stringify(body),
    }),
    environment,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("starting a session", () => {
  it("checks the caller and the app, takes both slots, and answers a ticket and the relay's address (T1)", async () => {
    const { appId, slug, key } = await setup();
    const response = await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, string>;
    expect(body.relay_url).toBe("wss://relay.test/v2/relay/session");
    const { payload } = parseTicket(body.ticket!)!;
    expect(payload).toMatchObject({ sid: body.session_id, app: appId, endUser: "user-7", operation: "openai.realtime", model: "gpt-realtime", slot: "conversational", mode: "relayed" });
    expect(payload.url).toBe("https://api.openai.com/v1/realtime?model=gpt-realtime");
    expect(body.ticket).not.toContain(SECRET);
    expect(new Date(body.ends_at!).getTime()).toBe(payload.start + payload.cap);
    // Both slots are reserved, and the session's row is written after the reply.
    const row = await ledger().prepare("SELECT state FROM session WHERE id = ?").bind(body.session_id).first<{ state: string }>();
    expect(row?.state).toBe("starting");
  });

  it("refuses a path that isn't a live session, an operation the app doesn't allow, and a model it doesn't list", async () => {
    const chat = await setup({}, ["openai.chat"]);
    const notSession = await start(chat.appId, chat.slug, chat.key, { path: "v1/chat/completions", model: "gpt-4o-mini" });
    expect(notSession.status).toBe(403);
    const notAllowed = await start(chat.appId, chat.slug, chat.key, { path: "v1/realtime", model: "gpt-realtime" });
    expect(notAllowed.status).toBe(403);
    expect(await notAllowed.json()).toMatchObject({ error: { code: "path_not_allowed" } });
    const listed = await setup();
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, ?, json(?)) WHERE id = ?")
      .bind(`$.routing.providers.${listed.slug}.models`, JSON.stringify(["gpt-realtime-mini"]), listed.appId)
      .run();
    clearCaches();
    const unlisted = await start(listed.appId, listed.slug, listed.key, { path: "v1/realtime", model: "gpt-realtime" });
    expect(unlisted.status).toBe(403);
    expect(await unlisted.json()).toMatchObject({ error: { code: "model_not_allowed" } });
  });

  it("at the app's cap refuses with session_limit, records it for the console, and frees the user's slot it took (T3)", async () => {
    const { appId, slug, key } = await setup({ per_app: { sessions: { conversational: 1 } } });
    expect((await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-1")).status).toBe(201);
    const refused = await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-2");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "session_limit", data: { scope: "app", kind: "conversational" } } });
    const event = await ledger().prepare("SELECT reason, scope FROM app_rejection_event WHERE app_id = ? ORDER BY created_at DESC").bind(appId).first<{ reason: string; scope: string }>();
    expect(event).toMatchObject({ reason: "blocked_session_limit", scope: "app" });
    // user-2's slot from the refused start is freed at once: four more fit.
    for (let i = 0; i < USER_STARTING_BOUND; i += 1) {
      expect(await userLimiter(`${appId}:user:user-2`).admitSession(userAsk(claim(`ses_probe${i}`, Date.now()), Date.now()))).toMatchObject({ admitted: true });
    }
  });

  it("refuses a fifth conversational session for one user with a clear error (T14)", async () => {
    const { appId, slug, key } = await setup();
    for (let i = 0; i < USER_STARTING_BOUND; i += 1) {
      expect((await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" })).status).toBe(201);
    }
    const fifth = await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" });
    expect(fifth.status).toBe(429);
    expect(await fifth.json()).toMatchObject({ error: { code: "session_limit", data: { scope: "user" } } });
  });

  it("starts the session without a slot when a limiter can't be reached (T13; crash row 7)", async () => {
    const { appId, slug, key } = await setup();
    const unreachable = { getByName: () => ({ admitSession: () => Promise.reject(new Error("limiter down")) }) };
    const environment = { ...RELAY_ENV, END_USER_LIMITER: unreachable, APP_LIMITER: unreachable } as unknown as Env;
    const response = await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-7", environment);
    expect(response.status).toBe(201);
  });

  it("a lost reservation reply: the session starts, and the reservation the limiter wrote frees itself at the ticket's expiry (crash row 7)", async () => {
    const { appId } = await setup();
    const app = await loadRequestApp({ env, req: { raw: new Request(ORIGIN) } }, appId);
    const identity = { appId, userId: "user-lost", credentialType: "api_key", authMethod: "api_key", installId: null, appleAccountId: null } as const;
    const now = Date.now();
    const kept: Promise<unknown>[] = [];
    // A deadline already spent: both limiters are called, and their answers are lost.
    const admission = await admitSession({ env, app, identity, claim: claim("ses_lost", now), takesOver: null, waitUntil: (p) => kept.push(p), refuse: refusal, limitsDeadlineMs: 0 });
    expect(admission).toEqual({ userLimiter: null, appSeat: false });
    await Promise.all(kept);
    // The reservation was written: it counts toward the bound until the ticket expires.
    const limiter = userLimiter(`${appId}:user:user-lost`);
    for (let i = 1; i < USER_STARTING_BOUND; i += 1) expect(await limiter.admitSession(userAsk(claim(`ses_more${i}`, now), now))).toMatchObject({ admitted: true });
    expect(await limiter.admitSession(userAsk(claim("ses_over", now), now))).toMatchObject({ admitted: false, reason: "starting_bound" });
    const afterExpiry = now + MINUTE + 1;
    expect(await limiter.admitSession(userAsk(claim("ses_after", afterExpiry), afterExpiry))).toMatchObject({ admitted: true });
  });

  it("says live sessions are not set up when the deployment has no relay address", async () => {
    const { appId, slug, key } = await setup();
    const response = await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-7", env);
    expect(response.status).toBe(503);
  });
});

describe("Sol 9a3 round 1", () => {
  async function lastRejection(appId: string) {
    return ledger().prepare("SELECT reason, model FROM app_rejection_event WHERE app_id = ? ORDER BY created_at DESC").bind(appId).first<{ reason: string; model: string | null }>();
  }

  it("records a model the gateway doesn't know as unrecognized, never its text, whether the list or the cap refused it", async () => {
    const listed = await setup();
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, ?, json(?)) WHERE id = ?")
      .bind(`$.routing.providers.${listed.slug}.models`, JSON.stringify(["gpt-realtime-mini"]), listed.appId)
      .run();
    clearCaches();
    expect((await start(listed.appId, listed.slug, listed.key, { path: "v1/realtime", model: "not-a-model sk-oops" })).status).toBe(403);
    expect(await lastRejection(listed.appId)).toMatchObject({ reason: "model_not_allowed", model: "unrecognized" });
    const capped = await setup({ per_app: { sessions: { conversational: 1 } } });
    expect((await start(capped.appId, capped.slug, capped.key, { path: "v1/realtime", model: "first" }, "user-1")).status).toBe(201);
    expect((await start(capped.appId, capped.slug, capped.key, { path: "v1/realtime", model: "second sk-oops" }, "user-2")).status).toBe(429);
    expect(await lastRejection(capped.appId)).toMatchObject({ reason: "blocked_session_limit", model: "unrecognized" });
  });

  /** Minutes that answer only after the start's 2 s deadline has passed. */
  function lateMinutes(): Promise<number> {
    return new Promise((resolve) => setTimeout(() => resolve(10 * MINUTE), 2_500)); // real-timer: must come after the endpoint's own 2 s deadline, which runs on the real clock
  }

  function hosted(minutes: number | undefined, usedMs: number | null | "slow", otherLimits: Record<string, unknown> = {}): Env {
    const plan = { planKey: "p", planName: "P", isDefault: true, limits: { ...otherLimits, ...(minutes === undefined ? {} : { maxSessionMinutesPerMonth: minutes }) } };
    return {
      ...RELAY_ENV,
      BILLING: { getTenantAccess: async () => ({ plan, subscription: null }) },
      ACCOUNT_LIMITER: {
        getByName: () => ({
          sessionMs: () => (usedMs === "slow" ? lateMinutes() : Promise.resolve(usedMs)),
        }),
      },
    } as unknown as Env;
  }

  it("refuses a session once the plan's live-session minutes are known to be used up, and frees the slots it took (D17, T12)", async () => {
    const { appId, slug, key } = await setup({ per_app: { sessions: { conversational: 1 } } });
    const refused = await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-1", hosted(1, 60_000));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "billing_request_quota_exceeded", data: { limit: 1, used: 1 } } });
    expect(await lastRejection(appId)).toMatchObject({ reason: "blocked_billing" });
    // The app's only seat was freed: a session with minutes left starts.
    expect((await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-1", hosted(1, 59_000))).status).toBe(201);
  });

  it("starts the session when the plan or its minutes can't be read in time, and when the plan sets no minutes", async () => {
    const { appId, slug, key } = await setup();
    expect((await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-1", hosted(1, null))).status).toBe(201);
    // Each plan read fresh: the billing answer is cached per account.
    clearCaches();
    expect((await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-2", hosted(undefined, 10 * MINUTE))).status).toBe(201);
    clearCaches();
    // Minutes that never answer: the shared 2 s deadline lets the session start.
    expect((await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-3", hosted(1, "slow"))).status).toBe(201);
  });

  it("reads only the plan's session limit: a bad request limit doesn't stop it (Sol 9a3 round 2)", async () => {
    const { appId, slug, key } = await setup();
    clearCaches();
    const refused = await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-1", hosted(1, 60_000, { maxRequestsPerMonth: null }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "billing_request_quota_exceeded" } });
  });

  it("starts the session when a limiter call throws at once, before any answer exists (Sol 9a3 round 2)", async () => {
    const { appId, slug, key } = await setup();
    const throwing = {
      getByName: () => {
        throw new Error("limiter binding broken");
      },
    };
    const environment = { ...RELAY_ENV, END_USER_LIMITER: throwing, APP_LIMITER: throwing } as unknown as Env;
    expect((await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-7", environment)).status).toBe(201);
  });

  it("saves no session cap equal to its default, and no sessions block when nothing is left", () => {
    const base = { authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, routing: { providers: {} } };
    const defaults = parseAppConfig({ ...base, limits: { per_app: { sessions: { conversational: 10, streaming: 50 } } } });
    expect(defaults.limits.per_app.sessions).toBeUndefined();
    expect(JSON.stringify(defaults)).not.toContain("sessions");
    const one = parseAppConfig({ ...base, limits: { per_app: { sessions: { conversational: 4, streaming: 50 } } } });
    expect(one.limits.per_app.sessions).toEqual({ conversational: 4 });
  });
});

describe("the leases follow the session: open activates them, close frees them (T4, T8)", () => {
  it("an activated lease outlives its ticket, and close frees it; both are safe to repeat", async () => {
    const { appId, slug, key } = await setup({ per_app: { sessions: { conversational: 1 } } });
    const first = (await (await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" }, "user-1")).json()) as Record<string, string>;
    const { payload } = parseTicket(first.ticket!)!;
    await openForRelay(env, first.ticket, payload.start + 1_000);
    await openForRelay(env, first.ticket, payload.start + 2_000);
    // Past the ticket's expiry, the activated seat still holds the app's only seat.
    const later = payload.exp + 1;
    expect(await appLimiter(appId).admitSession({ ...claim("ses_probe", later), now: later, budgetNano: null, spend: null, cap: 1 })).toMatchObject({ admitted: false });
    await closeForRelay(env, first.ticket, { finalSlice: 0, endReason: "client_closed", endedAt: later });
    await closeForRelay(env, first.ticket, { finalSlice: 0, endReason: "client_closed", endedAt: later });
    expect(await appLimiter(appId).admitSession({ ...claim("ses_probe2", later), now: later, budgetNano: null, spend: null, cap: 1 })).toMatchObject({ admitted: true });
  });

  it("open still answers when the limiters can't be reached (crash row 7)", async () => {
    const { appId, slug, key } = await setup();
    const issued = (await (await start(appId, slug, key, { path: "v1/realtime", model: "gpt-realtime" })).json()) as Record<string, string>;
    const unreachable = { getByName: () => ({ activateSession: () => Promise.reject(new Error("limiter down")) }) };
    const environment = { ...env, END_USER_LIMITER: unreachable, APP_LIMITER: unreachable } as unknown as Env;
    await expect(openForRelay(environment, issued.ticket)).resolves.toMatchObject({ sessionId: issued.session_id });
  });
});
