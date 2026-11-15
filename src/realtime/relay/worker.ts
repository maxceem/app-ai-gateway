import { DurableObject } from "cloudflare:workers";
import { SessionCoordinator } from "./session";
import { SessionJournal } from "./journal";
import { sessionBackend, unwrapBackend } from "./backend";
import { REALTIME_BACKEND_CONTRACT, type Bootstrap, type RealtimeBackendCalls } from "./contract";
import { RelayError, errorResponse } from "./errors";
import { bootstrapHeader, readBootstrapHeader } from "./bootstrap";

/**
 * The gateway's side of the binding. The generated type names the gateway's
 * class, so it is read here as the contract both sides compile against.
 */
function gateway(env: RealtimeEnv): RealtimeBackendCalls {
  return env.BACKEND as unknown as RealtimeBackendCalls;
}

/**
 * The realtime Worker: one release of it, kept unchanged while it serves.
 *
 * It owns the sockets and metadata-only recovery, and asks the gateway for
 * everything else through `RealtimeBackendCalls`. It runs no gateway code, so
 * it is reused across gateway releases and price updates. A test keeps it that
 * way: nothing under `src/realtime/relay/` imports code from outside it.
 *
 * It holds a provider secret only in memory, to open the upstream socket, and
 * never stores one: secrets stay in the gateway's vault.
 */
export class RealtimeSession extends DurableObject<RealtimeEnv> {
  private coordinator: SessionCoordinator | null = null;

  override async fetch(request: Request): Promise<Response> {
    // Answered here, not thrown: an error crossing the stub arrives as a plain
    // Error, and a refusal would lose its status, code and Retry-After.
    try {
      if (this.coordinator || new SessionJournal(this.ctx.storage).metadata()) {
        throw new RelayError(409, "conflict", "Realtime session cannot be reopened");
      }
      // This URL exists only between this Worker's fetch handler and its own namespace.
      const b = readBootstrapHeader(request.headers.get("x-realtime-bootstrap")!) as Bootstrap;
      this.coordinator = new SessionCoordinator(
        sessionBackend(gateway(this.env)),
        this.ctx,
        b,
        request.headers,
      );
      return await this.coordinator.start();
    } catch (error) {
      if (error instanceof RelayError) return errorResponse(error);
      throw error;
    }
  }

  override async alarm(): Promise<void> {
    if (!this.coordinator) {
      const bootstrap = new SessionJournal(this.ctx.storage).metadata();
      if (!bootstrap) {
        await this.ctx.storage.deleteAll();
        return;
      }
      this.coordinator = new SessionCoordinator(
        sessionBackend(gateway(this.env)),
        this.ctx,
        bootstrap,
        new Headers(),
      );
    }
    await this.coordinator.alarm();
  }
}

export default {
  async fetch(request: Request, env: RealtimeEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/v1/healthz") {
        return Response.json(
          { ok: true, releaseId: env.REALTIME_RELEASE_ID, backendContract: REALTIME_BACKEND_CONTRACT },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      const route = /^\/v1\/apps\/([^/]+)\/realtime\/([^/]+)$/u.exec(url.pathname);
      if (!route) return errorResponse(new RelayError(404, "invalid_request", "Route not found"));
      const upgrade = request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (!upgrade) throw new RelayError(426, "upgrade_required", "A WebSocket upgrade is required");
      let appId: string;
      let provider: string;
      try {
        appId = decodeURIComponent(route[1]!);
        provider = decodeURIComponent(route[2]!);
      } catch {
        throw new RelayError(400, "invalid_request", "Malformed realtime path");
      }
      const prepared = await gateway(env).prepare(
        REALTIME_BACKEND_CONTRACT,
        env.REALTIME_RELEASE_ID,
        request,
        appId,
        provider,
        env.GATEWAY_ORIGIN,
      );
      const { bootstrap, headers } = unwrapBackend(prepared);
      const session = env.REALTIME_SESSION.get(env.REALTIME_SESSION.newUniqueId());
      return session.fetch(
        new Request("https://realtime.internal/", {
          headers: { ...Object.fromEntries(headers), "x-realtime-bootstrap": bootstrapHeader(bootstrap) },
        }),
      );
    } catch (error) {
      if (error instanceof RelayError) return errorResponse(error);
      return errorResponse(new RelayError(503, "provider_unavailable", "Realtime backend unavailable"));
    }
  },
} satisfies ExportedHandler<RealtimeEnv>;
