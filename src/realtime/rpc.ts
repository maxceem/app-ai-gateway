import { WorkerEntrypoint } from "cloudflare:workers";
import { gatewayBackend } from "./gateway-backend";
import type {
  Bootstrap,
  RealtimeBackendCalls,
  PreviousGrant,
  Settlement,
} from "./relay/contract";

/**
 * The binding a realtime Worker calls. Each method forwards to
 * {@link gatewayBackend}, which the gateway's own sessions call in-process;
 * the public fetch handler exposes none of them.
 */
export class RealtimeBackend extends WorkerEntrypoint<Env> implements RealtimeBackendCalls {
  private calls() {
    return gatewayBackend(this.env, promise => this.ctx.waitUntil(promise));
  }

  prepare(version: number, releaseId: string, request: Request, appId: string, provider: string, origin: string) {
    return this.calls().prepare(version, releaseId, request, appId, provider, origin);
  }

  grant(version: number, b: Bootstrap, headers: Headers, previous: PreviousGrant | null) {
    return this.calls().grant(version, b, headers, previous);
  }

  capacity(
    version: number,
    b: Bootstrap,
    scope: "user" | "app",
    operation: "acquire" | "renew" | "release",
    cap?: number,
  ) {
    return this.calls().capacity(version, b, scope, operation, cap);
  }

  admit(
    version: number,
    b: Bootstrap,
    headers: Headers,
    previous: PreviousGrant,
    generationId: string,
    at: number,
  ) {
    return this.calls().admit(version, b, headers, previous, generationId, at);
  }

  settle(version: number, b: Bootstrap, settlement: Settlement) {
    return this.calls().settle(version, b, settlement);
  }

  maintain(version: number, b: Bootstrap, headers: Headers, previous: PreviousGrant, active: boolean) {
    return this.calls().maintain(version, b, headers, previous, active);
  }
}
