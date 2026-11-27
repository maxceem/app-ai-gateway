/**
 * ElevenLabs agents on the gateway's side (step 11a): the agent operation's price (every agent at the base
 * rate a minute, one price rule over every write path), the setup checks when an app lists an agent, the
 * session start (the agent locked as the model, its lookup queued), `open` asking ElevenLabs for the
 * single-use signed URL, and the conversation lookup after the call: a final record settles the session to
 * ElevenLabs' own figure, one not final yet is tried again, and a deleted agent, a refused key, a doubtful
 * figure or an hour gone keep the estimate.
 *
 * ElevenLabs is a stand-in for `fetch` (the vault's calls), its answers written from ElevenLabs' API
 * reference (`GET v1/convai/conversations/{id}`, `GET v1/convai/conversation/get-signed-url`,
 * `GET v1/convai/agents/{id}`) with the values of real records (T16, T17a).
 *
 * Runs with split keys off and on (`vitest.config.ts`): with them on, `open` and the lookup open the key from
 * the session's own copies, and a save can't read an agent's settings (no app share), so it answers 503.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { parseTicket } from "../relay/src/ticket.js";
import { adapterFor, closeForRelay, ContractRefusal, openForRelay } from "../src/relay/contract.ts";
import { checkpointForRelay, priceSlice } from "../src/relay/checkpoint.ts";
import { conversationFigure } from "../src/relay/elevenlabs-agent.ts";
import { agentSetupProblem } from "../src/admin/agents.ts";
import { billing, billingForCharge, priceSources, savedPriceProblem } from "../src/pricing/billability.ts";
import { listPrice } from "../src/pricing/prices.ts";
import { elevenlabs } from "../src/providers/elevenlabs.ts";
import { lookupWorkId, PROVIDER_LOOKUP_WINDOW_MS } from "../src/ledger/sessions.ts";
import { runSweep } from "../src/ledger/sweep.ts";
import { sealForTest, splitKeysOn } from "./split-keys.ts";
import { ACCOUNT_ID, clearCaches, ledger, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedAccount, seedAppKey, seedManagementKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const RELAY_ENV = { ...env, RELAY_URL: "https://relay.test" } as unknown as Env;
const SECRET = "el-secret-for-tests-0123456789";
const AGENT = "agent_7201m7pdev6jevj929vxq7afhp6c";
const CONVERSATION = "conv_0201m7pdgwcmen0bwje84b2yh3my";
const agentOperation = elevenlabs.operations.find((op) => op.name === "elevenlabs.agent")!;
const tts = elevenlabs.operations.find((op) => op.name === "elevenlabs.tts")!;

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);
beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

type Answer = { status: number; body?: unknown };

/** An agent's settings as `GET v1/convai/agents/{id}` answers them (T17a's `agent_get.json`), trimmed. */
function agentSettings(fields: { enableAuth?: boolean; durationOverride?: boolean } = {}) {
  return {
    agent_id: AGENT,
    name: "agw-test",
    conversation_config: { agent: { first_message: "Hello" }, conversation: { max_duration_seconds: 300 } },
    platform_settings: {
      auth: { enable_auth: fields.enableAuth ?? true, allowlist: [], require_origin_header: false, shareable_token: null },
      overrides: {
        conversation_config_override: {
          conversation: { text_only: false, max_duration_seconds: fields.durationOverride ?? false },
          agent: { first_message: true, language: false },
        },
        custom_llm_extra_body: false,
      },
      call_limits: { agent_concurrency_limit: -1, daily_limit: 100000, bursting_enabled: true },
    },
  };
}

/** A conversation record as `GET v1/convai/conversations/{id}` answers it (T16, call B), with fields changed. */
function record(fields: { status?: string; costFiat?: number | null; cost?: number | null; surcharge?: number | null; charging?: Record<string, unknown> } = {}) {
  return {
    agent_id: AGENT,
    conversation_id: CONVERSATION,
    status: fields.status ?? "done",
    metadata: {
      start_time_unix_secs: 1794975225,
      call_duration_secs: 21,
      cost: fields.cost === undefined ? 138 : fields.cost,
      termination_reason: "Client disconnected: 1000",
      charging: {
        dev_discount: false,
        is_burst: false,
        tier: "starter",
        llm_charge: 0,
        llm_price: 6.185e-5,
        call_charge: 138,
        platform_charge: 138,
        platform_price: 0.027580610511979707,
        subagent_charge: 0,
        voice_surcharge_charge: fields.surcharge === undefined ? null : fields.surcharge,
        analysis: null,
        user_memory: null,
        ...fields.charging,
      },
      voice_rewards: [],
      cost_fiat: fields.costFiat === undefined ? 0.027642460511979706 : fields.costFiat,
    },
    transcript: [],
  };
}

/** ElevenLabs as the vault reaches it: each path's answer, and what was asked, with the key it got. */
function elevenLabsApi(answers: { signedUrl?: () => Answer; agent?: () => Answer; conversation?: () => Answer } = {}) {
  const asked: { url: string; key: string | null }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    asked.push({ url: request.url, key: request.headers.get("xi-api-key") });
    const path = new URL(request.url).pathname;
    const answer =
      path === "/v1/convai/conversation/get-signed-url"
        ? (answers.signedUrl?.() ?? { status: 200, body: { signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT}&conversation_signature=sig_test&conversation_id=${CONVERSATION}` } })
        : path.startsWith("/v1/convai/agents/")
          ? (answers.agent?.() ?? { status: 200, body: agentSettings() })
          : path.startsWith("/v1/convai/conversations/")
            ? (answers.conversation?.() ?? { status: 200, body: record() })
            : { status: 500 };
    return answer.body === undefined ? new Response(null, { status: answer.status }) : Response.json(answer.body, { status: answer.status });
  });
  return asked;
}

async function seedConnection(): Promise<{ id: string; slug: string }> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `elevenlabs-${id.slice(0, 6)}`;
  const blob = await sealForTest("providerKey", [ACCOUNT_ID, id, "elevenlabs", "", "", ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'elevenlabs', ?, 'ElevenLabs', 'active', ?, '6789', NULL, NULL, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, slug, blob, now, now)
    .run();
  return { id, slug };
}

/** An app that may start `agents` (seeded as it is stored: its save checks are tested on their own). */
async function setup(agents: readonly string[] = [AGENT]) {
  const connection = await seedConnection();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [connection.slug]: { operations: ["elevenlabs.agent"], models: [...agents] } } },
  );
  const key = await seedAppKey(appId);
  return { appId, slug: connection.slug, connectionId: connection.id, key: key.key };
}

async function start(appId: string, slug: string, key: string, body: Record<string, unknown>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}/v2/apps/${appId}/sessions/${slug}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "user-11a" },
      body: JSON.stringify(body),
    }),
    RELAY_ENV,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function admin(path: string, method: string, body: unknown) {
  const key = await seedManagementKey();
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: JSON.parse(text) as Record<string, any> };
}

const appConfig = (slug: string, models: readonly string[] | undefined, operations: readonly string[] = ["elevenlabs.agent"]) => ({
  authentication: { type: "api_key", end_user: { source: "none" } },
  routing: { providers: { [slug]: { operations: [...operations], ...(models === undefined ? {} : { models: [...models] }) } } },
});

describe(`ElevenLabs agents' price and the save rule (step 11a, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  const none = priceSources({ type: "elevenlabs", rates: null });

  it("prices every agent at the base rate a minute, as one entry of the list, and never as a voice model", () => {
    expect(listPrice("elevenlabs-agents", "agent")?.rates).toEqual({ per_minute: 80_000_000 });
    expect(billing(agentOperation, none, AGENT).price?.price.rates).toEqual({ per_minute: 80_000_000 });
    expect(billing(agentOperation, none, "agent_other").price?.price.rates).toEqual({ per_minute: 80_000_000 });
    expect(billingForCharge(none, AGENT, "elevenlabs.agent")?.price.rates).toEqual({ per_minute: 80_000_000 });
    // A minute of a call at $0.08.
    expect(priceSlice({}, billing(agentOperation, none, AGENT).price, 60_000)).toMatchObject({ costNano: 80_000_000, estimated: false, unit: "session_seconds" });
    // A voice model keeps its own price, which an agent session can't bill: never taken for an agent.
    expect(billing(agentOperation, none, "eleven_flash_v2_5").problem).toBe("wrong_unit");
    // A name that only starts like one is no agent.
    expect(billing(agentOperation, none, "agent_").problem).toBe("no_price");
    // Nothing else changed: a voice model bills as it did, and an agent is a model of another kind there.
    expect(billing(tts, none, "eleven_flash_v2_5").price?.price.rates).toEqual(listPrice("elevenlabs", "eleven_flash_v2_5")!.rates);
    expect(billing(tts, none, AGENT).problem).toBe("wrong_unit");
  });

  it("takes a customer's own rate for one agent, by its id, and its save must bill a call by the minute", () => {
    const own = priceSources({ type: "elevenlabs", rates: { [AGENT]: { per_minute: 70_000_000 } } });
    expect(billing(agentOperation, own, AGENT).price).toMatchObject({ source: "customer_rate", price: { rates: { per_minute: 70_000_000 } } });
    expect(billing(agentOperation, own, "agent_other").price).toMatchObject({ source: "list_rate" });
    expect(savedPriceProblem({ [AGENT]: { per_minute: 70_000_000 } }, AGENT, "elevenlabs", elevenlabs.operations)).toBeNull();
    expect(savedPriceProblem({ [AGENT]: { per_million_characters: 40_000_000_000 } }, AGENT, "elevenlabs", elevenlabs.operations)).toMatchObject({
      kind: "session_rates",
      operation: "elevenlabs.agent",
      rates: ["per_minute"],
      byClock: true,
    });
    // A voice model's own rate is judged as before, never against agents.
    expect(savedPriceProblem({ eleven_flash_v2_5: { per_million_characters: 30_000_000_000 } }, "eleven_flash_v2_5", "elevenlabs", elevenlabs.operations)).toBeNull();
  });

  it("reads an agent's setup: its own auth on, and the duration override off", () => {
    expect(agentSetupProblem(agentSettings())).toBeNull();
    expect(agentSetupProblem(agentSettings({ enableAuth: false }))).toBe("auth_off");
    expect(agentSetupProblem(agentSettings({ durationOverride: true }))).toBe("duration_override_on");
    expect(agentSetupProblem({})).toBe("auth_off");
    expect(agentSetupProblem(null)).toBe("auth_off");
  });
});

describe(`checking an agent when an app lists it (step 11a, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it.runIf(!splitKeysOn)("saves an agent whose auth is on and whose duration can't be overridden, and asks ElevenLabs with the connection's key", async () => {
    const { slug } = await seedConnection();
    const asked = elevenLabsApi();
    const saved = await admin("/v2/admin/apps", "POST", { name: "agents", config: appConfig(slug, [AGENT, "eleven_flash_v2_5"], ["elevenlabs.agent", "elevenlabs.tts"]) });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    // The voice model is not asked about: only the agent.
    expect(asked).toEqual([{ url: `https://api.elevenlabs.io/v1/convai/agents/${AGENT}`, key: SECRET }]);
  });

  it.runIf(!splitKeysOn)("refuses an agent with its own auth off, one whose duration can be overridden, and one the key can't reach", async () => {
    const { slug } = await seedConnection();
    let agent: Answer = { status: 200, body: agentSettings({ enableAuth: false }) };
    elevenLabsApi({ agent: () => agent });
    const save = () => admin("/v2/admin/apps", "POST", { name: "agents", config: appConfig(slug, [AGENT]) });
    const auth = await save();
    expect(auth.status).toBe(400);
    expect(auth.body.error.message).toContain("authentication off");
    agent = { status: 200, body: agentSettings({ durationOverride: true }) };
    expect((await save()).body.error.message).toContain("override its maximum duration");
    agent = { status: 404, body: { detail: { status: "agent_not_found" } } };
    expect((await save()).body.error.message).toContain("is not an agent");
    agent = { status: 401, body: { detail: { status: "invalid_api_key" } } };
    expect((await save()).status).toBe(400);
    // No answer it can read: a 503, never a guess (AGENTS.md).
    agent = { status: 500 };
    expect((await save()).status).toBe(503);
    // A route that allows agents lists them: none listed would let any agent through unchecked.
    const unlisted = await admin("/v2/admin/apps", "POST", { name: "agents", config: appConfig(slug, undefined) });
    expect(unlisted.status).toBe(400);
    expect(unlisted.body.error.message).toContain("list the agents");
  });

  it.runIf(!splitKeysOn)("checks only an agent the save newly lists, also when it validates an edit", async () => {
    const { slug } = await seedConnection();
    const asked = elevenLabsApi();
    const created = await admin("/v2/admin/apps", "POST", { name: "agents", config: appConfig(slug, [AGENT]) });
    expect(created.status).toBe(201);
    const app = created.body.app as { id: string; revision: number };
    asked.length = 0;
    // An agent set up badly since, in ElevenLabs: a rename doesn't refuse the app (it was judged when listed).
    elevenLabsApi({ agent: () => ({ status: 200, body: agentSettings({ enableAuth: false }) }) });
    const renamed = await admin(`/v2/admin/apps/${app.id}`, "PUT", { name: "renamed", config: appConfig(slug, [AGENT]), revision: app.revision });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    // A new agent is checked, on validate as on save.
    const asking = elevenLabsApi({ agent: () => ({ status: 200, body: agentSettings({ enableAuth: false }) }) });
    const validated = await admin(`/v2/admin/apps/${app.id}/validate`, "POST", { name: "renamed", config: appConfig(slug, [AGENT, "agent_second"]) });
    expect(validated.status).toBe(400);
    expect(asking.map((one) => one.url)).toEqual(["https://api.elevenlabs.io/v1/convai/agents/agent_second"]);
  });

  it.runIf(splitKeysOn)("answers 503 when the connection's key opens only with an app's share, which a save doesn't have", async () => {
    const { slug } = await seedConnection();
    const asked = elevenLabsApi();
    const saved = await admin("/v2/admin/apps", "POST", { name: "agents", config: appConfig(slug, [AGENT]) });
    expect(saved.status).toBe(503);
    expect(asked).toEqual([]);
  });
});

describe(`starting an agent call and its signed URL (step 11a, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("starts a conversational session with the agent locked as its model and its lookup queued", async () => {
    const { appId, slug, key } = await setup();
    const response = await start(appId, slug, key, { path: `v1/convai/conversation?agent_id=${AGENT}&branch_id=agtbrch_1&xi-api-key=theirs` });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ticket: string; session_id: string };
    const { payload } = parseTicket(body.ticket)!;
    expect(payload).toMatchObject({ operation: "elevenlabs.agent", model: AGENT, slot: "conversational", mode: "relayed", sessionTotal: true });
    // A credential in the query never goes on.
    expect(payload.url).toBe(`https://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT}&branch_id=agtbrch_1`);
    expect(adapterFor(payload)).toBe("elevenlabs_agent");
    const row = await ledger().prepare("SELECT kind, detail_json FROM open_work WHERE id = ?").bind(lookupWorkId(body.session_id)).first<{ kind: string; detail_json: string }>();
    expect(row?.kind).toBe("provider_lookup");
    const detail = JSON.parse(row!.detail_json) as Record<string, unknown>;
    expect(detail.providerType).toBe("elevenlabs");
    if (splitKeysOn) expect(detail.keyCopies).toMatchObject({ providerKey: { blob: expect.any(String) } });
    else expect(detail.keyCopies).toBeUndefined();
    // The agent in the body is the same agent.
    const named = await start(appId, slug, key, { path: "v1/convai/conversation", model: AGENT });
    expect(parseTicket(((await named.json()) as { ticket: string }).ticket)!.payload.url).toBe(`https://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT}`);
  });

  it("refuses an agent the app doesn't list, a voice model named as one, and a call naming none", async () => {
    const { appId, slug, key } = await setup();
    expect((await start(appId, slug, key, { path: "v1/convai/conversation?agent_id=agent_unlisted" })).status).toBe(403);
    const voice = await setup(["eleven_flash_v2_5"]);
    expect((await start(voice.appId, voice.slug, voice.key, { path: "v1/convai/conversation?agent_id=eleven_flash_v2_5" })).status).toBe(400);
    expect((await start(appId, slug, key, { path: "v1/convai/conversation" })).status).toBe(400);
  });

  it("asks ElevenLabs for a single-use signed URL at open, with the session's own key, and hands it to the relay", async () => {
    const { appId, slug, key } = await setup();
    const { ticket } = (await (await start(appId, slug, key, { path: `v1/convai/conversation?agent_id=${AGENT}&branch_id=agtbrch_1` })).json()) as { ticket: string };
    const asked = elevenLabsApi();
    const ctx = createExecutionContext();
    const settings = await openForRelay(env, ticket, Date.now(), (promise) => ctx.waitUntil(promise));
    await waitOnExecutionContext(ctx);
    expect(settings).toMatchObject({ adapter: "elevenlabs_agent", model: AGENT, signedUrl: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT}&conversation_signature=sig_test&conversation_id=${CONVERSATION}` });
    // The app's options go on; the URL starts one conversation only; the vault added the key from the session's copy.
    expect(asked).toEqual([{ url: `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${AGENT}&branch_id=agtbrch_1&include_conversation_id=true`, key: SECRET }]);
    // A session that doesn't start through one gets none.
    expect(settings.signedUrl).toBeDefined();
  });

  it("refuses open with provider_unavailable when ElevenLabs refuses the signed URL (a deleted agent) or answers none", async () => {
    const { appId, slug, key } = await setup();
    let answer: Answer = { status: 404, body: { detail: { status: "agent_not_found" } } };
    elevenLabsApi({ signedUrl: () => answer });
    const ticket = async () => ((await (await start(appId, slug, key, { path: `v1/convai/conversation?agent_id=${AGENT}` })).json()) as { ticket: string }).ticket;
    await expect(openForRelay(env, await ticket())).rejects.toEqual(new ContractRefusal("provider_unavailable"));
    answer = { status: 200, body: { signed_url: 42 } };
    await expect(openForRelay(env, await ticket())).rejects.toEqual(new ContractRefusal("provider_unavailable"));
  });
});

/** An agent call through the endpoint, its slices booked and closed as the relay does; returns its ids. */
async function closedCall(sliceMs = 60_000, conversationId: string | null = CONVERSATION) {
  const { appId, slug, key } = await setup();
  const response = await start(appId, slug, key, { path: `v1/convai/conversation?agent_id=${AGENT}` });
  const { ticket, session_id: sessionId } = (await response.json()) as { ticket: string; session_id: string };
  const { payload } = parseTicket(ticket)!;
  const endedAt = payload.start + sliceMs + 1_000;
  const ctx = createExecutionContext();
  const reply = await checkpointForRelay(
    env,
    ticket,
    { slice: { seq: 1, measures: {}, sessionMs: sliceMs, gapMs: 0, gaps: 0, from: payload.start, to: payload.start + sliceMs }, connected: true, accounting: true, providerCallId: conversationId },
    endedAt,
    (promise) => ctx.waitUntil(promise),
  );
  expect(reply.written).toBe(true);
  await closeForRelay(env, ticket, { finalSlice: 1, endReason: "client_closed", endedAt, providerCallId: conversationId }, endedAt, (promise) => ctx.waitUntil(promise));
  await waitOnExecutionContext(ctx);
  return { sessionId, endedAt };
}

async function settlementOf(sessionId: string) {
  return ledger().prepare("SELECT settlement, session_total_nano FROM session WHERE id = ?").bind(sessionId).first<{ settlement: string; session_total_nano: number | null }>();
}

async function sessionCost(sessionId: string): Promise<number> {
  const row = await ledger().prepare("SELECT COALESCE(SUM(cost_nano), 0) AS cost FROM charge WHERE owner_id = ?").bind(sessionId).first<{ cost: number }>();
  return row?.cost ?? 0;
}

async function lookupRow(sessionId: string) {
  return ledger().prepare("SELECT tries, last_error FROM open_work WHERE id = ?").bind(lookupWorkId(sessionId)).first<{ tries: number; last_error: string | null }>();
}

describe(`ElevenLabs' conversation lookup after an agent call (step 11a, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("reads a finished record's cost_fiat, plus a voice surcharge in credits at the record's own price per credit", () => {
    expect(conversationFigure(record())).toEqual({ kind: "final", usd: 0.027642460511979706 });
    // `failed` is final too.
    expect(conversationFigure(record({ status: "failed", costFiat: 0.01 }))).toEqual({ kind: "final", usd: 0.01 });
    // 10 credits at $0.02 / 100 credits.
    expect(conversationFigure(record({ costFiat: 0.02, cost: 100, surcharge: 10 }))).toEqual({ kind: "final", usd: 0.022 });
    // ElevenLabs is still on it.
    for (const status of ["initiated", "in-progress", "processing"]) expect(conversationFigure(record({ status }))).toEqual({ kind: "pending" });
    // A call that never started (queued, T16) is $0: the caller keeps the estimate for it.
    expect(conversationFigure(record({ costFiat: null, cost: null, charging: { call_charge: null, platform_charge: null, subagent_charge: null } }))).toEqual({ kind: "final", usd: 0 });
    // A surcharge with no price per credit, or a charge whose part in the figure is unknown, is doubtful.
    expect(conversationFigure(record({ cost: 0, surcharge: 10 }))).toEqual({ kind: "doubtful" });
    expect(conversationFigure(record({ charging: { subagent_charge: 12 } }))).toEqual({ kind: "doubtful" });
    expect(conversationFigure(record({ charging: { memory_charge: 3 } }))).toEqual({ kind: "doubtful" });
    expect(conversationFigure(null)).toEqual({ kind: "pending" });
  });

  it("settles the call to ElevenLabs' own figure once it is done, minus the estimate booked (ok)", async () => {
    const { sessionId, endedAt } = await closedCall();
    // The estimate: a minute at the base rate.
    expect(await sessionCost(sessionId)).toBe(80_000_000);
    const asked = elevenLabsApi();
    await runSweep(env, ledger(), { now: endedAt + 31_000 });
    expect(await settlementOf(sessionId)).toEqual({ settlement: "settled", session_total_nano: 27_642_461 });
    expect(await sessionCost(sessionId)).toBe(27_642_461);
    expect(asked).toEqual([{ url: `https://api.elevenlabs.io/v1/convai/conversations/${CONVERSATION}`, key: SECRET }]);
    expect(await lookupRow(sessionId)).toBeNull();
  });

  it("tries a record that isn't done again, a minute later and then doubling (pending), and settles once it is", async () => {
    const { sessionId, endedAt } = await closedCall();
    let answer: Answer = { status: 200, body: record({ status: "processing" }) };
    elevenLabsApi({ conversation: () => answer });
    await runSweep(env, ledger(), { now: endedAt + 31_000 });
    expect(await lookupRow(sessionId)).toMatchObject({ tries: 1, last_error: "record not complete" });
    answer = { status: 503 };
    await runSweep(env, ledger(), { now: endedAt + 91_000 });
    expect(await lookupRow(sessionId)).toMatchObject({ tries: 2, last_error: "record answered 503" });
    expect(await settlementOf(sessionId)).toMatchObject({ settlement: "open" });
    answer = { status: 200, body: record({ costFiat: 0.05 }) };
    await runSweep(env, ledger(), { now: endedAt + 211_000 });
    expect(await settlementOf(sessionId)).toEqual({ settlement: "settled", session_total_nano: 50_000_000 });
  });

  it("keeps the estimate when the agent was deleted, its records with it (404), and when the key may not read them (401, 403)", async () => {
    for (const status of [404, 401, 403]) {
      const { sessionId, endedAt } = await closedCall();
      elevenLabsApi({ conversation: () => ({ status, body: { detail: { status: "not_found" } } }) });
      await runSweep(env, ledger(), { now: endedAt + 31_000 });
      expect(await settlementOf(sessionId), String(status)).toEqual({ settlement: "estimate_kept", session_total_nano: null });
      expect(await sessionCost(sessionId)).toBe(80_000_000);
      expect(await lookupRow(sessionId)).toBeNull();
    }
  });

  it("keeps the estimate on a doubtful figure: $0 (a call that never started), a negative one, an unknown charge", async () => {
    for (const body of [record({ costFiat: null, cost: null }), record({ costFiat: -0.01 }), record({ charging: { subagent_charge: 5 } })]) {
      const { sessionId, endedAt } = await closedCall();
      elevenLabsApi({ conversation: () => ({ status: 200, body }) });
      await runSweep(env, ledger(), { now: endedAt + 31_000 });
      expect(await settlementOf(sessionId)).toEqual({ settlement: "estimate_kept", session_total_nano: null });
      expect(await sessionCost(sessionId)).toBe(80_000_000);
    }
  });

  it("keeps the estimate once an hour has passed since the call ended (expiry), and when it has no conversation id, asking ElevenLabs nothing", async () => {
    const late = await closedCall();
    const asked = elevenLabsApi();
    await runSweep(env, ledger(), { now: late.endedAt + PROVIDER_LOOKUP_WINDOW_MS + 1_000 });
    expect(await settlementOf(late.sessionId)).toEqual({ settlement: "estimate_kept", session_total_nano: null });
    const unnamed = await closedCall(60_000, null);
    await runSweep(env, ledger(), { now: unnamed.endedAt + 31_000 });
    expect(await settlementOf(unnamed.sessionId)).toMatchObject({ settlement: "estimate_kept" });
    expect(asked).toEqual([]);
  });
});
