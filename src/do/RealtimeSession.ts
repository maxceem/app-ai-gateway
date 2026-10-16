import { DurableObject } from 'cloudflare:workers';
import { localSessionBackend } from '../realtime/local-backend';
import type { SessionCoordinator } from '../realtime/session';
import type { Bootstrap } from '../realtime/types';
import { object } from '../realtime/protocols/validation';
import { GatewayError, errorResponse } from '../core/errors';

/**
 * The session engine, loaded on first use: the gateway's cold start must not
 * pay for it on every HTTP request. This class holds sessions when the gateway
 * serves them itself; with seamless releases, the release Worker's own class
 * does, and this one serves only local development.
 */
const engine = () => Promise.all([import('../realtime/session'), import('../realtime/journal')])
  .then(([{ SessionCoordinator }, { SessionJournal }]) => ({ SessionCoordinator, SessionJournal }));

/** Binding-only per-connection owner. No route accepts a caller-selected object/session ID. */
export class RealtimeSession extends DurableObject<Env> {
  private coordinator: SessionCoordinator | null = null;
  override async fetch(request: Request): Promise<Response> {
    const { SessionCoordinator, SessionJournal } = await engine();
    // Answered here, not thrown: an error crossing the stub arrives as a plain
    // Error, and a refusal would lose its status, code and Retry-After.
    try {
      if (this.coordinator || new SessionJournal(this.ctx.storage).metadata()) throw new GatewayError(409, 'conflict', 'Realtime session cannot be reopened');
      const bootstrap = parseBootstrap(request.headers.get('x-realtime-bootstrap'));
      this.coordinator = new SessionCoordinator(localSessionBackend(this.env, promise => this.ctx.waitUntil(promise)), this.ctx, bootstrap, request.headers);
      return await this.coordinator.start();
    } catch (error) {
      if (error instanceof GatewayError) return errorResponse(error.status, error.code, error.message, error.headers, error.data);
      throw error;
    }
  }
  override async alarm(): Promise<void> {
    if (!this.coordinator) {
      const { SessionCoordinator, SessionJournal } = await engine();
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
  if (identity.appId !== value.appId || !['api_key', 'gateway_token'].includes(String(identity.credentialType)) || !['api_key', 'attest'].includes(String(identity.authMethod)) || (identity.userId !== null && typeof identity.userId !== 'string') || (identity.authMethod === 'attest' ? typeof identity.installId !== 'string' || !identity.installId : identity.installId !== null) || (identity.credentialType === 'gateway_token' && (typeof identity.expiresAt !== 'number' || !Number.isFinite(identity.expiresAt))) || !['openai_realtime', 'gemini_live'].includes(String(value.protocol)) || (value.appVersion !== null && typeof value.appVersion !== 'string')) throw new GatewayError(400, 'invalid_request', 'Invalid realtime identity');
  return value as unknown as Bootstrap;
}
