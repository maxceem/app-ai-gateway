/**
 * The generic WebSocket adapter for a provider the gateway does not know (step 10b; plan D4, D10, section
 * 5): a custom provider lists one WebSocket path with a price per minute, an app that allows passthrough
 * starts a session on it, and the relay forwards its frames as they are, both ways, reading none. The
 * session is billed by its connection time at the listing's rate, with the time cap and checkpoints as for
 * every session. The key goes only in the header the connection names, from the vault's seal.
 *
 * - Saving: the path is a custom provider's `GET`, needs `per_minute`, and is one per provider. A path
 *   saved before keeps saving and working as it did.
 * - The start: the app's query goes on without credential fields; the ticket names the `websocket`
 *   operation, the `generic` adapter and the key's header. An HTTP request never reaches the path.
 * - The price: one rule (`websocketPrice`), at the listing's rate when the session started, which its signed
 *   ticket carries and the session saves as its price: a later edit or removal never reprices it.
 * - The relay's session core, on a clock faked with Vitest's timers: the clock and checkpoints. The
 *   cap, a stop, the provider's close and a restart are the shared core's (`relay-start.test.ts`).
 * - The real relay, vault and provider stand-in: frames both ways and the key in its own header.
 *
 * Runs with split keys off and on (`vitest.config.ts`).
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { parseTicket } from "../relay/src/ticket.js";
import { adapterFor as relayAdapter, knownAdapter } from "../relay/src/adapters.js";
import { SESSION_PATH } from "../relay/src/constants.js";
import { SessionCore } from "../relay/src/start.js";
import { passthroughJson } from "../src/admin/providers.ts";
import { GatewayError } from "../src/core/errors.ts";
import { websocketPrice } from "../src/pricing/billability.ts";
import { openai } from "../src/providers/openai.ts";
import type { PassthroughPath } from "../src/providers/matcher.ts";
import { compiledPassthrough, compiledWebsocket, readPassthrough, storedPassthrough } from "../src/providers/passthrough.ts";
import { adapterFor, closeForRelay } from "../src/relay/contract.ts";
import { checkpointForRelay, priceSlice } from "../src/relay/checkpoint.ts";
import { issueTicket } from "../src/relay/tickets.ts";
import { MemoryStore, ticketFor } from "./relay-stand-ins.ts";
import { sealForTest, splitKeysOn, testShare } from "./split-keys.ts";
import { ACCOUNT_ID, clearCaches, ledger, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedAccount, seedAppKey, seedManagementKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const RELAY_ENV = { ...env, RELAY_URL: "https://relay.test" } as unknown as Env;
const SECRET = "sk-live-provider-key-2468";
const BASE = "https://live.example.com/";
const AUTH = { header: "x-api-key", format: "{key}" };
/** $0.06 a minute, in nano-dollars. */
const PER_MINUTE_NANO = 60_000_000;
const LIVE: PassthroughPath = { method: "GET", path: "v1/live", websocket: true, perMinuteNano: PER_MINUTE_NANO };
const PLAIN: PassthroughPath = { method: "GET", path: "v1/echo/{id}" };

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Saving a WebSocket path.

const custom = { kind: "custom" as const, baseUrl: BASE, auth: AUTH };
/** The save check's answer: what it stores, or the message it refuses with. */
function saved(asked: Record<string, unknown>[], before: readonly PassthroughPath[] = [], subject: Parameters<typeof passthroughJson>[0] = custom): string {
  try {
    return passthroughJson(subject, asked as never, before).stored ?? "";
  } catch (error) {
    if (error instanceof GatewayError) return `refused: ${error.message}`;
    throw error;
  }
}

describe(`saving a WebSocket path (step 10b, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("stores a custom provider's GET path with its price a minute, apart from HTTP passthrough", () => {
    const stored = saved([{ method: "GET", path: "v1/live", websocket: true, per_minute: 0.06 }, { method: "GET", path: "v1/echo/{id}" }]);
    expect(JSON.parse(stored).paths).toEqual([
      { method: "GET", path: "v1/live", websocket: true, per_minute_nano: PER_MINUTE_NANO },
      { method: "GET", path: "v1/echo/{id}" },
    ]);
    const paths = readPassthrough(stored);
    expect(paths[0]).toEqual(LIVE);
    // An HTTP request reaches only the plain path; a live session only the WebSocket one.
    expect(compiledPassthrough(paths).map((one) => one.listed.path)).toEqual(["v1/echo/{id}"]);
    expect(compiledWebsocket(paths).map((one) => one.listed.path)).toEqual(["v1/live"]);
    // A price of $0 a minute is the customer's own price, as $0 a request is.
    expect(saved([{ method: "GET", path: "v1/live", websocket: true, per_minute: 0 }])).not.toMatch(/^refused/u);
  });

  it.each([
    ["no price a minute", { method: "GET", path: "v1/live", websocket: true }, "per_minute: a WebSocket path needs a price per minute"],
    ["a method other than GET", { method: "POST", path: "v1/live", websocket: true, per_minute: 0.06 }, "method: a WebSocket path is a GET"],
    ["an API style", { method: "GET", path: "v1/live", websocket: true, per_minute: 0.06, style: "openai-chat" }, "priced per minute"],
    ["a price per request", { method: "GET", path: "v1/live", websocket: true, per_minute: 0.06, per_request: 0.01 }, "priced per minute"],
    ["field settings", { method: "GET", path: "v1/live", websocket: true, per_minute: 0.06, set_fields: [{ in: "query", name: "voice", value: "a" }] }, "sets no fields"],
    ["a price a minute on a plain path", { method: "GET", path: "v1/live", per_minute: 0.06 }, "only a WebSocket path has a price per minute"],
    ["a price too large to store", { method: "GET", path: "v1/live", websocket: true, per_minute: 1e12 }, "per_minute: the price is too large"],
  ])("refuses a WebSocket path with %s", (_name, entry, problem) => {
    expect(saved([entry])).toContain(problem);
  });

  it("refuses a second WebSocket path, and one on a built-in provider", () => {
    const two = saved([
      { method: "GET", path: "v1/live", websocket: true, per_minute: 0.06 },
      { method: "GET", path: "v1/other", websocket: true, per_minute: 0.06 },
    ]);
    expect(two).toContain("list one WebSocket path per provider; GET v1/live is one already");
    const builtIn = saved([{ method: "GET", path: "v1/live", websocket: true, per_minute: 0.06 }], [], { kind: "builtIn", description: openai, cloudflareGateway: null, baseUrl: null });
    expect(builtIn).toContain("only a custom provider's path can be a WebSocket session");
  });

  it("refuses a WebSocket path that is a known provider's built-in session: that one is metered by its own adapter", () => {
    const xai = saved([{ method: "GET", path: "v1/realtime", websocket: true, per_minute: 0.06 }], [], { kind: "custom", baseUrl: "https://api.x.ai/", auth: AUTH });
    expect(xai).toMatch(/^refused: .*built-in xai\.realtime endpoint/u);
  });

  it("keeps saving what was saved before: plain paths stay as they were, and a plain path made a WebSocket path is judged as new", () => {
    const before = [PLAIN, { method: "GET" as const, path: "v1/{a}/x" }];
    // A stored path that today's named-part rule would refuse still saves, as it always did.
    const kept = saved([{ method: "GET", path: "v1/echo/{id}" }, { method: "GET", path: "v1/{a}/x" }, { method: "GET", path: "v1/live", websocket: true, per_minute: 0.06 }], before);
    expect(JSON.parse(kept).paths).toHaveLength(3);
    // The same stored path turned into a WebSocket path is a new listing: today's rules judge it.
    expect(saved([{ method: "GET", path: "v1/{a}/x", websocket: true, per_minute: 0.06 }], before)).toMatch(/^refused: passthrough\.0\.path:/u);
  });

  it("saves and shows a WebSocket path through the management API, with its price in dollars a minute", async () => {
    const key = await seedManagementKey();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/admin/providers`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          type: "custom",
          name: "Live",
          slug: `live-${crypto.randomUUID().slice(0, 6)}`,
          secret: SECRET,
          baseUrl: BASE,
          auth: AUTH,
          passthrough: [{ method: "GET", path: "v1/live", websocket: true, per_minute: 0.06 }],
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { provider: { passthrough: unknown } };
    expect(body.provider.passthrough).toEqual([{ method: "GET", path: "v1/live", websocket: true, per_minute: 0.06 }]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("saves a plain GET and a WebSocket path at the same address, each with its own settings, and still refuses a repeated plain one (Sol, #274 round 3)", async () => {
    const key = await seedManagementKey();
    const http = { method: "GET", path: "v1/live", set_fields: [{ in: "query", name: "format", value: "json" }] };
    const live = { method: "GET", path: "v1/live", websocket: true, per_minute: 0.06 };
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/admin/providers`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ type: "custom", name: "Both", slug: `both-${crypto.randomUUID().slice(0, 6)}`, secret: SECRET, baseUrl: BASE, auth: AUTH, passthrough: [http, live] }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { provider: { passthrough: unknown } }).provider.passthrough).toEqual([http, live]);
    // An HTTP request reaches only the plain one, a live session only the WebSocket one.
    const paths = readPassthrough(storedPassthrough([{ method: "GET", path: "v1/live" }, LIVE], AUTH));
    expect(compiledPassthrough(paths).map((one) => one.listed.websocket)).toEqual([undefined]);
    expect(compiledWebsocket(paths).map((one) => one.listed.websocket)).toEqual([true]);
    expect(saved([{ method: "GET", path: "v1/live" }, { method: "GET", path: "v1/live" }])).toContain("matches the same requests as another listed path");
  });

  it("reads a stored WebSocket path only with its price: one without was never saved, and would bill nothing", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(readPassthrough(JSON.stringify({ paths: [{ method: "GET", path: "v1/live", websocket: true }] }))).toEqual([]);
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("passthrough_unreadable"));
  });
});

// ---------------------------------------------------------------------------
// The price: one rule for every write path.

describe(`a WebSocket session's price (step 10b, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("bills connection time at the listing's rate, as the customer's own price, whatever the model", () => {
    const price = websocketPrice(PER_MINUTE_NANO);
    expect(price).toEqual({ price: { rates: { per_minute: PER_MINUTE_NANO }, raw: {} }, source: "customer_rate" });
    // 90 s at $0.06 a minute: $0.09.
    expect(priceSlice({}, price, 90_000)).toMatchObject({ costNano: 90_000_000, unit: "session_seconds", units: 90_000, priceSource: "customer_rate", estimated: false });
  });
});

// ---------------------------------------------------------------------------
// Starting a session on the path.

async function seedLive(paths: readonly PassthroughPath[], operations: readonly string[], models?: readonly string[]) {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `live-${id.slice(0, 6)}`;
  const blob = await sealForTest("providerKey", [ACCOUNT_ID, id, "custom", BASE, AUTH.header, AUTH.format], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, passthrough_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'custom', ?, 'Live', 'active', ?, '2468', ?, NULL, ?, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, slug, blob, BASE, storedPassthrough(paths, AUTH), now, now)
    .run();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: { operations, ...(models === undefined ? {} : { models }) } } },
  );
  const { key } = await seedAppKey(appId);
  return { id, appId, slug, key };
}

async function call(path: string, key: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-10b", ...init.headers } }), RELAY_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const start = (appId: string, slug: string, key: string, body: Record<string, unknown>) =>
  call(`/v2/apps/${appId}/sessions/${slug}`, key, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe(`starting a session on a WebSocket path (step 10b, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("starts it on a conversational slot with the generic adapter: the app's options go on without its own credentials, and the key goes in the connection's header", async () => {
    const { appId, slug, key } = await seedLive([PLAIN, LIVE], ["passthrough"]);
    const response = await start(appId, slug, key, { path: "v1/live?voice=alloy&api_key=theirs&access_token=t&x-api-key=k&Authorization=b&apiKey=c&accessToken=d&lang=en", model: "ignored" });
    expect(response.status).toBe(201);
    const { payload } = parseTicket(((await response.json()) as { ticket: string }).ticket)!;
    expect(payload).toMatchObject({ providerType: "custom", operation: "websocket", model: "", slot: "conversational", mode: "relayed", sessionTotal: false });
    expect(payload.url).toBe("https://live.example.com/v1/live?voice=alloy&lang=en");
    expect(adapterFor(payload)).toBe("generic");
    // The listing's rate as the session started, signed, for the gateway to price its slices at.
    expect(payload.perMinuteNano).toBe(PER_MINUTE_NANO);
    // The relay sends the key only in the header and format the connection names, never in the address.
    expect(payload.seal.providerKey).toMatchObject({ header: "x-api-key", format: "{key}" });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    // The relay knows the adapter, and it reads no frame: each is forwarded as it is.
    expect(knownAdapter("generic")).toBe(true);
    const generic = relayAdapter("generic");
    for (const frame of ['{"type":"response.done","usage":{"input_tokens":5}}', '{"type":"mock.usage","event_id":"e","usage":{"input_tokens":5}}', new ArrayBuffer(8)]) {
      expect(generic.read(frame)).toBeNull();
      expect(generic.turn(frame)).toBeNull();
    }
    expect(generic).not.toHaveProperty("lock");
    expect(generic).not.toHaveProperty("client");
    expect(generic).not.toHaveProperty("clock");
  });

  it("is reached only by an app that allows passthrough, only at the listed path, and never by an HTTP request", async () => {
    const without = await seedLive([LIVE], ["custom.openai-chat"]);
    const refused = await start(without.appId, without.slug, without.key, { path: "v1/live" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "path_not_allowed" } });
    const { appId, slug, key } = await seedLive([PLAIN, LIVE], ["passthrough"], ["some-model"]);
    // A plain listed path is HTTP passthrough, not a live session.
    expect((await start(appId, slug, key, { path: "v1/echo/1" })).status).toBe(403);
    expect((await start(appId, slug, key, { path: "v1/other" })).status).toBe(403);
    // An app's model list doesn't apply: the path has no model, as any listed path.
    expect((await start(appId, slug, key, { path: "v1/live" })).status).toBe(201);
    // An HTTP request to the WebSocket path is never passed through: nothing is sent.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const http = await call(`/v2/apps/${appId}/proxy/${slug}/v1/live`, key);
    expect(http.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The session's slices at the checkpoint, and in the pricing sweep.

async function startedSession(paths: readonly PassthroughPath[] = [LIVE]) {
  const seeded = await seedLive(paths, ["passthrough"]);
  const response = await start(seeded.appId, seeded.slug, seeded.key, { path: "v1/live" });
  expect(response.status).toBe(201);
  const { ticket, session_id: sessionId } = (await response.json()) as { ticket: string; session_id: string };
  return { ...seeded, ticket, sessionId, payload: parseTicket(ticket)!.payload };
}

async function checkpoint(ticket: string, seq: number, sessionMs: number, from: number, now: number, accounting = false) {
  const ctx = createExecutionContext();
  const reply = await checkpointForRelay(
    env,
    ticket,
    { slice: { seq, measures: {}, sessionMs, gapMs: 0, gaps: 0, from, to: from + sessionMs }, connected: true, accounting, providerCallId: null },
    now,
    (promise) => ctx.waitUntil(promise),
  );
  await waitOnExecutionContext(ctx);
  return reply;
}

const slicesOf = async (sessionId: string) =>
  (await ledger().prepare("SELECT id, operation, model, cost_nano, price_source, unit, units, session_ms FROM charge WHERE owner_id = ? ORDER BY seq, id").bind(sessionId).all())
    .results as Record<string, unknown>[];

describe(`a WebSocket session's slices (step 10b, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("books each checkpoint's connection time at the rate the session started with: a price change before its first checkpoint never reprices it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { id, ticket, sessionId, payload } = await startedSession();
    // The customer doubles the rate right after the start, before any checkpoint (Sol, #274 round 1).
    await env.DB.prepare("UPDATE provider_connection SET passthrough_json = ? WHERE id = ?")
      .bind(storedPassthrough([{ ...LIVE, perMinuteNano: 2 * PER_MINUTE_NANO }], AUTH), id)
      .run();
    expect((await checkpoint(ticket, 1, 60_000, payload.start, payload.start + 60_000)).decision).toBe("continue");
    vi.setSystemTime(payload.start + 90_000);
    await checkpoint(ticket, 2, 30_000, payload.start + 60_000, payload.start + 90_000, true);
    const ctx = createExecutionContext();
    await closeForRelay(env, ticket, { finalSlice: 2, endReason: "client_closed", endedAt: payload.start + 90_000 }, payload.start + 90_000, (promise) => ctx.waitUntil(promise));
    await waitOnExecutionContext(ctx);
    expect(await slicesOf(sessionId)).toEqual([
      { id: `${sessionId}:slice:1`, operation: "websocket", model: "", cost_nano: 60_000_000, price_source: "customer_rate", unit: "session_seconds", units: 60_000, session_ms: 60_000 },
      { id: `${sessionId}:slice:2`, operation: "websocket", model: "", cost_nano: 30_000_000, price_source: "customer_rate", unit: "session_seconds", units: 30_000, session_ms: 30_000 },
    ]);
    // Saved as the session's price, which the pricing sweep prices any of its slices at.
    const saved = await ledger().prepare("SELECT rates_json FROM session WHERE id = ?").bind(sessionId).first<{ rates_json: string }>();
    expect(JSON.parse(saved!.rates_json)).toEqual(websocketPrice(PER_MINUTE_NANO));
  });

  it("still prices its slices at its rate when the listing is removed before its first checkpoint, never at another path's or as unpriced", async () => {
    const { id, ticket, sessionId, payload } = await startedSession([PLAIN, LIVE]);
    // The WebSocket path is removed, and another listed in its place at another rate.
    await env.DB.prepare("UPDATE provider_connection SET passthrough_json = ? WHERE id = ?")
      .bind(storedPassthrough([PLAIN, { method: "GET", path: "v1/other", websocket: true, perMinuteNano: 5 * PER_MINUTE_NANO }], AUTH), id)
      .run();
    await checkpoint(ticket, 1, 45_000, payload.start, payload.start + 45_000);
    // 45 s at $0.06 a minute: $0.045.
    expect(await slicesOf(sessionId)).toEqual([expect.objectContaining({ cost_nano: 45_000_000, price_source: "customer_rate", session_ms: 45_000 })]);
  });
});

// ---------------------------------------------------------------------------
// The relay's session core with the generic adapter, on a faked clock.

type Slice = { seq: number; measures: Record<string, number>; sessionMs: number; gapMs: number; gaps: number; billedMs?: number };

function core() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  const startedAt = Date.now();
  const store = new MemoryStore();
  const checkpoints: { slice: Slice | null; accounting: boolean }[] = [];
  const closes: { endReason: string; finalSlice: number }[] = [];
  const parts = () => ({
    store,
    now: () => Date.now(),
    log: () => undefined,
    vault: { sessionKey: async () => ({ key: { value: SECRET, header: AUTH.header, format: AUTH.format }, target: "https://live.example.com/v1/live" }) as never },
    main: {
      open: async () => ({ deadline: startedAt + 30 * 60_000, mode: "relayed", operation: "websocket", model: "", checkpointIntervalMs: 60_000, version: 2, adapter: "generic" }) as never,
      checkpoint: async (_ticket: string, input: { slice: Slice | null; accounting: boolean }) => {
        checkpoints.push(structuredClone(input));
        return { decision: "continue", reasons: [], written: true } as never;
      },
      close: async (_ticket: string, input: { endReason: string; finalSlice: number }) => {
        closes.push({ endReason: input.endReason, finalSlice: input.finalSlice });
        return { version: 2 };
      },
    },
    provider: { connect: async () => ({ callId: null, close: () => undefined }) },
  });
  const { text, ticket } = ticketFor(startedAt, { providerType: "custom", operation: "websocket", model: "", url: "https://live.example.com/v1/live" });
  const slices = () => checkpoints.map((one) => one.slice).filter((slice): slice is Slice => slice !== null);
  return {
    store,
    closes,
    slices,
    text,
    ticket,
    client: { close: () => undefined },
    instance: () => new SessionCore(parts()),
    tick: (ms: number) => vi.setSystemTime(Date.now() + ms),
  };
}

// The cap, a checkpoint's stop, the provider's close and a restart are the shared session core's, with the same
// reads-nothing adapter: `relay-start.test.ts` covers them.
describe("the relay's generic adapter: the clock and checkpoints (step 10b)", () => {
  it("bills the connection from its start to its close, one slice a checkpoint, with no usage read and no first-activity wait", async () => {
    const s = core();
    const session = s.instance();
    await session.start(s.text, s.ticket, s.client);
    // Nothing the client sends starts or stops the clock: it runs from the start.
    expect(session.idle).toBe(false);
    s.tick(60_000);
    await session.alarm();
    s.tick(60_000);
    await session.alarm();
    s.tick(25_000);
    await session.end("client_closed");
    expect(s.slices().map((slice) => [slice.seq, slice.sessionMs, slice.measures, slice.gapMs, slice.billedMs])).toEqual([
      [1, 60_000, {}, 0, undefined],
      [2, 60_000, {}, 0, undefined],
      [3, 25_000, {}, 0, undefined],
    ]);
    expect(s.closes).toEqual([{ endReason: "client_closed", finalSlice: 3 }]);
  });

});

// ---------------------------------------------------------------------------
// The real relay, vault and provider stand-in.

const relay = () => (env as unknown as { RELAY_TEST: Fetcher }).RELAY_TEST;
const provider = () => (env as unknown as { PROVIDER_STUB: Fetcher }).PROVIDER_STUB;

describe(`a WebSocket session through the real relay (step 10b, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("forwards frames both ways as they are, and sends the key only in the connection's own header", async () => {
    const connection = "conn_generic_live";
    const identity: [string, string, string, string, string, string] = [ACCOUNT_ID, connection, "custom", BASE, AUTH.header, AUTH.format];
    const blob = await sealForTest("providerKey", identity, SECRET);
    const share = await testShare(ACCOUNT_ID);
    const { ticket } = await issueTicket(env, {
      accountId: ACCOUNT_ID,
      appId: "app_generic",
      endUserId: null,
      installId: null,
      appleAccountId: null,
      appKeyId: null,
      providerType: "custom",
      connectionId: connection,
      operation: "websocket",
      model: "",
      mode: "relayed",
      slot: "conversational",
      sessionTotal: false,
      url: "https://live.example.com/v1/live?voice=alloy",
      capMs: 60_000,
      credentials: { providerKey: { blob, identity }, cloudflareToken: null, ...(share === null ? {} : { credential: share.forVault() }) },
      keyPlacement: AUTH,
    });
    const response = await relay().fetch(`https://relay.test${SESSION_PATH}`, { headers: { upgrade: "websocket", authorization: `Bearer ${ticket}` } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.binaryType = "arraybuffer";
    const got: (string | number[])[] = [];
    let waiting: { count: number; resolve: () => void } | null = null;
    socket.addEventListener("message", (event) => {
      got.push(typeof event.data === "string" ? event.data : [...new Uint8Array(event.data as ArrayBuffer)]);
      if (waiting !== null && got.length >= waiting.count) waiting.resolve();
    });
    socket.accept();
    const received = (count: number) => (got.length >= count ? Promise.resolve() : new Promise<void>((resolve) => (waiting = { count, resolve })));
    // The stand-in's first event, then each frame echoed: text and binary, a frame that names a key too.
    socket.send('{"type":"anything","api_key":"theirs"}');
    socket.send(new Uint8Array([1, 2, 3]));
    await received(3);
    expect(got).toEqual(['{"type":"session.created"}', '{"type":"anything","api_key":"theirs"}', [1, 2, 3]]);
    // The key went in the connection's header, in its format, and nowhere else.
    expect(await (await provider().fetch("https://provider.test/last-headers")).json()).toEqual({ authorization: null, "x-api-key": SECRET, query: "?voice=alloy" });
    socket.close(1000, "done");
  });
});
