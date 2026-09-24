/**
 * The token exchanges an application can offer at `/auth/token` — its API key
 * plus a user's issuer token, or an App Attest assertion — and the App Attest
 * key registration at `/auth/register` that comes before the second.
 *
 * Each is an {@link ExchangeHandler}: the body it accepts, derived from the
 * application's configuration, and what it does with a body that parsed. The
 * route picks one by the application's {@link TokenExchange} and runs it, so
 * it branches neither on the configuration nor on the shape of the body.
 */

import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { lookupApiKeyUncached } from "./api-keys";
import type { ExchangeType, TokenExchange } from "./client-auth";
import { issueGatewayToken } from "./gateway-token";
import { verifyIssuerToken } from "./issuer";
import {
  ApiKeyTokenRequestSchema,
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
} from "../contracts/schemas";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import type { AuthMethod } from "../core/types";
import { database } from "../db";
import { appAuthChallenge, appUser } from "../db/schema";
import type {
  AppAttestEndUser,
  AppAttestEnvironment,
  IssuerAuthentication,
} from "../shared/app-config";

/**
 * What a handler learns about the attempt as it runs, for the event row it will
 * produce either way. Mutable because the interesting facts — which client
 * proof was used, whose identity the issuer vouched for — are only known part
 * way through, and the row has to be written from the failure path too.
 */
export interface AuthAttempt {
  authMethod: AuthMethod | null;
  userId: string | null;
  claimDelayMs: number | null;
}

/** A gateway token, as an exchange hands it back. */
export interface IssuedToken {
  token: string;
  expiresIn: number;
}

/**
 * Whose identity an App Attest request claims: the user an issuer token names,
 * or — under `app_install` — the installation, whose attested key *is* the
 * identity.
 */
type Claimant =
  | { source: "app_install" }
  | { source: "issuer"; issuer: IssuerAuthentication; token: string };

const APP_INSTALL: Claimant = { source: "app_install" };

/**
 * What an App Attest body's `issuer_token` has to be for this application. The
 * published schemas leave it optional because one document serves every
 * application; this is where the application's own `end_user.source` narrows
 * it, into the {@link Claimant} the handler acts for.
 *
 * A token sent to an `app_install` application is refused rather than ignored:
 * a client presenting one believes it is authenticating a person, and quietly
 * handing it an installation-scoped identity instead would file that user's
 * traffic — and their limits, and their block — under the wrong subject.
 */
function claimantSchema(
  endUser: AppAttestEndUser,
  issuerToken: z.ZodOptional<z.ZodString>,
): z.ZodType<Claimant> {
  if (endUser.source === "app_install") {
    return z.undefined({
      error: "This application identifies users by app installation, so issuer_token is not accepted",
    }).optional().transform((): Claimant => APP_INSTALL);
  }
  const { issuer } = endUser;
  return issuerToken.unwrap().transform((token): Claimant => ({ source: "issuer", issuer, token }));
}

/** A parsed App Attest body, with the claimant in place of the token it was read from. */
function withClaimant<T extends { issuer_token: Claimant }>({ issuer_token: claimant, ...body }: T) {
  return { ...body, claimant };
}

function attestBodies(endUser: AppAttestEndUser) {
  return {
    token: AppAttestTokenRequestSchema
      .extend({ issuer_token: claimantSchema(endUser, AppAttestTokenRequestSchema.shape.issuer_token) })
      .transform(withClaimant),
    register: AppAttestRegisterRequestSchema
      .extend({ issuer_token: claimantSchema(endUser, AppAttestRegisterRequestSchema.shape.issuer_token) })
      .transform(withClaimant),
  };
}

type AttestBodies = ReturnType<typeof attestBodies>;

/**
 * Built once per configuration rather than per request, and keyed by it: the
 * `issuer` variant carries the application's issuer into the claimant, so it
 * cannot be one module-level schema. The key is the parsed block, which lives
 * exactly as long as the cached app record holding it.
 */
const attestBodyCache = new WeakMap<AppAttestEndUser, AttestBodies>();

function attestBodiesFor(endUser: AppAttestEndUser): AttestBodies {
  let bodies = attestBodyCache.get(endUser);
  if (!bodies) {
    bodies = attestBodies(endUser);
    attestBodyCache.set(endUser, bodies);
  }
  return bodies;
}

/** The bodies each exchange accepts, once parsed. */
interface ExchangeBodies {
  api_key_issuer: { token: z.output<typeof ApiKeyTokenRequestSchema> };
  app_attest: { token: z.output<AttestBodies["token"]>; register: z.output<AttestBodies["register"]> };
}

type RegisterBody<K extends ExchangeType> = ExchangeBodies[K] extends { register: infer Body } ? Body : never;

interface ExchangeInput<K extends ExchangeType, Body> {
  env: Env;
  appId: string;
  exchange: TokenExchange<K>;
  body: Body;
  attempt: AuthAttempt;
}

/** One token exchange: the bodies it accepts from an application, and what it does with them. */
export interface ExchangeHandler<K extends ExchangeType> {
  /** Recorded on the attempt before the body is parsed, so a malformed body is still filed under its exchange. */
  readonly authMethod: AuthMethod;
  /**
   * A refusal the body's schema cannot word, checked before the attempt is
   * attributed to this exchange: a body that plainly belongs to another one.
   */
  refuseBody?(raw: Record<string, unknown>): void;
  /** The `/auth/token` body this application accepts. */
  tokenBody(exchange: TokenExchange<K>): z.ZodType<ExchangeBodies[K]["token"]>;
  token(input: ExchangeInput<K, ExchangeBodies[K]["token"]>): Promise<IssuedToken>;
  /** The `/auth/register` step, where the exchange registers a key first: App Attest only. */
  registration?: {
    body(exchange: TokenExchange<K>): z.ZodType<RegisterBody<K>>;
    run(input: ExchangeInput<K, RegisterBody<K>>): Promise<{ user_id: string }>;
  };
}

async function consumeChallenge(env: Env, appId: string, challenge: string): Promise<void> {
  const consumed = await database(env.DB)
    .delete(appAuthChallenge)
    .where(and(
      eq(appAuthChallenge.challenge, challenge),
      eq(appAuthChallenge.appId, appId),
      gt(appAuthChallenge.expiresAt, sql`datetime('now')`),
    ))
    .returning({ challenge: appAuthChallenge.challenge });
  if (consumed.length === 0) {
    throw new GatewayError(403, "attest_failed", "Challenge is invalid, expired, or already used");
  }
}

/**
 * Who an App Attest request acts for, which is the application's own choice
 * rather than the client's: under `issuer` whoever the presented token names,
 * under `app_install` the attested key id.
 *
 * `trusted` says whether the id has been proved yet. An issuer's has: the token
 * was verified to get it. An `app_install` id is the caller's own `key_id` and
 * is proved only once the attestation or assertion verifies against it, so it
 * must not be written to the auth-event row before then — an unauthenticated
 * caller could otherwise name any string and have the failure filed against it.
 */
async function attestedUserId(
  body: { key_id: string; claimant: Claimant },
): Promise<{ userId: string; trusted: boolean }> {
  if (body.claimant.source === "app_install") return { userId: body.key_id, trusted: false };
  const { userId } = await verifyIssuerToken(body.claimant.token, body.claimant.issuer);
  return { userId, trusted: true };
}

async function storeAttestedUser(input: {
  env: Env;
  appId: string;
  userId: string;
  keyId: string;
  publicKeyPem: string;
  environment: AppAttestEnvironment;
}): Promise<void> {
  await database(input.env.DB)
    .insert(appUser)
    .values({
      appId: input.appId,
      id: input.userId,
      attestKeyId: input.keyId,
      attestPublicKey: input.publicKeyPem,
      attestCounter: 0,
      attestEnvironment: input.environment,
      lastSeenAt: sql`datetime('now')`,
    })
    .onConflictDoUpdate({
      target: [appUser.appId, appUser.id],
      set: {
        attestKeyId: input.keyId,
        attestPublicKey: input.publicKeyPem,
        attestCounter: 0,
        attestEnvironment: input.environment,
        lastSeenAt: sql`datetime('now')`,
      },
    });
}

/**
 * Upserts the issuer identity and reports whether it was waiting on a claim.
 *
 * The pending timestamp comes back from the same statement rather than from a
 * second read: `RETURNING` answers with the row's post-update values and this
 * update never touches that column, so what it returns is the window that was
 * already open — which is exactly what {@link settleClaimDelay} needs.
 */
async function storeIssuerUser(
  env: Env,
  appId: string,
  userId: string,
): Promise<{ claimPendingSince: string | null }> {
  const [user] = await database(env.DB)
    .insert(appUser)
    .values({ appId, id: userId, lastSeenAt: sql`datetime('now')` })
    .onConflictDoUpdate({
      target: [appUser.appId, appUser.id],
      set: { lastSeenAt: sql`datetime('now')` },
      setWhere: eq(appUser.status, "active"),
    })
    .returning({ status: appUser.status, claimPendingSince: appUser.claimPendingSince });
  if (!user || user.status !== "active") {
    throw new GatewayError(403, "auth_required", "User is blocked");
  }
  return { claimPendingSince: user.claimPendingSince };
}

async function assertExistingUserActive(
  env: Env,
  appId: string,
  userId: string,
): Promise<{ claimPendingSince: string | null }> {
  const user = await database(env.DB).query.appUser.findFirst({
    columns: { status: true, claimPendingSince: true },
    where: and(eq(appUser.appId, appId), eq(appUser.id, userId)),
  });
  if (user?.status !== undefined && user.status !== "active") {
    throw new GatewayError(403, "auth_required", "User is blocked");
  }
  return { claimPendingSince: user?.claimPendingSince ?? null };
}

/**
 * Opens a claim-propagation window for a user the issuer vouched for but whose
 * entitlement claim has not arrived yet.
 *
 * Only if one is not already open: the metric is the wait from the *first*
 * rejection, and a client retrying every few seconds would otherwise keep
 * resetting it to zero. Inserts the row when the user has never been seen,
 * which is the common shape of this incident — the purchase is the first thing
 * the user does, so the gateway has no record of them yet.
 *
 * Never throws: this is measurement, and the request has already been refused.
 */
export async function markClaimPending(env: Env, appId: string, userId: string): Promise<void> {
  try {
    await database(env.DB)
      .insert(appUser)
      .values({ appId, id: userId, claimPendingSince: sql`datetime('now')` })
      .onConflictDoUpdate({
        target: [appUser.appId, appUser.id],
        set: { claimPendingSince: sql`datetime('now')` },
        // Blocked users are excluded: no exchange of theirs can ever succeed, so
        // a window opened for one would stay open forever and inflate the count
        // of people the operator is supposed to be waiting on.
        setWhere: and(isNull(appUser.claimPendingSince), eq(appUser.status, "active")),
      });
  } catch (error) {
    log("warn", "claim_pending_mark_failed", {
      app: appId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Closes an open claim-propagation window, returning how long it stayed open.
 *
 * `datetime('now')` is UTC without a zone marker, so it is read back as one.
 *
 * Never throws, for the same reason {@link markClaimPending} does not — and with
 * more at stake. This runs on the *success* path, after the App Attest key has
 * been stored or the assertion counter advanced, so letting a transient D1
 * failure escape would turn a completed authentication into a 500 and cost the
 * client work it has already done. A failure here loses one measurement and
 * leaves the window open; the user's next successful exchange closes it.
 */
async function settleClaimDelay(
  env: Env,
  appId: string,
  userId: string,
  pendingSince: string | null,
): Promise<number | null> {
  if (pendingSince === null) return null;
  const openedAt = Date.parse(`${pendingSince.replace(" ", "T")}Z`);
  if (Number.isNaN(openedAt)) return null;
  const delayMs = Math.max(0, Date.now() - openedAt);
  try {
    await database(env.DB)
      .update(appUser)
      .set({ claimPendingSince: null })
      .where(and(eq(appUser.appId, appId), eq(appUser.id, userId)));
  } catch (error) {
    log("warn", "claim_settle_failed", {
      app: appId,
      userId,
      delayMs,
      error: error instanceof Error ? error.message : String(error),
    });
    // Not reported as recovered, and not recorded on the event: a window that
    // is still open has not been measured, and a figure written next to one
    // would be counted again when the window really does close.
    return null;
  }
  log("info", "claim_propagation_recovered", { app: appId, userId, delayMs });
  return delayMs;
}

/** An API key and a user's issuer token, exchanged for a gateway token naming both. */
const API_KEY_ISSUER: ExchangeHandler<"api_key_issuer"> = {
  authMethod: "api_key",
  tokenBody: () => ApiKeyTokenRequestSchema,
  async token({ env, appId, exchange, body, attempt }) {
    // Token exchange is a security boundary where revocation must take effect
    // immediately. Issuer-less data-plane authentication keeps the short
    // verification cache, but an exchange always confirms the key's current
    // status against D1.
    const apiKeyRecord = await lookupApiKeyUncached(env, body.api_key);
    if (!apiKeyRecord || apiKeyRecord.appId !== appId) {
      throw new GatewayError(403, "auth_required", "Gateway API key was rejected");
    }
    const { userId } = await verifyIssuerToken(body.issuer_token, exchange.issuer);
    attempt.userId = userId;
    const { claimPendingSince } = await storeIssuerUser(env, appId, userId);
    attempt.claimDelayMs = await settleClaimDelay(env, appId, userId, claimPendingSince);
    return issueGatewayToken(env.JWT_SECRET, {
      appId,
      userId,
      authMethod: "api_key",
      apiKeyId: apiKeyRecord.id,
    });
  },
};

/**
 * An App Attest key registered against a fresh challenge, then an assertion
 * over another one exchanged for a gateway token.
 */
const APP_ATTEST: ExchangeHandler<"app_attest"> = {
  authMethod: "attest",
  registration: {
    body: ({ authentication }) => attestBodiesFor(authentication.end_user).register,
    async run({ env, appId, exchange: { authentication: auth }, body, attempt }) {
      const { userId, trusted } = await attestedUserId(body);
      if (trusted) attempt.userId = userId;
      // Do not spend a challenge or ask Apple to attest a replacement key for a
      // user whom the operator has blocked.
      const { claimPendingSince } = await assertExistingUserActive(env, appId, userId);
      await consumeChallenge(env, appId, body.challenge);
      // Imported here rather than at the top of the module: App Attest verification
      // pulls in pkijs, asn1js and cbor-x, which would otherwise be parsed at every
      // isolate cold start for the sake of these two handlers.
      const { verifyAppAttestation } = await import("./app-attest");
      const verifiedAttestation = await verifyAppAttestation({
        appId: `${auth.app_attest.team_id}.${auth.app_attest.bundle_id}`,
        allowedEnvironments: auth.app_attest.environments,
        keyId: body.key_id,
        challenge: body.challenge,
        attestation: body.attestation,
      });
      // Proved now: the attestation verified against this very key id, so recording
      // it as the attempt's identity does not take the caller's word for it.
      attempt.userId = userId;
      await storeAttestedUser({
        env,
        appId,
        userId,
        keyId: body.key_id,
        publicKeyPem: verifiedAttestation.publicKeyPem,
        environment: verifiedAttestation.environment,
      });
      attempt.claimDelayMs = await settleClaimDelay(env, appId, userId, claimPendingSince);
      return { user_id: userId };
    },
  },
  // An API key sent here is refused by naming the exchange it asked for: the
  // body may be a perfectly good one, addressed to the wrong kind of
  // application, and no schema rejection would say so.
  refuseBody(raw) {
    if ("api_key" in raw) {
      throw new GatewayError(
        400,
        "auth_method_not_supported",
        "API key token exchange is not supported for this app",
      );
    }
  },
  tokenBody: ({ authentication }) => attestBodiesFor(authentication.end_user).token,
  async token({ env, appId, exchange: { authentication: auth }, body, attempt }) {
    const { userId, trusted } = await attestedUserId(body);
    if (trusted) attempt.userId = userId;
    const user = await database(env.DB).query.appUser.findFirst({
      columns: {
        attestKeyId: true,
        attestPublicKey: true,
        attestCounter: true,
        attestEnvironment: true,
        status: true,
        // Read alongside the key material rather than in a second round trip:
        // this exchange already has to fetch the row.
        claimPendingSince: true,
      },
      where: and(eq(appUser.appId, appId), eq(appUser.id, userId)),
    });
    if (user?.status !== undefined && user.status !== "active") {
      throw new GatewayError(403, "auth_required", "User is blocked");
    }
    if (!user || user.attestKeyId !== body.key_id || !user.attestPublicKey) {
      throw new GatewayError(403, "attest_failed", "No matching registered App Attest key");
    }
    // Withdrawing an environment has to stop the keys it admitted, not just new
    // registrations: an assertion carries no aaguid, so the environment the key
    // was registered in is the only record of it. A stored key always has one.
    if (
      user.attestEnvironment === null ||
      !auth.app_attest.environments.includes(user.attestEnvironment)
    ) {
      throw new GatewayError(403, "attest_failed", "The registered App Attest environment is no longer allowed");
    }
    await consumeChallenge(env, appId, body.challenge);
    const { verifyAppAssertion } = await import("./app-attest");
    const counter = await verifyAppAssertion({
      gatewayAppId: appId,
      rpId: `${auth.app_attest.team_id}.${auth.app_attest.bundle_id}`,
      keyId: body.key_id,
      challenge: body.challenge,
      assertion: body.assertion,
      publicKeyPem: user.attestPublicKey,
      previousCounter: user.attestCounter,
    });
    const updated = await database(env.DB)
      .update(appUser)
      .set({ attestCounter: counter, lastSeenAt: sql`datetime('now')` })
      .where(and(
        eq(appUser.appId, appId),
        eq(appUser.id, userId),
        lt(appUser.attestCounter, counter),
      ))
      .returning({ id: appUser.id });
    if (updated.length !== 1) {
      throw new GatewayError(403, "attest_failed", "App Attest assertion counter was replayed");
    }
    // Proved now: the assertion verified against the stored public key for this
    // key id, so the identity is the gateway's own conclusion rather than a
    // string the caller supplied.
    attempt.userId = userId;
    attempt.claimDelayMs = await settleClaimDelay(env, appId, userId, user.claimPendingSince);
    return issueGatewayToken(env.JWT_SECRET, { appId, userId, authMethod: "attest" });
  },
};

/** Every token exchange, by the type an application's configuration settles on. */
export const EXCHANGES: { [K in ExchangeType]: ExchangeHandler<K> } = {
  api_key_issuer: API_KEY_ISSUER,
  app_attest: APP_ATTEST,
};
