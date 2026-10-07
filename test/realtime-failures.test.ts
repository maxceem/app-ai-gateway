import { env } from 'cloudflare:workers';
import { runInDurableObject, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import gateway from '../src/index';
import { database } from '../src/db';
import { app as appTable } from '../src/db/schema';
import { SessionCoordinator, settledEvent } from '../src/realtime/session';
import { SessionJournal } from '../src/realtime/journal';
import { GeminiAdapter } from '../src/realtime/protocols/gemini';
import { Mailbox } from '../src/realtime/transport';
import { GatewayError } from '../src/core/errors';
import { loadApp } from '../src/core/app-records';
import { authenticateRequest } from '../src/client-auth/client-auth';
import { requireProvider } from '../src/providers/provider-store';
import { buildUsageEvent, persistUsageEventAcknowledged } from '../src/usage/usage-record';
import type { Bootstrap, Generation, JsonObject } from '../src/realtime/types';
import { clearIsolateCaches, seedProvider, seedServerApp, testAttribution, TEST_ORGANIZATION_ID } from './helpers';

const usage = { input_tokens: 1, output_tokens: 1, input_token_details: { audio_tokens: 0, text_tokens: 1, cached_tokens: 0 }, output_token_details: { audio_tokens: 0, text_tokens: 1 } };
const ack = { type: 'session.updated', session: { model: 'gpt-realtime', max_output_tokens: 4096, audio: { input: { turn_detection: null, transcription: null } } } };
const manual = { ready: true, configuring: false, active: false, responseId: null };
async function setup(endUser: "none" | "header" = "none") {
  clearIsolateCaches(); const appId = crypto.randomUUID(); const key = await seedServerApp(appId, { endUser });
  await seedProvider({ type: 'openai', id: appId, slug: appId });
  const app = await loadApp(env, appId); app.config.realtime.enabled = true; app.config.routing.providers = { mode: 'all' };
  app.config.limits.per_app.requests.per_day = 1;
  await database(env.DB).update(appTable).set({ config: app.config }).where(eq(appTable.id, appId)); clearIsolateCaches();
  const headers = new Headers({ Authorization: `Bearer ${key}`, ...(endUser === "header" ? { "x-end-user-id": "u" } : {}) });
  const identity = (await authenticateRequest({ env, app: await loadApp(env, appId), headers })).identity;
  const provider = await requireProvider(env, TEST_ORGANIZATION_ID, appId);
  const bootstrap: Bootstrap = { sessionId: crypto.randomUUID(), appId, organizationId: TEST_ORGANIZATION_ID, providerId: provider.id,
    providerSlug: appId, model: 'gpt-realtime', requestedModel: 'gpt-realtime', protocol: 'openai_realtime', identity, appVersion: null, origin: 'https://gateway.test' };
  return { bootstrap, headers };
}
function hostedEnv(): Env {
  const scope = crypto.randomUUID();
  return { ...env, BILLING: { getTenantAccess: async () => ({ plan: { planKey: 'free', planName: 'Free', isDefault: true, limits: { maxRequestsPerMonth: 1 } }, subscription: null }) },
    ORG_QUOTA: new Proxy(env.ORG_QUOTA, { get(target, property) {
      if (property === 'getByName') return (name: string) => target.getByName(`${scope}:${name}`);
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } }),
  } as unknown as Env;
}
function generation(bootstrap: Bootstrap, stage: Generation['stage'] = 'admitted'): Generation {
  const id = crypto.randomUUID(); const at = Date.now();
  return { id, at, ordinal: 1, stage, observation: null, responseId: null, outputBytes: 0, price: { input: 4, output: 16, audio_input: 32, audio_output: 64, cached_input: .4, cached_audio_input: .4 },
    event: buildUsageEvent({ organizationId: bootstrap.organizationId, identity: bootstrap.identity, attribution: testAttribution({ model: 'gpt-realtime', apiStyle: 'other' }),
      appVersion: null, status: 'ok', latencyMs: 0, contentType: 'application/json', observed: null, eventId: id, createdAt: new Date(at).toISOString(),
      realtime: { sessionId: bootstrap.sessionId, generationId: id, protocol: 'openai_realtime', providerResponseId: null, completionStatus: 'interrupted' } }) };
}
function frames(socket: WebSocket) {
  const saved: JsonObject[] = []; const waiting = new Map<string, (frame: JsonObject) => void>();
  socket.addEventListener('message', event => { const frame = JSON.parse(String(event.data)) as JsonObject; const callback = waiting.get(String(frame.type));
    if (callback) { waiting.delete(String(frame.type)); callback(frame); } else saved.push(frame); });
  return (type: string): Promise<JsonObject> => {
    const index = saved.findIndex(frame => frame.type === type); if (index >= 0) return Promise.resolve(saved.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Missing ${type}`)), 4000); waiting.set(type, frame => { clearTimeout(timer); resolve(frame); }); });
  };
}
async function withSockets(run: (input: { coordinator: SessionCoordinator; socket: WebSocket; upstream: WebSocket; next: ReturnType<typeof frames>; state: DurableObjectState; bootstrap: Bootstrap }) => Promise<void>, runtimeEnv: Env = env, endUser: "none" | "header" = "none") {
  const { bootstrap, headers } = await setup(endUser); const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
  await runInDurableObject(stub, async (instance, state) => {
    const pair = new WebSocketPair(); pair[0].accept({ allowHalfOpen: true });
    pair[0].addEventListener('message', event => { const frame = JSON.parse(String(event.data)) as JsonObject; if (frame.type === 'session.update') pair[0].send(JSON.stringify(ack)); });
    const coordinator = new SessionCoordinator(runtimeEnv, state, bootstrap, headers);
    Reflect.set(instance, "coordinator", coordinator);
    const response = await coordinator.start(pair[1]); const socket = response.webSocket!; const next = frames(socket); socket.accept({ allowHalfOpen: true });
    await next('session.updated');
    try { await run({ coordinator, socket, next, upstream: pair[0], state, bootstrap }); }
    finally { coordinator.terminate(null, 1000); socket.close(1000); pair[0].close(1000); await new Promise(resolve => setTimeout(resolve, 30)); }
  });
}

describe('realtime failure boundaries', () => {
  it.each(['user', 'app'] as const)('setup alarm waits for a delayed %s acquire before releasing capacity and deleting the journal', async scope => {
    const { bootstrap, headers } = await setup(); const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
    let entered!: () => void; let release!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    let userAcquires = 0; let appAcquires = 0; let releases = 0;
    const runtimeEnv = { ...env, USER_LIMITER: { getByName: (name: string) => {
      const limiter = env.USER_LIMITER.getByName(name); const app = name === bootstrap.appId;
      return new Proxy(limiter, { get(target, property) {
        if (property === 'acquireSession') return async (sessionId: string, cap: number) => {
          if (app) appAcquires++; else userAcquires++;
          if (app === (scope === 'app')) { entered(); await gate; }
          // The lease is actually committed AFTER shutdown starts.
          return target.acquireSession(sessionId, cap);
        };
        if (property === 'releaseSession') return async (sessionId: string) => { releases++; return target.releaseSession(sessionId); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } } } as unknown as Env;
    await runInDurableObject(stub, async (instance, state) => {
      const pair = new WebSocketPair(); pair[0].accept({ allowHalfOpen: true }); let dispatches = 0;
      pair[0].addEventListener('message', () => { dispatches++; });
      const coordinator = new SessionCoordinator(runtimeEnv, state, bootstrap, headers); Reflect.set(instance, 'coordinator', coordinator);
      const start = coordinator.start(pair[1]).then(() => null, error => error as unknown);
      await pending;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001);
      try {
        const alarm = coordinator.alarm();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(releases).toBe(0); expect(coordinator.journal.metadata()?.sessionId).toBe(bootstrap.sessionId);
        release(); expect(await start).toMatchObject({ code: 'provider_error' }); await alarm;
        expect(userAcquires).toBe(1); expect(appAcquires).toBe(scope === 'app' ? 1 : 0);
        expect(dispatches).toBe(0); expect(releases).toBe(2); expect(await state.storage.getAlarm()).toBeNull();
      } finally { release(); clock.mockRestore(); pair[0].close(1000); }
      for (const name of [bootstrap.appId, `${bootstrap.appId}:realtime:key:${bootstrap.identity.apiKeyId}`]) {
        const limiter = env.USER_LIMITER.getByName(name);
        expect((await limiter.acquireSession('replacement', 1)).allowed).toBe(true); await limiter.releaseSession('replacement');
      }
    });
  });
  it('setup alarm closes a provider upgrade that resolves after shutdown starts', async () => {
    const { bootstrap, headers } = await setup(); const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
    let entered!: () => void; let release!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    await runInDurableObject(stub, async (instance, state) => {
      const pair = new WebSocketPair(); pair[0].accept({ allowHalfOpen: true }); let dispatches = 0;
      pair[0].addEventListener('message', () => { dispatches++; });
      const providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        entered(); await gate; return new Response(null, { status: 101, webSocket: pair[1] });
      });
      const coordinator = new SessionCoordinator(env, state, bootstrap, headers); Reflect.set(instance, 'coordinator', coordinator);
      const start = coordinator.start().then(() => null, error => error as unknown);
      await pending;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001);
      try {
        const alarm = coordinator.alarm(); release(); expect(await start).toMatchObject({ code: 'provider_error' }); await alarm;
        expect(pair[1].readyState).not.toBe(WebSocket.OPEN); expect(dispatches).toBe(0);
        expect(await state.storage.getAlarm()).toBeNull();
      } finally { release(); clock.mockRestore(); providerFetch.mockRestore(); pair[0].close(1000); }
    });
  });
  it('failed lease cleanup schedules its durable expiry and eventually stops without more RPCs', async () => {
    const { bootstrap, headers } = await setup(); const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
    let releases = 0;
    const runtimeEnv = { ...env, USER_LIMITER: { getByName: () => ({ releaseSession: async () => { releases++; throw new Error('Limiter permanently unavailable'); } }) } } as unknown as Env;
    await runInDurableObject(stub, async (_instance, state) => {
      const journal = new SessionJournal(state.storage); journal.open(bootstrap);
      const expiry = Date.now() + 60_000;
      for (const name of ['release:user', 'release:app'] as const) journal.saveTask(name, { attempts: 12, due: Date.now() + 3_600_000, complete: false, expiresAt: expiry });
      await new SessionCoordinator(runtimeEnv, state, bootstrap, headers).alarm();
      expect(releases).toBe(0); expect(await state.storage.getAlarm()).toBe(expiry);
      // A new coordinator retains the earlier expiry, not another seven days.
      await new SessionCoordinator(runtimeEnv, state, bootstrap, headers).alarm();
      expect(releases).toBe(0); expect(await state.storage.getAlarm()).toBe(expiry);
      for (const name of ['release:user', 'release:app'] as const) {
        const task = journal.task(name); task.expiresAt = Date.now() - 1; journal.saveTask(name, task);
      }
      await new SessionCoordinator(runtimeEnv, state, bootstrap, headers).alarm();
      expect(releases).toBe(0); expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('session_metadata', 'generations', 'recovery_tasks')").toArray()).toEqual([]);
    });
  });
  it.each(['error', 'cancellation'] as const)('%s send failure cannot interrupt shutdown or lose counted usage', async failure => {
    await withSockets(async ({ socket, upstream, next, coordinator, bootstrap }) => {
      upstream.addEventListener('message', event => {
        if (JSON.parse(String(event.data)).type === 'response.create') upstream.send('{"type":"response.created","response":{"id":"shutdown"}}');
      });
      socket.send('{"type":"response.create"}'); await next('response.created');
      const target = Reflect.get(coordinator, failure === 'error' ? 'client' : 'upstream') as WebSocket;
      const original = target.send;
      const spy = vi.spyOn(target, 'send').mockImplementation(data => {
        if (typeof data === 'string' && JSON.parse(data).type === (failure === 'error' ? 'gateway.error' : 'response.cancel')) throw new Error('Transport send failed');
        return original.call(target, data);
      });
      try {
        expect(() => coordinator.terminate(new GatewayError(502, 'provider_error', 'Realtime transport failed'), 1011)).not.toThrow();
        await new Promise(resolve => setTimeout(resolve, 2100));
        expect((Reflect.get(coordinator, 'upstream') as WebSocket).readyState).not.toBe(WebSocket.OPEN);
        const rows = await env.DB.prepare('SELECT completion_status, cost_source FROM app_usage_event WHERE realtime_session_id = ?').bind(bootstrap.sessionId).all();
        expect(rows.results).toEqual([{ completion_status: 'interrupted', cost_source: 'unresolved' }]);
        for (const name of [bootstrap.appId, `${bootstrap.appId}:realtime:key:${bootstrap.identity.apiKeyId}`]) {
          const limiter = env.USER_LIMITER.getByName(name);
          expect((await limiter.acquireSession('replacement', 1)).allowed).toBe(true);
          await limiter.releaseSession('replacement');
        }
      } finally { spy.mockRestore(); }
    });
  });
  it('identified audio does not exhaust lifetime IDs or evict generation-trigger protection', async () => {
    await withSockets(async ({ socket, upstream, next, coordinator, bootstrap }) => {
      let audio = 0; let triggers = 0; let target = 0; let batchDone: (() => void) | null = null;
      upstream.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as JsonObject;
        if (frame.type === 'response.create') {
          triggers++;
          upstream.send('{"type":"response.created","response":{"id":"identified"}}');
          upstream.send(JSON.stringify({ type: 'response.done', response: { id: 'identified', status: 'completed', usage } }));
        }
        if (frame.type === 'input_audio_buffer.append' && ++audio === target) batchDone?.();
      });
      const trigger = JSON.stringify({ type: 'response.create', event_id: 'original-trigger' });
      socket.send(trigger); await next('response.done');
      for (let offset = 0; offset < 5000; offset += 25) {
        target = offset + 25;
        const done = new Promise<void>(resolve => { batchDone = resolve; });
        for (let index = offset; index < target; index++) socket.send(JSON.stringify({ type: 'input_audio_buffer.append', event_id: `audio-${index}`, audio: 'AAAA' }));
        await done;
      }
      socket.send(trigger); // Still suppressed after more than 4096 intervening IDs.
      socket.send(JSON.stringify({ type: 'input_audio_buffer.append', event_id: 'audio-4999', audio: 'AAAA' })); // Recent duplicate also suppressed.
      target = 5001;
      const barrier = new Promise<void>(resolve => { batchDone = resolve; });
      socket.send(JSON.stringify({ type: 'input_audio_buffer.append', event_id: 'barrier', audio: 'AAAA' })); await barrier;
      expect(socket.readyState).toBe(WebSocket.OPEN); expect(triggers).toBe(1); expect(audio).toBe(5001);
      expect((Reflect.get(coordinator, 'recentIds') as Map<string, string>).size).toBe(4096);
      socket.send(JSON.stringify({ type: 'response.create', event_id: 'original-trigger', response: { instructions: 'changed' } }));
      expect(await next('gateway.error')).toMatchObject({ error: { code: 'realtime_protocol_error' } });
      expect(triggers).toBe(1);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_usage_event WHERE realtime_session_id = ?').bind(bootstrap.sessionId).first())?.n).toBe(1);
    });
  });
  it('closed sessions honor usage backoff and persist completed releases across reconstruction', async () => {
    const { bootstrap, headers } = await setup(); const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
    const releases = new Map<string, number>(); let failApp = true;
    const runtimeEnv = { ...env, USER_LIMITER: { getByName: (name: string) => {
      const limiter = env.USER_LIMITER.getByName(name);
      return new Proxy(limiter, { get(target, property) {
        if (property === 'releaseSession') return async (sessionId: string) => {
          releases.set(name, (releases.get(name) ?? 0) + 1);
          if (name === bootstrap.appId && failApp) throw new Error('Limiter unavailable');
          return target.releaseSession(sessionId);
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } } } as unknown as Env;
    await runInDurableObject(stub, async (_instance, state) => {
      const journal = new SessionJournal(state.storage); journal.open(bootstrap);
      const g = generation(bootstrap); journal.settle(g, settledEvent(g, 'interrupted', true));
      const item = journal.outbox()[0]!; const due = Date.now() + 3_600_000; item.due = due;
      state.storage.sql.exec('UPDATE usage_outbox SET json = ? WHERE id = ?', JSON.stringify(item), item.id);
      await new SessionCoordinator(runtimeEnv, state, bootstrap, headers).alarm();
      expect(releases.size).toBe(2); expect(journal.task('release:user').complete).toBe(true);
      expect(await state.storage.getAlarm()).toBe(journal.task('release:app').due);
      // Successful release is never repeated, and failed release respects its own deadline.
      await new SessionCoordinator(runtimeEnv, state, bootstrap, headers).alarm();
      expect([...releases.values()]).toEqual([1, 1]);
      const task = journal.task('release:app'); task.due = Date.now() - 1; journal.saveTask('release:app', task); failApp = false;
      await new SessionCoordinator(runtimeEnv, state, bootstrap, headers).alarm();
      expect(releases.get(bootstrap.appId)).toBe(2);
      expect(releases.get(`${bootstrap.appId}:realtime:key:${bootstrap.identity.apiKeyId}`)).toBe(1);
      expect(await state.storage.getAlarm()).toBe(due);
      await new SessionCoordinator(runtimeEnv, state, bootstrap, headers).alarm();
      expect([...releases.values()]).toEqual([1, 2]); expect(await state.storage.getAlarm()).toBe(due);
      await state.storage.deleteAlarm();
    });
  });
  it('unknown admission receipts use durable backoff instead of repeated maintenance polling', async () => {
    const { bootstrap, headers } = await setup(); const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
    let receipts = 0;
    const runtimeEnv = { ...env, ORG_QUOTA: { getByName: () => ({ receipt: async () => { receipts++; return null; } }) } } as unknown as Env;
    await runInDurableObject(stub, async (_instance, state) => {
      const journal = new SessionJournal(state.storage); journal.open(bootstrap);
      const g = generation(bootstrap, 'admitting'); g.claim = { admissionId: g.id, periodId: 'unknown', periodEnd: '2026-11-01T00:00:00Z', limit: 1 }; journal.save(g);
      journal.saveTask('admission', { attempts: 11, due: Date.now() - 1, complete: false });
      await new SessionCoordinator(runtimeEnv, state, bootstrap, headers).alarm();
      expect(receipts).toBe(1);
      const task = journal.task('admission'); expect(task.attempts).toBe(12);
      expect(task.due - Date.now()).toBeGreaterThan(3_590_000); expect(await state.storage.getAlarm()).toBe(task.due);
      await new SessionCoordinator(runtimeEnv, state, bootstrap, headers).alarm();
      expect(receipts).toBe(1); expect(await state.storage.getAlarm()).toBe(task.due);
      // Retention expiry takes precedence over the backoff deadline.
      g.at = Date.now() - 7 * 86_400_000 + 1000; journal.save(g);
      await new SessionCoordinator(runtimeEnv, state, bootstrap, headers).alarm();
      expect(await state.storage.getAlarm()).toBe(g.at + 7 * 86_400_000);
      await state.storage.deleteAlarm();
    });
  });
  it('refuses the second generation before upstream dispatch and records no refusal row', async () => {
    await withSockets(async ({ socket, upstream, next, bootstrap }) => {
      let sent = 0;
      upstream.addEventListener('message', event => {
        if ((JSON.parse(String(event.data)) as JsonObject).type !== 'response.create') return;
        const id = `r-${++sent}`; upstream.send(JSON.stringify({ type: 'response.created', response: { id } })); upstream.send(JSON.stringify({ type: 'response.done', response: { id, status: 'completed', usage } }));
      });
      socket.send('{"type":"response.create"}'); await next('response.done');
      socket.send('{"type":"response.create"}'); expect(await next('gateway.error')).toMatchObject({ error: { code: 'app_rate_limited' } });
      expect(sent).toBe(1);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_usage_event WHERE realtime_session_id = ?').bind(bootstrap.sessionId).first())?.n).toBe(1);
    });
  });
  it('disconnect while an app admission RPC awaits never dispatches or invents usage', async () => {
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const runtimeEnv = { ...env, USER_LIMITER: { getByName: (name: string) => {
      const limiter = env.USER_LIMITER.getByName(name);
      return new Proxy(limiter, { get(target, property) {
        if (property === 'checkAndIncrement') return async (input: Parameters<typeof limiter.checkAndIncrement>[0]) => { entered(); await gate; return target.checkAndIncrement(input); };
        return (...args: unknown[]) => Reflect.get(target, property)(...args);
      } });
    } } } as unknown as Env;
    await withSockets(async ({ socket, upstream, bootstrap }) => {
      let sent = 0; upstream.addEventListener('message', event => { if (JSON.parse(String(event.data)).type === 'response.create') sent++; });
      socket.send('{"type":"response.create"}'); await pending; socket.close(1000);
      await new Promise(resolve => setTimeout(resolve, 10)); release();
      await new Promise(resolve => setTimeout(resolve, 2100));
      expect(sent).toBe(0);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_usage_event WHERE realtime_session_id = ?').bind(bootstrap.sessionId).first())?.n).toBe(0);
    }, runtimeEnv);
  });
  it('two hosted sockets and HTTP race for the same final allowance', async () => {
    const runtimeEnv = hostedEnv(); const http = await setup();
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ model: 'gpt-realtime', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    let release!: () => void; let armed!: () => void; let ready = 0; let triggers = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }); const connections = new Promise<void>(resolve => { armed = resolve; });
    const outcomes: JsonObject[] = [];
    try {
      const sockets = [0, 1].map(() => withSockets(async peer => {
        peer.upstream.addEventListener('message', event => {
          if (JSON.parse(String(event.data)).type !== 'response.create') return; const id = `race-${++triggers}`;
          peer.upstream.send(JSON.stringify({ type: 'response.created', response: { id } })); peer.upstream.send(JSON.stringify({ type: 'response.done', response: { id, status: 'completed', usage } }));
        });
        if (++ready === 2) armed(); await gate; peer.socket.send('{"type":"response.create"}');
        outcomes.push(await Promise.race([peer.next('response.done'), peer.next('gateway.error')]));
      }, runtimeEnv));
      await connections; const ctx = createExecutionContext(); release();
      const response = await gateway.fetch(new Request(`https://gateway.test/v1/apps/${http.bootstrap.appId}/proxy/${http.bootstrap.providerSlug}/v1/chat/completions`, {
        method: 'POST', headers: { ...Object.fromEntries(http.headers), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-realtime', messages: [{ role: 'user', content: 'hello' }] }),
      }), runtimeEnv, ctx);
      await response.text(); await waitOnExecutionContext(ctx); await Promise.all(sockets);
      expect(outcomes.filter(frame => frame.type === 'response.done').length + Number(response.status === 200)).toBe(1);
      expect([200, 429]).toContain(response.status);
      expect(outcomes.filter(frame => frame.type === 'gateway.error').every(frame => (frame.error as JsonObject).code === 'billing_request_quota_exceeded')).toBe(true);
      expect(triggers + Number(response.status === 200)).toBe(1);
    } finally { release(); providerFetch.mockRestore(); }
  });
  it('disconnect after a hosted claim commits but before its RPC returns preserves one counted attempt', async () => {
    let entered!: () => void; let release!: () => void; const pending = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const baseEnv = hostedEnv();
    const runtimeEnv = { ...baseEnv,
      ORG_QUOTA: new Proxy(baseEnv.ORG_QUOTA, { get(target, property) {
        if (property === 'getByName') return (name: string) => { const quota = target.getByName(name); return new Proxy(quota, { get(owner, method) {
          if (method === 'admit') return async (input: Parameters<typeof quota.admit>[0]) => { const result = await owner.admit(input); entered(); await gate; return result; };
          return (...args: unknown[]) => Reflect.get(owner, method)(...args);
        } }); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } }),
    } as unknown as Env;
    await withSockets(async ({ socket, upstream, coordinator, bootstrap }) => {
      let triggers = 0; upstream.addEventListener('message', event => { if (JSON.parse(String(event.data)).type === 'response.create') triggers++; });
      socket.send('{"type":"response.create"}'); await pending;
      const attempt = coordinator.journal.generations()[0]!;
      socket.close(1000); await new Promise(resolve => setTimeout(resolve, 10)); release(); await new Promise(resolve => setTimeout(resolve, 2100));
      expect(triggers).toBe(0);
      expect(await runtimeEnv.ORG_QUOTA.getByName(bootstrap.organizationId).usage(attempt.claim!.periodId)).toBe(1);
      expect((await env.DB.prepare('SELECT event_id, completion_status FROM app_usage_event WHERE realtime_session_id = ?').bind(bootstrap.sessionId).all()).results)
        .toEqual([{ event_id: attempt.id, completion_status: 'interrupted' }]);
    }, runtimeEnv);
  });
  it('the last allowed hosted generation survives periodic exhaustion checks', async () => {
    const runtimeEnv = hostedEnv();
    await withSockets(async ({ socket, upstream, next, coordinator }) => {
      upstream.addEventListener('message', event => { if (JSON.parse(String(event.data)).type === 'response.create') upstream.send('{"type":"response.created","response":{"id":"last"}}'); });
      socket.send('{"type":"response.create"}'); await next('response.created');
      Reflect.set(coordinator, 'nextMaintenance', Date.now() - 1); await coordinator.alarm();
      const maintenance = Reflect.get(coordinator, 'maintenance') as Promise<void> | null; if (maintenance) await maintenance;
      expect(socket.readyState).toBe(WebSocket.OPEN);
      upstream.send(JSON.stringify({ type: 'response.done', response: { id: 'last', status: 'completed', usage } }));
      await next('response.done');
    }, runtimeEnv);
  });
  it('periodic maintenance detects blocked users and changing auth policy without new turns', async () => {
    await withSockets(async ({ coordinator, next, bootstrap }) => {
      await env.DB.prepare("INSERT INTO app_user (app_id, id, status) VALUES (?, 'u', 'blocked')").bind(bootstrap.appId).run();
      clearIsolateCaches(); Reflect.set(coordinator, 'nextMaintenance', Date.now() - 1);
      await coordinator.alarm(); expect(await next('gateway.error')).toMatchObject({ error: { code: 'auth_required' } });
    }, env, 'header');
    await withSockets(async ({ coordinator, next, bootstrap }) => {
      const application = await loadApp(env, bootstrap.appId);
      application.config.authentication = { type: 'api_key', end_user: { source: 'none' } };
      await database(env.DB).update(appTable).set({ config: application.config }).where(eq(appTable.id, bootstrap.appId)); clearIsolateCaches();
      Reflect.set(coordinator, 'nextMaintenance', Date.now() - 1);
      await coordinator.alarm(); expect(await next('gateway.error')).toMatchObject({ error: { code: 'auth_required' } });
    }, env, 'header');
  });
  it('audio frames do not scan the journal or rewrite unchanged live alarms', async () => {
    await withSockets(async ({ socket, upstream, coordinator, state }) => {
      let forwarded = 0; let complete!: () => void; const done = new Promise<void>(resolve => { complete = resolve; });
      upstream.addEventListener('message', event => { if (JSON.parse(String(event.data)).type === 'input_audio_buffer.append' && ++forwarded === 100) complete(); });
      const scans = vi.spyOn(coordinator.journal, 'generations');
      const alarm = vi.spyOn(state.storage, 'setAlarm');
      for (let index = 0; index < 100; index++) socket.send('{"type":"input_audio_buffer.append","audio":"AAAA"}');
      await done; expect(scans).not.toHaveBeenCalled(); expect(alarm).not.toHaveBeenCalled();
      scans.mockRestore(); alarm.mockRestore();
    });
  });
  it('acknowledged realtime usage marks API keys used', async () => {
    await withSockets(async ({ socket, upstream, next, bootstrap }) => {
      upstream.addEventListener('message', event => {
        if (JSON.parse(String(event.data)).type !== 'response.create') return;
        upstream.send('{"type":"response.created","response":{"id":"r"}}'); upstream.send(JSON.stringify({ type: 'response.done', response: { id: 'r', status: 'completed', usage } }));
      });
      socket.send('{"type":"response.create"}'); await next('response.done');
      await new Promise(resolve => setTimeout(resolve, 30));
      expect((await env.DB.prepare('SELECT last_used_at FROM app_api_key WHERE id = ?').bind(bootstrap.identity.apiKeyId).first())?.last_used_at).toBeTruthy();
    });
  });
  it('a send failure after unmetered admission records one interrupted attempt without replay', async () => {
    await withSockets(async ({ socket, upstream, next, coordinator, bootstrap }) => {
      let triggers = 0; upstream.addEventListener('message', event => { if (JSON.parse(String(event.data)).type === 'response.create') triggers++; });
      const providerSocket = Reflect.get(coordinator, 'upstream') as WebSocket; const original = providerSocket.send;
      const spy = vi.spyOn(providerSocket, 'send').mockImplementation(data => {
        if (typeof data === 'string' && JSON.parse(data).type === 'response.create') throw new Error('Ambiguous socket send failure');
        return original.call(providerSocket, data);
      });
      socket.send('{"type":"response.create"}'); await next('gateway.error'); await new Promise(resolve => setTimeout(resolve, 2100)); spy.mockRestore();
      expect(triggers).toBe(0);
      const rows = await env.DB.prepare('SELECT completion_status, cost_source FROM app_usage_event WHERE realtime_session_id = ?').bind(bootstrap.sessionId).all();
      expect(rows.results).toEqual([{ completion_status: 'interrupted', cost_source: 'unresolved' }]);
      expect(await env.USER_LIMITER.getByName(bootstrap.appId).getStatus(Date.now())).toEqual({ requestsToday: 1 });
    });
  });
  it('missing usage closes after one honest unresolved attempt', async () => {
    await withSockets(async ({ socket, upstream, next, coordinator }) => {
      upstream.addEventListener('message', event => {
        if ((JSON.parse(String(event.data)) as JsonObject).type !== 'response.create') return;
        upstream.send('{"type":"response.created","response":{"id":"r"}}'); upstream.send('{"type":"response.done","response":{"id":"r","status":"completed"}}');
      });
      socket.send('{"type":"response.create"}'); await next('response.done');
      expect(await next('gateway.error')).toMatchObject({ error: { code: 'realtime_usage_unresolved' } });
      expect(coordinator.journal.generations()[0]?.event.row.costSource).toBe('unresolved');
    });
  });
  it('a lost D1 insert acknowledgement replays exactly one row and spend delta', async () => {
    const { bootstrap } = await setup(); const g = generation(bootstrap);
    g.observation = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, modalityTokens: { input: {}, output: {}, cachedInput: {} } };
    const event = settledEvent(g, 'completed', false); let lost = false;
    const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrapStatement(target.bind(...args));
      if (property === 'run') return async () => { const result = await target.run(); if (!lost) { lost = true; throw new Error('Lost committed insert acknowledgement'); } return result; };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === 'prepare') return (sql: string) => /insert into ["`]?app_usage_event/iu.test(sql) ? wrapStatement(target.prepare(sql)) : target.prepare(sql);
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await persistUsageEventAcknowledged({ ...env, DB: db }, event)).toBe('stored'); expect(lost).toBe(true);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_usage_event WHERE event_id = ?').bind(event.eventId).first())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT microusd FROM app_usage_spend WHERE app_id = ? AND scope = 'app'").bind(bootstrap.appId).first())?.microusd).toBe(20);
  });
  it('ancillary key-write failure leaves usage acknowledged and does not retain the outbox', async () => {
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === 'prepare') return (sql: string) => { if (/update ["`]?app_api_key/iu.test(sql)) throw new Error('Simulated key metadata outage'); return target.prepare(sql); };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await withSockets(async ({ socket, upstream, next, coordinator, bootstrap }) => {
      upstream.addEventListener('message', event => {
        if (JSON.parse(String(event.data)).type !== 'response.create') return;
        upstream.send('{"type":"response.created","response":{"id":"r"}}'); upstream.send(JSON.stringify({ type: 'response.done', response: { id: 'r', status: 'completed', usage } }));
      });
      socket.send('{"type":"response.create"}'); await next('response.done'); await new Promise(resolve => setTimeout(resolve, 100));
      expect(coordinator.journal.outbox()).toHaveLength(0);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_usage_event WHERE realtime_session_id = ?').bind(bootstrap.sessionId).first())?.n).toBe(1);
    }, { ...env, DB: db });
  });
  it('D1 outage retains the outbox, stops new dispatch, and replay writes one row', async () => {
    let failInsert = true;
    const db = new Proxy(env.DB, { get(target, property) { const value = Reflect.get(target, property); if (property === 'prepare') return (sql: string) => {
      if (failInsert && /insert into ["`]?app_usage_event/iu.test(sql)) throw new Error('Simulated usage outage'); return target.prepare(sql);
    }; return typeof value === 'function' ? value.bind(target) : value; } });
    const runtimeEnv = { ...env, DB: db } as Env;
    await withSockets(async ({ socket, upstream, next, coordinator, state, bootstrap }) => {
      let sent = 0; upstream.addEventListener('message', event => {
        if ((JSON.parse(String(event.data)) as JsonObject).type !== 'response.create') return; sent++;
        upstream.send('{"type":"response.created","response":{"id":"r"}}'); upstream.send(JSON.stringify({ type: 'response.done', response: { id: 'r', status: 'completed', usage } }));
      });
      socket.send('{"type":"response.create"}'); await next('response.done'); socket.send('{"type":"response.create"}'); await next('gateway.error');
      expect(sent).toBe(1); expect(coordinator.journal.outbox()).toHaveLength(1);
      const item = coordinator.journal.outbox()[0]!; failInsert = false; item.due = Date.now();
      state.storage.sql.exec('UPDATE usage_outbox SET json = ? WHERE id = ?', JSON.stringify(item), item.id);
      await new Promise(resolve => setTimeout(resolve, 20)); await coordinator.alarm();
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_usage_event WHERE realtime_session_id = ?').bind(bootstrap.sessionId).first())?.n).toBe(1);
    }, runtimeEnv);
  });
  it('crash reconciliation queries claimed allowance without replaying admission', async () => {
    const { bootstrap, headers } = await setup(); const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
    await runInDurableObject(stub, async (_instance, state) => {
      const journal = new SessionJournal(state.storage); journal.open(bootstrap);
      const g = generation(bootstrap, 'admitting'); g.claim = { periodId: 'p', periodEnd: '2026-11-01T00:00:00Z', limit: 1, admissionId: g.id };
      journal.save(g); await env.ORG_QUOTA.getByName(bootstrap.organizationId).admit(g.claim);
      const coordinator = new SessionCoordinator(env, state, bootstrap, headers); await coordinator.recover();
      const recovered = journal.generations()[0]!; expect(recovered.stage).toBe('settled');
      expect(recovered.event.row).toMatchObject({ costSource: 'unresolved', completionStatus: 'interrupted' });
      await coordinator.recover(); expect(journal.outbox()).toHaveLength(1);
      expect(await env.ORG_QUOTA.getByName(bootstrap.organizationId).usage('p')).toBe(1);
    });
  });
  it('prepared or partially checked unmetered intents create no invented usage row', async () => {
    const { bootstrap, headers } = await setup(); const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
    await runInDurableObject(stub, async (_instance, state) => {
      const journal = new SessionJournal(state.storage); journal.open(bootstrap); journal.save(generation(bootstrap, 'prepared')); journal.save(generation(bootstrap, 'admitting'));
      await new SessionCoordinator(env, state, bootstrap, headers).recover(); expect(journal.outbox()).toHaveLength(0);
    });
  });
  it('unknown claim receipts remain pending for read-only reconciliation', async () => {
    const { bootstrap, headers } = await setup(); const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
    await runInDurableObject(stub, async (_instance, state) => {
      const journal = new SessionJournal(state.storage); journal.open(bootstrap); const g = generation(bootstrap, 'admitting');
      g.claim = { admissionId: g.id, periodId: 'unknown', periodEnd: '2026-11-01T00:00:00Z', limit: 1 }; journal.save(g);
      await new SessionCoordinator(env, state, bootstrap, headers).recover(); expect(journal.generations()[0]?.stage).toBe('admitting'); expect(journal.outbox()).toHaveLength(0);
    });
  });
  it('cancelled/incomplete attempts retain observed usage and original admission month', async () => {
    const { bootstrap } = await setup(); const g = generation(bootstrap); g.event.row.createdAt = '2026-09-30T23:59:59Z';
    g.observation = { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, modalityTokens: { input: {}, output: {}, cachedInput: {} } };
    expect(settledEvent(g, 'cancelled', true).row).toMatchObject({ createdAt: '2026-09-30T23:59:59Z', completionStatus: 'cancelled', costSource: 'computed', costUsd: .00002 });
  });
  it('serial mailbox preserves ordering across awaits and bounds the current frame too', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let overflow = 0; const order: number[] = [];
    const mailbox = new Mailbox(() => overflow++, () => { throw new Error('Unexpected mailbox failure'); });
    const first = mailbox.push(900_000, async () => { order.push(1); await gate; order.push(2); });
    mailbox.push(200_000, async () => { order.push(9); });
    const second = mailbox.push(1, async () => { order.push(3); }); release(); await Promise.all([first, second]);
    expect(overflow).toBe(1); expect(order).toEqual([1, 2, 3]);
  });
  it('shutdown waits for a full mailbox without consuming a frame queue slot', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let overflow = 0; const order: number[] = [];
    const mailbox = new Mailbox(() => overflow++, () => { throw new Error('Unexpected mailbox failure'); });
    const drain = mailbox.push(1, async () => { await gate; order.push(1); });
    for (let index = 0; index < 256; index++) mailbox.push(1, async () => {});
    const cleanup = mailbox.afterDrain(async () => { order.push(2); });
    expect(overflow).toBe(0); release(); await Promise.all([drain, cleanup]); expect(order).toEqual([1, 2]);
  });
  it('dormant Gemini adapter admits explicit activity before audio and rejects autonomous modes', () => {
    const adapter = new GeminiAdapter('candidate', 1024);
    const frame = { setup: { model: 'models/candidate', generationConfig: { responseModalities: ['AUDIO'] }, realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } };
    expect(adapter.client(frame, { ...manual, ready: false })[0]).toMatchObject({ kind: 'configure', frame: { setup: { generationConfig: { maxOutputTokens: 1024 } } } });
    expect(() => adapter.client({ realtimeInput: { audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' } } }, manual)).toThrow();
    expect(adapter.client({ realtimeInput: { activityStart: {} } }, manual)[0]?.kind).toBe('generate');
    expect(adapter.client({ realtimeInput: { audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' } } }, { ...manual, active: true })[0]?.kind).toBe('forward');
    expect(() => new GeminiAdapter('candidate', 1024).client({ setup: { ...frame.setup, tools: [] } }, manual)).toThrow();
  });
});
