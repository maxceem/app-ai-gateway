/**
 * Test helpers: an account, apps with given sign-in settings, App Attest
 * installs registered without Apple, and the assertions and request proofs a
 * device would send.
 */
import { Buffer } from "node:buffer";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { env } from "cloudflare:workers";
import { encode } from "cbor-x";
import { hashApiKey } from "../src/client-auth/api-keys.ts";
import { issueGatewayToken } from "../src/client-auth/gateway-token.ts";
import { base64url, requestClientData } from "../src/client-auth/request-proof.ts";
import { appCache } from "../src/apps/app-records.ts";
import { clearAllCaches } from "../src/core/ttl-cache.ts";
import { resetStallHold } from "../src/core/stale-read.ts";

export const ACCOUNT_ID = "acc_test";
export const TEAM_ID = "AAAAAAAAAA";
export const BUNDLE_ID = "com.example.app";
export const RP_ID = `${TEAM_ID}.${BUNDLE_ID}`;

let seeded = false;

/** The test account, created once per test file's storage. */
export async function seedAccount(): Promise<void> {
  if (seeded) return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO mgmt_user(id, name, email, kind, email_verified, created_at, updated_at) VALUES ('usr_test', 'Test', NULL, 'service', 0, ?, ?)",
    ).bind(now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Test', 'usr_test', ?, ?)",
    ).bind(ACCOUNT_ID, new Date(now).toISOString(), new Date(now).toISOString()),
  ]);
  seeded = true;
}

let appCounter = 0;

/** An app with these sign-in settings. Returns its id. */
export async function seedApp(authentication: Record<string, unknown>, status: "active" | "disabled" = "active"): Promise<string> {
  await seedAccount();
  appCounter += 1;
  const id = `app_test_${appCounter}_${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO app(id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
  )
    .bind(id, ACCOUNT_ID, id, JSON.stringify({ authentication }), status, now, now)
    .run();
  return id;
}

/** App Attest settings: install users, every request signed, production and development keys. */
export function attestAuthentication(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "apple_app_attest",
    end_user: { source: "app_install" },
    app_attest: { team_id: TEAM_ID, bundle_id: BUNDLE_ID, environments: ["production", "development"], ...overrides },
  };
}

/** Stores an app key and returns its plain value. */
export async function seedAppKey(appId: string, status: "active" | "revoked" = "active"): Promise<{ id: string; key: string }> {
  const key = `agw_${crypto.randomUUID().replaceAll("-", "")}`;
  const id = `key_${crypto.randomUUID().slice(0, 12)}`;
  await env.DB.prepare(
    "INSERT INTO app_key(id, app_id, name, key_hash, key_prefix, status, created_at) VALUES (?, ?, 'test', ?, ?, ?, ?)",
  )
    .bind(id, appId, await hashApiKey(key), key.slice(0, 12), status, Date.now())
    .run();
  return { id, key };
}

export interface TestInstall {
  appId: string;
  userId: string;
  keyId: string;
  privateKey: KeyObject;
  publicKeyPem: string;
  counter: number;
}

/** Registers an App Attest key the way `/auth/register` would leave one, without asking Apple. */
export async function registerTestInstall(
  appId: string,
  options: { userId?: string; environment?: "production" | "development" } = {},
): Promise<TestInstall> {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const userId = options.userId ?? keyId;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO app_attest_key(app_id, key_id, public_key, environment, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(appId, keyId, publicKeyPem, options.environment ?? "production", userId, now, now)
    .run();
  return { appId, userId, keyId, privateKey: pair.privateKey, publicKeyPem, counter: 0 };
}

/** A gateway token for a registered install, as `/auth/token` would issue it. */
export async function tokenForInstall(install: TestInstall): Promise<string> {
  const issued = await issueGatewayToken(env.JWT_SECRET, {
    appId: install.appId,
    userId: install.userId,
    authMethod: "attest",
    installId: install.keyId,
    appleAccountId: null,
  });
  return issued.token;
}

/** An App Attest assertion over `clientDataHash`, as `DCAppAttestService` makes one. */
export async function testAssertion(input: {
  privateKey: KeyObject;
  rpId?: string;
  counter: number;
  clientDataHash: Uint8Array;
}): Promise<Buffer> {
  const authenticatorData = Buffer.alloc(37);
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.rpId ?? RP_ID))).copy(authenticatorData, 0);
  authenticatorData[32] = 1;
  authenticatorData.writeUInt32BE(input.counter, 33);
  const nonce = Buffer.from(
    await crypto.subtle.digest("SHA-256", Buffer.concat([authenticatorData, Buffer.from(input.clientDataHash)])),
  );
  const signer = createSign("SHA256");
  signer.update(nonce);
  return Buffer.from(encode({ signature: signer.sign(input.privateKey), authenticatorData }));
}

/** The `X-AppAttest-Proof` a device sends with one request. */
export async function signedProof(input: {
  install: TestInstall;
  token: string;
  method: string;
  url: string;
  body?: Uint8Array;
  counter: number;
}): Promise<string> {
  const url = new URL(input.url);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const clientData = await requestClientData({
    appId: input.install.appId,
    method: input.method,
    pathAndQuery: `${url.pathname}${url.search}`,
    body: input.body ?? new Uint8Array(),
    token: input.token,
    timestamp,
    nonce,
  });
  const assertion = await testAssertion({
    privateKey: input.install.privateKey,
    counter: input.counter,
    clientDataHash: new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientData))),
  });
  return `v1.${timestamp}.${nonce}.${base64url(assertion)}`;
}

/** Forgets every isolate cache, so each test reads D1 again. */
export function clearCaches(): void {
  clearAllCaches();
  appCache.clear();
  resetStallHold();
}

/**
 * Slow fakes for tests, without real timers. A fake awaits `held()`, so it
 * answers only once the test calls `release()`. Tests never sleep: they wait
 * for the deadline under test, or release the fake when they want it to
 * answer. Call `release()` in `afterEach` so nothing is left waiting.
 */
export function slowFakes(): { held: () => Promise<void>; release: () => void } {
  const waiting: (() => void)[] = [];
  return {
    held: () => new Promise<void>((resolve) => waiting.push(resolve)),
    release: () => {
      for (const go of waiting.splice(0)) go();
    },
  };
}

/** The auth events of one app, oldest first. */
export async function authEvents(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM app_auth_event WHERE app_id = ? ORDER BY id").bind(appId).all();
  return results;
}

/** An app with sign-in and routing settings. Returns its id. */
export async function seedRoutedApp(
  authentication: Record<string, unknown>,
  routing: Record<string, unknown>,
): Promise<string> {
  await seedAccount();
  appCounter += 1;
  const id = `app_test_${appCounter}_${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO app(id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)",
  )
    .bind(id, ACCOUNT_ID, id, JSON.stringify({ authentication, routing }), now, now)
    .run();
  return id;
}

/**
 * A management key for the test account. The user is made a member with
 * `role`. Returns the key's plain value.
 */
export async function seedManagementKey(
  options: { grant?: "read" | "manage"; role?: "owner" | "admin" | "member"; userId?: string } = {},
): Promise<string> {
  await seedAccount();
  const userId = options.userId ?? `usr_${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const key = `agw_mgmt_${crypto.randomUUID().replaceAll("-", "")}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO mgmt_user(id, name, email, kind, email_verified, created_at, updated_at) VALUES (?, 'Key owner', NULL, 'service', 0, ?, ?)",
    ).bind(userId, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization_user(id, organization_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).bind(`mem_${userId}`, ACCOUNT_ID, userId, options.role ?? "owner", new Date(now).toISOString()),
    env.DB.prepare(
      `INSERT INTO mgmt_api_key(id, user_id, organization_id, name, token_hash, token_hint, enabled, created_at, source, "grant", credential_type)
       VALUES (?, ?, ?, 'test', ?, ?, 1, ?, 'console', ?, 'apiKey')`,
    ).bind(`mk_${crypto.randomUUID().slice(0, 8)}`, userId, ACCOUNT_ID, hash, key.slice(-4), now, options.grant ?? "manage"),
  ]);
  return key;
}

/**
 * Loads the management code and the sign-in library once, before a file's
 * first test. The Worker loads them on first use, which takes a few seconds
 * in the test runtime, longer than one test may take while files run side by
 * side.
 */
export async function loadManagement(): Promise<void> {
  const { default: management } = await import("../src/management/app.ts");
  // The sign-in library does more of its loading on its first request.
  await management.fetch(new Request("https://console.gateway.test/v2/auth/get-session"), env);
  await management.fetch(new Request("https://console.gateway.test/.well-known/oauth-authorization-server/v2"), env);
}

/** How long {@link loadManagement} may take. */
export const LOAD_MANAGEMENT_TIMEOUT_MS = 60_000;

export interface SeededHuman {
  userId: string;
  accountId: string;
  /** For a request's `Cookie:` header. */
  cookie: string;
  email: string;
}

/**
 * A person with an account of their own and a console session, without
 * signing up: a password hash costs about two and a half seconds. Tests
 * whose subject is signing up still sign up.
 */
export async function seedHuman(email?: string): Promise<SeededHuman> {
  const { createIdentity } = await import("../src/auth/identity.ts");
  const { createTestSessions } = await import("@maxceem/cf-auth/testing");
  // As a deployment that admits anyone: a self-hosted one admits only listed emails.
  const sessions = createTestSessions(await createIdentity({ ...env, ALLOWED_REGISTRATION_EMAILS: "*" } as Env, "https://console.gateway.test"));
  const human = await sessions.human(email === undefined ? {} : { email });
  return { userId: human.userId, accountId: human.organizationId, cookie: human.cookie, email: human.user.email! };
}
