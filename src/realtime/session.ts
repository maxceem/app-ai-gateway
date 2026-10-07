import type { AppRecord } from '../core/types';
import { GatewayError } from '../core/errors';
import { log } from '../core/log';
import { cachedAppUserBlocked } from '../client-auth/user-status';
import { billingQuota } from '../billing/quota';
import { requireActiveBilling } from '../billing/gateway';
import { monthlyBudgetMicrousd } from '../shared/app-config';
import { monthlySpendMicrousd } from '../usage/app-usage-accounting';
import { authenticatedAccess } from '../execution/authenticated-access';
import { admitGeneration } from '../execution/admission';
import { requireProvider, type ResolvedProvider } from '../providers/provider-store';
import { resolveDeployment } from '../policy/deployment';
import { DIRECT_ROUTE } from '../providers/route-adapters';
import { buildUsageEvent, persistUsageEventAcknowledged, markUsageApiKeyUsed, type AttemptAttribution, type UsageEvent } from '../usage/usage-record';
import { computeCost } from '../usage/pricing';
import { realtimePolicy } from './policy';
import { REALTIME_LIMITS as L } from './limits';
import { SessionJournal } from './journal';
import { Mailbox, close, frameBytes, send } from './transport';
import { protocolAdapter, upstreamRequest } from './upstream';
import { id, object, invalid } from './protocols/validation';
import type { AdapterEffect, Bootstrap, CompletionStatus, Generation, JsonObject, ProtocolAdapter } from './types';

export class SessionCoordinator {
  private app: AppRecord | null = null;
  private provider: ResolvedProvider | null = null;
  private adapter: ProtocolAdapter | null = null;
  private client: WebSocket | null = null;
  private upstream: WebSocket | null = null;
  private active: Generation | null = null;
  private ready = false;
  private configuring = true;
  private terminating = false;
  private closed = false;
  private cleaned = false;
  private ordinal = 0;
  private inputBytes = 0;
  private inputStarted: number | null = null;
  private lastActivity = Date.now();
  private openedAt = Date.now();
  private expiresAt = 0;
  private nextMaintenance = Date.now() + L.revalidateMs;
  private leaseExpiry = 0;
  private pendingAuto: Extract<AdapterEffect, { kind: 'pendingAuto' }> | null = null;
  private generationIds = new Map<string, string>();
  private recentIds = new Map<string, string>();
  private terminalResponses = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private configurationAt = Date.now();
  private alarmDue: number | null = null;
  private authPolicy: string | null = null;
  private maintenance: Promise<void> | null = null;
  private flushing: Promise<boolean> | null = null;
  private releasing: Promise<void> | null = null;
  private shuttingDown: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private drainUntil = 0;
  private mailbox: Mailbox;
  private authHeaders: Headers;
  readonly journal: SessionJournal;

  constructor(private env: Env, private ctx: DurableObjectState, readonly bootstrap: Bootstrap, headers: Headers) {
    this.authHeaders = new Headers(headers);
    this.journal = new SessionJournal(ctx.storage);
    this.mailbox = new Mailbox(() => this.terminate(new GatewayError(413, 'payload_too_large', 'Realtime queue limit exceeded'), 1009), error => this.fail(error));
  }

  private live(): boolean { return !this.terminating && !this.closed && Date.now() < this.expiresAt && Date.now() < this.leaseExpiry - L.leaseSafetyMs; }
  private userLeaseKey(): string {
    const identity = this.bootstrap.identity;
    return identity.userId === null
      ? `${identity.appId}:realtime:key:${identity.apiKeyId}`
      : `${identity.appId}:${identity.userId}`;
  }
  private userLimiter() { return this.env.USER_LIMITER.getByName(this.userLeaseKey()); }
  private appLimiter() { return this.env.USER_LIMITER.getByName(this.bootstrap.appId); }

  async start(testUpstream?: WebSocket): Promise<Response> {
    if (this.journal.metadata()) throw new GatewayError(409, 'conflict', 'A realtime object cannot be reopened');
    await this.revalidate();
    const app = this.app!;
    this.openedAt = Date.now();
    this.lastActivity = this.openedAt;
    this.expiresAt = Math.min(this.openedAt + app.config.realtime.max_session_seconds * 1000, this.bootstrap.identity.expiresAt ?? Infinity);
    this.journal.open(this.bootstrap);
    let finishStarting!: () => void;
    this.starting = new Promise<void>(resolve => { finishStarting = resolve; });
    try {
      // Schedule crash recovery before external effects. Leases expire independently in their owners.
      await this.ctx.storage.setAlarm(this.openedAt + L.setupMs);
      this.requireStarting();
      const user = await this.userLimiter().acquireSession(this.bootstrap.sessionId, app.config.realtime.max_concurrent_sessions_per_identity);
      if (!user.allowed) throw new GatewayError(429, 'realtime_session_limit', 'Realtime identity capacity exceeded');
      this.requireStarting();
      const application = await this.appLimiter().acquireSession(this.bootstrap.sessionId, app.config.realtime.max_concurrent_sessions);
      if (!application.allowed) throw new GatewayError(429, 'realtime_session_limit', 'Realtime app capacity exceeded');
      this.leaseExpiry = Math.min(user.expiresAt, application.expiresAt);
      this.requireStarting();
      const provider = this.provider!;
      const policy = realtimePolicy(app, provider, this.bootstrap.requestedModel);
      this.adapter = protocolAdapter(policy.protocol, policy.model, policy.outputCap);
      if (testUpstream) this.upstream = testUpstream;
      else {
        const request = upstreamRequest(policy.protocol, policy.model, provider.secret);
        const response = await fetch(request, { signal: AbortSignal.timeout(L.setupMs) });
        if (response.status !== 101 || !response.webSocket) throw new GatewayError(502, 'provider_error', 'Realtime provider upgrade failed');
        this.upstream = response.webSocket;
      }
      this.upstream.accept({ allowHalfOpen: true });
      this.requireStarting();
      const pair = new WebSocketPair(); this.client = pair[1];
      this.client.accept({ allowHalfOpen: true });
      this.attach(this.client, 'client'); this.attach(this.upstream, 'server');
      this.configurationAt = Date.now();
      const initial = this.adapter.initial();
      if (initial) send(this.upstream, initial);
      await this.schedule();
      this.requireStarting();
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'x-gateway-session-id': this.bootstrap.sessionId } });
    } catch (error) {
      this.terminating = true; close(this.client, 1011); close(this.upstream, 1011); this.closed = true;
      await this.release(); await this.schedule(); throw error;
    } finally { finishStarting(); this.starting = null; }
  }

  private requireStarting(): void {
    if (this.terminating || this.closed || Date.now() >= this.expiresAt || Date.now() >= this.openedAt + L.setupMs) {
      throw new GatewayError(504, 'provider_error', 'Realtime setup expired');
    }
  }

  private async revalidate(): Promise<void> {
    const b = this.bootstrap;
    const access = await authenticatedAccess({ env: this.env, deployment: resolveDeployment(this.env, b.origin), appId: b.appId, headers: this.authHeaders, providerSlug: b.providerSlug });
    if (access.app.organizationId !== b.organizationId || JSON.stringify(access.identity) !== JSON.stringify(b.identity)) throw new GatewayError(401, 'auth_required', 'Realtime identity changed');
    const authentication = JSON.stringify(access.app.config.authentication);
    if (this.authPolicy !== null && authentication !== this.authPolicy) throw new GatewayError(401, 'auth_required', 'Realtime authentication policy changed; reconnect');
    if (b.identity.userId !== null && await cachedAppUserBlocked(this.env.DB, b.appId, b.identity.userId)) throw new GatewayError(403, 'auth_required', 'User is blocked');
    const provider = await requireProvider(this.env, b.organizationId, b.providerSlug);
    if (this.provider && provider.secret !== this.provider.secret) throw new GatewayError(403, 'provider_not_configured', 'Realtime provider credential changed; reconnect');
    if (provider.id !== b.providerId) throw new GatewayError(403, 'provider_not_configured', 'Realtime provider identity changed');
    const policy = realtimePolicy(access.app, provider, b.requestedModel);
    if (policy.model !== b.model || policy.protocol !== b.protocol) throw new GatewayError(403, 'model_not_allowed', 'Realtime model policy changed');
    if (this.app) {
      const previous = realtimePolicy(this.app, this.provider!, b.requestedModel);
      if (policy.outputCap < previous.outputCap) throw new GatewayError(403, 'max_output_tokens_exceeded', 'Realtime output policy changed; reconnect');
    }
    this.authPolicy = authentication; this.app = access.app; this.provider = provider;
  }

  private attach(socket: WebSocket, source: 'client' | 'server'): void {
    socket.addEventListener('message', event => {
      if (source === 'client' && this.terminating) return;
      if (typeof event.data !== 'string') { this.terminate(new GatewayError(400, 'realtime_protocol_error', 'Binary realtime frames are unsupported'), 1008); return; }
      const bytes = frameBytes(event.data);
      if (bytes > (source === 'client' ? L.clientFrameBytes : L.providerFrameBytes)) { this.terminate(new GatewayError(413, 'payload_too_large', 'Realtime frame limit exceeded'), 1009); return; }
      if (source === 'server' && this.active) {
        this.active.outputBytes += bytes;
        if (this.active.outputBytes > L.generationOutputBytes) { this.terminate(new GatewayError(413, 'payload_too_large', 'Realtime output limit exceeded'), 1009); return; }
      }
      const raw = event.data;
      this.ctx.waitUntil(this.mailbox.push(bytes, async () => {
        if (this.closed || (source === 'client' && !this.live())) return;
        let frame: JsonObject;
        try { frame = object(JSON.parse(raw)); } catch { return invalid('Invalid realtime JSON frame'); }
        if (source === 'client') {
          if (frame.event_id !== undefined) {
            const eventId = id(frame.event_id);
            const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), byte => byte.toString(16).padStart(2, '0')).join('');
            const previous = this.generationIds.get(eventId) ?? this.recentIds.get(eventId);
            if (previous !== undefined) {
              if (previous !== fingerprint) invalid('Event identifier was reused with different content');
              return;
            }
            // Generation triggers remain protected for the entire connection.
            // Audio and other traffic use a bounded recent window, not a lifetime cap.
            if (frame.type === 'response.create') {
              if (this.generationIds.size >= L.generations) invalid('Realtime generation limit exceeded');
              this.generationIds.set(eventId, fingerprint);
            } else {
              this.recentIds.set(eventId, fingerprint);
              if (this.recentIds.size > 4096) this.recentIds.delete(this.recentIds.keys().next().value!);
            }
          }
        } else if (frame.type === 'response.done') {
          const responseId = id(object(frame.response).id);
          if (this.terminalResponses.has(responseId)) return;
        }
        const state = { ready: this.ready, configuring: this.configuring, active: this.active !== null, responseId: this.active?.responseId ?? null };
        const effects = source === 'client' ? this.adapter!.client(frame, state) : this.adapter!.server(frame, state);
        for (const effect of effects) await this.effect(effect, source, bytes);
        await this.schedule();
      }));
    });
    socket.addEventListener('close', () => this.terminate(null, source === 'client' ? 1000 : 1011));
    socket.addEventListener('error', () => this.terminate(new GatewayError(502, 'provider_error', 'Realtime transport failed'), 1011));
  }

  private async effect(effect: AdapterEffect, source: 'client' | 'server', bytes: number): Promise<void> {
    switch (effect.kind) {
      case 'ready': this.ready = true; this.configuring = false; return;
      case 'configure':
        this.configuring = true; this.ready = false; this.configurationAt = Date.now(); send(this.upstream, effect.frame); return;
      case 'forward':
        if (source === 'client') {
          if (!this.live()) return;
          if (effect.input) {
            this.inputBytes += bytes;
            if (this.inputStarted === null) this.inputStarted = Date.now();
            if (this.inputBytes > L.turnInputBytes) throw new GatewayError(413, 'payload_too_large', 'Realtime turn input limit exceeded');
          }
          if (effect.useful) this.lastActivity = Date.now();
          send(this.upstream, effect.frame);
          if (effect.endInput) this.inputStarted = null;
        } else send(this.client, effect.frame);
        return;
      case 'generate': await this.generate(effect.frame, effect.inputActivity === true); return;
      case 'pendingAuto':
        if (this.pendingAuto) invalid('Realtime automatic turn backlog exceeded');
        this.pendingAuto = effect; return;
      case 'cancel': { const frame = this.adapter!.cancel(); if (frame) send(this.upstream, frame); else this.terminate(null, 1000); return; }
      case 'created':
        if (!this.active) invalid('Unadmitted response');
        this.active.responseId = effect.responseId; this.active.stage = 'active'; this.journal.save(this.active); return;
      case 'observe':
        if (!this.active) invalid('Unattributed usage');
        this.active.observation = effect.usage; this.journal.save(this.active); return;
      case 'finalize': {
        const generation = this.active;
        if (!generation) invalid('Unadmitted terminal response');
        generation.observation = effect.usage;
        const event = settledEvent(generation, effect.status, this.terminating);
        // SQLite settlement precedes terminal forwarding. D1 settlement gates the next turn.
        this.journal.settle(generation, event); this.terminalResponses.add(effect.responseId); this.active = null;
        await this.schedule(); send(this.client, effect.frame);
        if (event.row.costSource === 'unresolved') { this.terminate(new GatewayError(502, 'realtime_usage_unresolved', 'Provider usage is missing or inconsistent'), 1011); }
        const persisted = await this.flush();
        if (!persisted) this.terminate(new GatewayError(503, 'provider_unavailable', 'Realtime usage recording failed'), 1011);
        const pending = this.pendingAuto; this.pendingAuto = null;
        if (pending && this.live()) await this.generate(pending.frame);
        return;
      }
    }
  }

  private async generate(frame: JsonObject, inputActivity = false): Promise<void> {
    if (!this.live()) return;
    if (this.active || this.pendingAuto) invalid('Only one active realtime generation is permitted');
    if (this.ordinal >= L.generations) invalid('Realtime generation limit exceeded');
    if (!(await this.flush())) throw new GatewayError(503, 'provider_unavailable', 'Previous realtime usage is not settled');
    if (!this.live()) return;
    await this.revalidate();
    if (!this.live()) return;
    const provider = this.provider!; const app = this.app!;
    const policy = realtimePolicy(app, provider, this.bootstrap.requestedModel);
    const attribution: AttemptAttribution = { provider: provider.type, providerId: provider.id, providerSlug: provider.slug, providerRoute: DIRECT_ROUTE,
      pricing: provider.pricing, model: policy.model, apiStyle: 'other', route: `${provider.slug}/${policy.path}` };
    const at = Date.now(); const generationId = crypto.randomUUID();
    const event = buildUsageEvent({ organizationId: app.organizationId, identity: this.bootstrap.identity, attribution, appVersion: this.bootstrap.appVersion,
      status: 'ok', latencyMs: 0, contentType: 'application/json', observed: null, eventId: generationId, createdAt: new Date(at).toISOString(),
      realtime: { sessionId: this.bootstrap.sessionId, generationId, protocol: this.bootstrap.protocol, providerResponseId: null, completionStatus: 'interrupted' } });
    const intent = { kind: typeof frame.type === 'string' ? frame.type : inputActivity ? 'gemini.activityStart' : 'gemini.clientContent',
      fingerprint: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(frame)))), byte => byte.toString(16).padStart(2, '0')).join('') };
    if (!this.live()) return;
    const generation: Generation = { intent, id: generationId, ordinal: ++this.ordinal, at, stage: 'prepared', responseId: null, observation: null, outputBytes: 0, price: policy.price, event };
    this.active = generation; this.journal.save(generation);
    generation.stage = 'admitting'; this.journal.save(generation);
    try {
      await admitGeneration({ env: this.env, deployment: resolveDeployment(this.env, this.bootstrap.origin), billingCache: new Map(), app, identity: this.bootstrap.identity,
        attribution, endpointSlug: null, appVersion: this.bootstrap.appVersion, admissionId: generationId, now: at, freshSpend: true,
        waitUntil: promise => this.ctx.waitUntil(promise), mayContinue: () => this.live(),
        beforeClaim: claim => { generation.claim = claim; this.journal.save(generation); } });
      // Persist acceptance even if disconnect occurred during the claim RPC. It was counted.
      generation.stage = 'admitted'; this.journal.save(generation);
      if (!this.live()) return;
      generation.stage = 'dispatching'; this.journal.save(generation);
      send(this.upstream, frame);
      this.inputBytes = 0; this.inputStarted = inputActivity ? at : null; this.lastActivity = Date.now();
    } catch (error) {
      // Once admitted, a failed/ambiguous send still belongs to that counted
      // attempt, including unmetered sessions with no hosted claim receipt.
      if (generation.stage === 'admitting') {
        if (generation.claim) {
          // An RPC can fail after committing. Read only; never resend the trigger.
          let receipt;
          try { receipt = await this.env.ORG_QUOTA.getByName(app.organizationId).receipt(generation.id); } catch { /* alarm will reconcile */ }
          if (receipt?.allowed) generation.stage = 'admitted';
          else if (receipt) generation.stage = 'refused';
        } else generation.stage = 'refused';
      }
      this.journal.save(generation); this.fail(error);
    }
  }

  private fail(error: unknown): void {
    const known = error instanceof GatewayError ? error : new GatewayError(502, 'provider_error', 'Realtime session failed');
    this.terminate(known, known.code === 'payload_too_large' ? 1009 : known.status < 500 ? 1008 : 1011);
  }
  terminate(error: GatewayError | null, code: number): void {
    if (this.terminating) return;
    this.terminating = true;
    if (this.timer) clearTimeout(this.timer);
    // Termination is immediate even while the serial mailbox awaits a quota/DB RPC.
    // Install cleanup before best-effort writes to an already failing transport.
    this.drainUntil = Date.now() + (this.active ? L.drainMs : 0);
    setTimeout(() => {
      close(this.upstream, code); this.closed = true;
      this.ctx.waitUntil(this.shutdown());
    }, Math.max(0, this.drainUntil - Date.now()));
    this.ctx.waitUntil(this.schedule());
    try {
      if (error) send(this.client, { type: 'gateway.error', error: { code: error.code, message: error.message,
        ...(new Headers(error.headers).get('Retry-After') ? { retry_after_seconds: Number(new Headers(error.headers).get('Retry-After')) } : {}) }, session_id: this.bootstrap.sessionId, generation_id: this.active?.id ?? null });
    } catch { /* Reporting must never prevent cleanup. */ }
    close(this.client, code);
    try { if (this.active && this.adapter) { const cancel = this.adapter.cancel(); if (cancel) send(this.upstream, cancel); } }
    catch { /* Cancellation must never prevent closing the provider transport. */ }
  }

  private shutdown(): Promise<void> {
    if (this.cleaned) return Promise.resolve();
    if (this.shuttingDown) return this.shuttingDown;
    this.shuttingDown = (async () => {
      try {
        await this.starting;
        // A pending upgrade may have supplied a socket after the first close.
        close(this.upstream, 1011);
        // Capacity cleanup does not wait for an in-flight accounting/admission RPC.
        await Promise.all([this.release(), this.mailbox.afterDrain(async () => { await this.recover(); await this.flush(); })]);
      } finally { await this.schedule(); }
    })().finally(() => { this.shuttingDown = null; });
    return this.shuttingDown;
  }
  private release(): Promise<void> {
    if (this.releasing) return this.releasing;
    this.releasing = Promise.all(['user', 'app'].map(async scope => {
      const name = scope === 'user' ? 'release:user' : 'release:app';
      const task = this.journal.task(name);
      if (task.complete) return;
      if (task.expiresAt === undefined) {
        task.expiresAt = Date.now() + L.outboxRetentionMs; this.journal.saveTask(name, task);
      }
      if (Date.now() >= task.expiresAt) {
        log('error', 'realtime_lease_cleanup_expired', { sessionId: this.bootstrap.sessionId, scope });
        task.complete = true; this.journal.saveTask(name, task); return;
      }
      if (task.due > Date.now()) return;
      try {
        await (scope === 'user' ? this.userLimiter() : this.appLimiter()).releaseSession(this.bootstrap.sessionId);
        task.complete = true; this.journal.saveTask(name, task);
      } catch { this.journal.retryTask(name, task); }
    })).then(() => {}).finally(() => { this.releasing = null; });
    return this.releasing;
  }
  private flush(): Promise<boolean> {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().finally(() => { this.flushing = null; }); return this.flushing;
  }
  private async deliver(): Promise<boolean> {
    let complete = true;
    for (const item of this.journal.outbox()) {
      if (Date.now() - item.createdAt >= L.outboxRetentionMs) {
        log('error', 'realtime_usage_permanent_failure', { sessionId: this.bootstrap.sessionId, eventId: item.id });
        this.journal.acknowledged(item.id); continue;
      }
      if (item.due > Date.now()) { complete = false; continue; }
      try {
        const result = await persistUsageEventAcknowledged(this.env, item.event);
        this.journal.acknowledged(item.id);
        if (result === 'stored') this.ctx.waitUntil(markUsageApiKeyUsed(this.env, item.event));
      }
      catch { this.journal.retry(item); complete = false; log('error', 'realtime_usage_retry', { sessionId: this.bootstrap.sessionId, eventId: item.id }); }
    }
    return complete;
  }

  /** Restarts never restore sockets or issue admission/dispatch calls. */
  async recover(): Promise<void> {
    this.active = null;
    const task = this.journal.task('admission');
    let pending = false;
    for (const generation of this.journal.generations()) {
      if (generation.stage === 'settled' || generation.stage === 'refused') continue;
      if (generation.stage === 'prepared' || (generation.stage === 'admitting' && !generation.claim)) {
        generation.stage = 'refused'; this.journal.save(generation); continue;
      }
      if (generation.stage === 'admitting') {
        if (task.due > Date.now() && Date.now() - generation.at < L.outboxRetentionMs) { pending = true; continue; }
        try {
          const receipt = await this.env.ORG_QUOTA.getByName(this.bootstrap.organizationId).receipt(generation.id);
          if (!receipt) {
            if (Date.now() - generation.at < L.outboxRetentionMs) { pending = true; continue; }
            log('error', 'realtime_admission_accounting_gap', { sessionId: this.bootstrap.sessionId, generationId: generation.id });
            generation.stage = 'refused'; this.journal.save(generation); continue;
          }
          if (!receipt.allowed) { generation.stage = 'refused'; this.journal.save(generation); continue; }
        } catch {
          if (Date.now() - generation.at < L.outboxRetentionMs) { pending = true; continue; }
          log("error", "realtime_admission_accounting_gap", { sessionId: this.bootstrap.sessionId, generationId: generation.id });
          generation.stage = "refused"; this.journal.save(generation); continue;
        }
      }
      this.journal.settle(generation, settledEvent(generation, 'interrupted', true));
    }
    if (pending && task.due <= Date.now()) this.journal.retryTask('admission', task);
  }

  private async maintain(): Promise<void> {
    if (!this.live()) return;
    await this.revalidate();
    // Read-only availability checks: maintenance never spends inference counters.
    const quota = await billingQuota(resolveDeployment(this.env, this.bootstrap.origin), this.env, this.bootstrap.organizationId, new Map());
    requireActiveBilling(quota.access);
    if (!this.active && quota.kind === 'metered' && await this.env.ORG_QUOTA.getByName(this.bootstrap.organizationId).usage(quota.period.periodId) >= quota.limit && !this.active) {
      throw new GatewayError(429, 'billing_request_quota_exceeded', 'Request allowance exhausted');
    }
    const month = new Date().toISOString().slice(0, 7);
    for (const userKey of [null, this.bootstrap.identity.userId]) {
      const scope = userKey === null ? this.app!.config.limits.per_app : this.app!.config.limits.per_user;
      const budget = monthlyBudgetMicrousd(scope);
      if (!this.active && budget !== null && await monthlySpendMicrousd(this.env.DB, { appId: this.bootstrap.appId, userKey }, month) >= budget && !this.active) {
        throw new GatewayError(429, 'app_budget_exhausted', 'Application spending budget exhausted');
      }
      if (this.bootstrap.identity.userId === null) break;
    }
    if (!this.live()) return;
    const [user, app] = await Promise.all([this.userLimiter().renewSession(this.bootstrap.sessionId), this.appLimiter().renewSession(this.bootstrap.sessionId)]);
    if (!this.live() || !user.allowed || !app.allowed) throw new GatewayError(429, 'realtime_session_limit', 'Realtime capacity lease expired');
    this.leaseExpiry = Math.min(user.expiresAt, app.expiresAt); this.nextMaintenance = Date.now() + L.revalidateMs;
  }
  private deadline(): number {
    return Math.min(this.expiresAt, this.leaseExpiry - L.leaseSafetyMs,
      this.configuring ? this.configurationAt + L.setupMs : Infinity,
      this.lastActivity + L.idleMs, this.inputStarted === null ? Infinity : this.inputStarted + L.inputMs,
      this.active && ['admitted', 'dispatching', 'active'].includes(this.active.stage) ? this.active.at + L.responseMs : Infinity);
  }
  private async schedule(): Promise<void> {
    if (this.cleaned) return;
    const now = Date.now();
    const live = !this.closed && !this.terminating;
    let due: number;
    if (live) {
      // The socket path uses only scalar state. Completed generations are never
      // reread for audio deltas, and extending a deadline keeps the earlier alarm.
      due = Math.min(this.deadline(), this.maintenance ? Infinity : this.nextMaintenance);
      if (this.alarmDue !== null && this.alarmDue <= due && this.timer !== null) return;
    } else {
      const pending = this.journal.outbox().map(item => Math.min(item.due, item.createdAt + L.outboxRetentionMs));
      for (const generation of this.journal.generations()) {
        if (generation.stage === 'admitting' && generation.claim) pending.push(Math.min(this.journal.task('admission').due, generation.at + L.outboxRetentionMs));
      }
      for (const name of ['release:user', 'release:app'] as const) {
        const task = this.journal.task(name); if (!task.complete) pending.push(Math.min(task.due, task.expiresAt ?? Infinity));
      }
      due = !this.closed ? this.drainUntil : pending.length ? Math.min(...pending) : now + 60_000;
    }
    due = Math.max(now + 1, due);
    if (this.alarmDue === due) return;
    this.alarmDue = due;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.ctx.storage.setAlarm(due);
    if (this.alarmDue !== due || !live || this.terminating) return;
    this.timer = setTimeout(() => {
      this.timer = null; this.alarmDue = null;
      this.tick(); this.ctx.waitUntil(this.schedule());
    }, Math.max(1, due - Date.now()));
  }
  private tick(): void {
    if (this.terminating) return;
    if (Date.now() >= this.deadline()) {
      const expired = Date.now() >= this.expiresAt;
      this.terminate(new GatewayError(expired ? 401 : 408, expired ? 'auth_required' : 'realtime_protocol_error', expired ? 'Realtime session expired' : 'Realtime deadline exceeded'), expired ? 1000 : 1008); return;
    }
    if (!this.maintenance && Date.now() >= this.nextMaintenance) {
      this.maintenance = this.maintain().catch(error => this.fail(error)).finally(() => { this.maintenance = null; this.ctx.waitUntil(this.schedule()); });
      this.ctx.waitUntil(this.maintenance);
    }
  }
  async alarm(): Promise<void> {
    if (this.cleaned) return;
    this.alarmDue = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.closed && !this.terminating && this.client) { this.tick(); await this.schedule(); return; }
    // A reconstructed object has no sockets or live credentials, and is closed by definition.
    close(this.client, 1000); close(this.upstream, 1011);
    this.closed = true; this.terminating = true;
    await this.shutdown();
    const pending = this.journal.outbox().length > 0 || this.journal.generations().some(generation => generation.stage === 'admitting')
      || !this.journal.task('release:user').complete || !this.journal.task('release:app').complete;
    if (!pending) { this.cleaned = true; await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); return; }
    await this.schedule();
  }
}

export function settledEvent(generation: Generation, status: CompletionStatus, aborted: boolean): UsageEvent {
  const usage = generation.observation;
  const cost = usage ? computeCost(generation.event.row.providerType as 'openai' | 'gemini', generation.event.row.model, usage, { [generation.event.row.model]: generation.price as import('../db/schema').ProviderPricing[string] }) : null;
  return { ...generation.event, row: { ...generation.event.row,
    inputTokens: usage?.inputTokens ?? 0, cachedInputTokens: usage?.cachedInputTokens ?? 0, cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0, modalityTokens: usage?.modalityTokens ?? {},
    costUsd: cost ?? 0, costSource: cost === null ? 'unresolved' : 'computed', providerResponseId: generation.responseId,
    completionStatus: status, status: status === 'failed' ? 'provider_error' : 'ok', clientAborted: aborted ? 1 : null,
    latencyMs: Math.max(0, Date.now() - generation.at),
  } };
}
