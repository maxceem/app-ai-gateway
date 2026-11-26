/**
 * The writes an agent hands to a person (v1's `resource-operations.ts` and
 * `operation-status.ts`, cut to what v2 has). The rules are in
 * `../contracts/handoffs.ts`; the kinds the engine knows are in
 * `../auth/operation-kinds.ts`.
 *
 * Each write is checked when it is asked for, as the plain create would check
 * it, so a request the write would refuse is refused before anything is
 * recorded. Then it runs as drizzle statements inside the operation engine's
 * batch, guarded by the engine's own condition: the write and the
 * operation's completion either both land or neither does. A plan ceiling
 * travels in the same statement, as in the plain creates.
 *
 * Nothing here returns a key. A provider key comes in on the console's
 * approval page and is sealed by the vault before anything stores it; a key a
 * reserved create minted is sealed by the engine and reaches only a person on
 * the reveal page.
 */
import type { AuthState, CfAuth, CfAuthOperations, OperationStatus, OperationView } from "@maxceem/cf-auth";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { cfAuth, identityFor, isCfAuthError } from "../auth/identity.ts";
import {
  browserKindName,
  browserKindOf,
  isReservedKindName,
  parseEnvelope,
  reservedKindName,
  stageApproval,
  type BrowserKind,
  type ReservedKind,
} from "../auth/operation-kinds.ts";
import { consoleOrigin, V2_PATH } from "../auth/settings.ts";
import { generateApiKey } from "../client-auth/api-keys.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import {
  HandoffProofSchema,
  HandoffSubmitRequestSchema,
  ProviderHandoffRequestSchema,
  ProviderKeyHandoffRequestSchema,
  ReservedAppKeyRequestSchema,
  ReservedAppRequestSchema,
} from "../contracts/handoffs.ts";
import { GatewayError } from "../core/errors.ts";
import { enforceEndpointRateLimit } from "../core/flood-limit.ts";
import { database } from "../db/index.ts";
import { app as appTable, appKey as appKeyTable, providerConnection } from "../db/schema.ts";
import { invalidateConnection, keyIdentity, keyOrigin, readCloudflareGateway } from "../providers/connections.ts";
import { readCustomAuth } from "../providers/passthrough.ts";
import { CUSTOM_PROVIDER_TYPE } from "../providers/custom.ts";
import { cloudflareGatewayOrigin } from "../providers/destinations.ts";
import { builtInProvider } from "../providers/index.ts";
import { sealingRoot } from "../vault/split-keys.ts";
import { vault } from "../vault/client.ts";
import { requireConsoleSession, requireManage, type AdminVariables } from "./actor.ts";
import { appRow, checkAppConfig, checkConversations, checkNewConnection, freshAppId, parseAppConfig, parseBody, requireApiKeyApp } from "./apps.ts";
import { capCondition, planCap, planCeiling, type PlanCap } from "./plan-caps.ts";
import {
  checkCloudflareIds,
  checkDestination,
  checkedBaseUrl,
  storedCloudflare,
  connectionRow,
  newConnectionId,
  providerView,
  ratesFromPricing,
  assertModesSelectable,
  secretHint,
  type ConnectionRow,
} from "./providers.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;
type PageContext = Context<{ Bindings: Env; Variables: { identity: Promise<CfAuth>; authState: AuthState } }>;

const iso = (ms: number) => new Date(ms).toISOString();

/** The console pages a person is sent to (built with the console). */
export const APPROVE_PAGE_PATH = `${V2_PATH}/approve`;
export const REVEAL_PAGE_PATH = `${V2_PATH}/reveal`;

function consoleAt(env: Env): string {
  const origin = consoleOrigin(env);
  if (origin === null) {
    throw new GatewayError(503, "service_unavailable", "This deployment has no console (CONSOLE_ORIGIN) for a person to finish this on");
  }
  return origin;
}

/** The link a person approves a browser step on. The proof is in the fragment, which no server or referrer sees. */
function approvalUrl(env: Env, view: Pick<OperationView, "id" | "browserProof">): string {
  if (view.browserProof === null) throw new GatewayError(500, "internal_error", "A browser step opened without its approval link");
  return `${consoleAt(env)}${APPROVE_PAGE_PATH}/${encodeURIComponent(view.id)}#${view.browserProof}`;
}

/** The page a person reveals a created key on. Their own session is the whole authority. */
export function revealUrl(env: Env, id: string): string {
  return `${consoleAt(env)}${REVEAL_PAGE_PATH}/${encodeURIComponent(id)}`;
}

/** The reveal page's link, left out where no console origin is set (a repeat answered after it was removed). */
function revealLink(env: Env, id: string): { reveal_url?: string } {
  return consoleOrigin(env) === null ? {} : { reveal_url: revealUrl(env, id) };
}

async function engineOf(c: { get(key: "identity"): Promise<CfAuth> }): Promise<CfAuthOperations> {
  return (await c.get("identity")).operations;
}

function engineRefused(error: unknown, code: string): boolean {
  return isCfAuthError(error) && error.code === code;
}

// ---------------------------------------------------------------------------
// Request digests, and an identical request made recently

/** JSON with sorted keys, so the same request always has the same digest. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What binds an operation to its request: the request itself is never stored. */
function requestDigest(kind: string, payload: unknown): Promise<string> {
  return sha256(canonical({ kind, payload }));
}

/** How long an identical request is remembered for the notice beside a new one. */
const RECENT_REQUEST_MS = 3_600_000;

/**
 * A note about the newest operation of this account, of this kind, for the
 * same request, opened within the hour and pending or completed, a completed
 * one first. Reported beside a new request, so an agent that lost an answer
 * can find what it already did. It never changes what the new request does.
 */
async function recentNotice(env: Env, accountId: string, engineKind: string, digest: string): Promise<string | undefined> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT id, state, created_at FROM mgmt_operation
     WHERE organization_id = ? AND kind = ?
       AND (state = 'completed' OR (state = 'pending' AND expires_at > ?))
       AND created_at > ? AND json_extract(payload, '$.requestHash') = ?
     ORDER BY state = 'completed' DESC, created_at DESC LIMIT 1`,
  )
    .bind(accountId, engineKind, now, now - RECENT_REQUEST_MS, digest)
    .first<{ id: string; state: string; created_at: number }>();
  if (row === null) return undefined;
  const minutes = Math.max(0, Math.round((now - row.created_at) / 60_000));
  const when = minutes === 0 ? "less than a minute ago" : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const what = row.state === "completed" ? "completed" : "was opened";
  return `An identical request ${what} ${when} as operation ${row.id}; use get_operation to inspect it before creating another.`;
}

// ---------------------------------------------------------------------------
// Browser steps: a key a person enters

interface ProviderReview {
  type: string;
  name: string;
  slug: string;
  baseUrl: string | null;
  /** Through Cloudflare AI Gateway: the account and gateway. The person approving enters its token. */
  cloudflareGateway?: { accountId: string; gatewayId: string };
  pricing?: unknown;
}

interface RotateReview {
  id: string;
  revision: number;
  type: string;
  name: string;
  slug: string;
  baseUrl: string | null;
  /** The connection's Cloudflare AI Gateway, where its key is sent instead of the provider's own host. */
  cloudflareGateway?: { accountId: string; gatewayId: string } | null;
  secretHint: string | null;
}

async function openBrowserStep(c: AdminContext, kind: BrowserKind, review: Record<string, unknown>): Promise<Response> {
  const actor = c.get("actor");
  const engineKind = browserKindName(kind);
  const digest = await requestDigest(kind, review);
  const notice = await recentNotice(c.env, actor.accountId, engineKind, digest);
  await enforceEndpointRateLimit(c.env, "operation", actor.accountId);
  const { createOperationToken } = await cfAuth();
  const view = await (await engineOf(c)).open({
    kind: engineKind,
    // Proves nothing once the operation is open: nobody polls it with it.
    token: createOperationToken(),
    payload: { requestHash: digest, review },
    opener: c.get("authState"),
  });
  return c.json(
    {
      id: view.id,
      kind,
      url: approvalUrl(c.env, view),
      expiresAt: view.expiresAt,
      ...(notice === undefined ? {} : { notice }),
    } satisfies OperationResponse<"openProviderHandoff">,
    201,
  );
}

export async function openProviderHandoff(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const body = await parseBody(c, ProviderHandoffRequestSchema);
  // Everything `createProvider` checks but the key, now, before anything is recorded.
  if (builtInProvider(body.type) === null) {
    throw new GatewayError(400, "invalid_request", `type: ${body.type} is not a supported provider type`);
  }
  const slug = body.slug ?? body.type;
  const baseUrl = body.baseUrl === undefined ? null : checkedBaseUrl(body.baseUrl);
  const cloudflare = body.cloudflareGateway ?? null;
  // A new connection: its ids must be plain path segments.
  if (cloudflare !== null) checkCloudflareIds(cloudflare, null);
  checkDestination(builtInProvider(body.type)!, baseUrl, cloudflare);
  if (body.pricing !== undefined) assertModesSelectable(builtInProvider(body.type)!, baseUrl, ratesFromPricing(body.pricing, body.type), null);
  await refuseTakenSlug(c.env.DB, actor.accountId, slug);
  await (await planCap(c.env, c.env.DB, actor.accountId, "provider")).assertNotReached();
  consoleAt(c.env);
  const review: ProviderReview = {
    type: body.type,
    name: body.name,
    slug,
    baseUrl,
    // Only when set, so a request without it is the same request it always was.
    ...(cloudflare === null ? {} : { cloudflareGateway: { accountId: cloudflare.accountId, gatewayId: cloudflare.gatewayId } }),
    ...(body.pricing === undefined ? {} : { pricing: body.pricing }),
  };
  return openBrowserStep(c, "provider.add", review as unknown as Record<string, unknown>);
}

export async function openProviderKeyHandoff(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const body = await parseBody(c, ProviderKeyHandoffRequestSchema);
  const current = await connectionRow(c.env.DB, actor.accountId, c.req.param("id")!);
  if (current.revision !== body.revision) {
    throw new GatewayError(409, "conflict", "The provider connection changed since it was read; read it again and retry");
  }
  consoleAt(c.env);
  const review: RotateReview = {
    id: current.id,
    revision: current.revision,
    type: current.type,
    name: current.name,
    slug: current.slug,
    baseUrl: current.base_url,
    cloudflareGateway: cloudflareIds(current.cloudflare_gateway_json),
    secretHint: current.secret_hint,
  };
  return openBrowserStep(c, "provider.rotate-key", review as unknown as Record<string, unknown>);
}

/** A stored Cloudflare AI Gateway setting's account and gateway, without its token. */
function cloudflareIds(stored: string | null): { accountId: string; gatewayId: string } | null {
  const setting = readCloudflareGateway(stored);
  return setting === null ? null : { accountId: setting.accountId, gatewayId: setting.gatewayId };
}

async function refuseTakenSlug(db: D1Database, accountId: string, slug: string): Promise<void> {
  const taken = await db.prepare("SELECT 1 FROM provider_connection WHERE account_id = ? AND slug = ?").bind(accountId, slug).first();
  if (taken !== null) throw new GatewayError(409, "conflict", `A provider connection with slug ${slug} already exists`);
}

/** The operation a page's proof addresses: its kind, account, opener and stored request. */
async function verifiedStep(c: PageContext, proof: string) {
  const id = c.req.param("id") ?? "";
  const engine = (await identityFor(c)).operations;
  let details;
  try {
    details = await engine.details({ id, proof });
  } catch (error) {
    if (engineRefused(error, "operation_not_found")) throw new GatewayError(404, "not_found", "Nothing is waiting at this link");
    throw error;
  }
  const kind = browserKindOf(details.kind);
  if (kind === null) throw new GatewayError(404, "not_found", "Nothing is waiting at this link");
  // Counted only after the proof is judged, so a stranger guessing at proofs
  // cannot lock the page out for its owner.
  await enforceEndpointRateLimit(c.env, "submission", details.id);
  const row = await c.env.DB.prepare("SELECT organization_id, opener_user_id, payload FROM mgmt_operation WHERE id = ?")
    .bind(details.id)
    .first<{ organization_id: string | null; opener_user_id: string | null; payload: string | null }>();
  const review = row?.payload ? parseEnvelope(JSON.parse(row.payload)).review : undefined;
  if (row === null || row.organization_id === null || row.opener_user_id === null || review === undefined) {
    throw new GatewayError(500, "internal_error", "A stored operation does not match its kind");
  }
  return { engine, details, kind, accountId: row.organization_id, openerUserId: row.opener_user_id, review };
}

export async function getHandoff(c: PageContext): Promise<Response> {
  const { proof } = await parseBody(c, HandoffProofSchema);
  const { details, kind, review, accountId } = await verifiedStep(c, proof);
  const baseUrl = typeof review.baseUrl === "string" ? review.baseUrl : null;
  const gateway = review.cloudflareGateway as { accountId?: unknown; gatewayId?: unknown } | null | undefined;
  const cloudflare =
    gateway && typeof gateway.accountId === "string" && typeof gateway.gatewayId === "string"
      ? { accountId: gateway.accountId, gatewayId: gateway.gatewayId }
      : null;
  // Every host the key goes to: a custom base URL replaces only the main one;
  // through Cloudflare AI Gateway, the gateway is the only one.
  // A custom provider's key goes only to its base URL.
  const hosts = builtInProvider(String(review.type))?.hosts ?? {};
  const through = cloudflare === null ? null : cloudflareGatewayOrigin(cloudflare);
  const destinations =
    cloudflare !== null
      ? through === null
        ? []
        : [through]
      : review.type === CUSTOM_PROVIDER_TYPE
        ? baseUrl === null
          ? []
          : [baseUrl]
        : Object.entries(hosts).map(([key, host]) => (key === "main" && baseUrl !== null ? baseUrl : `https://${host}/`));
  return c.json({
    id: details.id,
    kind,
    state: details.state,
    expiresAt: details.expiresAt,
    // Which account gets the key, from the operation the proof addresses.
    account: { id: accountId, name: details.organization?.name ?? accountId },
    review: {
      type: String(review.type),
      name: String(review.name),
      slug: String(review.slug),
      baseUrl,
      destinations,
      ...(kind === "provider.rotate-key" ? { secretHint: typeof review.secretHint === "string" ? review.secretHint : null } : {}),
      // Adding through Cloudflare: the page asks for its token, and the provider key becomes optional.
      ...(kind === "provider.add" && cloudflare !== null ? { cloudflareGateway: cloudflare } : {}),
    },
  } satisfies OperationResponse<"getHandoff">);
}

export async function denyHandoff(c: PageContext): Promise<Response> {
  const { proof } = await parseBody(c, HandoffProofSchema);
  const { engine, details } = await verifiedStep(c, proof);
  await engine.deny({ id: details.id, proof });
  return c.json({ state: "denied" } satisfies OperationResponse<"denyHandoff">);
}

/**
 * Approves a browser step with the key the person entered. The write runs as
 * the credential that opened the step (the engine rechecks it when it
 * commits), in the batch that completes the operation.
 */
export async function submitHandoff(c: PageContext): Promise<Response> {
  const { proof, secret, cloudflareToken } = await parseBody(c, HandoffSubmitRequestSchema);
  const { engine, details, kind, accountId, openerUserId, review } = await verifiedStep(c, proof);
  // Adding through Cloudflare takes its token, and the provider key only if given; anything else takes the key alone.
  const throughCloudflare = kind === "provider.add" && isRecord(review.cloudflareGateway);
  if (throughCloudflare && cloudflareToken === undefined) {
    throw new GatewayError(400, "invalid_request", "cloudflareToken: enter the Cloudflare token for this gateway");
  }
  if (!throughCloudflare && cloudflareToken !== undefined) {
    throw new GatewayError(400, "invalid_request", "cloudflareToken: this request does not go through Cloudflare AI Gateway");
  }
  if (!throughCloudflare && secret === undefined) throw new GatewayError(400, "invalid_request", "secret: enter the provider key");
  // One already approved is answered as approved. Only an approved one: a
  // person holding the link of a declined step must not be told it landed.
  switch (details.state) {
    case "pending":
      break;
    case "completed":
      return c.json({ state: "completed" } satisfies OperationResponse<"submitHandoff">);
    case "denied":
      throw new GatewayError(409, "operation_denied", "This request was declined; ask for it again");
    case "retired":
      throw new GatewayError(409, "conflict", "This request was withdrawn; ask for it again");
    case "expired":
      throw new GatewayError(410, "operation_expired", "This link has expired; ask for it again");
  }
  const guard = await engine.guard({ id: details.id });
  const write = kind === "provider.add"
    ? await providerAddWrite(c.env, accountId, openerUserId, review as unknown as ProviderReview, { secret, cloudflareToken }, guard)
    : await providerKeyWrite(c.env, accountId, review as unknown as RotateReview, secret!, guard);
  const unstage = stageApproval(await identityFor(c), details.id, {
    outcome: write.outcome,
    statements: [write.statement],
    afterCommit: () => invalidateConnection(accountId, write.slug),
  });
  try {
    await engine.approve({
      id: details.id,
      proof,
      input: { ...(secret === undefined ? {} : { secret }), ...(cloudflareToken === undefined ? {} : { cloudflareToken }) },
    });
  } catch (error) {
    // Someone else's approval landed first: this key was not stored.
    if ((await engine.details({ id: details.id, proof })).state === "completed") {
      throw new GatewayError(409, "conflict", "This request was already approved; the key you entered was not stored");
    }
    throw await write.refusal(error);
  } finally {
    unstage();
  }
  return c.json({ state: "completed" } satisfies OperationResponse<"submitHandoff">);
}

interface StagedWrite {
  statement: unknown;
  outcome: Record<string, unknown>;
  slug: string;
  /** The refusal to answer when the engine did not commit it. */
  refusal(error: unknown): Promise<unknown>;
}

function uniqueViolation(error: unknown): boolean {
  return String(error).includes("UNIQUE");
}

async function providerAddWrite(
  env: Env,
  accountId: string,
  openerUserId: string,
  review: ProviderReview,
  entered: { readonly secret: string | undefined; readonly cloudflareToken: string | undefined },
  guard: SQL,
): Promise<StagedWrite> {
  const id = newConnectionId();
  const now = Date.now();
  const { secret, cloudflareToken } = entered;
  const cloudflare = review.cloudflareGateway ?? null;
  // Judged again at approval, so a step opened before the rule cannot send a token where its ids lead once parsed.
  if (cloudflare !== null) checkCloudflareIds(cloudflare, null);
  // Sealed for where the key goes: the base URL, the Cloudflare gateway, or the provider's own host.
  const origin = keyOrigin({ type: review.type, baseUrl: review.baseUrl ?? null, cloudflareGateway: cloudflare });
  const blob = secret === undefined ? null : await vault(env).seal("providerKey", keyIdentity(accountId, id, review.type, origin, null), secret, await sealingRoot(env, accountId));
  const cloudflareJson =
    cloudflare === null || cloudflareToken === undefined ? null : await storedCloudflare(env, accountId, id, { ...cloudflare, token: cloudflareToken });
  const cap = await planCap(env, env.DB, accountId, "provider");
  const { guardedInsert } = await cfAuth();
  const rates = review.pricing === undefined ? null : ratesFromPricing(review.pricing as Parameters<typeof ratesFromPricing>[0], review.type);
  const description = builtInProvider(review.type);
  // Judged again at approval, so a handoff opened before a check existed is covered too.
  if (description !== null) checkDestination(description, review.baseUrl ?? null, cloudflare);
  if (description !== null) assertModesSelectable(description, review.baseUrl ?? null, rates, null);
  // Apps may already route to the slug: their calls are judged on the new rates, as a connection save does.
  await checkNewConnection(env.DB, accountId, { slug: review.slug, type: review.type, baseUrl: review.baseUrl ?? null }, rates);
  const statement = guardedInsert(
    database(env.DB) as never,
    providerConnection,
    {
      id,
      accountId,
      type: review.type,
      slug: review.slug,
      name: review.name,
      status: "active",
      secretBlob: blob,
      secretHint: secret === undefined ? null : secretHint(secret),
      baseUrl: review.baseUrl,
      cloudflareGateway: cloudflareJson === null ? null : (JSON.parse(cloudflareJson) as Record<string, unknown>),
      rates: rates as Record<string, unknown> | null,
      revision: 1,
      createdBy: openerUserId,
      createdAt: now,
      updatedAt: now,
    },
    and(guard, capCondition(cap))!,
  );
  const row: ConnectionRow = {
    id,
    account_id: accountId,
    type: review.type,
    slug: review.slug,
    name: review.name,
    status: "active",
    secret_blob: null,
    secret_hint: secret === undefined ? null : secretHint(secret),
    base_url: review.baseUrl,
    cloudflare_gateway_json: cloudflareJson,
    serving_providers_json: null,
    rates_json: rates === null ? null : JSON.stringify(rates),
    passthrough_json: null,
    revision: 1,
    created_by: openerUserId,
    created_at: now,
    updated_at: now,
  };
  return {
    statement,
    outcome: { provider: providerView(row) },
    slug: review.slug,
    async refusal(error) {
      if (uniqueViolation(error)) return new GatewayError(409, "conflict", `A provider connection with slug ${review.slug} already exists`);
      if (engineRefused(error, "conflict")) {
        await cap.assertNotReached();
        return new GatewayError(409, "conflict", "The connection could not be added: the request expired or its sender lost access. Ask for it again");
      }
      return error;
    },
  };
}

async function providerKeyWrite(env: Env, accountId: string, review: RotateReview, secret: string, guard: SQL): Promise<StagedWrite> {
  const current = await connectionRow(env.DB, accountId, review.id);
  if (current.revision !== review.revision) {
    throw new GatewayError(409, "conflict", "The provider connection changed since this was asked for; ask for it again");
  }
  // Sealed for the origin the connection has now, which the revision check keeps unchanged.
  const origin = keyOrigin({ type: current.type, baseUrl: current.base_url, cloudflareGateway: readCloudflareGateway(current.cloudflare_gateway_json) });
  const blob = await vault(env).seal(
    "providerKey",
    keyIdentity(accountId, current.id, current.type, origin, readCustomAuth(current.passthrough_json)),
    secret,
    await sealingRoot(env, accountId),
  );
  const now = Date.now();
  const statement = database(env.DB)
    .update(providerConnection)
    .set({ secretBlob: blob, secretHint: secretHint(secret), revision: sql`${providerConnection.revision} + 1`, updatedAt: now })
    .where(
      and(
        eq(providerConnection.id, current.id),
        eq(providerConnection.accountId, accountId),
        eq(providerConnection.revision, review.revision),
        current.base_url === null ? isNull(providerConnection.baseUrl) : eq(providerConnection.baseUrl, current.base_url),
        guard,
      ),
    );
  const updated: ConnectionRow = { ...current, secret_hint: secretHint(secret), revision: current.revision + 1, updated_at: now };
  return {
    statement,
    outcome: { provider: providerView(updated) },
    slug: current.slug,
    async refusal(error) {
      if (engineRefused(error, "conflict")) {
        return new GatewayError(409, "conflict", "The provider connection changed, or the request expired; ask for it again");
      }
      return error;
    },
  };
}

// ---------------------------------------------------------------------------
// Reserved creates: once, and the key only to a person

const KEY_METADATA = (key: { id: string; name: string; key_prefix: string; created_at: string }) => ({
  id: key.id,
  name: key.name,
  key_prefix: key.key_prefix,
  created_at: key.created_at,
});

function mismatch(): GatewayError {
  return new GatewayError(409, "operation_mismatch", "This handle was reserved for a different request; reserve again for this one");
}

/** The engine's refusals of an execution, in the gateway's words. */
function executionRefusal(error: unknown): unknown {
  if (engineRefused(error, "operation_not_found")) return new GatewayError(404, "operation_not_found", "No reservation answers to this handle");
  if (engineRefused(error, "operation_mismatch")) return mismatch();
  if (engineRefused(error, "operation_expired")) return new GatewayError(410, "operation_expired", "This reservation lapsed before it was executed");
  if (engineRefused(error, "already_completed")) {
    return new GatewayError(409, "already_completed", "This reservation was executed too long ago for its answer to be repeated");
  }
  if (engineRefused(error, "conflict")) {
    return new GatewayError(409, "conflict", "Another call is executing this reservation, or the credential's access changed while it ran; nothing was written");
  }
  return error;
}

/**
 * Refuses a handle sent with another request than the one it reserved,
 * before the engine is asked to execute it, whatever the reservation's state.
 * An unknown handle is left to the engine. The execution compares again
 * inside the engine's guard, and a repeat compares the record it answers.
 */
async function assertReservedFor(env: Env, accountId: string, engineKind: string, handle: string, digest: string): Promise<void> {
  const row = await env.DB.prepare("SELECT kind, organization_id, payload FROM mgmt_operation WHERE poll_token_hash = ?")
    .bind(await sha256(handle))
    .first<{ kind: string; organization_id: string | null; payload: string | null }>();
  if (row === null) return;
  if (row.kind !== engineKind || row.organization_id !== accountId) throw mismatch();
  let reserved: string;
  try {
    reserved = parseEnvelope(JSON.parse(row.payload ?? "null")).requestHash;
  } catch {
    throw mismatch();
  }
  if (reserved !== digest) throw mismatch();
}

/** Whether the engine still holds an operation's sealed outcome: not yet revealed, and inside its window. */
async function outcomeHeld(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT sealed_outcome IS NOT NULL AND sealed_until > ? AS held FROM mgmt_operation WHERE id = ?",
  )
    .bind(Date.now(), id)
    .first<{ held: number }>();
  return Boolean(row?.held);
}

async function reserve(c: AdminContext, kind: ReservedKind, digest: string): Promise<Response> {
  const actor = c.get("actor");
  const engineKind = reservedKindName(kind);
  const notice = await recentNotice(c.env, actor.accountId, engineKind, digest);
  // Counted as every operation an account starts is, so a loop that reserves
  // and never executes is held to the same pace as one that creates.
  await enforceEndpointRateLimit(c.env, "operation", actor.accountId);
  const reservation = await (await engineOf(c)).reserve({ kind: engineKind, opener: c.get("authState"), input: { requestHash: digest } });
  return c.json({
    state: "reserved",
    handle: reservation.handle,
    id: reservation.id,
    expiresAt: reservation.expiresAt,
    ...(notice === undefined ? {} : { notice }),
  } as const);
}

/**
 * Executes a reservation: `write` builds the statements under the engine's
 * guard, and the engine seals what they created. A repeat inside the replay
 * window answers the same record without running anything.
 */
async function execute(
  c: AdminContext,
  kind: ReservedKind,
  handle: string,
  digest: string,
  write: (guard: SQL) => Promise<{ statements: unknown[]; outcome: Record<string, unknown>; record: Record<string, unknown> }>,
  onRefused: (error: unknown) => Promise<void>,
): Promise<{ id: string; replayed: boolean; record: Record<string, unknown>; revealable: boolean }> {
  const actor = c.get("actor");
  const engineKind = reservedKindName(kind);
  await assertReservedFor(c.env, actor.accountId, engineKind, handle, digest);
  let executed;
  try {
    executed = await (await engineOf(c)).execute({ handle, kind: engineKind, opener: c.get("authState") }, async (context) => {
      if (parseEnvelope(context.input).requestHash !== digest) throw mismatch();
      const built = await write(context.guard);
      return { outcome: built.outcome, record: { ...built.record, requestHash: digest }, statements: built.statements };
    });
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    // A more particular refusal first, such as the plan's ceiling.
    await onRefused(error);
    throw executionRefusal(error);
  }
  const { requestHash, ...record } = (executed.record ?? {}) as Record<string, unknown>;
  // A repeat runs nothing, so it is the record that says what was reserved.
  if (requestHash !== digest) throw mismatch();
  const carriesKey = record.api_key !== null && typeof record.api_key === "object";
  return {
    id: executed.id,
    replayed: executed.replayed,
    record,
    revealable: carriesKey && (!executed.replayed || (await outcomeHeld(c.env, executed.id))),
  };
}

export async function createReservedApp(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const { handle, ...request } = await parseBody(c, ReservedAppRequestSchema);
  // The request as the reservation was made for it, read without the
  // account's current state, so a repeat matches whatever has changed since.
  const payload = { name: request.name, config: parseAppConfig(request.config), status: request.status ?? "active" };
  const apiKeyApp = payload.config.authentication.type === "api_key";
  const digest = await requestDigest("app.add", payload);

  /** What `createApp` checks against the account as it stands: when reserving, and before a fresh write. */
  const liveChecks = async () => {
    // A key needs a page to be revealed on, checked before anything is written.
    if (apiKeyApp) consoleAt(c.env);
    await checkAppConfig(c.env.DB, actor.accountId, request.config);
    // As `createApp`: storage needs this deployment's bucket and a plan that includes it.
    await checkConversations(c.env, actor.accountId, payload.config, null);
    // The first key is not counted against the key ceiling, as v1, except
    // when the plan allows no keys at all.
    if (apiKeyApp && (await planCeiling(c.env, actor.accountId, "appKey")) === 0) {
      throw new GatewayError(409, "billing_plan_limit_reached", "This plan allows at most 0 active keys per app", undefined, {
        data: { limit: 0, used: 0 },
      });
    }
    return planCap(c.env, c.env.DB, actor.accountId, "app");
  };

  if (handle === undefined) {
    await (await liveChecks()).assertNotReached();
    return reserve(c, "app.add", digest);
  }

  const { guardedInsert } = await cfAuth();
  const db = database(c.env.DB);
  let cap: PlanCap | undefined;
  const executed = await execute(
    c,
    "app.add",
    handle,
    digest,
    async (guard) => {
      cap = await liveChecks();
      const now = Date.now();
      const id = await freshAppId(c.env.DB, payload.name);
      const app = {
        id,
        revision: 1,
        name: payload.name,
        config: payload.config,
        status: payload.status,
        created_at: iso(now),
        updated_at: iso(now),
      };
      const statements: unknown[] = [
        guardedInsert(
          db as never,
          appTable,
          { id, accountId: actor.accountId, name: payload.name, config: payload.config, revision: 1, status: payload.status, createdAt: now, updatedAt: now },
          // Never an id an app has had (`freshAppId` checked; checked again in the write).
          and(guard, capCondition(cap), sql`NOT EXISTS (SELECT 1 FROM retired_app_id WHERE id = ${id})`)!,
        ),
      ];
      let key: { id: string; name: string; key: string; key_prefix: string; created_at: string } | null = null;
      if (apiKeyApp) {
        const generated = await generateApiKey();
        key = { id: generated.id, name: "Initial key", key: generated.key, key_prefix: generated.keyPrefix, created_at: iso(now) };
        // Written only if the app insert just before it wrote: the engine
        // completes only when this last statement wrote.
        statements.push(
          guardedInsert(
            db as never,
            appKeyTable,
            { id: generated.id, appId: id, name: key.name, keyHash: generated.keyHash, keyPrefix: generated.keyPrefix, status: "active", createdAt: now },
            and(guard, sql`changes() = 1`)!,
          ),
        );
      }
      return {
        statements,
        outcome: { app, api_key: key },
        record: { app, api_key: key === null ? null : KEY_METADATA(key) },
      };
    },
    async (error) => {
      if (engineRefused(error, "conflict") && cap !== undefined) await cap.assertNotReached();
    },
  );
  return c.json({
    state: "created",
    id: executed.id,
    replayed: executed.replayed,
    app: executed.record.app,
    api_key: executed.record.api_key ?? null,
    ...(executed.revealable ? revealLink(c.env, executed.id) : {}),
  } as OperationResponse<"createReservedApp">);
}

export async function createReservedAppKey(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const appId = c.req.param("app")!;
  const { handle, name } = await parseBody(c, ReservedAppKeyRequestSchema);
  const digest = await requestDigest("app.key.add", { app: appId, name });

  const liveChecks = async () => {
    consoleAt(c.env);
    requireApiKeyApp(await appRow(c.env.DB, actor.accountId, appId));
    return planCap(c.env, c.env.DB, actor.accountId, "appKey", appId);
  };

  if (handle === undefined) {
    await (await liveChecks()).assertNotReached();
    return reserve(c, "app.key.add", digest);
  }

  const { guardedInsert } = await cfAuth();
  const db = database(c.env.DB);
  let cap: PlanCap | undefined;
  const executed = await execute(
    c,
    "app.key.add",
    handle,
    digest,
    async (guard) => {
      cap = await liveChecks();
      const now = Date.now();
      const generated = await generateApiKey();
      const key = { id: generated.id, name, key: generated.key, key_prefix: generated.keyPrefix, created_at: iso(now) };
      const statement = guardedInsert(
        db as never,
        appKeyTable,
        { id: generated.id, appId, name, keyHash: generated.keyHash, keyPrefix: generated.keyPrefix, status: "active", createdAt: now },
        and(
          guard,
          capCondition(cap),
          sql`exists (select 1 from app where id = ${appId} and account_id = ${actor.accountId} and json_extract(config_json, '$.authentication.type') = 'api_key')`,
        )!,
      );
      return { statements: [statement], outcome: { app_id: appId, api_key: key }, record: { app_id: appId, api_key: KEY_METADATA(key) } };
    },
    async (error) => {
      if (engineRefused(error, "conflict") && cap !== undefined) await cap.assertNotReached();
    },
  );
  return c.json({
    state: "created",
    id: executed.id,
    replayed: executed.replayed,
    app_id: appId,
    api_key: executed.record.api_key,
    ...(executed.revealable ? revealLink(c.env, executed.id) : {}),
  } as OperationResponse<"createReservedAppKey">);
}

// ---------------------------------------------------------------------------
// Where an operation stands, and revealing a created key

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a completed operation's record publishes: only the fields the
 * response names. A key's value is dropped even if a record ever carried one.
 */
function publishedResult(record: unknown): OperationResponse<"getOperation">["result"] {
  if (!isRecord(record)) return {};
  const apiKey = record.api_key;
  return {
    ...(isRecord(record.app) ? { app: record.app as never } : {}),
    ...(typeof record.app_id === "string" ? { app_id: record.app_id } : {}),
    ...(apiKey === null ? { api_key: null } : isRecord(apiKey) ? { api_key: KEY_METADATA(apiKey as never) } : {}),
    ...(isRecord(record.provider) ? { provider: record.provider as never } : {}),
  };
}

export async function getOperation(c: AdminContext): Promise<Response> {
  let status: OperationStatus;
  try {
    status = await (await engineOf(c)).status({ id: c.req.param("id") ?? "", opener: c.get("authState") });
  } catch (error) {
    if (engineRefused(error, "operation_not_found")) {
      throw new GatewayError(404, "operation_not_found", "No operation of your account has this id");
    }
    throw error;
  }
  const base = { id: status.id, kind: status.kind, createdAt: status.createdAt, expiresAt: status.expiresAt };
  if (status.state !== "completed") {
    const state = status.state === "pending" ? "pending" : "expired";
    return c.json({ ...base, state, ...(status.state === "denied" ? { denied: true as const } : {}) } satisfies OperationResponse<"getOperation">);
  }
  const result = publishedResult(status.record);
  const revealable = isReservedKindName(status.kind) && isRecord(result?.api_key) && (await outcomeHeld(c.env, status.id));
  return c.json({
    ...base,
    state: "completed",
    result,
    ...(revealable ? revealLink(c.env, status.id) : {}),
  } satisfies OperationResponse<"getOperation">);
}

/**
 * Hands a created key to the person on the reveal page, once. Their console
 * session is the whole authority: the engine checks their owner or admin role
 * in the operation's account in the statement that hands the key over.
 */
export async function revealOperation(c: AdminContext): Promise<Response> {
  const origin = consoleOrigin(c.env);
  if (origin === null || new URL(c.req.url).origin !== origin || c.req.header("origin") !== origin) {
    throw new GatewayError(403, "forbidden", "Reveal a key on the console's own page");
  }
  const session = requireConsoleSession(c.get("authState"));
  try {
    // cf-auth checks the person's owner or admin role in the operation's own
    // account, whichever account the console has selected.
    const revealed = await (await engineOf(c)).reveal({ id: c.req.param("id") ?? "", actor: session });
    c.header("Cache-Control", "no-store");
    return c.json({
      id: revealed.id,
      kind: revealed.kind,
      result: revealed.outcome as OperationResponse<"revealOperation">["result"],
    } satisfies OperationResponse<"revealOperation">);
  } catch (error) {
    if (engineRefused(error, "operation_not_found")) throw new GatewayError(404, "operation_not_found", "No operation of your account has this id");
    if (engineRefused(error, "already_revealed")) throw new GatewayError(409, "already_revealed", "This key was already revealed, and is shown only once");
    if (engineRefused(error, "operation_expired")) {
      throw new GatewayError(410, "operation_expired", "This key can no longer be revealed: its window passed, or it was revoked");
    }
    throw error;
  }
}
