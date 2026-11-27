/**
 * Session tickets, on the main Worker's side (plan section 4.3, step 8j
 * "Session tickets", step 9a).
 *
 * When an app asks for a live session, the main Worker signs a short-lived
 * ticket that carries everything the session needs to start. The relay and
 * the vault check it with the public key; only this Worker holds the private
 * key (`RELAY_TICKET_PRIVATE_KEY`). The ticket carries the session's seal: the
 * vault opens the connection's credentials with the app's own credential
 * (split keys) and seals a copy for this session alone, bound to its address
 * and to an expiry a few minutes past the session's deadline. So this Worker
 * never sees the key, and the relay gets it only from the vault.
 *
 * The client endpoint that asks for a session (`./start-session.ts`) admits
 * it and takes its leases, then calls this module.
 */
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { errorFacts } from "../core/error-facts.ts";
import type { SealedCredentials } from "../providers/connections.ts";
import type { SessionMode, SessionSlot } from "../ledger/labels.ts";
import type { SessionRow } from "../ledger/sessions.ts";
import { vault, type CopyRequest } from "../vault/client.ts";
import { base64url, fromBase64url, TICKET_VERSION, verifyTicket as verifyWithPublicKey, type Ticket } from "../../relay/src/ticket.js";

export type { Ticket } from "../../relay/src/ticket.js";

/** How long a ticket stays good for the first connection: short, it is used once, at once. */
export const TICKET_TTL_MS = 60_000;
/** How long past the session's deadline its seal still opens: enough to hang up and close (8j). */
export const SEAL_GRACE_MS = 5 * 60_000;
/**
 * The longest session the relay allows (plan section 5.1, "a hard cap on
 * session length"). Well inside the ledger's late-booking window, and inside
 * the vault's 3-hour limit on a stored copy once the grace is added.
 */
export const MAX_SESSION_CAP_MS = 2 * 60 * 60_000;

/** What signs: the private key, from `RELAY_TICKET_PRIVATE_KEY` (`<x>.<d>`, base64url). */
interface SigningKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: string;
}

let signing: { readonly text: string; readonly key: Promise<SigningKey> } | null = null;

function ticketKeyMissing(): GatewayError {
  log("error", "relay_ticket_key_unusable", {});
  return new GatewayError(503, "service_unavailable", "Live sessions are not set up on this deployment");
}

/** The signing key, read once per isolate. */
export function signingKey(env: Env): Promise<SigningKey> {
  const text = (env as unknown as { RELAY_TICKET_PRIVATE_KEY?: unknown }).RELAY_TICKET_PRIVATE_KEY;
  if (typeof text !== "string" || text === "") return Promise.reject(ticketKeyMissing());
  if (signing !== null && signing.text === text) return signing.key;
  const key = (async (): Promise<SigningKey> => {
    const [x = "", d = "", ...rest] = text.split(".");
    if (rest.length > 0 || fromBase64url(x)?.byteLength !== 32 || fromBase64url(d)?.byteLength !== 32) throw ticketKeyMissing();
    try {
      const privateKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x, d }, { name: "Ed25519" }, false, ["sign"]);
      return { privateKey, publicKey: x };
    } catch {
      throw ticketKeyMissing();
    }
  })();
  signing = { text, key };
  // A key that failed is not kept, so a fixed secret works on the next request.
  key.catch(() => {
    if (signing?.key === key) signing = null;
  });
  return key;
}

/** Signs a ticket's payload. */
export async function signTicket(env: Env, payload: Ticket): Promise<string> {
  const { privateKey } = await signingKey(env);
  const signed = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(signed)));
  return `${signed}.${base64url(signature)}`;
}

/** The ticket's payload when this Worker signed it; else null. Expiry is the caller's to check. */
export async function verifyTicket(env: Env, ticket: unknown): Promise<Ticket | null> {
  const { publicKey } = await signingKey(env);
  return await verifyWithPublicKey(ticket, publicKey);
}

/** What the endpoint that asks for a session knows when it issues the ticket. */
export interface TicketRequest {
  readonly accountId: string;
  readonly appId: string;
  readonly endUserId: string | null;
  readonly installId: string | null;
  readonly appleAccountId: string | null;
  readonly appKeyId: string | null;
  readonly providerType: string;
  readonly connectionId: string | null;
  readonly operation: string;
  readonly model: string | null;
  readonly mode: SessionMode;
  readonly slot: SessionSlot;
  readonly sessionTotal: boolean;
  /** Where the session connects. The vault checks it against the seal's address. */
  readonly url: string;
  readonly capMs: number;
  /** The connection's credentials, still sealed, with the header and format the key goes in. */
  readonly credentials: SealedCredentials;
  readonly keyPlacement: { readonly header: string; readonly format: string } | null;
  /** The models the session's backend may call (GPT-Live's, 9g), when its operation has one. */
  readonly backend?: readonly string[];
}

export interface IssuedTicket {
  readonly ticket: string;
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly deadline: number;
  /** The session's ledger row, to write after the reply (4.3 step 1). */
  readonly session: SessionRow;
}

/** A new session id. The endpoint takes the session's slots under it before the ticket is signed. */
export function newSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Seals the session's copy of the credentials and signs its ticket. The
 * session's row is the caller's to write after the reply.
 */
export async function issueTicket(
  env: Env,
  request: TicketRequest,
  now: number = Date.now(),
  sessionId: string = newSessionId(),
): Promise<IssuedTicket> {
  if (!Number.isSafeInteger(request.capMs) || request.capMs <= 0 || request.capMs > MAX_SESSION_CAP_MS) {
    throw new GatewayError(500, "internal_error", "A session's time cap is out of range");
  }
  const expiresAt = now + TICKET_TTL_MS;
  const sealUntil = expiresAt + request.capMs + SEAL_GRACE_MS;
  const { providerKey, cloudflareToken, credential } = request.credentials;
  let copies;
  try {
    copies = await vault(env).storeCopy(
      {
        ...(providerKey === null ? {} : { providerKey: providerKey as NonNullable<CopyRequest["providerKey"]> }),
        ...(cloudflareToken === null ? {} : { cloudflareToken: cloudflareToken as NonNullable<CopyRequest["cloudflareToken"]> }),
        ...(credential === undefined ? {} : { credential }),
      } as CopyRequest,
      sealUntil,
    );
  } catch (error) {
    log("warn", "relay_session_seal_failed", { app: request.appId, error: errorFacts(error) });
    throw new GatewayError(502, "provider_unavailable", "The provider credential could not be used");
  }
  const payload: Ticket = {
    v: TICKET_VERSION,
    sid: sessionId,
    account: request.accountId,
    app: request.appId,
    endUser: request.endUserId,
    install: request.installId,
    appleAccount: request.appleAccountId,
    appKey: request.appKeyId,
    providerType: request.providerType,
    connection: request.connectionId,
    operation: request.operation,
    model: request.model,
    mode: request.mode,
    slot: request.slot,
    sessionTotal: request.sessionTotal,
    url: request.url,
    start: now,
    cap: request.capMs,
    exp: expiresAt,
    ...(request.backend === undefined ? {} : { backend: [...request.backend] }),
    seal: {
      ...(copies.providerKey === undefined
        ? {}
        : { providerKey: { blob: copies.providerKey.blob, identity: [...copies.providerKey.identity], ...(request.keyPlacement ?? {}) } }),
      ...(copies.cloudflareToken === undefined ? {} : { cloudflareToken: { blob: copies.cloudflareToken.blob, identity: [...copies.cloudflareToken.identity] } }),
    },
  };
  return { ticket: await signTicket(env, payload), sessionId, expiresAt, deadline: now + request.capMs, session: sessionRowOf(payload) };
}

/** The session's ledger row, from its ticket. */
export function sessionRowOf(ticket: Ticket): SessionRow {
  return {
    id: ticket.sid,
    accountId: ticket.account,
    appId: ticket.app,
    endUserId: ticket.endUser,
    installId: ticket.install,
    appleAccountId: ticket.appleAccount,
    appKeyId: ticket.appKey,
    providerType: ticket.providerType,
    providerConnectionId: ticket.connection,
    operation: ticket.operation,
    model: ticket.model,
    mode: ticket.mode,
    slot: ticket.slot,
    timeCapMs: ticket.cap,
    startedAt: ticket.start,
    expectsSessionTotal: ticket.sessionTotal,
  };
}
