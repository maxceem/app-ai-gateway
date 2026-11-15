import { gatewayBackend } from "../src/realtime/gateway-backend";
import { sessionBackend } from "../src/realtime/relay/backend";
import { env } from "cloudflare:workers";
import { runInDurableObject, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import gateway from "../src/index";
import { database } from "../src/db";
import { app as appTable } from "../src/db/schema";
import { SessionCoordinator } from "../src/realtime/relay/session";
import { realtimeTicket, settledEvent } from "../src/realtime/usage";
import { RelayError } from "../src/realtime/relay/errors";
import { SessionJournal } from "../src/realtime/relay/journal";
import { GeminiAdapter } from "../src/realtime/relay/protocols/gemini";
import { Mailbox } from "../src/realtime/relay/transport";
import { loadApp } from "../src/core/app-records";
import { authenticateRequest } from "../src/client-auth/client-auth";
import { requireProvider } from "../src/providers/provider-store";
import { buildUsageEvent, persistUsageEventAcknowledged } from "../src/usage/usage-record";
import type { Bootstrap, CompletionStatus, JsonObject, Settlement } from "../src/realtime/relay/contract";
import type { Generation } from "../src/realtime/relay/types";
import type { SessionBackend } from "../src/realtime/relay/backend";
import {
  clearIsolateCaches,
  seedProvider,
  seedServerApp,
  testAttribution,
  TEST_ORGANIZATION_ID,
} from "./helpers";

/** The gateway's answers, reached the way the gateway's own sessions reach them. */
const localSessionBackend = (runtimeEnv: Env, waitUntil: (promise: Promise<unknown>) => void) =>
  sessionBackend(gatewayBackend(runtimeEnv, waitUntil));

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  input_token_details: { audio_tokens: 0, text_tokens: 1, cached_tokens: 0 },
  output_token_details: { audio_tokens: 0, text_tokens: 1 },
};
const ack = {
  type: "session.updated",
  session: {
    model: "gpt-realtime",
    max_output_tokens: 4096,
    audio: { input: { turn_detection: null, transcription: null } },
  },
};
const manual = { ready: true, configuring: false, active: false, responseId: null };

const attribution = () => testAttribution({ model: "gpt-realtime", apiStyle: "other" });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A provider's `response.done` that reports `usage`. */
const responseDone = (id: string) =>
  JSON.stringify({ type: "response.done", response: { id, status: "completed", usage } });

/** The code a socket will close with. */
const closeCode = (socket: WebSocket) =>
  new Promise<number>(resolve => socket.addEventListener("close", event => resolve(event.code)));

/** The `type` of a frame received on a socket. */
const frameType = (event: MessageEvent) => (JSON.parse(String(event.data)) as JsonObject).type;

/** What a proxy that changes nothing returns for `property`: methods stay bound to `target`. */
function passthrough(target: object, property: string | symbol) {
  const value = Reflect.get(target, property);
  return typeof value === "function" ? value.bind(target) : value;
}

/** The lease holders a session acquires: its app, then its API key. */
function leaseNames(bootstrap: Bootstrap) {
  return [bootstrap.appId, `${bootstrap.appId}:realtime:key:${bootstrap.identity.apiKeyId}`];
}

/** Waits up to two seconds for a session's usage records to reach `count`. */
async function usageRecorded(sessionId: string, count: number) {
  for (let waited = 0; waited < 2_000 && Number(await sessionUsageCount(sessionId)) < count; waited += 20) {
    await sleep(20);
  }
  return sessionUsageCount(sessionId);
}

async function sessionUsageCount(sessionId: string) {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM app_usage_event WHERE realtime_session_id = ?")
    .bind(sessionId)
    .first();
  return row?.n;
}

async function saveAppConfig(appId: string, config: Awaited<ReturnType<typeof loadApp>>["config"]) {
  await database(env.DB).update(appTable).set({ config }).where(eq(appTable.id, appId));
  clearIsolateCaches();
}

function newSessionStub() {
  return env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
}

function coordinatorFor(runtimeEnv: Env, state: DurableObjectState, bootstrap: Bootstrap, headers: Headers) {
  return new SessionCoordinator(
    localSessionBackend(runtimeEnv, promise => state.waitUntil(promise)),
    state,
    bootstrap,
    headers,
  );
}

async function setup(endUser: "none" | "header" = "none") {
  clearIsolateCaches();
  const appId = crypto.randomUUID();
  const key = await seedServerApp(appId, { endUser });
  await seedProvider({ type: "openai", id: appId, slug: appId });
  const app = await loadApp(env, appId);
  app.config.realtime.enabled = true;
  app.config.routing.providers = { mode: "all" };
  app.config.limits.per_app.requests.per_day = 1;
  await saveAppConfig(appId, app.config);
  const headers = new Headers({
    Authorization: `Bearer ${key}`,
    ...(endUser === "header" ? { "x-end-user-id": "u" } : {}),
  });
  const identity = (await authenticateRequest({
    env,
    app: await loadApp(env, appId),
    request: new Request("https://gateway.test/", { headers }),
    body: async () => new Uint8Array(),
  })).identity;
  const provider = await requireProvider(env, TEST_ORGANIZATION_ID, appId);
  const bootstrap: Bootstrap = {
    sessionId: crypto.randomUUID(),
    appId,
    organizationId: TEST_ORGANIZATION_ID,
    providerId: provider.id,
    providerSlug: appId,
    model: "gpt-realtime",
    requestedModel: "gpt-realtime",
    protocol: "openai_realtime",
    identity,
    appVersion: null,
    origin: "https://gateway.test",
  };
  return { bootstrap, headers };
}
function hostedEnv(): Env {
  const scope = crypto.randomUUID();
  return {
    ...env,
    BILLING: {
      getTenantAccess: async () => ({
        plan: { planKey: "free", planName: "Free", isDefault: true, limits: { maxRequestsPerMonth: 1 } },
        subscription: null,
      }),
    },
    ORG_QUOTA: new Proxy(env.ORG_QUOTA, {
      get(target, property) {
        if (property === "getByName") return (name: string) => target.getByName(`${scope}:${name}`);
        return passthrough(target, property);
      },
    }),
  } as unknown as Env;
}
function generation(bootstrap: Bootstrap, stage: Generation["stage"] = "dispatching"): Generation {
  const id = crypto.randomUUID();
  const at = Date.now();
  return {
    id,
    at,
    ordinal: 1,
    stage,
    usage: null,
    responseId: null,
    outputBytes: 0,
    ticket: realtimeTicket({ price: {
      kind: "realtime",
      input: 4,
      output: 16,
      audio_input: 32,
      audio_output: 64,
      cached_input: .4,
      cached_input_audio: .4,
    },
    event: buildUsageEvent({
      organizationId: bootstrap.organizationId,
      identity: bootstrap.identity,
      attribution: attribution(),
      appVersion: null,
      status: "ok",
      latencyMs: 0,
      contentType: "application/json",
      observed: null,
      eventId: id,
      createdAt: new Date(at).toISOString(),
      realtime: {
        sessionId: bootstrap.sessionId,
        generationId: id,
        protocol: "openai_realtime",
        providerResponseId: null,
        completionStatus: "interrupted",
      },
    }) }),
  };
}
/** What a session reports when `g` settles. */
function settlementOf(g: Generation, status: CompletionStatus, aborted: boolean): Settlement {
  return {
    generationId: g.id,
    at: g.at,
    ticket: g.ticket,
    usage: g.usage,
    responseId: g.responseId,
    status,
    aborted,
    latencyMs: Math.max(0, Date.now() - g.at),
  };
}
function frames(socket: WebSocket) {
  const saved: JsonObject[] = [];
  const waiting = new Map<string, (frame: JsonObject) => void>();
  socket.addEventListener("message", event => {
    const frame = JSON.parse(String(event.data)) as JsonObject;
    const callback = waiting.get(String(frame.type));
    if (callback) {
      waiting.delete(String(frame.type));
      callback(frame);
    } else saved.push(frame);
  });
  return (type: string): Promise<JsonObject> => {
    const index = saved.findIndex(frame => frame.type === type);
    if (index >= 0) return Promise.resolve(saved.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing ${type}`)), 4000);
      waiting.set(type, frame => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  };
}
interface Sockets {
  coordinator: SessionCoordinator;
  socket: WebSocket;
  upstream: WebSocket;
  next: ReturnType<typeof frames>;
  state: DurableObjectState;
  bootstrap: Bootstrap;
}
/** Lets a test session admit more than the one response a day `setup` allows. */
async function allowManyResponses(appId: string) {
  const application = await loadApp(env, appId);
  application.config.limits.per_app.requests.per_day = null;
  await saveAppConfig(appId, application.config);
}
async function withSockets(
  run: (input: Sockets) => Promise<void>,
  runtimeEnv: Env = env,
  endUser: "none" | "header" = "none",
) {
  const { bootstrap, headers } = await setup(endUser);
  const stub = newSessionStub();
  await runInDurableObject(stub, async (instance, state) => {
    const pair = new WebSocketPair();
    pair[0].accept({ allowHalfOpen: true });
    pair[0].addEventListener("message", event => {
      const frame = JSON.parse(String(event.data)) as JsonObject;
      if (frame.type === "session.update") pair[0].send(JSON.stringify(ack));
    });
    const coordinator = coordinatorFor(runtimeEnv, state, bootstrap, headers);
    Reflect.set(instance, "coordinator", coordinator);
    const response = await coordinator.start(pair[1]);
    const socket = response.webSocket!;
    const next = frames(socket);
    socket.accept({ allowHalfOpen: true });
    await next("session.updated");
    try {
      await run({ coordinator, socket, next, upstream: pair[0], state, bootstrap });
    } finally {
      coordinator.terminate(null, 1000);
      socket.close(1000);
      pair[0].close(1000);
      await sleep(30);
    }
  });
}

describe("realtime failure boundaries", () => {
  it.each(["billing_request_quota_exceeded", "app_budget_exhausted"] as const)(
    "active admitted generation survives idle maintenance %s race",
    async code => {
      await withSockets(async ({ coordinator, socket, next, upstream }) => {
        let entered!: () => void;
        let release!: () => void;
        const pending = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const backend = Reflect.get(coordinator, "backend") as SessionBackend;
        backend.maintain = async (_bootstrap, _headers, _previous, active) => {
          expect(active).toBe(false);
          entered();
          await gate;
          throw new RelayError(429, code, "Exhausted");
        };
        const maintain = Reflect.get(coordinator, "maintain");
        const maintenance = Reflect.apply(maintain, coordinator, []) as Promise<void>;
        await pending;
        let dispatched!: () => void;
        const admission = new Promise<void>(resolve => { dispatched = resolve; });
        upstream.addEventListener("message", event => {
          if (frameType(event) === "response.create") {
            upstream.send(JSON.stringify({ type: "response.created", response: { id: "race-response" } }));
            dispatched();
          }
        });
        socket.send(JSON.stringify({ type: "response.create", event_id: "maintenance-race" }));
        await admission;
        release();
        await maintenance;
        upstream.send(responseDone("race-response"));
        expect((await next("response.done")).type).toBe("response.done");
        expect(coordinator.journal.generations()[0]?.stage).toBe("settled");
      });
    },
  );

  it.each(["user", "app"] as const)(
    "setup alarm waits for a delayed %s acquire before releasing capacity and deleting the journal",
    async scope => {
      const { bootstrap, headers } = await setup();
      const stub = newSessionStub();
      let entered!: () => void;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      let userAcquires = 0;
      let appAcquires = 0;
      let releases = 0;
      const runtimeEnv = {
        ...env,
        USER_LIMITER: {
          getByName: (name: string) => {
            const limiter = env.USER_LIMITER.getByName(name);
            const app = name === bootstrap.appId;
            return new Proxy(limiter, {
              get(target, property) {
                if (property === "acquireSession") {
                  return async (sessionId: string, cap: number) => {
                    if (app) appAcquires++;
                    else userAcquires++;
                    if (app === (scope === "app")) {
                      entered();
                      await gate;
                    }
                    // The lease is actually committed AFTER shutdown starts.
                    return target.acquireSession(sessionId, cap);
                  };
                }
                if (property === "releaseSession") {
                  return async (sessionId: string) => {
                    releases++;
                    return target.releaseSession(sessionId);
                  };
                }
                return passthrough(target, property);
              },
            });
          },
        },
      } as unknown as Env;
      await runInDurableObject(stub, async (instance, state) => {
        const pair = new WebSocketPair();
        pair[0].accept({ allowHalfOpen: true });
        let dispatches = 0;
        pair[0].addEventListener("message", () => { dispatches++; });
        const coordinator = coordinatorFor(runtimeEnv, state, bootstrap, headers);
        Reflect.set(instance, "coordinator", coordinator);
        const start = coordinator.start(pair[1]).then(() => null, error => error as unknown);
        await pending;
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);
        try {
          const alarm = coordinator.alarm();
          await sleep(10);
          expect(releases).toBe(0);
          expect(coordinator.journal.metadata()?.sessionId).toBe(bootstrap.sessionId);
          release();
          expect(await start).toMatchObject({ code: "provider_error" });
          await alarm;
          // Both leases are asked for at once, and both are released.
          expect(userAcquires).toBe(1);
          expect(appAcquires).toBe(1);
          expect(dispatches).toBe(0);
          expect(releases).toBe(2);
          expect(await state.storage.getAlarm()).toBeNull();
        } finally {
          release();
          clock.mockRestore();
          pair[0].close(1000);
        }
        for (const name of leaseNames(bootstrap)) {
          const limiter = env.USER_LIMITER.getByName(name);
          expect((await limiter.acquireSession("replacement", 1)).allowed).toBe(true);
          await limiter.releaseSession("replacement");
        }
      });
    },
  );
  it("setup alarm closes a provider upgrade that resolves after shutdown starts", async () => {
    const { bootstrap, headers } = await setup();
    const stub = newSessionStub();
    let entered!: () => void;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await runInDurableObject(stub, async (instance, state) => {
      const pair = new WebSocketPair();
      pair[0].accept({ allowHalfOpen: true });
      let dispatches = 0;
      pair[0].addEventListener("message", () => { dispatches++; });
      const providerFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        entered();
        await gate;
        return new Response(null, { status: 101, webSocket: pair[1] });
      });
      const coordinator = coordinatorFor(env, state, bootstrap, headers);
      Reflect.set(instance, "coordinator", coordinator);
      const start = coordinator.start().then(() => null, error => error as unknown);
      await pending;
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);
      try {
        const alarm = coordinator.alarm();
        release();
        expect(await start).toMatchObject({ code: "provider_error" });
        await alarm;
        expect(pair[1].readyState).not.toBe(WebSocket.OPEN);
        expect(dispatches).toBe(0);
        expect(await state.storage.getAlarm()).toBeNull();
      } finally {
        release();
        clock.mockRestore();
        providerFetch.mockRestore();
        pair[0].close(1000);
      }
    });
  });
  it("failed lease cleanup schedules its durable expiry and eventually stops without more RPCs", async () => {
    const { bootstrap, headers } = await setup();
    const stub = newSessionStub();
    let releases = 0;
    const runtimeEnv = {
      ...env,
      USER_LIMITER: {
        getByName: () => ({
          releaseSession: async () => {
            releases++;
            throw new Error("Limiter permanently unavailable");
          },
        }),
      },
    } as unknown as Env;
    await runInDurableObject(stub, async (_instance, state) => {
      const journal = new SessionJournal(state.storage);
      journal.open(bootstrap);
      const expiry = Date.now() + 60_000;
      for (const name of ["release:user", "release:app"] as const) {
        journal.saveTask(name, {
          attempts: 12,
          due: Date.now() + 3_600_000,
          complete: false,
          expiresAt: expiry,
        });
      }
      await coordinatorFor(runtimeEnv, state, bootstrap, headers).alarm();
      expect(releases).toBe(0);
      expect(await state.storage.getAlarm()).toBe(expiry);
      // A new coordinator retains the earlier expiry, not another seven days.
      await coordinatorFor(runtimeEnv, state, bootstrap, headers).alarm();
      expect(releases).toBe(0);
      expect(await state.storage.getAlarm()).toBe(expiry);
      for (const name of ["release:user", "release:app"] as const) {
        const task = journal.task(name);
        task.expiresAt = Date.now() - 1;
        journal.saveTask(name, task);
      }
      await coordinatorFor(runtimeEnv, state, bootstrap, headers).alarm();
      expect(releases).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE name IN ('session_metadata', 'generations', 'recovery_tasks')",
      ).toArray()).toEqual([]);
    });
  });
  it.each(["error", "cancellation"] as const)(
    "%s send failure cannot interrupt shutdown or lose counted usage",
    async failure => {
      await withSockets(async ({ socket, upstream, next, coordinator, bootstrap }) => {
        upstream.addEventListener("message", event => {
          if (JSON.parse(String(event.data)).type === "response.create") {
            upstream.send('{"type":"response.created","response":{"id":"shutdown"}}');
          }
        });
        socket.send('{"type":"response.create"}');
        await next("response.created");
        const target = Reflect.get(coordinator, failure === "error" ? "client" : "upstream") as WebSocket;
        const original = target.send;
        const spy = vi.spyOn(target, "send").mockImplementation(data => {
          const failing = failure === "error" ? "gateway.error" : "response.cancel";
          if (typeof data === "string" && JSON.parse(data).type === failing) {
            throw new Error("Transport send failed");
          }
          return original.call(target, data);
        });
        try {
          expect(() => coordinator.terminate(
            new RelayError(502, "provider_error", "Realtime transport failed"),
            1011,
          )).not.toThrow();
          await sleep(2100);
          expect((Reflect.get(coordinator, "upstream") as WebSocket).readyState).not.toBe(WebSocket.OPEN);
          const rows = await env.DB
            .prepare(
              "SELECT completion_status, cost_source FROM app_usage_event WHERE realtime_session_id = ?",
            )
            .bind(bootstrap.sessionId)
            .all();
          expect(rows.results).toEqual([{ completion_status: "interrupted", cost_source: "unresolved" }]);
          for (const name of leaseNames(bootstrap)) {
            const limiter = env.USER_LIMITER.getByName(name);
            expect((await limiter.acquireSession("replacement", 1)).allowed).toBe(true);
            await limiter.releaseSession("replacement");
          }
        } finally {
          spy.mockRestore();
        }
      });
    },
  );
  it("identified audio does not exhaust lifetime IDs or evict generation-trigger protection", async () => {
    await withSockets(async ({ socket, upstream, next, coordinator, bootstrap }) => {
      let audio = 0;
      let triggers = 0;
      let target = 0;
      let batchDone: (() => void) | null = null;
      upstream.addEventListener("message", event => {
        const frame = JSON.parse(String(event.data)) as JsonObject;
        if (frame.type === "response.create") {
          triggers++;
          upstream.send('{"type":"response.created","response":{"id":"identified"}}');
          upstream.send(responseDone("identified"));
        }
        if (frame.type === "input_audio_buffer.append" && ++audio === target) batchDone?.();
      });
      const trigger = JSON.stringify({ type: "response.create", event_id: "original-trigger" });
      socket.send(trigger);
      await next("response.done");
      for (let offset = 0; offset < 5000; offset += 25) {
        target = offset + 25;
        const done = new Promise<void>(resolve => { batchDone = resolve; });
        for (let index = offset; index < target; index++) {
          socket.send(JSON.stringify({
            type: "input_audio_buffer.append",
            event_id: `audio-${index}`,
            audio: "AAAA",
          }));
        }
        await done;
      }
      socket.send(trigger); // Still suppressed after more than 4096 intervening IDs.
      // Recent duplicate also suppressed.
      socket.send(JSON.stringify({
        type: "input_audio_buffer.append",
        event_id: "audio-4999",
        audio: "AAAA",
      }));
      target = 5001;
      const barrier = new Promise<void>(resolve => { batchDone = resolve; });
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", event_id: "barrier", audio: "AAAA" }));
      await barrier;
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(triggers).toBe(1);
      expect(audio).toBe(5001);
      expect((Reflect.get(coordinator, "recentIds") as Map<string, string>).size).toBe(4096);
      socket.send(JSON.stringify({
        type: "response.create",
        event_id: "original-trigger",
        response: { instructions: "changed" },
      }));
      expect(await next("gateway.error")).toMatchObject({ error: { code: "realtime_protocol_error" } });
      expect(triggers).toBe(1);
      expect(await sessionUsageCount(bootstrap.sessionId)).toBe(1);
    });
  });
  it("closed sessions honor usage backoff and persist completed releases across reconstruction", async () => {
    const { bootstrap, headers } = await setup();
    const stub = newSessionStub();
    const releases = new Map<string, number>();
    let failApp = true;
    const runtimeEnv = {
      ...env,
      USER_LIMITER: {
        getByName: (name: string) => {
          const limiter = env.USER_LIMITER.getByName(name);
          return new Proxy(limiter, {
            get(target, property) {
              if (property === "releaseSession") {
                return async (sessionId: string) => {
                  releases.set(name, (releases.get(name) ?? 0) + 1);
                  if (name === bootstrap.appId && failApp) throw new Error("Limiter unavailable");
                  return target.releaseSession(sessionId);
                };
              }
              return passthrough(target, property);
            },
          });
        },
      },
    } as unknown as Env;
    await runInDurableObject(stub, async (_instance, state) => {
      const journal = new SessionJournal(state.storage);
      journal.open(bootstrap);
      const g = generation(bootstrap);
      journal.settle(g, settlementOf(g, "interrupted", true));
      const item = journal.outbox()[0]!;
      const due = Date.now() + 3_600_000;
      item.due = due;
      state.storage.sql.exec("UPDATE usage_outbox SET json = ? WHERE id = ?", JSON.stringify(item), item.id);
      await coordinatorFor(runtimeEnv, state, bootstrap, headers).alarm();
      expect(releases.size).toBe(2);
      expect(journal.task("release:user").complete).toBe(true);
      expect(await state.storage.getAlarm()).toBe(journal.task("release:app").due);
      // Successful release is never repeated, and failed release respects its own deadline.
      await coordinatorFor(runtimeEnv, state, bootstrap, headers).alarm();
      expect([...releases.values()]).toEqual([1, 1]);
      const task = journal.task("release:app");
      task.due = Date.now() - 1;
      journal.saveTask("release:app", task);
      failApp = false;
      await coordinatorFor(runtimeEnv, state, bootstrap, headers).alarm();
      expect(releases.get(bootstrap.appId)).toBe(2);
      expect(releases.get(`${bootstrap.appId}:realtime:key:${bootstrap.identity.apiKeyId}`)).toBe(1);
      expect(await state.storage.getAlarm()).toBe(due);
      await coordinatorFor(runtimeEnv, state, bootstrap, headers).alarm();
      expect([...releases.values()]).toEqual([1, 2]);
      expect(await state.storage.getAlarm()).toBe(due);
      await state.storage.deleteAlarm();
    });
  });
  it("a limit reached ends the session after the response it refused, which runs uncounted", async () => {
    await withSockets(async ({ socket, upstream, next, bootstrap }) => {
      let sent = 0;
      upstream.addEventListener("message", event => {
        if (frameType(event) !== "response.create") return;
        const id = `r-${++sent}`;
        upstream.send(JSON.stringify({ type: "response.created", response: { id } }));
        upstream.send(responseDone(id));
      });
      // The app allows one request a day: the second turn is sent at once,
      // and its count is refused in the background.
      socket.send('{"type":"response.create"}');
      await next("response.done");
      socket.send('{"type":"response.create"}');
      await next("response.done");
      expect(await next("gateway.error")).toMatchObject({ error: { code: "app_rate_limited" } });
      expect(sent).toBe(2);
      // Both responses ran, so both have a usage record; only one was counted.
      await sleep(20);
      expect(await sessionUsageCount(bootstrap.sessionId)).toBe(2);
      expect(await env.USER_LIMITER.getByName(bootstrap.appId).getStatus(Date.now()))
        .toEqual({ requestsToday: 1 });
    });
  });
  it("a refusal arriving as a response ends still lets its last event reach the app", async () => {
    await withSockets(async ({ socket, upstream, next, coordinator }) => {
      const backend = Reflect.get(coordinator, "backend") as SessionBackend;
      const counted = backend.admit;
      // Counting answers normally; the refusal is applied below, at the worst moment.
      backend.admit = async (...args) => counted(...args);
      const schedule = Reflect.get(coordinator, "schedule") as () => Promise<void>;
      let done = false;
      let refused = false;
      Reflect.set(coordinator, "schedule", async () => {
        // The moment the response is no longer active, before the next turn.
        if (done && !refused && Reflect.get(coordinator, "active") === null) {
          refused = true;
          Reflect.apply(Reflect.get(coordinator, "refuseNextTurn"), coordinator, [
            new RelayError(429, "app_rate_limited", "Request limit exceeded"),
          ]);
        }
        return Reflect.apply(schedule, coordinator, []);
      });
      upstream.addEventListener("message", event => {
        if (frameType(event) !== "response.create") return;
        upstream.send('{"type":"response.created","response":{"id":"r"}}');
        done = true;
        upstream.send(responseDone("r"));
      });
      const order: unknown[] = [];
      socket.addEventListener("message", event => order.push(frameType(event)));
      socket.send('{"type":"response.create"}');
      expect(await next("gateway.error")).toMatchObject({ error: { code: "app_rate_limited" } });
      // The response's last event comes first, then the refusal.
      expect(order.filter(type => type === "response.done" || type === "gateway.error"))
        .toEqual(["response.done", "gateway.error"]);
    });
  });
  it("turns go on while counting is slow, and a late refusal closes the session after them", async () => {
    await withSockets(async ({ socket, upstream, next, coordinator, bootstrap }) => {
      await allowManyResponses(bootstrap.appId);
      const backend = Reflect.get(coordinator, "backend") as SessionBackend;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      backend.admit = async () => {
        await gate;
        throw new RelayError(429, "app_rate_limited", "Request limit exceeded");
      };
      let sent = 0;
      upstream.addEventListener("message", event => {
        if (frameType(event) !== "response.create") return;
        const id = `r-${++sent}`;
        upstream.send(JSON.stringify({ type: "response.created", response: { id } }));
        upstream.send(responseDone(id));
      });
      for (let turn = 0; turn < 3; turn++) {
        socket.send('{"type":"response.create"}');
        await next("response.done");
      }
      // Three turns, none waiting on a count that has not answered.
      expect(sent).toBe(3);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      release();
      expect(await next("gateway.error")).toMatchObject({ error: { code: "app_rate_limited" } });
      expect(sent).toBe(3);
    });
  });
  it("a response is sent at once, while its count is still waiting on the gateway", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const counting = new Promise<void>(resolve => { entered = resolve; });
    const runtimeEnv = {
      ...env,
      USER_LIMITER: {
        getByName: (name: string) => {
          const limiter = env.USER_LIMITER.getByName(name);
          return new Proxy(limiter, {
            get(target, property) {
              if (property === "checkAndIncrement") {
                return async (input: Parameters<typeof limiter.checkAndIncrement>[0]) => {
                  entered();
                  await gate;
                  return target.checkAndIncrement(input);
                };
              }
              return (...args: unknown[]) => Reflect.get(target, property)(...args);
            },
          });
        },
      },
    } as unknown as Env;
    await withSockets(async ({ socket, upstream, bootstrap }) => {
      let sent = 0;
      upstream.addEventListener("message", event => {
        if (JSON.parse(String(event.data)).type === "response.create") sent++;
      });
      socket.send('{"type":"response.create"}');
      await counting;
      await sleep(10);
      // Sent while the limiter has not answered.
      expect(sent).toBe(1);
      // The app hangs up; the response is still recorded, as interrupted.
      socket.close(1000);
      await sleep(10);
      release();
      await sleep(2100);
      expect(await sessionUsageCount(bootstrap.sessionId)).toBe(1);
    }, runtimeEnv);
  });
  it("two hosted sockets and HTTP race for the same final allowance", async () => {
    const runtimeEnv = hostedEnv();
    const http = await setup();
    const providerFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      model: "gpt-realtime",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    let release!: () => void;
    let armed!: () => void;
    let ready = 0;
    let triggers = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const connections = new Promise<void>(resolve => { armed = resolve; });
    const outcomes: JsonObject[] = [];
    try {
      const sockets = [0, 1].map(() => withSockets(async peer => {
        peer.upstream.addEventListener("message", event => {
          if (JSON.parse(String(event.data)).type !== "response.create") return;
          const id = `race-${++triggers}`;
          peer.upstream.send(JSON.stringify({ type: "response.created", response: { id } }));
          peer.upstream.send(responseDone(id));
        });
        if (++ready === 2) armed();
        await gate;
        peer.socket.send('{"type":"response.create"}');
        // Sent at once; a refused count closes the session after the response.
        await peer.next("response.done");
        outcomes.push(await Promise.race([peer.next("gateway.error"), sleep(1_000).then(() => ({ type: "open" }))]));
      }, runtimeEnv));
      await connections;
      const ctx = createExecutionContext();
      release();
      const { appId, providerSlug } = http.bootstrap;
      const response = await gateway.fetch(new Request(
        `https://gateway.test/v1/apps/${appId}/proxy/${providerSlug}/v1/chat/completions`,
        {
          method: "POST",
          headers: { ...Object.fromEntries(http.headers), "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-realtime", messages: [{ role: "user", content: "hello" }] }),
        },
      ), runtimeEnv, ctx);
      await response.text();
      await waitOnExecutionContext(ctx);
      await Promise.all(sockets);
      // One allowance, three takers: exactly one is counted, and the two
      // refused are the HTTP request (429) or a session closed after its turn.
      const refused = outcomes.filter(frame => frame.type === "gateway.error");
      expect([200, 429]).toContain(response.status);
      expect(refused.length + Number(response.status === 429)).toBe(2);
      expect(refused.every(frame => (frame.error as JsonObject).code === "billing_request_quota_exceeded")).toBe(true);
      // Both sockets' responses were sent: a refused count never holds a turn back.
      expect(triggers).toBe(2);
    } finally {
      release();
      providerFetch.mockRestore();
    }
  });
  it("a disconnect while a sent response is being counted still counts it once and records it", async () => {
    let entered!: () => void;
    let release!: () => void;
    let periodId = "";
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const baseEnv = hostedEnv();
    const runtimeEnv = {
      ...baseEnv,
      ORG_QUOTA: new Proxy(baseEnv.ORG_QUOTA, {
        get(target, property) {
          if (property === "getByName") {
            return (name: string) => {
              const quota = target.getByName(name);
              return new Proxy(quota, {
                get(owner, method) {
                  if (method === "admit") {
                    return async (input: Parameters<typeof quota.admit>[0]) => {
                      periodId = input.periodId;
                      const result = await owner.admit(input);
                      entered();
                      await gate;
                      return result;
                    };
                  }
                  return (...args: unknown[]) => Reflect.get(owner, method)(...args);
                },
              });
            };
          }
          return passthrough(target, property);
        },
      }),
    } as unknown as Env;
    await withSockets(async ({ socket, upstream, coordinator, bootstrap }) => {
      let triggers = 0;
      upstream.addEventListener("message", event => {
        if (JSON.parse(String(event.data)).type === "response.create") triggers++;
      });
      socket.send('{"type":"response.create"}');
      await pending;
      const attempt = coordinator.journal.generations()[0]!;
      socket.close(1000);
      await sleep(10);
      release();
      await sleep(2100);
      expect(triggers).toBe(1);
      const quota = runtimeEnv.ORG_QUOTA.getByName(bootstrap.organizationId);
      expect(await quota.usage(periodId)).toBe(1);
      expect((await env.DB
        .prepare("SELECT event_id, completion_status FROM app_usage_event WHERE realtime_session_id = ?")
        .bind(bootstrap.sessionId)
        .all()).results)
        .toEqual([{ event_id: attempt.id, completion_status: "interrupted" }]);
    }, runtimeEnv);
  });
  it("the last allowed hosted generation survives periodic exhaustion checks", async () => {
    const runtimeEnv = hostedEnv();
    await withSockets(async ({ socket, upstream, next, coordinator }) => {
      upstream.addEventListener("message", event => {
        if (JSON.parse(String(event.data)).type === "response.create") {
          upstream.send('{"type":"response.created","response":{"id":"last"}}');
        }
      });
      socket.send('{"type":"response.create"}');
      await next("response.created");
      Reflect.set(coordinator, "nextMaintenance", Date.now() - 1);
      await coordinator.alarm();
      const maintenance = Reflect.get(coordinator, "maintenance") as Promise<void> | null;
      if (maintenance) await maintenance;
      expect(socket.readyState).toBe(WebSocket.OPEN);
      upstream.send(responseDone("last"));
      await next("response.done");
    }, runtimeEnv);
  });
  it("periodic maintenance detects blocked users and changing auth policy without new turns", async () => {
    await withSockets(async ({ coordinator, next, bootstrap }) => {
      await env.DB
        .prepare("INSERT INTO app_user (app_id, id, status) VALUES (?, 'u', 'blocked')")
        .bind(bootstrap.appId)
        .run();
      clearIsolateCaches();
      Reflect.set(coordinator, "nextMaintenance", Date.now() - 1);
      await coordinator.alarm();
      expect(await next("gateway.error")).toMatchObject({ error: { code: "auth_required" } });
    }, env, "header");
    await withSockets(async ({ coordinator, next, bootstrap }) => {
      const application = await loadApp(env, bootstrap.appId);
      application.config.authentication = { type: "api_key", end_user: { source: "none" } };
      await saveAppConfig(bootstrap.appId, application.config);
      Reflect.set(coordinator, "nextMaintenance", Date.now() - 1);
      await coordinator.alarm();
      expect(await next("gateway.error")).toMatchObject({ error: { code: "auth_required" } });
    }, env, "header");
  });
  it("a transient maintenance failure retries while the leases hold, and a policy refusal still closes", async () => {
    await withSockets(async ({ coordinator, socket, next }) => {
      const backend = Reflect.get(coordinator, "backend") as SessionBackend;
      const maintain = backend.maintain;
      let failures = 1;
      backend.maintain = async (...args) => {
        if (failures-- > 0) throw new Error("D1 unavailable");
        return maintain(...args);
      };
      const leaseBefore = Reflect.get(coordinator, "leaseExpiry") as number;
      await sleep(5);
      Reflect.set(coordinator, "nextMaintenance", Date.now() - 1);
      await coordinator.alarm();
      await Reflect.get(coordinator, "maintenance");
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(Reflect.get(coordinator, "nextMaintenance")).toBeLessThanOrEqual(Date.now() + 5_000);
      // The gateway check failed, but the leases were still renewed.
      expect(Reflect.get(coordinator, "leaseExpiry")).toBeGreaterThan(leaseBefore);
      backend.maintain = async () => {
        throw new RelayError(429, "app_budget_exhausted", "Exhausted");
      };
      Reflect.set(coordinator, "nextMaintenance", Date.now() - 1);
      await coordinator.alarm();
      expect(await next("gateway.error")).toMatchObject({ error: { code: "app_budget_exhausted" } });
    });
  });
  it("a limiter that cannot answer keeps the session open, holding its leases locally", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withSockets(async ({ coordinator, socket }) => {
      const backend = Reflect.get(coordinator, "backend") as SessionBackend;
      const capacity = backend.capacity;
      backend.capacity = async (b, scope, operation, cap) => {
        if (operation === "renew") throw new RelayError(503, "provider_unavailable", "Realtime backend unavailable");
        return capacity(b, scope, operation, cap);
      };
      // The leases are about to lapse when the limiter stops answering.
      Reflect.set(coordinator, "leaseExpiry", Date.now() + 20_000);
      Reflect.set(coordinator, "nextMaintenance", Date.now() - 1);
      await coordinator.alarm();
      await Reflect.get(coordinator, "maintenance");
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(Reflect.get(coordinator, "leaseExpiry")).toBeGreaterThan(Date.now() + 60_000);
    });
    vi.restoreAllMocks();
  });
  it("an idle session closes as a protocol timeout, and an expired one as a finished session", async () => {
    await withSockets(async ({ coordinator, socket, next }) => {
      const closed = closeCode(socket);
      Reflect.set(coordinator, "lastActivity", Date.now() - 3_600_000);
      await coordinator.alarm();
      expect(await next("gateway.error")).toMatchObject({ error: { code: "realtime_protocol_error" } });
      expect(await closed).toBe(1008);
    });
    await withSockets(async ({ coordinator, socket, next }) => {
      const closed = closeCode(socket);
      Reflect.set(coordinator, "expiresAt", Date.now() - 1);
      await coordinator.alarm();
      expect(await next("gateway.error")).toMatchObject({ error: { code: "auth_required" } });
      expect(await closed).toBe(1000);
    });
  });
  it("input faster than real time closes the session, whether or not it is speech", async () => {
    await withSockets(async ({ socket, next }) => {
      const closed = closeCode(socket);
      const chunk = JSON.stringify({ type: "input_audio_buffer.append", audio: "A".repeat(200_000) });
      for (let sent = 0; sent < 6; sent++) socket.send(chunk);
      expect(await next("gateway.error")).toMatchObject({
        error: {
          code: "realtime_protocol_error",
          message: "Realtime input is arriving faster than real time",
        },
      });
      expect(await closed).toBe(1008);
    });
  });
  it("a second utterance committed while a turn is pending joins it instead of closing the session", async () => {
    await withSockets(async ({ coordinator, socket }) => {
      const effect = Reflect.get(coordinator, "effect") as (...args: unknown[]) => Promise<void>;
      const trigger = { type: "response.create", response: { max_output_tokens: 4096 } };
      await effect.call(
        coordinator,
        { kind: "pendingAuto", frame: trigger, correlation: "first" },
        "server",
        0,
      );
      await effect.call(
        coordinator,
        { kind: "pendingAuto", frame: trigger, correlation: "second" },
        "server",
        0,
      );
      expect(Reflect.get(coordinator, "pendingAuto")).toMatchObject({ correlation: "second" });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    });
  });
  it("audio frames do not scan the journal or rewrite unchanged live alarms", async () => {
    await withSockets(async ({ socket, upstream, coordinator, state }) => {
      let forwarded = 0;
      let complete!: () => void;
      const done = new Promise<void>(resolve => { complete = resolve; });
      upstream.addEventListener("message", event => {
        const type = JSON.parse(String(event.data)).type;
        if (type === "input_audio_buffer.append" && ++forwarded === 100) complete();
      });
      const scans = vi.spyOn(coordinator.journal, "generations");
      const alarm = vi.spyOn(state.storage, "setAlarm");
      for (let index = 0; index < 100; index++) {
        socket.send('{"type":"input_audio_buffer.append","audio":"AAAA"}');
      }
      await done;
      expect(scans).not.toHaveBeenCalled();
      expect(alarm).not.toHaveBeenCalled();
      scans.mockRestore();
      alarm.mockRestore();
    });
  });
  it("acknowledged realtime usage marks API keys used", async () => {
    await withSockets(async ({ socket, upstream, next, bootstrap }) => {
      upstream.addEventListener("message", event => {
        if (JSON.parse(String(event.data)).type !== "response.create") return;
        upstream.send('{"type":"response.created","response":{"id":"r"}}');
        upstream.send(responseDone("r"));
      });
      socket.send('{"type":"response.create"}');
      await next("response.done");
      await sleep(30);
      expect((await env.DB
        .prepare("SELECT last_used_at FROM app_api_key WHERE id = ?")
        .bind(bootstrap.identity.apiKeyId)
        .first())?.last_used_at).toBeTruthy();
    });
  });
  it("a send failure after unmetered admission records one interrupted attempt without replay", async () => {
    await withSockets(async ({ socket, upstream, next, coordinator, bootstrap }) => {
      let triggers = 0;
      upstream.addEventListener("message", event => {
        if (JSON.parse(String(event.data)).type === "response.create") triggers++;
      });
      const providerSocket = Reflect.get(coordinator, "upstream") as WebSocket;
      const original = providerSocket.send;
      const spy = vi.spyOn(providerSocket, "send").mockImplementation(data => {
        if (typeof data === "string" && JSON.parse(data).type === "response.create") {
          throw new Error("Ambiguous socket send failure");
        }
        return original.call(providerSocket, data);
      });
      socket.send('{"type":"response.create"}');
      await next("gateway.error");
      await sleep(2100);
      spy.mockRestore();
      expect(triggers).toBe(0);
      const rows = await env.DB
        .prepare(
          "SELECT completion_status, cost_source FROM app_usage_event WHERE realtime_session_id = ?",
        )
        .bind(bootstrap.sessionId)
        .all();
      expect(rows.results).toEqual([{ completion_status: "interrupted", cost_source: "unresolved" }]);
      expect(await env.USER_LIMITER.getByName(bootstrap.appId).getStatus(Date.now()))
        .toEqual({ requestsToday: 1 });
    });
  });
  it("missing usage is recorded unresolved and the conversation goes on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withSockets(async ({ socket, upstream, next, coordinator }) => {
      await allowManyResponses(coordinator.bootstrap.appId);
      let turn = 0;
      upstream.addEventListener("message", event => {
        if (frameType(event) !== "response.create") return;
        const id = `r-${++turn}`;
        upstream.send(JSON.stringify({ type: "response.created", response: { id } }));
        upstream.send(turn === 1
          ? JSON.stringify({ type: "response.done", response: { id, status: "completed" } })
          : responseDone(id));
      });
      socket.send('{"type":"response.create"}');
      await next("response.done");
      socket.send('{"type":"response.create"}');
      await next("response.done");
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(await usageRecorded(coordinator.bootstrap.sessionId, 2)).toBe(2);
      expect((await env.DB
        .prepare("SELECT cost_source FROM app_usage_event WHERE realtime_session_id = ? ORDER BY created_at")
        .bind(coordinator.bootstrap.sessionId)
        .all()).results.map(row => row.cost_source).sort()).toEqual(["computed", "unresolved"]);
    });
    vi.restoreAllMocks();
  });
  it("usage the gateway cannot record stays in the journal and the conversation goes on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withSockets(async ({ socket, upstream, next, coordinator, state }) => {
      await allowManyResponses(coordinator.bootstrap.appId);
      const backend = Reflect.get(coordinator, "backend") as SessionBackend;
      const settle = backend.settle;
      let down = true;
      backend.settle = async (...args) => {
        if (down) throw new RelayError(503, "provider_unavailable", "Realtime backend unavailable");
        return settle(...args);
      };
      let turn = 0;
      upstream.addEventListener("message", event => {
        if (frameType(event) !== "response.create") return;
        const id = `r-${++turn}`;
        upstream.send(JSON.stringify({ type: "response.created", response: { id } }));
        upstream.send(responseDone(id));
      });
      socket.send('{"type":"response.create"}');
      await next("response.done");
      socket.send('{"type":"response.create"}');
      await next("response.done");
      expect(socket.readyState).toBe(WebSocket.OPEN);
      await sleep(20);
      expect(coordinator.journal.outbox().length).toBeGreaterThan(0);
      // Once the gateway answers again, the journal delivers what it kept.
      down = false;
      for (const item of coordinator.journal.outbox()) {
        item.due = 0;
        state.storage.sql.exec(
          "UPDATE usage_outbox SET json = ? WHERE id = ?",
          JSON.stringify(item),
          item.id,
        );
      }
      await Reflect.apply(Reflect.get(coordinator, "flush"), coordinator, []);
      expect(coordinator.journal.outbox()).toHaveLength(0);
      expect(await sessionUsageCount(coordinator.bootstrap.sessionId)).toBe(2);
    });
    vi.restoreAllMocks();
  });
  it("a lost D1 insert acknowledgement replays exactly one row and spend delta", async () => {
    const { bootstrap } = await setup();
    const g = generation(bootstrap);
    g.usage = usage;
    const event = settledEvent(bootstrap, settlementOf(g, "completed", false));
    let lost = false;
    const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrapStatement(target.bind(...args));
        if (property === "run") {
          return async () => {
            const result = await target.run();
            if (!lost) {
              lost = true;
              throw new Error("Lost committed insert acknowledgement");
            }
            return result;
          };
        }
        return passthrough(target, property);
      },
    });
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => /insert into ["`]?app_usage_event/iu.test(sql)
            ? wrapStatement(target.prepare(sql))
            : target.prepare(sql);
        }
        return passthrough(target, property);
      },
    });
    expect(await persistUsageEventAcknowledged({ ...env, DB: db }, event)).toBe("stored");
    expect(lost).toBe(true);
    expect((await env.DB
      .prepare("SELECT COUNT(*) AS n FROM app_usage_event WHERE event_id = ?")
      .bind(event.eventId)
      .first())?.n).toBe(1);
    expect((await env.DB
      .prepare("SELECT microusd FROM app_usage_spend WHERE app_id = ? AND scope = 'app'")
      .bind(bootstrap.appId)
      .first())?.microusd).toBe(20);
  });
  it("ancillary key-write failure leaves usage acknowledged and does not retain the outbox", async () => {
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (/update ["`]?app_api_key/iu.test(sql)) throw new Error("Simulated key metadata outage");
            return target.prepare(sql);
          };
        }
        return passthrough(target, property);
      },
    });
    await withSockets(async ({ socket, upstream, next, coordinator, bootstrap }) => {
      upstream.addEventListener("message", event => {
        if (JSON.parse(String(event.data)).type !== "response.create") return;
        upstream.send('{"type":"response.created","response":{"id":"r"}}');
        upstream.send(responseDone("r"));
      });
      socket.send('{"type":"response.create"}');
      await next("response.done");
      await sleep(100);
      expect(coordinator.journal.outbox()).toHaveLength(0);
      expect(await sessionUsageCount(bootstrap.sessionId)).toBe(1);
    }, { ...env, DB: db });
  });
  it("a D1 outage keeps usage in the outbox, the conversation goes on, and replay writes each row once", async () => {
    let failInsert = true;
    const db = new Proxy(env.DB, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "prepare") {
          return (sql: string) => {
            if (failInsert && /insert into ["`]?app_usage_event/iu.test(sql)) {
              throw new Error("Simulated usage outage");
            }
            return target.prepare(sql);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtimeEnv = { ...env, DB: db } as Env;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withSockets(async ({ socket, upstream, next, coordinator, state, bootstrap }) => {
      await allowManyResponses(bootstrap.appId);
      let sent = 0;
      upstream.addEventListener("message", event => {
        if (frameType(event) !== "response.create") return;
        const id = `r-${++sent}`;
        upstream.send(JSON.stringify({ type: "response.created", response: { id } }));
        upstream.send(responseDone(id));
      });
      socket.send('{"type":"response.create"}');
      await next("response.done");
      socket.send('{"type":"response.create"}');
      await next("response.done");
      expect(sent).toBe(2);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      await sleep(50);
      expect(coordinator.journal.outbox()).toHaveLength(2);
      failInsert = false;
      for (const item of coordinator.journal.outbox()) {
        item.due = Date.now();
        state.storage.sql.exec("UPDATE usage_outbox SET json = ? WHERE id = ?", JSON.stringify(item), item.id);
      }
      await Reflect.apply(Reflect.get(coordinator, "flush"), coordinator, []);
      await Reflect.apply(Reflect.get(coordinator, "flush"), coordinator, []);
      expect(coordinator.journal.outbox()).toHaveLength(0);
      expect(await sessionUsageCount(bootstrap.sessionId)).toBe(2);
    }, runtimeEnv);
    vi.restoreAllMocks();
  });
  it("after a restart every sent response is settled once, as interrupted, on its own horizon", async () => {
    const { bootstrap, headers } = await setup();
    const stub = newSessionStub();
    await runInDurableObject(stub, async (_instance, state) => {
      const journal = new SessionJournal(state.storage);
      journal.open(bootstrap);
      const sent = generation(bootstrap, "dispatching");
      sent.at = Date.now() - 3 * 86_400_000;
      journal.save(sent);
      journal.save(generation(bootstrap, "active"));
      const coordinator = coordinatorFor(env, state, bootstrap, headers);
      await coordinator.recover();
      expect(journal.generations().every(g => g.stage === "settled")).toBe(true);
      expect(journal.outbox().map(item => item.settlement))
        .toMatchObject([{ status: "interrupted", aborted: true }, { status: "interrupted", aborted: true }]);
      // Delivery keeps the response's own horizon rather than starting a new one.
      expect(journal.outbox().find(item => item.id === sent.id)?.createdAt).toBe(sent.at);
      expect(settledEvent(bootstrap, journal.outbox()[0]!.settlement).row)
        .toMatchObject({ costSource: "unresolved", completionStatus: "interrupted" });
      await coordinator.recover();
      expect(journal.outbox()).toHaveLength(2);
    });
  });
  it("cancelled/incomplete attempts retain observed usage and original admission month", async () => {
    const { bootstrap } = await setup();
    const g = generation(bootstrap);
    // Dated when the response was sent, so it counts in that month.
    g.at = Date.parse("2026-09-30T23:59:59Z");
    g.usage = usage;
    expect(settledEvent(bootstrap, settlementOf(g, "cancelled", true)).row).toMatchObject({
      createdAt: "2026-09-30T23:59:59.000Z",
      completionStatus: "cancelled",
      costSource: "computed",
      costUsd: .00002,
    });
  });
  it("serial mailbox preserves ordering across awaits and bounds the current frame too", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let overflow = 0;
    const order: number[] = [];
    const mailbox = new Mailbox(() => overflow++, () => {
      throw new Error("Unexpected mailbox failure");
    });
    const first = mailbox.push(900_000, async () => {
      order.push(1);
      await gate;
      order.push(2);
    });
    mailbox.push(200_000, async () => { order.push(9); });
    const second = mailbox.push(1, async () => { order.push(3); });
    release();
    await Promise.all([first, second]);
    expect(overflow).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });
  it("shutdown waits for a full mailbox without consuming a frame queue slot", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let overflow = 0;
    const order: number[] = [];
    const mailbox = new Mailbox(() => overflow++, () => {
      throw new Error("Unexpected mailbox failure");
    });
    const drain = mailbox.push(1, async () => {
      await gate;
      order.push(1);
    });
    for (let index = 0; index < 256; index++) mailbox.push(1, async () => {});
    const cleanup = mailbox.afterDrain(async () => { order.push(2); });
    expect(overflow).toBe(0);
    release();
    await Promise.all([drain, cleanup]);
    expect(order).toEqual([1, 2]);
  });
  it("dormant Gemini adapter admits explicit activity before audio and rejects autonomous modes", () => {
    const adapter = new GeminiAdapter("candidate", 1024);
    const frame = {
      setup: {
        model: "models/candidate",
        generationConfig: { responseModalities: ["AUDIO"] },
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
    };
    expect(adapter.client(frame, { ...manual, ready: false })[0]).toMatchObject({
      kind: "configure",
      frame: { setup: { generationConfig: { maxOutputTokens: 1024 } } },
    });
    expect(() => adapter.client(
      { realtimeInput: { audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } } },
      manual,
    )).toThrow();
    expect(adapter.client({ realtimeInput: { activityStart: {} } }, manual)[0]?.kind).toBe("generate");
    expect(adapter.client(
      { realtimeInput: { audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } } },
      { ...manual, active: true },
    )[0]?.kind).toBe("forward");
    expect(() => new GeminiAdapter("candidate", 1024).client(
      { setup: { ...frame.setup, tools: [] } },
      manual,
    )).toThrow();
  });
});

describe("realtime counting", () => {
  it("counting the same response twice counts it once", async () => {
    // The hosted plan allows one request a month.
    const runtimeEnv = hostedEnv();
    const { bootstrap, headers } = await setup();
    const application = await loadApp(runtimeEnv, bootstrap.appId);
    application.config.limits.per_app.requests.per_day = null;
    await saveAppConfig(bootstrap.appId, application.config);
    const backend = localSessionBackend(runtimeEnv, () => {});
    const grant = await backend.grant(bootstrap, headers, null);
    const id = crypto.randomUUID();
    const at = Date.now();
    await backend.admit(bootstrap, headers, grant, id, at);
    // A repeat, as a retry after a lost reply sends: answered, not counted again.
    await backend.admit(bootstrap, headers, grant, id, at);
    // Another response finds the one request spent.
    await expect(backend.admit(bootstrap, headers, grant, crypto.randomUUID(), Date.now()))
      .rejects.toMatchObject({ code: "billing_request_quota_exceeded" });
  });
  it("an HTTP stream completes and settles once while realtime routing is promoted twice", async () => {
    const runtimeEnv = hostedEnv();
    const { bootstrap, headers } = await setup();
    let finish!: () => void;
    const first = 'event: response.output_text.delta\ndata: {"delta":"hello"}\n\n';
    const terminal = "event: response.completed\n"
      + 'data: {"response":{"model":"gpt-realtime","usage":{"input_tokens":2,"output_tokens":1}}}\n\n';
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(first));
          finish = () => {
            controller.enqueue(new TextEncoder().encode(terminal));
            controller.close();
          };
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ));
    try {
      const ctx = createExecutionContext();
      const response = await gateway.fetch(new Request(
        `https://gateway.test/v1/apps/${bootstrap.appId}/proxy/${bootstrap.providerSlug}/v1/responses`,
        {
          method: "POST",
          headers: { ...Object.fromEntries(headers), "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-realtime", input: "hello", stream: true }),
        },
      ), runtimeEnv, ctx);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(first);
      for (let i = 0; i < 2; i++) {
        const id = crypto.randomUUID();
        await env.DB
          .prepare(
            "INSERT INTO realtime_release(id,worker_name,url,backend_contract,created_at) VALUES(?,?,?,1,?)",
          )
          .bind(id, id, "wss://release.test", Date.now())
          .run();
        await env.DB
          .prepare("UPDATE gateway_release_state SET active_realtime_id=?,promotion_at=? WHERE singleton=1")
          .bind(id, Date.now())
          .run();
      }
      finish();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(terminal);
      expect((await reader.read()).done).toBe(true);
      await waitOnExecutionContext(ctx);
      expect((await env.DB
        .prepare("SELECT COUNT(*) AS n FROM app_usage_event WHERE app_id=?")
        .bind(bootstrap.appId)
        .first())?.n).toBe(1);
    } finally {
      provider.mockRestore();
    }
  });
});

describe("realtime sessions during a billing outage", () => {
  it("stay open when billing cannot be read or the allowance counter is down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { bootstrap, headers } = await setup();
    const application = await loadApp(env, bootstrap.appId);
    application.config.limits.per_app.requests.per_day = null;
    await saveAppConfig(bootstrap.appId, application.config);
    const grant = await localSessionBackend(env, () => {}).grant(bootstrap, headers, null);
    const billingDown = {
      ...hostedEnv(),
      BILLING: { getTenantAccess: async () => { throw new Error("billing service unreachable"); } },
    } as unknown as Env;
    await expect(localSessionBackend(billingDown, () => {}).maintain(bootstrap, headers, grant, false))
      .resolves.toMatchObject({ model: "gpt-realtime" });
    const counterDown = hostedEnv();
    counterDown.ORG_QUOTA = new Proxy(counterDown.ORG_QUOTA, {
      get(target, property) {
        if (property === "getByName") {
          return () => ({ usage: async () => { throw new Error("counter unreachable"); } });
        }
        return passthrough(target, property);
      },
    });
    await expect(localSessionBackend(counterDown, () => {}).maintain(bootstrap, headers, grant, false))
      .resolves.toMatchObject({ model: "gpt-realtime" });
    vi.restoreAllMocks();
  });
});
