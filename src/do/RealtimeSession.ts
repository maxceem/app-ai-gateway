import { DurableObject } from "cloudflare:workers";
import { localSessionBackend } from "../realtime/local-backend";
import type { SessionCoordinator } from "../realtime/session";
import type { Bootstrap, JsonObject } from "../realtime/types";
import { object } from "../realtime/protocols/validation";
import { GatewayError, errorResponse } from "../core/errors";

/**
 * The session engine, loaded on first use: the gateway's cold start must not
 * pay for it on every HTTP request. This class holds sessions when the gateway
 * serves them itself; with seamless releases, the release Worker's own class
 * does, and this one serves only local development.
 */
const engine = () => Promise.all([import("../realtime/session"), import("../realtime/journal")])
  .then(([{ SessionCoordinator }, { SessionJournal }]) => ({ SessionCoordinator, SessionJournal }));

/** Binding-only per-connection owner. No route accepts a caller-selected object/session ID. */
export class RealtimeSession extends DurableObject<Env> {
  private coordinator: SessionCoordinator | null = null;

  override async fetch(request: Request): Promise<Response> {
    const { SessionCoordinator, SessionJournal } = await engine();
    // Answered here, not thrown: an error crossing the stub arrives as a plain
    // Error, and a refusal would lose its status, code and Retry-After.
    try {
      if (this.coordinator || new SessionJournal(this.ctx.storage).metadata()) {
        throw new GatewayError(409, "conflict", "Realtime session cannot be reopened");
      }
      const bootstrap = parseBootstrap(request.headers.get("x-realtime-bootstrap"));
      this.coordinator = new SessionCoordinator(this.backend(), this.ctx, bootstrap, request.headers);
      return await this.coordinator.start();
    } catch (error) {
      if (error instanceof GatewayError) {
        return errorResponse(error.status, error.code, error.message, error.headers, error.data);
      }
      throw error;
    }
  }

  override async alarm(): Promise<void> {
    if (!this.coordinator) {
      const { SessionCoordinator, SessionJournal } = await engine();
      const bootstrap = new SessionJournal(this.ctx.storage).metadata();
      if (!bootstrap) {
        await this.ctx.storage.deleteAll();
        return;
      }
      this.coordinator = new SessionCoordinator(this.backend(), this.ctx, bootstrap, new Headers());
    }
    await this.coordinator.alarm();
  }

  private backend() {
    return localSessionBackend(this.env, promise => this.ctx.waitUntil(promise));
  }
}

/** The bootstrap fields that must each be a non-empty string. */
const BOOTSTRAP_STRINGS = [
  "sessionId",
  "appId",
  "organizationId",
  "providerId",
  "providerSlug",
  "model",
  "requestedModel",
  "origin",
];

function invalidBootstrap(): GatewayError {
  return new GatewayError(400, "invalid_request", "Invalid realtime bootstrap");
}

function parseBootstrap(raw: string | null): Bootstrap {
  if (!raw || raw.length > 8192) throw invalidBootstrap();
  let value;
  try {
    value = object(JSON.parse(raw));
  } catch {
    throw invalidBootstrap();
  }
  for (const field of BOOTSTRAP_STRINGS) {
    if (typeof value[field] !== "string" || !value[field]) throw invalidBootstrap();
  }
  const identity = object(value.identity);
  if (!consistentIdentity(value, identity)) {
    throw new GatewayError(400, "invalid_request", "Invalid realtime identity");
  }
  return value as unknown as Bootstrap;
}

/**
 * Whether the bootstrap's identity has the shape client authentication gives
 * one, and belongs to the app, protocol and version the bootstrap names.
 * Checked in order, stopping at the first that fails.
 */
function consistentIdentity(value: JsonObject, identity: JsonObject): boolean {
  if (identity.appId !== value.appId) return false;
  if (!["api_key", "gateway_token"].includes(String(identity.credentialType))) return false;
  if (!["api_key", "attest"].includes(String(identity.authMethod))) return false;
  if (identity.userId !== null && typeof identity.userId !== "string") return false;
  // An App Attest identity names its install; any other names none.
  const installInvalid = identity.authMethod === "attest"
    ? typeof identity.installId !== "string" || !identity.installId
    : identity.installId !== null;
  if (installInvalid) return false;
  const expiryInvalid = identity.credentialType === "gateway_token"
    && (typeof identity.expiresAt !== "number" || !Number.isFinite(identity.expiresAt));
  if (expiryInvalid) return false;
  if (!["openai_realtime", "gemini_live"].includes(String(value.protocol))) return false;
  if (value.appVersion !== null && typeof value.appVersion !== "string") return false;
  return true;
}
