import { Hono } from "hono";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { assertAppActive, loadAppConfig } from "../core/config";
import { GatewayError } from "../core/errors";
import { verifyDevelopmentCredential } from "../core/development-credentials";
import { verifyAppAssertion, verifyAppAttestation } from "../core/appattest";
import { verifyIssuerToken } from "../core/issuer";
import { issueGatewayToken } from "../core/jwt";
import type { AppAttestEnvironment, AppConfig, AppleAppAttestAuthentication } from "../core/types";
import { database } from "../db";
import { authChallenges, users } from "../db/schema";
import {
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
  DevelopmentTokenRequestSchema,
} from "../contracts/schemas";

const GATEWAY_TOKEN_TTL_SECONDS = 3600;

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  return value as Record<string, unknown>;
}

function schemaBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new GatewayError(
    400,
    "invalid_request",
    issue
      ? issue.path.length > 0
        ? `${issue.path.join(".")} is required`
        : issue.message
      : "Invalid request body",
  );
}

async function consumeChallenge(env: Env, appId: string, challenge: string): Promise<void> {
  const consumed = await database(env.DB)
    .delete(authChallenges)
    .where(and(
      eq(authChallenges.challenge, challenge),
      eq(authChallenges.appId, appId),
      gt(authChallenges.expiresAt, sql`datetime('now')`),
    ))
    .returning({ challenge: authChallenges.challenge });
  if (consumed.length === 0) {
    throw new GatewayError(403, "attest_failed", "Challenge is invalid, expired, or already used");
  }
}

function accessTtl(): number {
  return GATEWAY_TOKEN_TTL_SECONDS;
}

function appleAuth(app: AppConfig): AppleAppAttestAuthentication {
  if (app.authentication.type !== "apple_app_attest") {
    throw new GatewayError(
      403,
      "auth_method_not_supported",
      "Issuer token exchange is not supported for this app",
    );
  }
  return app.authentication;
}

export async function storeAttestedUser(input: {
  env: Env;
  appId: string;
  userId: string;
  keyId: string;
  publicKeyPem: string;
  environment: AppAttestEnvironment;
}): Promise<void> {
  await database(input.env.DB)
    .insert(users)
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
      target: [users.appId, users.id],
      set: {
        attestKeyId: input.keyId,
        attestPublicKey: input.publicKeyPem,
        attestCounter: 0,
        attestEnvironment: input.environment,
        lastSeenAt: sql`datetime('now')`,
      },
    });
}

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.post("/challenge", async (c) => {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  assertAppActive(app);
  appleAuth(app);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
  await database(c.env.DB).insert(authChallenges).values({
    challenge,
    appId,
    expiresAt: sql`datetime('now', '+5 minutes')`,
  });
  return c.json({ challenge, expires_in: 300 });
});

authRoutes.post("/register", async (c) => {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  assertAppActive(app);
  const auth = appleAuth(app);
  const body = schemaBody(AppAttestRegisterRequestSchema, await c.req.json());
  const { userId } = await verifyIssuerToken(body.issuer_token, auth.issuer);
  await consumeChallenge(c.env, appId, body.challenge);
  const verifiedAttestation = await verifyAppAttestation({
    appId: `${auth.app_attest.team_id}.${auth.app_attest.bundle_id}`,
    allowedEnvironments: auth.app_attest.environments,
    keyId: body.key_id,
    challenge: body.challenge,
    attestation: body.attestation,
  });
  await storeAttestedUser({
    env: c.env,
    appId,
    userId,
    keyId: body.key_id,
    publicKeyPem: verifiedAttestation.publicKeyPem,
    environment: verifiedAttestation.environment,
  });
  return c.json({ user_id: userId });
});

authRoutes.post("/token", async (c) => {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  assertAppActive(app);
  const auth = appleAuth(app);
  const rawBody = objectBody(await c.req.json());

  if ("dev_secret" in rawBody) {
    if (!auth.development_access) {
      throw new GatewayError(403, "auth_required", "Development access is not enabled for this app");
    }
    if ("user_id" in rawBody) {
      throw new GatewayError(400, "invalid_request", "user_id is not accepted");
    }
    const body = schemaBody(DevelopmentTokenRequestSchema, rawBody);
    if (!(await verifyDevelopmentCredential(c.env, appId, body.dev_secret))) {
      throw new GatewayError(401, "auth_required", "Development credentials were rejected");
    }
    const { userId } = await verifyIssuerToken(body.issuer_token, auth.issuer);
    await database(c.env.DB)
      .insert(users)
      .values({ appId, id: userId, lastSeenAt: sql`datetime('now')` })
      .onConflictDoUpdate({
        target: [users.appId, users.id],
        set: { lastSeenAt: sql`datetime('now')` },
      });
    const issued = await issueGatewayToken(c.env.JWT_SECRET, appId, userId, "dev", accessTtl());
    return c.json({ access_token: issued.token, expires_in: issued.expiresIn });
  }

  const body = schemaBody(AppAttestTokenRequestSchema, rawBody);
  const { userId } = await verifyIssuerToken(body.issuer_token, auth.issuer);
  const user = await database(c.env.DB).query.users.findFirst({
    columns: {
      attestKeyId: true,
      attestPublicKey: true,
      attestCounter: true,
      attestEnvironment: true,
      status: true,
    },
    where: and(eq(users.appId, appId), eq(users.id, userId)),
  });
  if (
    !user ||
    user.status !== "active" ||
    user.attestKeyId !== body.key_id ||
    !user.attestPublicKey
  ) {
    throw new GatewayError(403, "attest_failed", "No matching registered App Attest key");
  }
  if (
    user.attestEnvironment !== null &&
    !auth.app_attest.environments.includes(user.attestEnvironment)
  ) {
    throw new GatewayError(403, "attest_failed", "The registered App Attest environment is no longer allowed");
  }
  await consumeChallenge(c.env, appId, body.challenge);
  const counter = await verifyAppAssertion({
    gatewayAppId: appId,
    rpId: `${auth.app_attest.team_id}.${auth.app_attest.bundle_id}`,
    keyId: body.key_id,
    challenge: body.challenge,
    assertion: body.assertion,
    publicKeyPem: user.attestPublicKey,
    previousCounter: user.attestCounter,
  });
  const updated = await database(c.env.DB)
    .update(users)
    .set({ attestCounter: counter, lastSeenAt: sql`datetime('now')` })
    .where(and(
      eq(users.appId, appId),
      eq(users.id, userId),
      lt(users.attestCounter, counter),
    ))
    .returning({ id: users.id });
  if (updated.length !== 1) {
    throw new GatewayError(403, "attest_failed", "App Attest assertion counter was replayed");
  }
  const issued = await issueGatewayToken(c.env.JWT_SECRET, appId, userId, "attest", accessTtl());
  return c.json({ access_token: issued.token, expires_in: issued.expiresIn });
});
