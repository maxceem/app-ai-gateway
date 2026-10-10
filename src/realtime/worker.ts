import { DurableObject } from 'cloudflare:workers';
import { SessionCoordinator } from './session';
import { SessionJournal } from './journal';
import { remoteSessionBackend, unwrapBackend } from './remote-backend';
import { REALTIME_BACKEND_CONTRACT } from './backend';
import type { Bootstrap } from './types';
import { GatewayError, errorResponse } from '../core/errors';

/** The immutable release owns sockets and metadata-only recovery, never account secrets. */
export class RealtimeSession extends DurableObject<RealtimeEnv> {
  private coordinator: SessionCoordinator | null = null;
  override async fetch(request: Request): Promise<Response> {
    if (this.coordinator || new SessionJournal(this.ctx.storage).metadata()) throw new GatewayError(409, 'conflict', 'Realtime session cannot be reopened');
    // This URL exists only between this Worker's fetch handler and its own namespace.
    const b = JSON.parse(request.headers.get('x-realtime-bootstrap')!) as Bootstrap;
    this.coordinator = new SessionCoordinator(remoteSessionBackend(this.env.BACKEND), this.ctx, b, request.headers);
    return this.coordinator.start();
  }
  override async alarm(): Promise<void> {
    if (!this.coordinator) {
      const bootstrap = new SessionJournal(this.ctx.storage).metadata();
      if (!bootstrap) { await this.ctx.storage.deleteAll(); return; }
      this.coordinator = new SessionCoordinator(remoteSessionBackend(this.env.BACKEND), this.ctx, bootstrap, new Headers());
    }
    await this.coordinator.alarm();
  }
}
export default {
  async fetch(request: Request, env: RealtimeEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/v1/healthz') return Response.json({ ok: true, releaseId: env.REALTIME_RELEASE_ID, backendContract: REALTIME_BACKEND_CONTRACT }, { headers: { 'Cache-Control': 'no-store' } });
      const route = /^\/v1\/apps\/([^/]+)\/realtime\/([^/]+)$/u.exec(url.pathname);
      if (!route) return errorResponse(404, 'invalid_request', 'Route not found');
      if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new GatewayError(426, 'upgrade_required', 'A WebSocket upgrade is required');
      const { bootstrap, headers } = unwrapBackend(await env.BACKEND.prepare(REALTIME_BACKEND_CONTRACT, env.REALTIME_RELEASE_ID, request, decodeURIComponent(route[1]!), decodeURIComponent(route[2]!), env.GATEWAY_ORIGIN));
      return env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId()).fetch(new Request('https://realtime.internal/', { headers: { ...Object.fromEntries(headers), 'x-realtime-bootstrap': JSON.stringify(bootstrap) } }));
    } catch (error) {
      if (error instanceof GatewayError) return errorResponse(error.status, error.code, error.message, error.headers, error.data);
      return errorResponse(503, 'provider_unavailable', 'Realtime backend unavailable');
    }
  },
} satisfies ExportedHandler<RealtimeEnv>;
