import { DurableObject } from 'cloudflare:workers';
import { localSessionBackend } from '../realtime/local-backend';
import { SessionCoordinator } from '../realtime/session';
import { SessionJournal } from '../realtime/journal';
import type { Bootstrap } from '../realtime/types';
import { object } from '../realtime/protocols/validation';
import { GatewayError } from '../core/errors';

/** Binding-only per-connection owner. No route accepts a caller-selected object/session ID. */
export class RealtimeSession extends DurableObject<Env> {
  private coordinator: SessionCoordinator | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    new SessionJournal(ctx.storage);
  }
  override async fetch(request: Request): Promise<Response> {
    if (this.coordinator || new SessionJournal(this.ctx.storage).metadata()) throw new GatewayError(409, 'conflict', 'Realtime session cannot be reopened');
    const bootstrap = parseBootstrap(request.headers.get('x-realtime-bootstrap'));
    this.coordinator = new SessionCoordinator(localSessionBackend(this.env, promise => this.ctx.waitUntil(promise)), this.ctx, bootstrap, request.headers);
    return this.coordinator.start();
  }
  override async alarm(): Promise<void> {
    if (!this.coordinator) {
      const bootstrap = new SessionJournal(this.ctx.storage).metadata();
      if (!bootstrap) { await this.ctx.storage.deleteAll(); return; }
      this.coordinator = new SessionCoordinator(localSessionBackend(this.env, promise => this.ctx.waitUntil(promise)), this.ctx, bootstrap, new Headers());
    }
    await this.coordinator.alarm();
  }
}
function parseBootstrap(raw: string | null): Bootstrap {
  if (!raw || raw.length > 8192) throw new GatewayError(400, 'invalid_request', 'Invalid realtime bootstrap');
  let value;
  try { value = object(JSON.parse(raw)); } catch { throw new GatewayError(400, 'invalid_request', 'Invalid realtime bootstrap'); }
  for (const field of ['sessionId', 'appId', 'organizationId', 'providerId', 'providerSlug', 'model', 'requestedModel', 'origin']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new GatewayError(400, 'invalid_request', 'Invalid realtime bootstrap');
  }
  const identity = object(value.identity);
  if (identity.appId !== value.appId || !['api_key', 'gateway_token'].includes(String(identity.credentialType)) || !['api_key', 'attest'].includes(String(identity.authMethod)) || (identity.userId !== null && typeof identity.userId !== 'string') || (identity.credentialType === 'gateway_token' && (typeof identity.expiresAt !== 'number' || !Number.isFinite(identity.expiresAt))) || !['openai_realtime', 'gemini_live'].includes(String(value.protocol)) || (value.appVersion !== null && typeof value.appVersion !== 'string')) throw new GatewayError(400, 'invalid_request', 'Invalid realtime identity');
  return value as unknown as Bootstrap;
}
