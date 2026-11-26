/**
 * The two exchanges `/auth/token` runs, and App Attest key registration.
 *
 * - `api_key_issuer`: an app key plus an issuer token gives a gateway token
 *   for the issuer's user.
 * - `app_attest`: an assertion from a registered App Attest key over a fresh
 *   challenge gives a gateway token for the install, with the user taken from
 *   an issuer token or the install itself.
 */
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { contained } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import type { AuthMethod } from "../core/types.ts";
import {
  ApiKeyTokenRequestSchema,
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
} from "../contracts/auth.ts";
import type { AppAttestEndUser, AppAttestEnvironment, IssuerAuthentication } from "../contracts/app-config.ts";
import { database } from "../db/index.ts";
import { appAttestKey, appAuthChallenge, appEndUser, appKeyShare } from "../db/schema.ts";
import { lookupApiKeyUncached } from "./api-keys.ts";
import type { ExchangeType, TokenExchange } from "./client-auth.ts";
import { issueGatewayToken } from "./gateway-token.ts";
import { checkShare, splitKeysOn } from "./key-shares.ts";
import { verifyIssuerToken } from "./issuer.ts";
import { useAssertionCounter } from "./replay.ts";
import { invalidateRegisteredKey } from "./request-proof.ts";

/** What one sign-in attempt learned, for its auth event. */
export interface AuthAttempt {
  authMethod: AuthMethod | null;
  userId: string | null;
  /** The account that owned the app when the attempt read it: its auth event is recorded under it. */
  accountId: string | null;
}

export interface IssuedToken {
  token: string;
  expiresIn: number;
}

/** Who an App Attest key belongs to: the install itself, or the user an issuer token names. */
type Claimant = { source: "app_install" } | { source: "issuer"; issuer: IssuerAuthentication; token: string };

const APP_INSTALL: Claimant = { source: "app_install" };

/** `issuer_token` is refused for an `app_install` app and required for an `issuer` one. */
function claimantSchema(endUser: AppAttestEndUser, issuerToken: z.ZodOptional<z.ZodString>): z.ZodType<Claimant> {
  if (endUser.source === "app_install") {
    return z
      .undefined({ error: "This application identifies users by app installation, so issuer_token is not accepted" })
      .optional()
      .transform((): Claimant => APP_INSTALL);
  }
  const { issuer } = endUser;
  return issuerToken.unwrap().transform((token): Claimant => ({ source: "issuer", issuer, token }));
}

function withClaimant<T extends { issuer_token: Claimant }>({ issuer_token: claimant, ...body }: T) {
  return { ...body, claimant };
}

function attestBodies(endUser: AppAttestEndUser) {
  return {
    token: AppAttestTokenRequestSchema.extend({
      issuer_token: claimantSchema(endUser, AppAttestTokenRequestSchema.shape.issuer_token),
    }).transform(withClaimant),
    register: AppAttestRegisterRequestSchema.extend({
      issuer_token: claimantSchema(endUser, AppAttestRegisterRequestSchema.shape.issuer_token),
    }).transform(withClaimant),
  };
}

type AttestBodies = ReturnType<typeof attestBodies>;

const attestBodyCache = new WeakMap<AppAttestEndUser, AttestBodies>();

function attestBodiesFor(endUser: AppAttestEndUser): AttestBodies {
  let bodies = attestBodyCache.get(endUser);
  if (!bodies) {
    bodies = attestBodies(endUser);
    attestBodyCache.set(endUser, bodies);
  }
  return bodies;
}

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
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface ExchangeHandler<K extends ExchangeType> {
  readonly authMethod: AuthMethod;
  /** Refuses a body meant for the other exchange with a clearer error than the schema would give. */
  refuseBody?(raw: Record<string, unknown>): void;
  tokenBody(exchange: TokenExchange<K>): z.ZodType<ExchangeBodies[K]["token"]>;
  token(input: ExchangeInput<K, ExchangeBodies[K]["token"]>): Promise<IssuedToken>;
  registration?: {
    body(exchange: TokenExchange<K>): z.ZodType<RegisterBody<K>>;
    run(input: ExchangeInput<K, RegisterBody<K>>): Promise<{ user_id: string }>;
  };
}

/** Spends a challenge this app issued and that has not expired, or refuses. Each challenge is used once. */
async function consumeChallenge(env: Env, appId: string, challenge: string): Promise<void> {
  const consumed = await database(env.DB)
    .delete(appAuthChallenge)
    .where(
      and(
        eq(appAuthChallenge.challenge, challenge),
        eq(appAuthChallenge.appId, appId),
        gt(appAuthChallenge.expiresAt, Date.now()),
      ),
    )
    .returning({ challenge: appAuthChallenge.challenge });
  if (consumed.length === 0) {
    throw new GatewayError(403, "attest_failed", "Challenge is invalid, expired, or already used");
  }
}

/** The user an App Attest key belongs to, and whether an issuer vouched for it. */
async function attestedUserId(body: { key_id: string; claimant: Claimant }): Promise<{ userId: string; trusted: boolean }> {
  if (body.claimant.source === "app_install") return { userId: body.key_id, trusted: false };
  const { userId } = await verifyIssuerToken(body.claimant.token, body.claimant.issuer);
  return { userId, trusted: true };
}

async function storeAttestedKey(input: {
  env: Env;
  appId: string;
  userId: string;
  keyId: string;
  publicKeyPem: string;
  environment: AppAttestEnvironment;
}): Promise<void> {
  const db = database(input.env.DB);
  const now = Date.now();
  await db.batch([
    db
      .insert(appEndUser)
      .values({ appId: input.appId, id: input.userId, createdAt: now, lastSeenAt: now })
      .onConflictDoUpdate({ target: [appEndUser.appId, appEndUser.id], set: { lastSeenAt: now } }),
    db
      .insert(appAttestKey)
      .values({
        appId: input.appId,
        keyId: input.keyId,
        publicKey: input.publicKeyPem,
        environment: input.environment,
        userId: input.userId,
        createdAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [appAttestKey.appId, appAttestKey.keyId],
        set: {
          publicKey: input.publicKeyPem,
          environment: input.environment,
          userId: input.userId,
          createdAt: now,
          lastSeenAt: now,
        },
      }),
  ]);
  invalidateRegisteredKey(input.appId, input.keyId);
}

/** Records an issuer's user, or refuses a blocked one. */
async function storeIssuerUser(env: Env, appId: string, userId: string): Promise<void> {
  const now = Date.now();
  const [user] = await database(env.DB)
    .insert(appEndUser)
    .values({ appId, id: userId, createdAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [appEndUser.appId, appEndUser.id],
      set: { lastSeenAt: now },
      setWhere: eq(appEndUser.status, "active"),
    })
    .returning({ status: appEndUser.status });
  if (!user || user.status !== "active") throw new GatewayError(403, "auth_required", "User is blocked");
}

async function assertExistingUserActive(env: Env, appId: string, userId: string): Promise<void> {
  const user = await database(env.DB).query.appEndUser.findFirst({
    columns: { status: true },
    where: and(eq(appEndUser.appId, appId), eq(appEndUser.id, userId)),
  });
  if (user !== undefined && user.status !== "active") throw new GatewayError(403, "auth_required", "User is blocked");
}

/**
 * The hashed Apple Account an AppTransaction names, or null. Never refuses
 * the exchange: an install without a verifiable transaction is counted on
 * its own.
 */
async function appleAccount(appId: string, bundleId: string, jws: string): Promise<string | null> {
  try {
    const { verifyAppTransaction } = await import("./app-transaction.ts");
    const result = await verifyAppTransaction({ jws, appId, bundleId });
    if (result.account === null) log("info", "app_transaction_unverified", { app: appId, reason: result.rejection });
    return result.account;
  } catch (error) {
    log("warn", "app_transaction_check_failed", { app: appId, error: errorFacts(error) });
    return null;
  }
}

const API_KEY_ISSUER: ExchangeHandler<"api_key_issuer"> = {
  authMethod: "api_key",
  tokenBody: () => ApiKeyTokenRequestSchema,
  async token({ env, appId, exchange, body, attempt }) {
    const apiKeyRecord = await lookupApiKeyUncached(env, body.api_key);
    if (!apiKeyRecord || apiKeyRecord.appId !== appId) {
      throw new GatewayError(403, "auth_required", "Gateway API key was rejected");
    }
    const { userId } = await verifyIssuerToken(body.issuer_token, exchange.issuer);
    attempt.userId = userId;
    await storeIssuerUser(env, appId, userId);
    return issueGatewayToken(env.JWT_SECRET, {
      appId,
      userId,
      authMethod: "api_key",
      apiKeyId: apiKeyRecord.id,
      // Split keys (plan step 8j): a key with a keyslot is the credential that
      // opens it, so the token carries it, sealed. Its hash just matched, so
      // it is the key the keyslot was made for.
      ...(apiKeyRecord.slot === null ? {} : { keyShare: body.api_key }),
    });
  },
};

const APP_ATTEST: ExchangeHandler<"app_attest"> = {
  authMethod: "attest",
  registration: {
    body: ({ authentication }) => attestBodiesFor(authentication.end_user).register,
    async run({ env, appId, exchange: { authentication: auth }, body, attempt }) {
      const { userId, trusted } = await attestedUserId(body);
      if (trusted) attempt.userId = userId;
      await assertExistingUserActive(env, appId, userId);
      await consumeChallenge(env, appId, body.challenge);
      const { verifyAppAttestation } = await import("./app-attest.ts");
      const verified = await verifyAppAttestation({
        appId: `${auth.app_attest.team_id}.${auth.app_attest.bundle_id}`,
        allowedEnvironments: auth.app_attest.environments,
        keyId: body.key_id,
        challenge: body.challenge,
        attestation: body.attestation,
      });
      attempt.userId = userId;
      await storeAttestedKey({
        env,
        appId,
        userId,
        keyId: body.key_id,
        publicKeyPem: verified.publicKeyPem,
        environment: verified.environment,
      });
      return { user_id: userId };
    },
  },
  refuseBody(raw) {
    if ("api_key" in raw) {
      throw new GatewayError(400, "auth_method_not_supported", "API key token exchange is not supported for this app");
    }
  },
  tokenBody: ({ authentication }) => attestBodiesFor(authentication.end_user).token,
  async token({ env, appId, exchange: { authentication: auth }, body, attempt, waitUntil }) {
    const { userId, trusted } = await attestedUserId(body);
    if (trusted) attempt.userId = userId;
    const db = database(env.DB);
    const accountId = attempt.accountId;
    const [user, key, splitKeys] = await Promise.all([
      db.query.appEndUser.findFirst({
        columns: { status: true },
        where: and(eq(appEndUser.appId, appId), eq(appEndUser.id, userId)),
      }),
      db.query.appAttestKey.findFirst({
        columns: { publicKey: true, environment: true, userId: true },
        where: and(eq(appAttestKey.appId, appId), eq(appAttestKey.keyId, body.key_id)),
      }),
      accountId === null ? false : splitKeysOn(env, accountId),
    ]);
    if (user !== undefined && user.status !== "active") throw new GatewayError(403, "auth_required", "User is blocked");
    if (!key || key.userId !== userId) throw new GatewayError(403, "attest_failed", "No matching registered App Attest key");
    if (!auth.app_attest.environments.includes(key.environment)) {
      throw new GatewayError(403, "attest_failed", "The registered App Attest environment is no longer allowed");
    }
    await consumeChallenge(env, appId, body.challenge);
    const { assertionClientData, sha256, verifyAppAssertion } = await import("./app-assertion.ts");
    const appTransaction = body.app_transaction;
    const appTransactionHash =
      appTransaction === undefined
        ? undefined
        : (await sha256(new TextEncoder().encode(appTransaction))).toString("base64url");
    const counter = await verifyAppAssertion({
      rpId: `${auth.app_attest.team_id}.${auth.app_attest.bundle_id}`,
      assertion: body.assertion,
      publicKeyPem: key.publicKey,
      clientDataHash: await sha256(assertionClientData(appId, body.challenge, body.key_id, appTransactionHash)),
    });
    // The token exchange signs with the same key as request proofs, so it
    // uses the same counter sequence, and its replay check is never skipped.
    await useAssertionCounter(env, appId, body.key_id, counter);
    // Split keys (plan step 8j): with them on, the install's requests can open
    // the account's keys only with the app's share, so a missing or wrong one
    // is refused here, before any call. With them off the field is ignored.
    let shareId: string | null = null;
    if (splitKeys && accountId !== null) {
      if (body.key_share === undefined) {
        throw new GatewayError(401, "auth_required", "This app needs its key share: split keys are on for its account");
      }
      shareId = await checkShare(env, appId, accountId, body.key_share);
    }
    const now = Date.now();
    waitUntil(
      contained(
        "auth_last_seen",
        db.batch([
          db
            .update(appAttestKey)
            .set({ lastSeenAt: now })
            .where(and(eq(appAttestKey.appId, appId), eq(appAttestKey.keyId, body.key_id))),
          db
            .update(appEndUser)
            .set({ lastSeenAt: now })
            .where(and(eq(appEndUser.appId, appId), eq(appEndUser.id, userId))),
          ...(shareId === null ? [] : [db.update(appKeyShare).set({ lastUsedAt: now }).where(eq(appKeyShare.id, shareId))]),
        ]),
      ),
    );
    const appleAccountId =
      appTransaction === undefined ? null : await appleAccount(appId, auth.app_attest.bundle_id, appTransaction);
    attempt.userId = userId;
    return issueGatewayToken(env.JWT_SECRET, {
      appId,
      userId,
      authMethod: "attest",
      installId: body.key_id,
      appleAccountId,
      ...(shareId === null || body.key_share === undefined ? {} : { keyShare: body.key_share }),
    });
  },
};

export const EXCHANGES: { [K in ExchangeType]: ExchangeHandler<K> } = {
  api_key_issuer: API_KEY_ISSUER,
  app_attest: APP_ATTEST,
};
