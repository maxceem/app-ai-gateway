import { Hono } from "hono";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { assertAppActive, loadAppConfig } from "../core/config";
import { GatewayError } from "../core/errors";
import { verifyAppAssertion, verifyAppAttestation } from "../core/appattest";
import { verifyApiKey } from "../core/apikeys";
import { verifyIssuerToken } from "../core/issuer";
import { issueGatewayToken } from "../core/jwt";
import type { AppConfig, AppleAppAttestAuthentication } from "../core/types";
import { database } from "../db";
import { appAuthChallenge, appUser } from "../db/schema";
import {
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
  ApiKeyTokenRequestSchema,
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
}): Promise<void> {
  await database(input.env.DB)
    .insert(appUser)
    .values({
      appId: input.appId,
      id: input.userId,
      attestKeyId: input.keyId,
      attestPublicKey: input.publicKeyPem,
      attestCounter: 0,
      lastSeenAt: sql`datetime('now')`,
    })
    .onConflictDoUpdate({
      target: [appUser.appId, appUser.id],
      set: {
        attestKeyId: input.keyId,
        attestPublicKey: input.publicKeyPem,
        attestCounter: 0,
        lastSeenAt: sql`datetime('now')`,
      },
    });
}

async function storeIssuerUser(env: Env, appId: string, userId: string): Promise<void> {
  const [user] = await database(env.DB)
    .insert(appUser)
    .values({ appId, id: userId, lastSeenAt: sql`datetime('now')` })
    .onConflictDoUpdate({
      target: [appUser.appId, appUser.id],
      set: { lastSeenAt: sql`datetime('now')` },
      setWhere: eq(appUser.status, "active"),
    })
    .returning({ status: appUser.status });
  if (!user || user.status !== "active") {
    throw new GatewayError(403, "auth_required", "User is blocked");
  }
}

async function assertExistingUserActive(env: Env, appId: string, userId: string): Promise<void> {
  const user = await database(env.DB).query.appUser.findFirst({
    columns: { status: true },
    where: and(eq(appUser.appId, appId), eq(appUser.id, userId)),
  });
  if (user?.status !== undefined && user.status !== "active") {
    throw new GatewayError(403, "auth_required", "User is blocked");
  }
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
  await database(c.env.DB).insert(appAuthChallenge).values({
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
  // Do not spend a challenge or ask Apple to attest a replacement key for a
  // user whom the operator has blocked.
  await assertExistingUserActive(c.env, appId, userId);
  await consumeChallenge(c.env, appId, body.challenge);
  const verifiedAttestation = await verifyAppAttestation({
    appId: `${auth.app_attest.team_id}.${auth.app_attest.bundle_id}`,
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
  });
  return c.json({ user_id: userId });
});

authRoutes.post("/token", async (c) => {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  assertAppActive(app);
  const rawBody = objectBody(await c.req.json());

  if ("api_key" in rawBody) {
    if (app.authentication.type !== "api_key") {
      throw new GatewayError(
        400,
        "auth_method_not_supported",
        "API key token exchange is not supported for this app",
      );
    }
    const auth = app.authentication;
    if (!auth.issuer) {
      throw new GatewayError(
        400,
        "auth_method_not_supported",
        "API key token exchange requires an issuer configuration",
      );
    }
    const body = schemaBody(ApiKeyTokenRequestSchema, rawBody);
    let apiKeyId: string;
    try {
      // Token exchange is a security boundary where revocation must take effect
      // immediately. Issuer-less data-plane authentication keeps the existing
      // short cache, but an exchange always confirms the key's current status.
      const apiKeyIdentity = await verifyApiKey(
        body.api_key,
        c.env,
        appId,
        null,
        { bypassCache: true },
      );
      if (!apiKeyIdentity.apiKeyId) {
        throw new GatewayError(500, "internal_error", "Verified API key identity is incomplete");
      }
      apiKeyId = apiKeyIdentity.apiKeyId;
    } catch (error) {
      if (error instanceof GatewayError && error.code === "auth_required") {
        throw new GatewayError(403, "auth_required", "Gateway API key was rejected");
      }
      throw error;
    }
    const { userId } = await verifyIssuerToken(body.issuer_token, auth.issuer);
    await storeIssuerUser(c.env, appId, userId);
    const issued = await issueGatewayToken(
      c.env.JWT_SECRET,
      appId,
      userId,
      "api_key",
      accessTtl(),
      { apiKeyId },
    );
    return c.json({ access_token: issued.token, expires_in: issued.expiresIn });
  }

  if (app.authentication.type === "api_key") {
    throw new GatewayError(
      400,
      "invalid_request",
      app.authentication.issuer
        ? "api_key and issuer_token are required"
        : "API key token exchange requires an issuer configuration",
    );
  }

  const auth = appleAuth(app);
  const body = schemaBody(AppAttestTokenRequestSchema, rawBody);
  const { userId } = await verifyIssuerToken(body.issuer_token, auth.issuer);
  const user = await database(c.env.DB).query.appUser.findFirst({
    columns: {
      attestKeyId: true,
      attestPublicKey: true,
      attestCounter: true,
      status: true,
    },
    where: and(eq(appUser.appId, appId), eq(appUser.id, userId)),
  });
  if (user?.status !== undefined && user.status !== "active") {
    throw new GatewayError(403, "auth_required", "User is blocked");
  }
  if (!user || user.attestKeyId !== body.key_id || !user.attestPublicKey) {
    throw new GatewayError(403, "attest_failed", "No matching registered App Attest key");
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
  const issued = await issueGatewayToken(c.env.JWT_SECRET, appId, userId, "attest", accessTtl());
  return c.json({ access_token: issued.token, expires_in: issued.expiresIn });
});
