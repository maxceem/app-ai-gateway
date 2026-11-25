/**
 * Test helpers: an account, apps with given sign-in settings, App Attest
 * installs registered without Apple, and the assertions and request proofs a
 * device would send.
 */
import { AccountLedger } from "../src/do/AccountLedger.ts";
import { ledgerDb, type LedgerResult, type LedgerStatement } from "../src/ledger/database.ts";
import { Buffer } from "node:buffer";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { env } from "cloudflare:workers";
import { onTestFinished, vi } from "vitest";
import { hashApiKey } from "../src/client-auth/api-keys.ts";
import { issueGatewayToken } from "../src/client-auth/gateway-token.ts";
import { base64url, requestClientData } from "../src/client-auth/request-proof.ts";
import { appCache } from "../src/apps/app-records.ts";
import { clearAllCaches } from "../src/core/ttl-cache.ts";
import { resetStallHold } from "../src/core/stale-read.ts";
import { writeToLedger, type LedgerEntry } from "../src/ledger/write.ts";
import { encodeCbor } from "./app-attest-fixtures.ts";

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
  return Buffer.from(encodeCbor({ signature: signer.sign(input.privateKey), authenticatorData }));
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
 * answers only once the test calls `release()`. `reached(n)` resolves once
 * `n` fakes are waiting, so a test can move fake time only after the code
 * under test has started its deadline. Call `release()` in `afterEach` so
 * nothing is left waiting.
 */
export function slowFakes(): {
  held: () => Promise<void>;
  reached: (count?: number) => Promise<void>;
  release: () => void;
} {
  const waiting: (() => void)[] = [];
  const watchers: { count: number; resolve: () => void }[] = [];
  let arrived = 0;
  const notify = () => {
    for (const watcher of [...watchers]) {
      if (arrived >= watcher.count) {
        watchers.splice(watchers.indexOf(watcher), 1);
        watcher.resolve();
      }
    }
  };
  return {
    held: () => {
      const answer = new Promise<void>((resolve) => waiting.push(resolve));
      arrived += 1;
      notify();
      return answer;
    },
    reached: (count = 1) =>
      new Promise<void>((resolve) => {
        watchers.push({ count, resolve });
        notify();
      }),
    release: () => {
      arrived = 0;
      for (const go of waiting.splice(0)) go();
    },
  };
}

/** Whether a promise has settled yet, read without awaiting it. */
export function watch(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

/** Fake time for deadline tests: timers and the clock, nothing else. */
export function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/** The auth events of one app, oldest first. */
export async function authEvents(appId: string, accountId: string = ACCOUNT_ID): Promise<Record<string, unknown>[]> {
  const { results } = await ledger(accountId).prepare("SELECT * FROM app_auth_event WHERE app_id = ? ORDER BY id").bind(appId).all();
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
  options: {
    grant?: "read" | "manage";
    role?: "owner" | "admin" | "member";
    userId?: string;
    /**
     * An account of the test's own instead of the shared test account. Tests in
     * one file share the database, so a test that reads totals across a whole
     * account needs one nothing else writes to.
     */
    accountId?: string;
  } = {},
): Promise<string> {
  await seedAccount();
  const accountId = options.accountId ?? ACCOUNT_ID;
  const userId = options.userId ?? `usr_${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  if (accountId !== ACCOUNT_ID) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Own', 'usr_test', ?, ?)",
    )
      .bind(accountId, new Date(now).toISOString(), new Date(now).toISOString())
      .run();
  }
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
    ).bind(`mem_${userId}_${accountId}`, accountId, userId, options.role ?? "owner", new Date(now).toISOString()),
    env.DB.prepare(
      `INSERT INTO mgmt_api_key(id, user_id, organization_id, name, token_hash, token_hint, enabled, created_at, source, "grant", credential_type)
       VALUES (?, ?, ?, 'test', ?, ?, 1, ?, 'console', ?, 'apiKey')`,
    ).bind(`mk_${crypto.randomUUID().slice(0, 8)}`, userId, accountId, hash, key.slice(-4), now, options.grant ?? "manage"),
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

/**
 * Writes ledger entries as if now were their own write time, so a test's
 * fixed clock and the ledger's late-booking rule (`../src/ledger/late-booking.ts`)
 * agree.
 */
export async function writeAtTheirTime(entries: readonly LedgerEntry[]): Promise<number> {
  const at = Math.max(...entries.map((entry) => entry.charge.writtenAt));
  let changes = 0;
  for (const accountId of new Set(entries.map((entry) => entry.charge.accountId))) {
    changes += await writeToLedger(ledger(accountId), entries.filter((entry) => entry.charge.accountId === accountId), at);
  }
  return changes;
}

/**
 * `base` with every account's ledger object replaced by a D1-shaped stand-in
 * `make` builds from the real one: one that fails, stalls or counts.
 */
export function withLedgerDb(base: Env, make: (real: D1Database, accountId: string) => D1Database): Env {
  const namespace = {
    idFromName: (name: string) => name,
    get: (accountId: string) => ({
      query: async (statements: readonly LedgerStatement[], transaction: boolean): Promise<LedgerResult[]> => {
        const db = make(ledger(accountId), accountId);
        const prepared = statements.map((statement) => db.prepare(statement.sql).bind(...statement.params));
        const results = transaction ? await db.batch(prepared) : [await prepared[0]!.all()];
        return results.map((result) => {
          const columns = Object.keys((result.results[0] ?? {}) as object);
          const values = (result.results as Record<string, unknown>[]).map((row) => columns.map((column) => row[column]));
          return { values, columns, changes: result.meta.changes ?? 0, rowsRead: 0 };
        });
      },
    }),
  };
  return { ...base, ACCOUNT_LEDGER: namespace } as unknown as Env;
}

/** The ledger object's own `planWork`, kept so a test can let alarms be set again. */
const PLAN_WORK = (AccountLedger.prototype as unknown as { planWork(fresh?: boolean): Promise<void> }).planWork;

/**
 * Keeps the ledger objects from setting their alarms, for every test unless
 * it calls `allowLedgerWork`: an alarm would run the real sweep and nightly
 * clean-up at the real time, over rows each test dates at its own, and an
 * alarm left set keeps the run from ending. Patched on the class itself, not
 * spied, so `vi.restoreAllMocks()` in a test never turns alarms back on.
 */
export function pauseLedgerWork(): void {
  (AccountLedger.prototype as unknown as { planWork(): Promise<void> }).planWork = async () => undefined;
}

/** Lets the ledger objects set their alarms until the test ends. */
export function allowLedgerWork(): void {
  (AccountLedger.prototype as unknown as { planWork(fresh?: boolean): Promise<void> }).planWork = PLAN_WORK;
  onTestFinished(() => pauseLedgerWork());
}

/** An account's ledger, with D1's shape, as the code reads and writes it (step 8f). */
export function ledger(accountId: string = ACCOUNT_ID): D1Database {
  return ledgerDb(env, accountId);
}
