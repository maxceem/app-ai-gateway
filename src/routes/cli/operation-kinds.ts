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
}

export interface BootstrapKind extends KindBase {
  readonly type: "bootstrap";
}

export interface ClaimKind extends KindBase {
  readonly type: "claim";
}

/** The input one resource write runs with: the accepted payload, and a browser's secret if one was sent. */
export interface ResourceInput {
  payload: Record<string, unknown>;
  secret: string | undefined;
}

export interface ResourceKind extends KindBase {
  readonly type: "resource";
  /** Whether it runs at once, only after a browser step, or either way. */
  readonly browser: "never" | "optional" | "always";
  /** What its browser step must supply as the secret. */
  readonly secret: "required" | "optional" | null;
  /** The existing row its browser step edits, shown to the approver as it now stands. */
  readonly target: "provider" | "provider_gateway" | null;
  /** The payload grammar for each path; the request schema already admitted their union. */
  payload(browser: boolean): z.ZodType<Record<string, unknown>>;
  /** The one management write, through the operation's boundary. */
  run(
    scope: ManagementScope,
    actor: Actor,
    input: ResourceInput,
    boundary: ResourceWriteBoundary,
  ): Promise<unknown>;
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
async function ownedApp(scope: ManagementScope, actor: Actor, appId: unknown) {
  const row = typeof appId === "string"
    ? await database(scope.env.DB).query.app.findFirst({
      where: and(eq(app.id, appId), eq(app.organizationId, actor.organizationId)),
    })
    : undefined;
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  return row;
}

/** Both provider edits are one write; a rotation is an update whose changed field is the secret. */
const updateProviderKind = (secret: "required" | "optional", payload: z.ZodType<Record<string, unknown>>): ResourceKind => ({
  type: "resource",
  open: "setup",
  continueTo: "cli",
  browser: "always",
  secret,
  target: "provider",
  payload: () => payload,
  run: (scope, actor, { payload: { id, ...fields }, secret: value }, boundary) =>
    updateProvider(scope, actor, String(id), { ...fields, ...(value === undefined ? {} : { secret: value }) }, boundary),
  result: (outcome) => ({ provider: outcome.provider }),
});

export const OPERATION_KINDS: Record<CliOperationKind, OperationKind> = {
  bootstrap: { type: "bootstrap", open: "read", continueTo: "cli" },
  /**
   * Read access: an unclaimed account whose free window has closed can still
   * be claimed, and claiming is what reopens it.
   */
  claim: { type: "claim", open: "read", continueTo: "console" },
  "app.add": {
    type: "resource",
    open: "setup",
    continueTo: "cli",
    browser: "never",
    secret: null,
    target: null,
    payload: () => AppWriteSchema,
    run: (scope, actor, { payload }, boundary) => createApp(scope, actor, payload, boundary),
    result: (outcome) => ({ app: outcome.app, api_key: outcome.api_key }),
    redact: withoutKey,
  },
  "app.key.add": {
    type: "resource",
    open: "setup",
    continueTo: "cli",
    browser: "never",
    secret: null,
    target: null,
    payload: () => CliAppKeyAddPayloadSchema,
    run: async (scope, actor, { payload: { app: appId, ...body } }, boundary) =>
      createAppKey(scope, actor, await ownedApp(scope, actor, appId), body, boundary),
    result: (outcome) => ({ api_key: outcome }),
    redact: withoutKey,
  },
  "provider.add": {
    type: "resource",
    open: "setup",
    continueTo: "cli",
    browser: "optional",
    secret: "optional",
    target: null,
    payload: (browser) => browser ? HandoffProviderAddPayloadSchema : ProviderCreateRequestSchema,
    run: (scope, actor, { payload, secret }, boundary) =>
      createProvider(scope, actor, { ...payload, ...(secret === undefined ? {} : { secret }) }, boundary),
    result: (outcome) => ({ provider: outcome.provider }),
  },
  "provider.update": updateProviderKind("optional", HandoffProviderUpdatePayloadSchema),
  "provider.rotate-key": updateProviderKind("required", HandoffRotatePayloadSchema),
  "provider-gateway.add": {
    type: "resource",
    open: "setup",
    continueTo: "cli",
    browser: "optional",
    secret: "required",
    target: null,
    payload: (browser) => browser ? HandoffProviderGatewayAddPayloadSchema : ProviderGatewayCreateRequestSchema,
    run: (scope, actor, { payload, secret }, boundary) =>
      createProviderGateway(scope, actor, { ...payload, ...(secret === undefined ? {} : { token: secret }) }, boundary),
    result: (outcome) => ({ gateway: outcome.gateway }),
  },
  "provider-gateway.rotate-key": {
    type: "resource",
    open: "setup",
    continueTo: "cli",
    browser: "always",
    secret: "required",
    target: "provider_gateway",
    payload: () => HandoffRotatePayloadSchema,
    run: (scope, actor, { payload: { id, revision }, secret }, boundary) =>
      rotateProviderGateway(scope, actor, String(id), { revision, token: secret }, boundary),
    result: (outcome) => ({ gateway: outcome.gateway }),
  },
};

/**
 * The entry for a kind, whether it arrived in a request or out of a stored row.
 * A stored kind this deployment no longer knows is refused rather than guessed
 * at, because every rule that would govern it lives in the entry.
 */
export function operationKind(kind: string): OperationKind {
  const entry = Object.hasOwn(OPERATION_KINDS, kind)
    ? OPERATION_KINDS[kind as CliOperationKind]
    : undefined;
  if (!entry) throw new GatewayError(400, "invalid_request", "Unsupported operation kind");
  return entry;
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
