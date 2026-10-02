import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import {
  CliAppKeyAddPayloadSchema,
  CliOperationRequestSchema,
  type CliHandoffContinuation,
  type CliOperationKind,
  type CliRequestedOperationKind,
} from "../contracts/cli";
import {
  AppWriteSchema,
  HandoffProviderAddPayloadSchema,
  HandoffProviderGatewayAddPayloadSchema,
  HandoffProviderUpdatePayloadSchema,
  HandoffRotatePayloadSchema,
  ProviderCreateRequestSchema,
  ProviderGatewayCreateRequestSchema,
  ProviderGatewayRotateRequestSchema,
  ProviderUpdateRequestSchema,
} from "../contracts/schemas";
import { cliKindName, type ResourceOperationKind } from "../auth/operation-kinds";
import { GatewayError } from "../core/errors";
import { database } from "../db";
import { app } from "../db/schema";
import type { AccountAccessMode } from "../policy/accounts";
import type { Actor } from "./actor";
import { createApp, validateAppDraft } from "./apps";
import { digest } from "./digest";
import { apiKeyApp, createAppKey } from "./keys";
import { createProviderGateway, rotateProviderGateway } from "./provider-gateways";
import { createProvider, updateProvider } from "./providers";
import type { ManagementScope } from "./scope";
import { parseRequest } from "./validation";
import type { ResourceWriteBoundary } from "./write-boundary";

/**
 * Every kind of CLI operation, one entry each.
 *
 * Four families, told apart by `type`: the bootstrap, which creates an account
 * and needs no credential; the login, cf-auth's own, which a CLI with no
 * credential opens and a signed-in person approves into one of their accounts;
 * the claim, which settles an account on the person approving it in a browser
 * and is completed by cf-auth; and the resource kinds, each of which is one
 * management write run under the operation's own transaction boundary — at
 * once, or once a browser has supplied its secret.
 *
 * Each is also registered with cf-auth's operation engine, which owns the row;
 * see `src/auth/operation-kinds.ts` for what the engine is told. The CLI, the
 * MCP server and the approval page all run a resource kind through
 * `./resource-operations`, so what a kind does is written here once.
 */
export type OperationKind = BootstrapKind | LoginKind | ClaimKind | ResourceKind;

interface KindBase {
  /** Account access the sender needs to open an operation of this kind. */
  readonly open: AccountAccessMode;
  /** Where the person who approved its browser step goes next. */
  readonly continueTo: CliHandoffContinuation;
  /** Whether its completed answer reports the account it settled on. */
  readonly reportsAccount: boolean;
}

export interface BootstrapKind extends KindBase {
  readonly type: "bootstrap";
}

export interface LoginKind extends KindBase {
  readonly type: "login";
}

export interface ClaimKind extends KindBase {
  readonly type: "claim";
}

/**
 * What one resource write is made from: the payload as the CLI sent it, or as
 * a browser step stored it, and the secret that step's approver supplied.
 */
export interface ResourceInput {
  payload: Record<string, unknown>;
  secret: string | undefined;
}

/** One management write, bound to its body, waiting for the operation's boundary. */
export type ResourceWrite = (
  scope: ManagementScope,
  actor: Actor,
  boundary: ResourceWriteBoundary,
) => Promise<unknown>;

export interface ResourceKind extends KindBase {
  readonly type: "resource";
  /** Whether it runs at once, only after a browser step, or either way. */
  readonly browser: "never" | "optional" | "always";
  /** What its browser step must supply as the secret. */
  readonly secret: "required" | "optional" | null;
  /** The existing row its browser step edits, shown to the approver as it now stands. */
  readonly target: "provider" | "provider_gateway" | null;
  /**
   * What a browser step stores and shows its approver: the reviewable part of
   * the write, never its secret. Null for a kind that has no browser step.
   */
  readonly handoff: z.ZodType<Record<string, unknown>> | null;
  /**
   * The one management write, its body parsed from the input by the
   * service's own schema — the only parse that body gets, and the one that
   * refuses it. Called before an immediate operation is recorded, and when a
   * browser step has supplied its secret.
   */
  prepare(input: ResourceInput): ResourceWrite;
  /**
   * What a reservation of this kind checks against the account before it is
   * recorded, beyond the payload's own schema: the judgement the write will
   * make when it runs, made early, so an agent learns about a request that
   * would be refused before it confirms one. It decides nothing the write does
   * not decide again.
   */
  precheck?(scope: ManagementScope, actor: Actor, payload: Record<string, unknown>): Promise<void>;
  /** What the write's own answer is recorded as, in `CliOperationResult`'s shape. */
  result(outcome: Record<string, unknown>): Record<string, unknown>;
  /**
   * The same result with its one-time secret removed, which is what outlives
   * the sealed copy. Absent where the result carries none.
   */
  redact?(result: Record<string, unknown>): Record<string, unknown>;
}

/** An application key's plaintext, taken out of whichever result carries one. */
function withoutKey(result: Record<string, unknown>): Record<string, unknown> {
  const apiKey = result.api_key as Record<string, unknown> | null | undefined;
  if (!apiKey) return result;
  const { key: _key, ...rest } = apiKey;
  return { ...result, api_key: rest };
}

/** The application an `app.key.add` names, which must be this account's. */
export async function ownedApp(scope: ManagementScope, actor: Actor, appId: string) {
  const row = await database(scope.env.DB).query.app.findFirst({
    where: and(eq(app.id, appId), eq(app.organizationId, actor.organizationId)),
  });
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  return row;
}

/** Both provider edits are one write; a rotation is an update whose changed field is the secret. */
const updateProviderKind = (secret: "required" | "optional", handoff: z.ZodType<Record<string, unknown>>): ResourceKind => ({
  type: "resource",
  open: "setup",
  continueTo: "cli",
  reportsAccount: false,
  browser: "always",
  secret,
  target: "provider",
  handoff,
  prepare: ({ payload: { id, ...fields }, secret: value }) => {
    const body = parseRequest(ProviderUpdateRequestSchema, { ...fields, ...(value === undefined ? {} : { secret: value }) });
    return (scope, actor, boundary) => updateProvider(scope, actor, String(id), body, boundary);
  },
  result: (outcome) => ({ provider: outcome.provider }),
});

export const OPERATION_KINDS: Record<CliOperationKind, OperationKind> = {
  bootstrap: { type: "bootstrap", open: "read", continueTo: "cli", reportsAccount: true },
  /**
   * Read access: logging a CLI in to an account adds a way to reach it, and
   * whatever that account may do is still asked of it on every request.
   */
  login: { type: "login", open: "read", continueTo: "cli", reportsAccount: true },
  /**
   * Read access: an unclaimed account whose free window has closed can still
   * be claimed, and claiming is what reopens it.
   */
  claim: { type: "claim", open: "read", continueTo: "console", reportsAccount: true },
  "app.add": {
    type: "resource",
    open: "setup",
    continueTo: "cli",
    reportsAccount: false,
    browser: "never",
    secret: null,
    target: null,
    handoff: null,
    prepare: ({ payload }) => {
      const body = parseRequest(AppWriteSchema, payload);
      return (scope, actor, boundary) => createApp(scope, actor, body, boundary);
    },
    precheck: async (scope, actor, payload) => {
      await validateAppDraft(scope, actor, parseRequest(AppWriteSchema, payload));
    },
    result: (outcome) => ({ app: outcome.app, api_key: outcome.api_key }),
    redact: withoutKey,
  },
  "app.key.add": {
    type: "resource",
    open: "setup",
    continueTo: "cli",
    reportsAccount: false,
    browser: "never",
    secret: null,
    target: null,
    handoff: null,
    prepare: ({ payload }) => {
      const { app: appId, ...body } = parseRequest(CliAppKeyAddPayloadSchema, payload);
      return async (scope, actor, boundary) =>
        createAppKey(scope, actor, await ownedApp(scope, actor, appId), body, boundary);
    },
    precheck: async (scope, actor, payload) => {
      apiKeyApp(await ownedApp(scope, actor, parseRequest(CliAppKeyAddPayloadSchema, payload).app));
    },
    result: (outcome) => ({ api_key: outcome }),
    redact: withoutKey,
  },
  "provider.add": {
    type: "resource",
    open: "setup",
    continueTo: "cli",
    reportsAccount: false,
    browser: "optional",
    secret: "optional",
    target: null,
    handoff: HandoffProviderAddPayloadSchema,
    prepare: ({ payload, secret }) => {
      const body = parseRequest(ProviderCreateRequestSchema, { ...payload, ...(secret === undefined ? {} : { secret }) });
      return (scope, actor, boundary) => createProvider(scope, actor, body, boundary);
    },
    result: (outcome) => ({ provider: outcome.provider }),
  },
  "provider.update": updateProviderKind("optional", HandoffProviderUpdatePayloadSchema),
  "provider.rotate-key": updateProviderKind("required", HandoffRotatePayloadSchema),
  "provider-gateway.add": {
    type: "resource",
    open: "setup",
    continueTo: "cli",
    reportsAccount: false,
    browser: "optional",
    secret: "required",
    target: null,
    handoff: HandoffProviderGatewayAddPayloadSchema,
    prepare: ({ payload, secret }) => {
      const body = parseRequest(ProviderGatewayCreateRequestSchema, { ...payload, ...(secret === undefined ? {} : { token: secret }) });
      return (scope, actor, boundary) => createProviderGateway(scope, actor, body, boundary);
    },
    result: (outcome) => ({ gateway: outcome.gateway }),
  },
  "provider-gateway.rotate-key": {
    type: "resource",
    open: "setup",
    continueTo: "cli",
    reportsAccount: false,
    browser: "always",
    secret: "required",
    target: "provider_gateway",
    handoff: HandoffRotatePayloadSchema,
    prepare: ({ payload: { id, revision }, secret }) => {
      const body = parseRequest(ProviderGatewayRotateRequestSchema, { revision, token: secret });
      return (scope, actor, boundary) => rotateProviderGateway(scope, actor, String(id), body, boundary);
    },
    result: (outcome) => ({ gateway: outcome.gateway }),
  },
};

/**
 * Every kind this table runs as a management write is registered with the
 * engine as one: a kind the engine did not know would be refused when opened.
 */
type Unregistered = Exclude<CliOperationKind, "bootstrap" | "login" | "claim" | ResourceOperationKind>;
export const EVERY_KIND_REGISTERED: [Unregistered] extends [never] ? true : Unregistered = true;

function isKnownKind(kind: string): kind is CliOperationKind {
  return Object.hasOwn(OPERATION_KINDS, kind);
}

/**
 * A kind as this deployment knows it, whether it arrived in a request or out
 * of a stored row. A stored kind this deployment no longer knows is refused
 * rather than guessed at, because every rule that would govern it lives in its
 * entry.
 */
export function knownKind(kind: string): CliOperationKind {
  if (!isKnownKind(kind)) throw new GatewayError(400, "invalid_request", "Unsupported operation kind");
  return kind;
}

/** The entry for a kind; see {@link knownKind}. */
export function operationKind(kind: string): OperationKind {
  return OPERATION_KINDS[knownKind(kind)];
}

/**
 * How the row a targeted kind names is shown on the approval page: the
 * reviewable configuration and nothing else — no sealed secret, and nothing a
 * browser has no business seeing.
 */
export const TARGET_SNAPSHOTS: Record<NonNullable<ResourceKind["target"]>, string> = {
  provider:
    "SELECT id,type,name,slug,base_url AS baseUrl,provider_gateway_id AS providerGatewayId,gateway_route_json AS gatewayRoute,status,revision FROM provider WHERE id=? AND organization_id=?",
  provider_gateway:
    "SELECT id,type,name,config_json AS config,status,revision FROM provider_gateway WHERE id=? AND organization_id=?",
};

/** The entry for a kind that runs one management write, or the refusal that it does not. */
export function resourceKind(kind: string): ResourceKind {
  const entry = operationKind(kind);
  if (entry.type !== "resource") throw new GatewayError(400, "invalid_request", "Unsupported operation kind");
  return entry;
}

/**
 * The id the CLI knows an operation by: `op:` and its token's digest.
 *
 * The CLI computes it from the token it saved before sending, so it can poll
 * an operation whose answer it never received. Every operation opened under a
 * token is opened with it as the engine's own id, so the two never differ.
 */
export async function operationId(token: string): Promise<string> {
  return `op:${await digest(token)}`;
}

/** The gateway's kind of an engine kind, and its entry in the gateway's table. */
export function kindOf(engineKind: string): { kind: CliOperationKind; entry: OperationKind } {
  const kind = knownKind(cliKindName(engineKind));
  return { kind, entry: OPERATION_KINDS[kind] };
}

/**
 * A record that breaks its kind's rules. The engine stores what this gateway
 * handed it, so a record that fails them means the deployment has moved under
 * its own data.
 */
function malformed(): GatewayError {
  return new GatewayError(500, "internal_error", "A stored operation does not match its kind");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a completed claim or resource write reports: its result, with any
 * one-time secret removed where the engine holds the whole of it sealed.
 */
export function resultRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw malformed();
  return raw;
}

/**
 * The schema a kind's payload is sent under, as `/v1/cli/operations` reads
 * it: the one normalisation every request digest is taken over, whichever
 * transport sent the request.
 */
export function requestPayloadSchema(kind: CliRequestedOperationKind): z.ZodType {
  const member = CliOperationRequestSchema.options.find((option) => option.shape.kind.value === kind);
  if (!member) throw new GatewayError(400, "invalid_request", "Unsupported operation kind");
  return member.shape.payload;
}

/**
 * The digest of one request: its kind, its payload as
 * {@link requestPayloadSchema} parsed it, and whether it owes a browser step.
 * Stored in the operation's payload, where it binds a retry with the same
 * token to the same request — the request itself may carry a secret that must
 * not be stored — and where a later identical request is recognised by it.
 */
export function requestDigest(kind: CliOperationKind, payload: unknown, browser: boolean): Promise<string> {
  return digest(JSON.stringify({ kind, payload, browser }));
}
