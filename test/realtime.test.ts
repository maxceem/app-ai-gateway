import type { OrgQuota } from '../src/do/OrgQuota';
import type { UserLimiter } from '../src/do/UserLimiter';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { database } from '../src/db';
import { app as appTable } from '../src/db/schema';
import app from '../src/index';
import { OpenAIAdapter, openAIUsage } from '../src/realtime/protocols/openai';
import { realtimePolicy } from '../src/realtime/policy';
import { protocolAdapter, upstreamRequest } from '../src/realtime/upstream';
import { SessionCoordinator } from '../src/realtime/session';
import { SessionJournal } from '../src/realtime/journal';
import { loadApp } from '../src/core/app-records';
import { authenticateRequest } from '../src/client-auth/client-auth';
import { requireProvider } from '../src/providers/provider-store';
import { computeCost } from '../src/usage/pricing';
import { persistUsageEventAcknowledged } from '../src/usage/usage-record';
import { REALTIME_LIMITS } from '../src/realtime/limits';
import { frameBytes } from '../src/realtime/transport';
import { parseAppConfig } from '../src/shared/app-config';
import { CATALOG } from '../src/contracts/catalog';
import { createOpenAPIDocument } from '../src/contracts/openapi';
import { INFERENCE_ROUTES } from '../src/contracts/inference-routes';
import type { Bootstrap, JsonObject } from '../src/realtime/types';
import { clearIsolateCaches, seedProvider, seedServerApp, TEST_ORGANIZATION_ID } from './helpers';

const soak = process.env.REALTIME_SOAK === '1';
const manual = { ready: true, configuring: false, active: false, responseId: null };
const usage = { input_tokens: 100, output_tokens: 20, input_token_details: { audio_tokens: 80, text_tokens: 20, cached_tokens: 30,
  cached_tokens_details: { audio_tokens: 20, text_tokens: 10 } }, output_token_details: { audio_tokens: 15, text_tokens: 5 } };
function ack(extra: JsonObject = {}): JsonObject { return { type: 'session.updated', session: { model: 'gpt-realtime', max_output_tokens: 4096,
  audio: { input: { turn_detection: null, transcription: null } }, ...extra } }; }

async function seeded(enabled = true) {
  clearIsolateCaches(); const appId = `realtime-${crypto.randomUUID()}`;
  const key = await seedServerApp(appId, { endUser: 'none' });
  await seedProvider({ type: 'openai', slug: appId, id: appId });
  const loaded = await loadApp(env, appId);
  loaded.config.realtime.enabled = enabled;
  loaded.config.routing.providers = { mode: "all" };
  await database(env.DB).update(appTable).set({ config: loaded.config }).where(eq(appTable.id, appId));
  clearIsolateCaches();
  const headers = new Headers({ Authorization: `Bearer ${key}` });
  const identity = (await authenticateRequest({ env, app: await loadApp(env, appId), headers })).identity;
  const provider = await requireProvider(env, TEST_ORGANIZATION_ID, appId);
  const bootstrap: Bootstrap = { sessionId: crypto.randomUUID(), appId, organizationId: TEST_ORGANIZATION_ID, providerId: provider.id,
    providerSlug: appId, model: 'gpt-realtime', requestedModel: 'gpt-realtime', protocol: 'openai_realtime', identity, appVersion: null, origin: 'https://gateway.test' };
  return { bootstrap, headers, provider, key, appId };
}

/** Deterministic native WebSocket peer in workerd; no real provider requests/credits. */
function collector(socket: WebSocket) {
  const frames: JsonObject[] = [];
  const waiters: { type: string; resolve: (value: JsonObject) => void }[] = [];
  socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)) as JsonObject;
    if (String(frame.type).endsWith('.delta')) return;
    const index = waiters.findIndex(waiter => frame.type === waiter.type);
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame); else frames.push(frame);
  });
  return (type: string): Promise<JsonObject> => {
    const index = frames.findIndex(frame => frame.type === type);
    if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve: (value: JsonObject) => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => reject(new Error(`Missing fixture event ${type}`)), 4000);
      waiters.push(waiter);
    });
  };
}

 describe('realtime protocol and accounting', () => {
  it('normalizes disjoint cached audio/text and computes independently priced cost', () => {
    const normalized = openAIUsage(usage);
    expect(normalized.inputTokens).toBe(70); expect(normalized.modalityTokens?.input?.audio).toBe(60);
    expect(normalized.modalityTokens?.cachedInput?.audio).toBe(20);
    expect(computeCost('openai', 'gpt-realtime', normalized)).toBeCloseTo((10 * 4 + 60 * 32 + 10 * .4 + 20 * .4 + 5 * 16 + 15 * 64) / 1e6);
    expect(() => openAIUsage({ ...usage, input_tokens: 99 })).toThrow();
  });
  it('never forwards input until safe configuration acknowledgement', () => {
    const adapter = new OpenAIAdapter('gpt-realtime', 4096);
    expect(adapter.initial()).toMatchObject({ session: { audio: { input: { turn_detection: null, transcription: null } } } });
    expect(() => adapter.client({ type: 'input_audio_buffer.append', audio: 'AAAA' }, { ...manual, ready: false })).toThrow();
    expect(adapter.server(ack(), manual)[0]).toEqual({ kind: 'ready' });
    expect(() => adapter.server(ack({ audio: { input: { turn_detection: { type: 'server_vad', create_response: true } } } }), manual)).toThrow();
  });
  it.each([
    { type: 'session.update', session: { model: 'other' } },
    { type: 'session.update', session: { audio: { input: { transcription: { model: 'whisper-1' } } } } },
    { type: 'session.update', session: { prompt: { id: 'stored' } } },
    { type: 'session.update', session: { tools: [{ type: 'mcp' }] } },
    { type: 'session.update', session: { audio: { input: { turn_detection: { type: 'server_vad', idle_timeout_ms: 1000 } } } } },
    { type: 'response.create', response: { max_output_tokens: 'inf' } },
    { type: 'response.create', response: { model: 'other' } },
    { type: 'unknown.future.trigger' },
  ])('rejects admission bypass configuration %j', frame => {
    expect(() => new OpenAIAdapter('gpt-realtime', 4096).client(frame, manual)).toThrow();
  });
  it('mediates VAD through committed items, deduplicates and refuses mixed manual triggers', () => {
    const adapter = new OpenAIAdapter('gpt-realtime', 1024);
    const config = adapter.client({ type: 'session.update', session: { audio: { input: { turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } } } } }, manual);
    expect(config[0]).toMatchObject({ kind: 'configure', frame: { session: { audio: { input: { turn_detection: { create_response: false, interrupt_response: false } } } } } });
    expect(adapter.server({ type: 'input_audio_buffer.speech_stopped' }, manual).every(effect => effect.kind !== 'generate')).toBe(true);
    expect(adapter.server({ type: 'input_audio_buffer.committed', item_id: 'item-1' }, manual)).toContainEqual({ kind: 'generate', correlation: 'item-1', frame: { type: 'response.create', response: { max_output_tokens: 1024 } } });
    expect(adapter.server({ type: 'input_audio_buffer.committed', item_id: 'item-1' }, manual)).toEqual([]);
    expect(() => adapter.client({ type: 'response.create' }, manual)).toThrow();
    expect(adapter.server({ type: 'input_audio_buffer.speech_started' }, { ...manual, active: true })[0]).toEqual({ kind: 'cancel' });
  });
  it('preserves a lower session cap across manual/VAD triggers and unrelated updates', () => {
    const adapter = new OpenAIAdapter('gpt-realtime', 4096);
    expect(adapter.client({ type: 'session.update', session: { max_output_tokens: 32 } }, manual)[0]).toMatchObject({ frame: { session: { max_output_tokens: 32 } } });
    expect(adapter.client({ type: 'response.create' }, manual)[0]).toMatchObject({ frame: { response: { max_output_tokens: 32 } } });
    expect(adapter.client({ type: 'response.create', response: { max_output_tokens: 10 } }, manual)[0]).toMatchObject({ frame: { response: { max_output_tokens: 10 } } });
    expect(adapter.client({ type: 'response.create', response: { max_output_tokens: 33 } }, manual)[0]).toMatchObject({ frame: { response: { max_output_tokens: 32 } } });
    expect(adapter.client({ type: 'session.update', session: { instructions: 'brief', audio: { input: { turn_detection: { type: 'server_vad' } } } } }, manual)[0]).toMatchObject({ frame: { session: { max_output_tokens: 32 } } });
    expect(adapter.server({ type: 'input_audio_buffer.committed', item_id: 'i' }, manual)[1]).toMatchObject({ frame: { response: { max_output_tokens: 32 } } });
    expect(() => adapter.server(ack(), manual)).toThrow();
  });
  it('reserves internal bootstrap headers only for realtime-enabled configurations', async () => {
    const { bootstrap } = await seeded(false); const application = await loadApp(env, bootstrap.appId);
    const config = { ...application.config, authentication: { type: 'api_key', end_user: { source: 'header', header: 'X-Realtime-Bootstrap' } } };
    expect(parseAppConfig(config).authentication.end_user).toEqual({ source: 'header', header: 'x-realtime-bootstrap' });
    expect(() => parseAppConfig({ ...config, realtime: { ...config.realtime, enabled: true } })).toThrow(/x-realtime-bootstrap/u);
  });
  it('hosted-style concurrent distinct admissions share one allowance exactly', async () => {
    const quota = env.ORG_QUOTA.getByName(crypto.randomUUID());
    const input = { periodId: 'race', periodEnd: '2026-11-01T00:00:00Z', limit: 3 };
    const results = await Promise.all(Array.from({ length: 20 }, () => quota.admit({ ...input, admissionId: crypto.randomUUID() })));
    expect(results.filter(result => result.allowed)).toHaveLength(3);
    expect(await quota.usage('race')).toBe(3);
  });
  it('rejects unadmitted output, mismatched terminals and unknown paid input', () => {
    const adapter = new OpenAIAdapter('gpt-realtime', 4096);
    expect(() => adapter.server({ type: 'response.created', response: { id: 'r' } }, manual)).toThrow();
    expect(() => adapter.server({ type: 'response.done', response: { id: 'r', status: 'completed', usage } }, { ...manual, active: true, responseId: 'other' })).toThrow();
    expect(() => adapter.client({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'unknown', output: 'result' } }, manual)).toThrow();
  });
  it('constructs official protocol-specific upstreams and keeps Gemini profiles unavailable', async () => {
    const openai = upstreamRequest('openai_realtime', 'gpt-realtime', 'fixture');
    expect(new URL(openai.url).hostname).toBe('api.openai.com'); expect(openai.headers.get('authorization')).toBe('Bearer fixture');
    const gemini = upstreamRequest('gemini_live', 'candidate', 'fixture');
    expect(new URL(gemini.url).hostname).toBe('generativelanguage.googleapis.com');
    expect(gemini.headers.get('x-goog-api-key')).toBe('fixture'); expect(gemini.headers.has('authorization')).toBe(false); expect(new URL(gemini.url).search).toBe('');
    const adapter = protocolAdapter('gemini_live', 'candidate', 32); expect(adapter.initial()).toBeNull(); expect(adapter.cancel()).toBeNull();
    const { bootstrap, provider } = await seeded();
    const application = await loadApp(env, bootstrap.appId);
    expect(() => realtimePolicy(application, { ...provider, type: 'gemini' }, 'candidate')).toThrow(/unavailable/u);
  });
  it('documents 101 with no fabricated response body and derives inference mounts', () => {
    const document = createOpenAPIDocument();
    expect(document.paths?.[CATALOG.connectRealtime.path]?.get?.responses?.['101']).not.toHaveProperty('content');
    expect(INFERENCE_ROUTES.connectRealtime).toBe(CATALOG.connectRealtime.path.replace(/\{(\w+)\}/gu, ':$1'));
  });
  it('60 seconds of 24kHz PCM fit the finite input ceiling with JSON overhead', () => {
    const pcmBase64 = 'A'.repeat(24_000 * 2 * 60 * 4 / 3);
    const chunks = pcmBase64.match(/.{1,64000}/gu)!;
    expect(chunks.reduce((bytes, audio) => bytes + frameBytes(JSON.stringify({ type: 'input_audio_buffer.append', audio })), 0)).toBeLessThan(REALTIME_LIMITS.turnInputBytes);
  });
  it('quota receipt replays count once and mismatched periods are rejected', async () => {
    const quota = env.ORG_QUOTA.getByName(crypto.randomUUID());
    const input = { periodId: 'period', periodEnd: '2026-11-01T00:00:00Z', limit: 1, admissionId: crypto.randomUUID() };
    const results = await Promise.all(Array.from({ length: 20 }, () => quota.admit(input)));
    expect(results.every(result => result.allowed)).toBe(true); expect(await quota.usage('period')).toBe(1);
    expect(await quota.receipt(input.admissionId)).toMatchObject({ allowed: true });
    await runInDurableObject(quota, instance => { expect(() => (instance as OrgQuota).admit({ ...input, periodId: "different" })).toThrow(); });
    expect((await quota.admit({ ...input, admissionId: 'another' })).allowed).toBe(false);
  });
  it('limiter receipts preserve original windows and separate leases from inference counts', async () => {
    const limiter = env.USER_LIMITER.getByName(crypto.randomUUID());
    const input = { now: Date.now(), rpm: 1, rpd: 1, monthlyBudgetMicrousd: null, spend: { appId: 'a', userKey: null }, admissionId: 'generation-1', freshSpend: true };
    await Promise.all(Array.from({ length: 10 }, () => limiter.checkAndIncrement(input)));
    expect(await limiter.getStatus(input.now)).toEqual({ requestsToday: 1 });
    await runInDurableObject(limiter, async instance => { await expect((instance as UserLimiter).checkAndIncrement({ ...input, now: input.now + 60_000 })).rejects.toThrow(); });
    expect(await limiter.acquireSession('s1', 1)).toMatchObject({ allowed: true });
    expect(await limiter.acquireSession('s1', 1)).toMatchObject({ allowed: true });
    expect(await limiter.acquireSession('s2', 1)).toMatchObject({ allowed: false });
    expect(await limiter.renewSession('s1')).toMatchObject({ allowed: true });
    await limiter.releaseSession('s1'); await limiter.releaseSession('s1');
    expect(await limiter.acquireSession('s2', 1)).toMatchObject({ allowed: true });
    expect(await limiter.getStatus(input.now)).toEqual({ requestsToday: 1 });
  });
  it('requires opt-in, official direct origin and a separately eligible model', async () => {
    const { bootstrap, provider } = await seeded(false); const application = await loadApp(env, bootstrap.appId);
    expect(() => realtimePolicy(application, provider, 'gpt-realtime')).toThrow();
    application.config.realtime.enabled = true;
    expect(() => realtimePolicy(application, { ...provider, baseUrl: 'https://example.test' }, 'gpt-realtime')).toThrow();
    expect(() => realtimePolicy(application, provider, 'gpt-5.6-sol')).toThrow();
    expect(realtimePolicy(application, provider, 'gpt-realtime').protocol).toBe('openai_realtime');
  });
  it('ordinary GET returns 426 before auth, URL credentials and forged metadata cannot open a session', async () => {
    const url = 'https://gateway.test/v1/apps/no-app/realtime/openai?model=gpt-realtime';
    expect((await app.fetch(new Request(url), env)).status).toBe(426);
    expect((await app.fetch(new Request(url + '&key=secret', { headers: { Upgrade: 'websocket', 'x-realtime-bootstrap': '{}' } }), env)).status).toBe(400);
    expect((await app.fetch(new Request(url, { headers: { Upgrade: 'websocket', 'x-realtime-bootstrap': '{}' } }), env)).status).toBe(401);
  });
  it('workerd native sockets serve twenty attempts and persist twenty stable rows', async () => {
    const { bootstrap, headers } = await seeded();
    const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
    const measured = await runInDurableObject(stub, async (instance, state) => {
      const upstream = new WebSocketPair(); upstream[0].accept({ allowHalfOpen: true });
      let dispatched = 0;
      const admissionLatencies: number[] = [];
      const terminalLatencies: number[] = [];
      let triggerAt = 0;
      const sessionStarted = performance.now();
      let metrics: Record<string, number | undefined> | undefined;
      upstream[0].addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as JsonObject;
        if (frame.type === 'session.update') upstream[0].send(JSON.stringify(ack()));
        if (frame.type === 'response.create') {
          admissionLatencies.push(performance.now() - triggerAt);
          const responseId = `response-${++dispatched}`;
          upstream[0].send(JSON.stringify({ type: 'response.created', response: { id: responseId } }));
          upstream[0].send(JSON.stringify({ type: 'response.output_audio.delta', response_id: responseId, delta: soak ? 'A'.repeat(64 * 1024) : 'AAAA' }));
          upstream[0].send(JSON.stringify({ type: 'response.done', response: { id: responseId, status: 'completed', usage } }));
        }
      });
      const coordinator = new SessionCoordinator(env, state, bootstrap, headers);
      Reflect.set(instance, "coordinator", coordinator);
      const response = await coordinator.start(upstream[1]); expect(response.status).toBe(101);
      const socket = response.webSocket!; const next = collector(socket); socket.accept({ allowHalfOpen: true });
      await next('session.updated');
      for (let index = 0; index < 20; index++) {
        socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }));
        triggerAt = performance.now();
        socket.send(JSON.stringify({ type: 'response.create', event_id: `trigger-${index}` }));
        await next('response.done');
        terminalLatencies.push(performance.now() - triggerAt);
        if (soak) await new Promise(resolve => setTimeout(resolve, 6000));
      }
      // Duplicate the already processed trigger; it must not dispatch again.
      socket.send(JSON.stringify({ type: 'response.create', event_id: 'trigger-19' }));
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(dispatched).toBe(20);
      if (soak) {
        const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
        metrics = { durationMs: Math.round(performance.now() - sessionStarted), generations: dispatched, admissionP50Ms: percentile(admissionLatencies, .5), admissionP95Ms: percentile(admissionLatencies, .95), terminalP50Ms: percentile(terminalLatencies, .5), terminalP95Ms: percentile(terminalLatencies, .95) };
      }
      const rows = await env.DB.prepare('SELECT * FROM app_usage_event WHERE realtime_session_id = ?').bind(bootstrap.sessionId).all();
      expect(rows.results).toHaveLength(20);
      expect(new Set(rows.results.map(row => row.event_id)).size).toBe(20);
      expect(rows.results.every(row => row.completion_status === 'completed' && row.cost_source === 'computed')).toBe(true);
      const first = coordinator.journal.generations()[0]!;
      await persistUsageEventAcknowledged(env, first.event);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM app_usage_event WHERE realtime_session_id = ?').bind(bootstrap.sessionId).first())?.count).toBe(20);
      coordinator.terminate(null, 1000); await new Promise(resolve => setTimeout(resolve, 20));
      expect(new SessionJournal(state.storage).outbox()).toHaveLength(0);
      upstream[0].close(1000); socket.close(1000);
      return metrics;
    });
    if (measured) console.info('REALTIME_SOAK', JSON.stringify(measured));
  }, soak ? 150_000 : 20_000);
});
