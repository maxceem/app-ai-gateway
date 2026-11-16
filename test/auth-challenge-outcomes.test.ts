import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { settleExpiredChallenges } from "../src/client-auth/auth-events";
import { MAINTENANCE_CRON } from "../src/core/maintenance-cron";
import app from "../src/index";
import { clearIsolateCaches, seedApp } from "./helpers";

const APPLE = { asn: 714, asOrganization: "Apple Inc." };

interface ChallengeEventRow {
  event: string;
  outcome: string;
  reason: string | null;
  app_version: string | null;
  client_sdk: string | null;
  network_asn: number | null;
  network_name: string | null;
  latency_ms: number | null;
  created_at: string;
}

async function call(
  appId: string,
  path: string,
  body: unknown,
  options: { headers?: Record<string, string>; cf?: Record<string, unknown> } = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://example.test/v1/apps/${appId}/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(body),
      ...(options.cf === undefined ? {} : { cf: options.cf }),
    } as RequestInit),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function issueChallenge(
  appId: string,
  options: { headers?: Record<string, string>; cf?: Record<string, unknown> } = {},
): Promise<string> {
  const response = await call(appId, "challenge", {}, options);
  expect(response.status).toBe(200);
  return ((await response.json()) as { challenge: string }).challenge;
}

async function eventsFor(appId: string, event?: string): Promise<ChallengeEventRow[]> {
  const rows = await env.DB.prepare(
    `SELECT event, outcome, reason, app_version, client_sdk, network_asn, network_name, latency_ms, created_at
       FROM app_auth_event WHERE app_id = ? ${event === undefined ? "" : "AND event = ?"} ORDER BY id`,
  ).bind(...(event === undefined ? [appId] : [appId, event])).all<ChallengeEventRow>();
  return rows.results;
}

async function challengesFor(appId: string): Promise<string[]> {
  const rows = await env.DB
    .prepare("SELECT challenge FROM app_auth_challenge WHERE app_id = ? ORDER BY challenge")
    .bind(appId)
    .all<{ challenge: string }>();
  return rows.results.map((row) => row.challenge);
}

/** Moves a challenge's window into the past, as an hour of waiting would. */
async function expire(challenge: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE app_auth_challenge SET expires_at = datetime('now', '-1 minute') WHERE challenge = ?",
  ).bind(challenge).run();
}

const ATTEST_FAILURE = {
  step: "attest_key",
  error: { domain: "com.apple.devicecheck.error", code: 3 },
  underlying_error: { domain: "NSURLErrorDomain", code: -1001 },
};

beforeEach(() => {
  clearIsolateCaches();
});

describe("issued App Attest challenges", () => {
  it("keep who asked, for the event recorded if nobody comes back", async () => {
    await seedApp("challenge-keeps-caller");
    const challenge = await issueChallenge("challenge-keeps-caller", {
      headers: { "x-app-version": "2.4.0", "x-client-sdk": "app-ai-gateway-swift/1.9.0" },
      cf: APPLE,
    });

    const row = await env.DB.prepare(
      "SELECT app_version, client_sdk, network_asn, network_name, attempted FROM app_auth_challenge WHERE challenge = ?",
    ).bind(challenge).first();
    expect(row).toEqual({
      app_version: "2.4.0",
      client_sdk: "app-ai-gateway-swift/1.9.0",
      network_asn: 714,
      network_name: "Apple Inc.",
      attempted: 0,
    });
  });
});

describe("settling expired challenges", () => {
  it("records each one nothing spent as abandoned, dated when it was issued, and deletes them all", async () => {
    const appId = "challenge-settle";
    await seedApp(appId);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_auth_challenge(challenge, app_id, expires_at, app_version, client_sdk, network_asn, network_name)
         VALUES (?, ?, '2026-10-01 10:05:00', '2.4.0', 'app-ai-gateway-swift/1.9.0', 714, 'Apple Inc.')`,
      ).bind(`${appId}-unused`, appId),
      // A refused registration or exchange named this one: already recorded.
      env.DB.prepare(
        "INSERT INTO app_auth_challenge(challenge, app_id, expires_at, attempted) VALUES (?, ?, '2026-10-01 10:05:00', 1)",
      ).bind(`${appId}-attempted`, appId),
      env.DB.prepare(
        "INSERT INTO app_auth_challenge(challenge, app_id, expires_at) VALUES (?, ?, datetime('now', '+5 minutes'))",
      ).bind(`${appId}-live`, appId),
    ]);

    const settled = await settleExpiredChallenges(env.DB);

    expect(settled.abandoned).toBeGreaterThanOrEqual(1);
    expect(settled.deleted).toBeGreaterThanOrEqual(2);
    expect(await eventsFor(appId)).toEqual([{
      event: "challenge",
      outcome: "abandoned",
      reason: "challenge_unused",
      app_version: "2.4.0",
      client_sdk: "app-ai-gateway-swift/1.9.0",
      network_asn: 714,
      network_name: "Apple Inc.",
      latency_ms: null,
      created_at: "2026-10-01 10:00:00",
    }]);
    await expect(challengesFor(appId)).resolves.toEqual([`${appId}-live`]);

    // Nothing is left to settle, and nothing is recorded twice.
    await settleExpiredChallenges(env.DB);
    expect(await eventsFor(appId)).toHaveLength(1);
  });

  it("does not count a refused exchange twice when it left its challenge unspent", async () => {
    const appId = "challenge-refused-exchange";
    await seedApp(appId, { endUser: "app_install" });
    const challenge = await issueChallenge(appId);

    // No key is registered under this id, so the exchange is refused before
    // it spends the challenge.
    const refused = await call(appId, "token", {
      key_id: "dW5yZWdpc3RlcmVkLWtleQ==",
      assertion: "AAAA",
      challenge,
    });
    expect(refused.status).toBe(403);
    await expect(challengesFor(appId)).resolves.toEqual([challenge]);

    await expire(challenge);
    await settleExpiredChallenges(env.DB);

    expect((await eventsFor(appId)).map((row) => `${row.event}:${row.outcome}`)).toEqual([
      "token_exchange:attest_failed",
    ]);
    await expect(challengesFor(appId)).resolves.toEqual([]);
  });

  it("run every hour from the one trigger, which runs the nightly maintenance only at 03:17", async () => {
    const appId = "challenge-hourly";
    await seedApp(appId);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO app_auth_challenge(challenge, app_id, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))",
      ).bind(`${appId}-unused`, appId),
      env.DB.prepare(
        `INSERT INTO app_auth_event(event_id, app_id, event, outcome, created_at)
         VALUES ('${appId}-old', ?, 'token_exchange', 'ok', datetime('now', '-91 days'))`,
      ).bind(appId),
    ]);

    const hourly = createExecutionContext();
    app.scheduled({ cron: MAINTENANCE_CRON, scheduledTime: Date.parse("2026-10-01T04:17:00Z") } as ScheduledController, env, hourly);
    await waitOnExecutionContext(hourly);

    await expect(challengesFor(appId)).resolves.toEqual([]);
    expect((await eventsFor(appId)).map((row) => `${row.event}:${row.outcome}`)).toEqual([
      "token_exchange:ok",
      "challenge:abandoned",
    ]);

    const nightly = createExecutionContext();
    app.scheduled({ cron: MAINTENANCE_CRON, scheduledTime: Date.parse("2026-10-01T03:17:00Z") } as ScheduledController, env, nightly);
    await waitOnExecutionContext(nightly);

    expect((await eventsFor(appId)).map((row) => `${row.event}:${row.outcome}`)).toEqual([
      "challenge:abandoned",
    ]);
  });
});

describe("failure reports", () => {
  it("record the step and errors the app reports, once per challenge", async () => {
    const appId = "challenge-report";
    await seedApp(appId);
    const challenge = await issueChallenge(appId, { headers: { "x-app-version": "2.4.0" } });

    const reported = await call(appId, "failure", { challenge, ...ATTEST_FAILURE }, {
      headers: { "x-client-sdk": "app-ai-gateway-swift/1.9.0" },
      cf: APPLE,
    });
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({ recorded: true });

    const [event] = await eventsFor(appId);
    expect(event).toMatchObject({
      event: "challenge",
      outcome: "client_failed",
      reason: "attest_key:com.apple.devicecheck.error:3>NSURLErrorDomain:-1001",
      app_version: "2.4.0",
      client_sdk: "app-ai-gateway-swift/1.9.0",
      network_asn: 714,
      network_name: "Apple Inc.",
    });
    expect(event?.latency_ms).toBeGreaterThanOrEqual(0);

    // The report spent the challenge: a second one records nothing, and it
    // never also becomes abandoned.
    const again = await call(appId, "failure", { challenge, ...ATTEST_FAILURE });
    expect(await again.json()).toEqual({ recorded: false });
    await expect(challengesFor(appId)).resolves.toEqual([]);
    await settleExpiredChallenges(env.DB);
    expect(await eventsFor(appId)).toHaveLength(1);
  });

  it("record a failure the app recovered from on its own as client_recovered", async () => {
    const appId = "challenge-report-recovered";
    await seedApp(appId);
    const challenge = await issueChallenge(appId);

    await call(appId, "failure", {
      challenge,
      step: "generate_assertion",
      error: { domain: "com.apple.devicecheck.error", code: 2 },
      recovered: true,
    });

    expect((await eventsFor(appId)).map((row) => [row.outcome, row.reason])).toEqual([
      ["client_recovered", "generate_assertion:com.apple.devicecheck.error:2"],
    ]);
  });

  it("record nothing for a challenge the app was never issued", async () => {
    await seedApp("challenge-report-owner");
    await seedApp("challenge-report-other");
    const challenge = await issueChallenge("challenge-report-owner");

    const elsewhere = await call("challenge-report-other", "failure", { challenge, ...ATTEST_FAILURE });
    const invented = await call("challenge-report-owner", "failure", { challenge: "invented", ...ATTEST_FAILURE });

    expect(await elsewhere.json()).toEqual({ recorded: false });
    expect(await invented.json()).toEqual({ recorded: false });
    expect(await eventsFor("challenge-report-other")).toEqual([]);
    expect(await eventsFor("challenge-report-owner")).toEqual([]);
    await expect(challengesFor("challenge-report-owner")).resolves.toEqual([challenge]);
  });

  it("keep an error domain only when it is a short token", async () => {
    const appId = "challenge-report-domain";
    await seedApp(appId);
    const challenge = await issueChallenge(appId);

    await call(appId, "failure", {
      challenge,
      step: "register",
      error: { domain: "visit https://example.test now", code: 1 },
      // A newer client's field this gateway does not know is ignored, not refused.
      attempt: 2,
    });

    expect((await eventsFor(appId)).map((row) => row.reason)).toEqual(["register:other:1"]);
  });

  it("refuse a body that is not a report, and leave the challenge alone", async () => {
    const appId = "challenge-report-invalid";
    await seedApp(appId);
    const challenge = await issueChallenge(appId);

    const missingStep = await call(appId, "failure", { challenge, error: { domain: "NSURLErrorDomain", code: -1 } });
    const freeTextStep = await call(appId, "failure", {
      challenge,
      step: "Something went wrong",
      error: { domain: "NSURLErrorDomain", code: -1 },
    });

    expect(missingStep.status).toBe(400);
    expect(freeTextStep.status).toBe(400);
    await expect(challengesFor(appId)).resolves.toEqual([challenge]);
    expect(await eventsFor(appId)).toEqual([]);
  });
});
