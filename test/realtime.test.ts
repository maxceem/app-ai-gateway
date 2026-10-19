import { prepareRealtime } from '../src/realtime/serve';
import { remoteSessionBackend, safeBackendCall } from '../src/realtime/remote-backend';
import { requireRealtimeAdmission } from '../src/realtime/releases';
import { testAttribution } from './helpers';
import { localSessionBackend } from '../src/realtime/local-backend';
import type { OrgQuota } from '../src/do/OrgQuota';
import type { UserLimiter } from '../src/do/UserLimiter';
import { env } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { database } from '../src/db';
import { app as appTable } from '../src/db/schema';
import app from '../src/index';
import { OpenAIAdapter, openAIUsage } from '../src/realtime/protocols/openai';
import { realtimePolicy } from '../src/realtime/policy';
import { protocolAdapter, upstreamRequest } from '../src/realtime/upstream';
import { routeThroughGateway } from '../src/providers/route-adapters';
import { realtimeProtocols } from '../src/shared/capabilities';
import { SessionCoordinator } from '../src/realtime/session';
import { SessionJournal } from '../src/realtime/journal';
import { loadApp } from '../src/core/app-records';
import { authenticateRequest } from '../src/client-auth/client-auth';
import { requireProvider } from '../src/providers/provider-store';
import { computeCost } from '../src/usage/pricing';
import { buildUsageEvent, persistUsageEventAcknowledged } from '../src/usage/usage-record';
import { REALTIME_LIMITS } from '../src/realtime/limits';
import { frameBytes } from '../src/realtime/transport';
import { parseAppConfig } from '../src/shared/app-config';
import { CATALOG } from '../src/contracts/catalog';
import { createOpenAPIDocument } from '../src/contracts/openapi';
import { INFERENCE_ROUTES } from '../src/contracts/inference-routes';
import companion from '../src/realtime/worker';
import { realtimeCaller } from '../src/realtime/caller';
import type { Bootstrap, JsonObject } from '../src/realtime/types';
import { clearIsolateCaches, registerTestInstall, seedApp, seedProvider, seedServerApp, signedProof, tokenForInstall, TEST_ORGANIZATION_ID } from './helpers';

const soak = process.env.REALTIME_SOAK === '1';
const manual = { ready: true, configuring: false, active: false, responseId: null };
const usage = { input_tokens: 100, output_tokens: 20, input_token_details: { audio_tokens: 80, text_tokens: 20, cached_tokens: 30,
  cached_tokens_details: { audio_tokens: 20, text_tokens: 10 } }, output_token_details: { audio_tokens: 15, text_tokens: 5 } };
function ack(extra: JsonObject = {}): JsonObject { return { type: 'session.updated', session: { model: 'gpt-realtime', max_output_tokens: 4096,
  audio: { input: { turn_detection: null, transcription: null } }, ...extra } }; }

async function seeded(enabled = true, gateway?: 'cf_aig') {
  clearIsolateCaches(); const appId = `realtime-${crypto.randomUUID()}`;
  const key = await seedServerApp(appId, { endUser: 'none' });
  await seedProvider({ type: 'openai', slug: appId, id: appId, ...(gateway ? { gateway } : {}) });
  const loaded = await loadApp(env, appId);
  loaded.config.realtime.enabled = enabled;
  loaded.config.routing.providers = { mode: "all" };
  await database(env.DB).update(appTable).set({ config: loaded.config }).where(eq(appTable.id, appId));
  clearIsolateCaches();
  const headers = new Headers({ Authorization: `Bearer ${key}` });
  const identity = (await authenticateRequest({ env, app: await loadApp(env, appId), request: new Request('https://gateway.test/', { headers }), body: async () => new Uint8Array() })).identity;
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
  it('accepts the requested model name under a rewrite and forwards the routed one', () => {
    const adapter = new OpenAIAdapter('gpt-realtime', 4096, 'voice-alias');
    const [effect] = adapter.client({ type: 'session.update', session: { model: 'voice-alias' } }, manual);
    expect(effect).toMatchObject({ kind: 'configure', frame: { session: { model: 'gpt-realtime' } } });
    expect(() => new OpenAIAdapter('gpt-realtime', 4096, 'voice-alias').client({ type: 'session.update', session: { model: 'other' } }, manual)).toThrow();
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
  it('applies VAD input bounds and interruption when the app creates responses itself', () => {
    const adapter = new OpenAIAdapter('gpt-realtime', 1024);
    adapter.client({ type: 'session.update', session: { audio: { input: { turn_detection: { type: 'server_vad', create_response: false, interrupt_response: true } } } } }, manual);
    const append = { type: 'input_audio_buffer.append', audio: 'AAAA' };
    expect(adapter.client(append, manual)).toMatchObject([{ input: false }]);
    expect(adapter.server({ type: 'input_audio_buffer.speech_started' }, { ...manual, active: true })[0]).toEqual({ kind: 'cancel' });
    expect(adapter.client(append, manual)).toMatchObject([{ input: true }]);
    // The utterance stays this turn's input until the app's own response.create.
    expect(adapter.server({ type: 'input_audio_buffer.committed', item_id: 'item-1' }, manual).map(effect => effect.kind)).toEqual(['forward']);
    expect(adapter.client(append, manual)).toMatchObject([{ input: false }]);
    expect(adapter.client({ type: 'response.create' }, manual)[0]).toMatchObject({ kind: 'generate' });
  });
  it('preserves a lower session cap across manual/VAD triggers and unrelated updates', () => {
    const adapter = new OpenAIAdapter('gpt-realtime', 4096);
    expect(adapter.client({ type: 'session.update', session: { max_output_tokens: 32 } }, manual)[0]).toMatchObject({ frame: { session: { max_output_tokens: 32 } } });
    expect(adapter.client({ type: 'response.create' }, manual)[0]).toMatchObject({ frame: { response: { max_output_tokens: 32 } } });
    expect(adapter.client({ type: 'response.create', response: { max_output_tokens: 10 } }, manual)[0]).toMatchObject({ frame: { response: { max_output_tokens: 10 } } });
    expect(adapter.client({ type: 'response.create', response: { max_output_tokens: 33 } }, manual)[0]).toMatchObject({ frame: { response: { max_output_tokens: 32 } } });
    expect(adapter.client({ type: 'session.update', session: { instructions: 'brief', audio: { input: { turn_detection: { type: 'server_vad' } } } } }, manual)[0]).toMatchObject({ frame: { session: { max_output_tokens: 32 } } });
    expect(adapter.server({ type: 'input_audio_buffer.committed', item_id: 'i' }, manual).at(-1)).toMatchObject({ frame: { response: { max_output_tokens: 32 } } });
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
  it('keeps the conversation when a cancel crosses its response on the wire, and closes on other provider errors', () => {
    const adapter = new OpenAIAdapter('gpt-realtime', 4096);
    const late = { type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'Cancellation failed: no active response found' } };
    expect(adapter.server(late, manual)).toEqual([{ kind: 'forward', frame: late }]);
    expect(() => adapter.server({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value' } }, manual)).toThrow();
  });
  it('counts managed VAD input only from detected speech, and manual input until the response', () => {
    const vad = new OpenAIAdapter('gpt-realtime', 4096);
    vad.client({ type: 'session.update', session: { audio: { input: { turn_detection: { type: 'server_vad' } } } } }, { ...manual, ready: false, configuring: false });
    const append = { type: 'input_audio_buffer.append', audio: 'AAAA' };
    expect(vad.client(append, manual)).toMatchObject([{ kind: 'forward', input: false }]);
    vad.server({ type: 'input_audio_buffer.speech_started' }, manual);
    expect(vad.client(append, manual)).toMatchObject([{ kind: 'forward', input: true }]);
    expect(vad.server({ type: 'input_audio_buffer.committed', item_id: 'item-1' }, manual).map(effect => effect.kind)).toEqual(['forward', 'inputReset', 'generate']);
    expect(vad.client(append, manual)).toMatchObject([{ kind: 'forward', input: false }]);
    const manualMode = new OpenAIAdapter('gpt-realtime', 4096);
    expect(manualMode.client(append, manual)).toMatchObject([{ kind: 'forward', input: true }]);
    expect(manualMode.server({ type: 'input_audio_buffer.cleared' }, manual).map(effect => effect.kind)).toEqual(['forward']);
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
    const cloudflare = upstreamRequest('openai_realtime', 'gpt-realtime', 'fixture', routeThroughGateway({ id: 'g', type: 'cf_aig', config: { accountId: 'acct', gatewayId: 'gw' } }, null), { appId: 'app', userId: null });
    expect(cloudflare.url).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/openai?model=gpt-realtime');
    expect(cloudflare.headers.get('cf-aig-authorization')).toBe('Bearer fixture'); expect(cloudflare.headers.has('authorization')).toBe(false);
    expect(cloudflare.headers.get('sec-websocket-protocol')).toBe('realtime'); expect(JSON.parse(cloudflare.headers.get('cf-aig-metadata')!)).toEqual({ app_id: 'app' });
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
    const input = { now: Date.now(), rpm: 1, rpd: 1, monthlyBudgetMicrousd: null, spend: { appId: 'a', scope: 'app' as const, key: null }, admissionId: 'generation-1', freshSpend: true };
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
  it('requires opt-in, an official origin or Cloudflare AI Gateway, and a separately eligible model', async () => {
    const { bootstrap, provider } = await seeded(false); const application = await loadApp(env, bootstrap.appId);
    expect(() => realtimePolicy(application, provider, 'gpt-realtime')).toThrow();
    application.config.realtime.enabled = true;
    expect(() => realtimePolicy(application, { ...provider, baseUrl: 'https://example.test' }, 'gpt-realtime')).toThrow();
    expect(realtimePolicy(application, { ...provider, route: routeThroughGateway({ id: 'g', type: 'cf_aig', config: { accountId: 'acct', gatewayId: 'gw' } }, null) }, 'gpt-realtime').protocol).toBe('openai_realtime');
    expect(() => realtimePolicy(application, { ...provider, route: routeThroughGateway({ id: 'g', type: 'vercel', config: {} }, null) }, 'gpt-realtime')).toThrow(/Cloudflare AI Gateway/u);
    expect(realtimeProtocols('cf_aig', 'openai')).toEqual(['openai_realtime']); expect(realtimeProtocols('vercel', 'openai')).toEqual([]);
    expect(() => realtimePolicy(application, provider, 'gpt-5.6-sol')).toThrow();
    expect(realtimePolicy(application, provider, 'gpt-realtime').protocol).toBe('openai_realtime');
  });
  it('configures a Cloudflare AI Gateway session only once the provider has spoken', async () => {
    const { bootstrap, headers, provider } = await seeded(true, 'cf_aig');
    expect(provider.route.kind).toBe('cf_aig');
    const stub = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
    await runInDurableObject(stub, async (instance, state) => {
      const upstream = new WebSocketPair(); upstream[0].accept({ allowHalfOpen: true });
      const sent: string[] = [];
      upstream[0].addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as JsonObject; sent.push(String(frame.type));
        if (frame.type === 'session.update') upstream[0].send(JSON.stringify(ack()));
      });
      const coordinator = new SessionCoordinator(localSessionBackend(env, promise => state.waitUntil(promise)), state, bootstrap, headers);
      Reflect.set(instance, "coordinator", coordinator);
      const response = await coordinator.start(upstream[1]);
      const socket = response.webSocket!; const next = collector(socket); socket.accept({ allowHalfOpen: true });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(sent).toEqual([]);
      upstream[0].send(JSON.stringify({ type: 'session.created', session: {} }));
      await next('session.updated');
      expect(sent).toEqual(['session.update']);
      coordinator.terminate(null, 1000); socket.close(1000); upstream[0].close(1000);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
  });
  it('ordinary GET returns 426 before auth, URL credentials and forged metadata cannot open a session', async () => {
    const url = 'https://gateway.test/v1/apps/no-app/realtime/openai?model=gpt-realtime';
    const seamlessEnv = { ...env, REALTIME_RELEASES: 'seamless' };
    expect((await app.fetch(new Request(url), env)).status).toBe(426);
    expect((await app.fetch(new Request(url + '&key=secret', { headers: { Upgrade: 'websocket', 'x-realtime-bootstrap': '{}' } }), seamlessEnv)).status).toBe(409);
    expect((await app.fetch(new Request(url, { headers: { Upgrade: 'websocket', 'x-realtime-bootstrap': '{}' } }), seamlessEnv)).status).toBe(409);
    // A gateway that serves sessions itself authenticates the handshake first.
    // A gateway that serves sessions itself refuses them as discovery does.
    expect((await app.fetch(new Request(url + '&key=secret', { headers: { Upgrade: 'websocket' } }), env, createExecutionContext())).status).toBe(400);
    const forged = await app.fetch(new Request(url, { headers: { Upgrade: 'websocket', 'x-realtime-bootstrap': '{}' } }), env, createExecutionContext());
    expect(forged.status).toBe(401);
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
      const coordinator = new SessionCoordinator(localSessionBackend(env, promise => state.waitUntil(promise)), state, bootstrap, headers);
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

describe('immutable realtime release boundaries', () => {
  it('discovery plus ten opens charges separate bounded counters', async () => {
    const { bootstrap, headers } = await seeded();
    const request = new Request(`https://gateway.test/v1/apps/${bootstrap.appId}/realtime/${bootstrap.providerSlug}?model=gpt-realtime`, { headers });
    for (let index = 0; index < 10; index++) {
      await prepareRealtime(env, request, bootstrap.appId, bootstrap.providerSlug, bootstrap.origin, 'realtime_discover');
      await prepareRealtime(env, request, bootstrap.appId, bootstrap.providerSlug, bootstrap.origin);
    }
    await expect(prepareRealtime(env, request, bootstrap.appId, bootstrap.providerSlug, bootstrap.origin)).rejects.toMatchObject({ status: 429 });
    await prepareRealtime(env, request, bootstrap.appId, bootstrap.providerSlug, bootstrap.origin, 'realtime_discover');
  });
  it('awaits a real service-binding acknowledgement before completing admission', async () => {
    const { bootstrap } = await seeded();
    const application = await loadApp(env, bootstrap.appId);
    const backend = remoteSessionBackend(env.TEST_REALTIME_BACKEND);
    let acknowledged = false;
    await backend.admit(bootstrap, application, testAttribution({ model: 'gpt-realtime', apiStyle: 'other' }), crypto.randomUUID(), Date.now(), async claim => {
      expect(claim).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 20)); acknowledged = true;
    }, () => true);
    expect(acknowledged).toBe(true);
    let transientCalls = 0;
    await expect(backend.admit(bootstrap, application, testAttribution({ model: 'gpt-realtime', apiStyle: 'other' }), crypto.randomUUID(), Date.now(), () => {
      transientCalls++; throw Object.assign(new Error('private transient detail'), { retryable: true, overloaded: true });
    }, () => true)).rejects.toMatchObject({ message: 'Realtime backend unavailable', retryable: true, overloaded: true });
    expect(transientCalls).toBe(1); // Admission remains non-retryable even on transient failure.

    await expect(backend.admit(bootstrap, application, testAttribution({ model: 'gpt-realtime', apiStyle: 'other' }), crypto.randomUUID(), Date.now(), () => { throw new Error('closed'); }, () => true)).rejects.toThrow();
  });
  it('retries explicitly transient safe calls, preserves public errors, never retries policy', async () => {
    let calls = 0;
    expect(await safeBackendCall(async () => {
      calls++; if (calls < 3) throw Object.assign(new Error('private failure'), { retryable: true });
      return { ok: true, value: 'ready' };
    })).toBe('ready');
    expect(calls).toBe(3);
    calls = 0;
    await expect(safeBackendCall(async () => { calls++; return { ok: false, error: { status: 429, code: 'app_rate_limited', message: 'Wait', headers: { 'Retry-After': '30' }, data: { scope: 'app' } } }; })).rejects.toMatchObject({ status: 429, code: 'app_rate_limited', headers: { 'Retry-After': '30' }, data: { scope: 'app' } });
    expect(calls).toBe(1);
  });
  it('session objects answer refusals with their status instead of throwing them across the stub', async () => {
    const { bootstrap, headers } = await seeded();
    const forged = await env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId()).fetch('https://realtime.internal/', { headers: { Upgrade: 'websocket', 'x-realtime-bootstrap': '{}' } });
    expect(forged.status).toBe(400);
    const application = await loadApp(env, bootstrap.appId);
    application.config.realtime.max_concurrent_sessions_per_identity = 1;
    await database(env.DB).update(appTable).set({ config: application.config }).where(eq(appTable.id, bootstrap.appId)); clearIsolateCaches();
    expect(await env.USER_LIMITER.getByName(realtimeCaller(bootstrap.identity)).acquireSession('another-session', 1)).toMatchObject({ allowed: true });
    const full = await env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId()).fetch('https://realtime.internal/', {
      headers: { Upgrade: 'websocket', Authorization: headers.get('authorization')!, 'x-realtime-bootstrap': JSON.stringify(bootstrap) } });
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ error: { code: 'realtime_session_limit' } });
  });
  it('the companion handshake prepares over the service binding and keeps the refusal it gets', async () => {
    const { bootstrap, headers } = await seeded(); const id = crypto.randomUUID();
    const companionEnv = { BACKEND: env.TEST_REALTIME_BACKEND, REALTIME_SESSION: env.REALTIME_SESSION, REALTIME_RELEASE_ID: id, GATEWAY_ORIGIN: 'https://gateway.test' } as unknown as RealtimeEnv;
    const url = `https://release.test/v1/apps/${bootstrap.appId}/realtime/${bootstrap.providerSlug}?model=gpt-realtime`;
    const open = () => companion.fetch(new Request(url, { headers: { Upgrade: 'websocket', Authorization: headers.get('authorization')! } }), companionEnv);
    expect((await companion.fetch(new Request(url, { headers }), companionEnv)).status).toBe(426);
    expect((await (await open()).json())).toMatchObject({ error: { code: 'conflict' } });
    await env.DB.prepare('INSERT INTO realtime_release(id,worker_name,url,backend_contract,created_at) VALUES(?,?,?,1,?)').bind(id, id, 'wss://release.test', Date.now()).run();
    await env.DB.prepare('UPDATE gateway_release_state SET active_realtime_id=?,promotion_at=? WHERE singleton=1').bind(id, Date.now()).run();
    const application = await loadApp(env, bootstrap.appId);
    application.config.realtime.max_concurrent_sessions_per_identity = 1;
    await database(env.DB).update(appTable).set({ config: application.config }).where(eq(appTable.id, bootstrap.appId)); clearIsolateCaches();
    await env.USER_LIMITER.getByName(realtimeCaller(bootstrap.identity)).acquireSession('another-session', 1);
    const full = await open();
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ error: { code: 'realtime_session_limit' } });
    // Discovery through the gateway's own route names this release's socket.
    const discovered = await app.fetch(new Request(`https://gateway.test/v1/apps/${bootstrap.appId}/realtime/${bootstrap.providerSlug}/connection?model=gpt-realtime`, { headers }), { ...env, REALTIME_RELEASES: 'seamless' }, createExecutionContext());
    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toEqual({ releaseId: id, url: `wss://release.test/v1/apps/${bootstrap.appId}/realtime/${bootstrap.providerSlug}?model=gpt-realtime` });
  });
  it('a gateway that serves sessions itself names its own URL, whatever release is recorded', async () => {
    const { bootstrap, headers } = await seeded(); const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO realtime_release(id,worker_name,url,backend_contract,created_at) VALUES(?,?,?,1,?)').bind(id, id, 'wss://release.test', Date.now()).run();
    await env.DB.prepare('UPDATE gateway_release_state SET active_realtime_id=?,promotion_at=? WHERE singleton=1').bind(id, Date.now()).run();
    const discovery = `https://gateway.test/v1/apps/${bootstrap.appId}/realtime/${bootstrap.providerSlug}/connection?model=gpt-realtime`;
    const discovered = await app.fetch(new Request(discovery, { headers }), { ...env, GATEWAY_BUILD_ID: 'build-1' }, createExecutionContext());
    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toEqual({ releaseId: 'build-1', url: `wss://gateway.test/v1/apps/${bootstrap.appId}/realtime/${bootstrap.providerSlug}?model=gpt-realtime` });
  });
  it('rejects candidates and expired retirement for new opens while permitting existing maintenance', async () => {
    const { bootstrap, headers } = await seeded(); const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO realtime_release(id,worker_name,url,backend_contract,created_at) VALUES(?,?,?,1,?)').bind(id, id, 'wss://release.test', Date.now()).run();
    await expect(requireRealtimeAdmission(env.DB, id)).rejects.toMatchObject({ status: 409 });
    await env.DB.prepare('UPDATE gateway_release_state SET active_realtime_id=?,promotion_at=? WHERE singleton=1').bind(id, Date.now()).run();
    await requireRealtimeAdmission(env.DB, id);
    await env.DB.prepare('UPDATE realtime_release SET retired_at=? WHERE id=?').bind(Date.now() - 60_001, id).run();
    await expect(requireRealtimeAdmission(env.DB, id)).rejects.toMatchObject({ status: 409 });
    const backend = remoteSessionBackend(env.TEST_REALTIME_BACKEND);
    const access = await backend.revalidate(bootstrap, headers);
    await backend.maintain(bootstrap, access.app, false);
    await backend.persist(buildEventForReleaseTest(bootstrap));
  });
});
describe('realtime on an App Attest app that verifies every request', () => {
  async function attested() {
    clearIsolateCaches(); const appId = `realtime-attest-${crypto.randomUUID()}`;
    await seedApp(appId, { endUser: 'app_install' });
    await seedProvider({ type: 'openai', slug: appId, id: appId });
    const loaded = await loadApp(env, appId);
    loaded.config.realtime.enabled = true; loaded.config.routing.providers = { mode: 'all' };
    await database(env.DB).update(appTable).set({ config: loaded.config }).where(eq(appTable.id, appId));
    clearIsolateCaches();
    const install = await registerTestInstall(appId, 'install-user');
    const token = await tokenForInstall(install);
    const url = `https://gateway.test/v1/apps/${appId}/realtime/${appId}/connection?model=gpt-realtime`;
    const signed = async (counter = ++install.counter) => new Request(url, { headers: {
      Authorization: `Bearer ${token}`, 'x-app-version': '1.0.0',
      'x-appattest-proof': await signedProof({ appId, privateKey: install.privateKey, token, method: 'GET', url, counter }),
    } });
    return { appId, install, token, url, signed };
  }

  it('requires a proof on every handshake and refuses one replayed', async () => {
    const { appId, install, token, url, signed } = await attested();
    const unsigned = new Request(url, { headers: { Authorization: `Bearer ${token}`, 'x-app-version': '1.0.0' } });
    await expect(prepareRealtime(env, unsigned, appId, appId, 'https://gateway.test', 'realtime_discover')).rejects.toMatchObject({ status: 401, code: 'assertion_required' });
    const request = await signed();
    const { bootstrap, headers } = await prepareRealtime(env, new Request(request.url, { headers: request.headers }), appId, appId, 'https://gateway.test', 'realtime_discover');
    expect(bootstrap.identity).toMatchObject({ authMethod: 'attest', installId: install.keyId });
    // The session never holds the proof: it signed one request, and is spent.
    expect(headers.has('x-appattest-proof')).toBe(false);
    await expect(prepareRealtime(env, request, appId, appId, 'https://gateway.test', 'realtime_discover')).rejects.toMatchObject({ status: 403, code: 'attest_failed' });
    await prepareRealtime(env, await signed(), appId, appId, 'https://gateway.test');
  });

  it('ends a session whose install key is removed, and bounds the stored app version', async () => {
    const { appId, install, token, url } = await attested();
    const request = new Request(url, { headers: { Authorization: `Bearer ${token}`, 'x-app-version': 'v'.repeat(500),
      'x-appattest-proof': await signedProof({ appId, privateKey: install.privateKey, token, method: 'GET', url, counter: ++install.counter }) } });
    const { bootstrap, headers } = await prepareRealtime(env, request, appId, appId, 'https://gateway.test');
    expect(bootstrap.appVersion).toHaveLength(64);
    const backend = localSessionBackend(env, () => {});
    await backend.revalidate(bootstrap, headers);
    await env.DB.prepare('DELETE FROM app_attest_key WHERE app_id = ? AND key_id = ?').bind(appId, install.keyId).run();
    clearIsolateCaches();
    await expect(backend.revalidate(bootstrap, headers)).rejects.toMatchObject({ status: 403, code: 'attest_failed' });
  });

  it('revalidates the token without the spent proof and holds leases per install', async () => {
    const { appId, install, signed } = await attested();
    const { bootstrap, headers } = await prepareRealtime(env, await signed(), appId, appId, 'https://gateway.test');
    const backend = localSessionBackend(env, () => {});
    expect((await backend.revalidate(bootstrap, headers)).app.id).toBe(appId);
    expect(await backend.capacity(bootstrap, 'user', 'acquire', 1)).toMatchObject({ allowed: true });
    const installLimiter = env.USER_LIMITER.getByName(`${appId}:install:${install.keyId}`);
    expect(await installLimiter.acquireSession('another-session', 1)).toMatchObject({ allowed: false });
    await backend.capacity(bootstrap, 'user', 'release');
    expect(await installLimiter.acquireSession('another-session', 1)).toMatchObject({ allowed: true });
  });
});

function buildEventForReleaseTest(b: Bootstrap) {
  return buildUsageEvent({ organizationId: b.organizationId, identity: b.identity, attribution: testAttribution({ model: 'gpt-realtime', apiStyle: 'other' }), appVersion: null,
    status: 'ok', latencyMs: 1, contentType: 'application/json', observed: null, eventId: crypto.randomUUID(), createdAt: new Date().toISOString() });
}
