import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import {
  CliAppKeyAddPayloadSchema,
  type CliHandoffContinuation,
  type CliOperationKind,
} from "../../contracts/cli";
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
} from "../../contracts/schemas";
import { GatewayError } from "../../core/errors";
import { database } from "../../db";
import { app } from "../../db/schema";
import type { Actor } from "../../management/actor";
import { createApp } from "../../management/apps";
import { createAppKey } from "../../management/keys";
import {
  createProviderGateway,
  rotateProviderGateway,
} from "../../management/provider-gateways";
import { createProvider, updateProvider } from "../../management/providers";
import type { ManagementScope } from "../../management/scope";
import { parseRequest } from "../../management/validation";
import type { ResourceWriteBoundary } from "../../management/write-boundary";
import type { AccountAccessMode } from "../../policy/accounts";

/**
 * Every kind of CLI operation, one entry each.
 *
 * Three families, told apart by `type`: the bootstrap, which creates an account
 * and needs no credential; the claim, which settles an account on the person
 * approving it in a browser and is completed by cf-auth; and the resource
 * kinds, each of which is one management write run under the operation's own
 * transaction boundary — at once, or once a browser has supplied its secret.
 */
export type OperationKind = BootstrapKind | ClaimKind | ResourceKind;

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
async function ownedApp(scope: ManagementScope, actor: Actor, appId: string) {
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
