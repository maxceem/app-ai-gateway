import {
  compactUsageEvents,
  foldUsageRollupMonths,
} from "../src/core/usage-retention";
import { recordBlockedUsageEvent } from "../src/core/usage";
import { claimOAuthAuthorized } from "../src/routes/cli/oauth";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearIsolateCaches, seedHuman, seedUnaffiliatedHuman } from "./helpers";
import type { BillingRuntime } from "../src/billing/contract";
import {
  assertAccountAccess,
  clearAccountLifecycleCache,
  pruneExpiredAccounts,
} from "../src/core/account-lifecycle";
import { ENDPOINT_RATE_LIMITS } from "../src/core/endpoint-rate-limit";
import { secretVault } from "../src/vault";
import { resolveDeployment } from "../src/policy/deployment";

function fakeBilling(): BillingRuntime {
  const none = { plan: null, subscription: null };
  return {
    getTenantAccess: async () => ({
      plan: { planKey: "free", planName: "Free", isDefault: true, limits: { maxRequestsPerMonth: 1000 } },
      subscription: null,
    }),
    listPlans: async () => ({ plans: [] }),
    createCheckout: async () => ({ url: "https://checkout.test" }),
    changePlan: async () => ({ ok: true }),
    resumeSubscription: async () => ({ ok: true }),
    cancelSubscription: async () => ({ ok: true }),
    startTrial: async () => none,
    handleLemonWebhook: async () => ({
      ok: true,
      duplicate: false,
      stale: false,
    }),
  };
}
function runtime(cloud = true): Env {
  const values: Partial<Env> = {
    DEPLOYMENT_ID: "cli-test-deployment",
    CLI_CONSOLE_ORIGIN: "https://example.test",
    ...(cloud ? { BILLING: fakeBilling() } : {}),
  };
  return new Proxy(env, {
    get: (target, key, receiver) =>
      key === "BILLING"
        ? values.BILLING
        : key in values
          ? Reflect.get(values, key)
          : Reflect.get(target, key, receiver),
  });
}
const random = () => crypto.randomUUID();
let rateLimitIp = random();
async function request(
  testEnv: Env,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return worker.request(
    `https://example.test/v1/cli${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "cf-connecting-ip": rateLimitIp,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    testEnv,
  );
}
async function start(testEnv: Env, headers: Record<string, string> = {}) {
  const input = { idempotencyKey: random(), pollToken: random() };
  const response = await request(testEnv, "/bootstrap", input, {
    "cf-connecting-ip": random(),
    ...headers,
  });
  expect(response.status).toBe(200);
  return {
    input,
    data: (await response.json()) as {
      account: { id: string };
      credential: { token: string };
    },
  };
}
beforeEach(async () => {
  rateLimitIp = random();
  clearIsolateCaches();
  vi.restoreAllMocks();
  await env.DB.batch(
    [
      "app_auth_challenge",
      "app_auth_event",
      "app_usage_event",
      "app_usage_rollup",
      "app_usage_spend",
      "app_api_key",
      "app_user",
      "app",
      "provider",
      "provider_gateway",
      "mgmt_handoff",
      "mgmt_resource_receipt",
      "mgmt_verification",
      "mgmt_api_key",
      "mgmt_organization_user",
      "mgmt_organization",
      "mgmt_user",
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});

describe("CLI account lifecycle", () => {
  it.each([500, 5000, null])("reports the configured free allowance %s on bootstrap", async (limit) => {
    const testEnv = runtime();
    testEnv.BILLING!.getTenantAccess = async () => ({
      plan: { planKey: "free", planName: "Free", isDefault: true, limits: limit === null ? {} : { maxRequestsPerMonth: limit } },
      subscription: null,
    });
    const response = await request(testEnv, "/bootstrap", { idempotencyKey: random(), pollToken: random() });
    expect(response.status).toBe(200);
    const data = await response.json() as { trial: { limit?: number } };
    if (limit === null) expect(data.trial).not.toHaveProperty("limit");
    else expect(data.trial.limit).toBe(limit);
  });
  it("replays concurrent bootstrap without another account or plaintext verification credential", async () => {
    const testEnv = runtime();
    const input = { idempotencyKey: random(), pollToken: random() };
    const responses = await Promise.all([
      request(testEnv, "/bootstrap", input),
      request(testEnv, "/bootstrap", input),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const values = (await Promise.all(
      responses.map((r) => r.json()),
    )) as Array<{ credential: { token: string } }>;
    expect(values[0]!.credential.token).toBe(values[1]!.credential.token);
    const rows = await env.DB.prepare(
      "SELECT request_hash,outcome,protected_credential FROM mgmt_resource_receipt WHERE kind='bootstrap'",
    ).all();
    expect(JSON.stringify(rows)).not.toContain(values[0]!.credential.token);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_organization",
      ).first("n"),
    ).toBe(1);
    expect(
      (await request(testEnv, "/bootstrap", { ...input, pollToken: random() }))
        .status,
    ).toBe(403);
  });
  it("bootstraps and renews an unclaimed account beside an unrelated claimed account", async () => {
    const testEnv = runtime();
    const existing = await seedHuman();
    const input = { idempotencyKey: random(), pollToken: random() };
    const first = await request(testEnv, "/bootstrap", input, {
      "cf-connecting-ip": random(),
    });
    expect(first.status, await first.clone().text()).toBe(200);
    const created = await first.json() as {
      account: { id: string };
      credential: { token: string };
    };
    expect(created.account.id).not.toBe(existing.organizationId);
    expect((await request(testEnv, "/account", undefined, {
      authorization: `Bearer ${created.credential.token}`,
    })).status).toBe(200);
    await env.DB.prepare(
      "UPDATE mgmt_resource_receipt SET protected_credential_expires_at=0 WHERE kind='bootstrap' AND organization_id=?",
    ).bind(created.account.id).run();
    const renewed = await request(testEnv, "/bootstrap", input, {
      "cf-connecting-ip": random(),
    });
    expect(renewed.status, await renewed.clone().text()).toBe(200);
    const renewedBody = await renewed.json() as { credential: { token: string } };
    expect(renewedBody.credential.token).not.toBe(created.credential.token);
    expect((await request(testEnv, "/account", undefined, {
      authorization: `Bearer ${renewedBody.credential.token}`,
    })).status).toBe(200);
    expect((await request(testEnv, "/account", undefined, {
      authorization: `Bearer ${created.credential.token}`,
    })).status).toBe(401);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mgmt_organization WHERE id=?",
    ).bind(existing.organizationId).first("n")).toBe(1);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mgmt_organization_user(id,organization_id,user_id,role,status,joined_at) VALUES (?,?,?,'owner','active',?)",
      ).bind(random(), created.account.id, existing.userId, new Date().toISOString()),
      env.DB.prepare("UPDATE mgmt_organization SET expires_at=NULL WHERE id=?")
        .bind(created.account.id),
    ]);
    // Claiming through the CLI drops the cached row itself; this one is written
    // straight into D1, so the isolate has to be told.
    clearAccountLifecycleCache();
    expect((await request(testEnv, "/bootstrap", input, {
      "cf-connecting-ip": random(),
    })).status).toBe(403);
  });
  it("activates the bootstrap key through cf-auth and repairs an interrupted run", async () => {
    const testEnv = runtime();
    const { input, data } = await start(testEnv);

    // The key is issued inactive and only activated once its receipt commits,
    // so this is the state a run that died in between would leave behind.
    await env.DB.prepare("UPDATE mgmt_api_key SET enabled=0 WHERE organization_id=?")
      .bind(data.account.id)
      .run();
    expect(
      (
        await request(testEnv, "/account", undefined, {
          authorization: `Bearer ${data.credential.token}`,
        })
      ).status,
    ).toBe(401);

    const repeated = await request(testEnv, "/bootstrap", input, {
      "cf-connecting-ip": random(),
    });
    expect(repeated.status, await repeated.clone().text()).toBe(200);
    const repeatedBody = (await repeated.json()) as { credential: { token: string } };
    // Same receipt, so the same credential — and it works again.
    expect(repeatedBody.credential.token).toBe(data.credential.token);
    expect(
      (
        await request(testEnv, "/account", undefined, {
          authorization: `Bearer ${data.credential.token}`,
        })
      ).status,
    ).toBe(200);
  });
  it("does not count a selfhost's attempts, so an installer may retry past the cloud allowance", async () => {
    const testEnv = runtime(false);
    const input = { idempotencyKey: random(), pollToken: random() };
    // A deployment whose database is not callable yet: the writes throw, the
    // request is answered 500, and nothing is created. The CLI answers this by
    // sending the identical request again, which is what a counted endpoint
    // would refuse on the fourth try — on a deployment nobody owns yet.
    const batch = env.DB.batch.bind(env.DB);
    let refusals = 0;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (refusals++ < ENDPOINT_RATE_LIMITS.bootstrap.limit)
        throw new Error("D1_ERROR: Network connection lost");
      return batch(statements);
    });
    for (let attempt = 0; attempt < ENDPOINT_RATE_LIMITS.bootstrap.limit; attempt++)
      expect((await request(testEnv, "/bootstrap", input)).status).toBe(500);
    const installed = await request(testEnv, "/bootstrap", input);
    expect(installed.status).toBe(200);
    expect(((await installed.json()) as { credential: { token: string } }).credential.token)
      .toMatch(/^agw_mgmt_/u);
  });
  it("counts a cloud account's attempts, which is the deployment nobody owns", async () => {
    // Cloud is where initializing is open to anyone and each attempt is another
    // account on somebody else's infrastructure, so the allowance still holds.
    const testEnv = runtime();
    for (let spent = 0; spent < ENDPOINT_RATE_LIMITS.bootstrap.limit; spent++)
      expect(
        (await request(testEnv, "/bootstrap", { idempotencyKey: random(), pollToken: random() }))
          .status,
      ).toBe(200);
    const refused = await request(testEnv, "/bootstrap", {
      idempotencyKey: random(),
      pollToken: random(),
    });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
  it("gives a selfhost to its first caller and permanently closes second bootstrap", async () => {
    const testEnv = runtime(false);
    const input = { idempotencyKey: random(), pollToken: random() };
    const response = await request(testEnv, "/bootstrap", input);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      account: { expiresAt: null };
      credential: { token: string };
    };
    expect(data.account.expiresAt).toBeNull();
    expect(data.credential.token).toMatch(/^agw_mgmt_/u);
    expect(
      (
        await request(
          testEnv,
          "/bootstrap",
          { idempotencyKey: random(), pollToken: random() },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await worker.request(
          "https://example.test/v1/auth/sign-up/email",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email: "stranger@example.test",
              password: "sufficient-password",
              name: "Stranger",
            }),
          },
          testEnv,
        )
      ).status,
    ).toBe(403);
  });
  it("requires the submission proof, preserves account, retires bootstrap, and replays protected poll", async () => {
    const testEnv = runtime();
    const { input, data } = await start(testEnv);
    const human = await seedUnaffiliatedHuman();
    const pollToken = random();
    const operationResponse = await request(
      testEnv,
      "/operations",
      { kind: "claim", payload: {}, pollToken },
      { authorization: `Bearer ${data.credential.token}` },
    );
    expect(operationResponse.status).toBe(200);
    const op = (await operationResponse.json()) as { id: string; url: string };
    // The human half is a console route, and the proof reaches it only as a
    // fragment: a query string would be in the request line and in every log.
    const handoffUrl = new URL(op.url);
    expect(handoffUrl.origin).toBe("https://example.test");
    expect(handoffUrl.pathname).toBe(`/cli/approve/${encodeURIComponent(op.id)}`);
    expect(handoffUrl.search).toBe("");
    expect(handoffUrl.hash.length).toBeGreaterThan(1);
    const submissionToken = new URL(op.url).hash.slice(1);
    const headers = { origin: "https://example.test", cookie: human.cookie };
    expect(
      (
        await request(
          testEnv,
          `/browser/${op.id}/submit`,
          { submissionToken: random(), approve: true },
          headers,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          testEnv,
          `/browser/${op.id}/submit`,
          { approve: true },
          headers,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          testEnv,
          `/browser/${op.id}/submit`,
          { submissionToken, approve: true },
          headers,
        )
      ).status,
    ).toBe(200);
    const first = await request(testEnv, `/operations/${op.id}`, undefined, {
      authorization: `Bearer ${pollToken}`,
    });
    expect(first.status).toBe(200);
    const result = (await first.json()) as {
      state: string;
      account: { id: string };
      result: { accountId: string };
    };
    expect(result.state).toBe("completed");
    expect(result.account.id).toBe(data.account.id);
    expect(result.result.accountId).toBe(data.account.id);
    expect(
      await (
        await request(testEnv, `/operations/${op.id}`, undefined, {
          authorization: `Bearer ${pollToken}`,
        })
      ).json(),
    ).toEqual(result);
    expect((await request(testEnv, "/bootstrap", input)).status).toBe(403);
    expect((await request(testEnv, "/account", undefined, {
      authorization: `Bearer ${data.credential.token}`,
    })).status).toBe(200);
  });

  it("checks the submission proof before spending the operation limit", async () => {
    const testEnv = runtime();
    const { data } = await start(testEnv);
    const human = await seedUnaffiliatedHuman();
    const operationResponse = await request(
      testEnv,
      "/operations",
      { kind: "claim", payload: {}, pollToken: random() },
      { authorization: `Bearer ${data.credential.token}` },
    );
    const op = (await operationResponse.json()) as { id: string; url: string };
    const submissionToken = new URL(op.url).hash.slice(1);
    const headers = { origin: "https://example.test", cookie: human.cookie };

    for (let attempt = 0; attempt < ENDPOINT_RATE_LIMITS.submission.limit + 2; attempt++) {
      const rejected = await request(
        testEnv,
        `/browser/${op.id}/submit`,
        { submissionToken: random(), approve: true },
        headers,
      );
      expect(rejected.status, `bad proof ${attempt}`).toBe(403);
    }

    const approved = await request(
      testEnv,
      `/browser/${op.id}/submit`,
      { submissionToken, approve: true },
      headers,
    );
    expect(approved.status, await approved.clone().text()).toBe(200);
  });

  it("still rate limits submissions that carry the valid proof", async () => {
    const anchor = Math.floor((Date.now() + 86_400_000) / 60_000) * 60_000 + 10_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(anchor);
    const testEnv = runtime();
    const { data } = await start(testEnv);
    const operationResponse = await request(
      testEnv,
      "/operations",
      { kind: "claim", payload: {}, pollToken: random() },
      { authorization: `Bearer ${data.credential.token}` },
    );
    const op = (await operationResponse.json()) as { id: string; url: string };
    const input = { submissionToken: new URL(op.url).hash.slice(1) };
    const headers = { origin: "https://example.test" };

    for (let attempt = 0; attempt < ENDPOINT_RATE_LIMITS.submission.limit; attempt++) {
      const allowed = await request(testEnv, `/browser/${op.id}/details`, input, headers);
      expect(allowed.status, `valid proof ${attempt}`).toBe(200);
    }
    const refused = await request(testEnv, `/browser/${op.id}/details`, input, headers);
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "rate_limited", data: { scope: "submission" } },
    });
    vi.useRealTimers();
  });
  it("retires an undisclosed credential after vault failure and retries the same account", async () => {
    const testEnv = runtime();
    const input = { idempotencyKey: random(), pollToken: random() };
    const vault = secretVault(testEnv);
    const spy = vi
      .spyOn(vault, "encryptSecret")
      .mockRejectedValueOnce(new Error("transient vault unavailable"));
    expect((await request(testEnv, "/bootstrap", input)).status).toBe(500);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_api_key WHERE enabled=1",
      ).first("n"),
    ).toBe(0);
    spy.mockRestore();
    expect((await request(testEnv, "/bootstrap", input)).status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_api_key WHERE enabled=1",
      ).first("n"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_organization",
      ).first("n"),
    ).toBe(1);
  });
  it("registers a claim recipient without provisioning a second account", async () => {
    const testEnv = runtime(false);
    const { data } = await start(testEnv);
    const pollToken = random();
    const op = (await (
      await request(
        testEnv,
        "/operations",
        { kind: "claim", payload: {}, pollToken },
        { authorization: `Bearer ${data.credential.token}` },
      )
    ).json()) as { id: string; url: string };
    const response = await request(
      testEnv,
      `/browser/${op.id}/register`,
      {
        submissionToken: new URL(op.url).hash.slice(1),
        email: "new-claim@example.test",
        password: "claim-password-for-test",
        name: "New person",
      },
      { origin: "https://example.test" },
    );
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(cookie).not.toBe("");
    const claimant = await env.DB.prepare(
      "SELECT id FROM mgmt_user WHERE email='new-claim@example.test'",
    ).first<{ id: string }>();
    const unrelatedAdmin = await worker.request(
      "https://example.test/v1/admin/session",
      { headers: { cookie, "x-console-request": "1" } },
      testEnv,
    );
    expect(unrelatedAdmin.status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_organization_user WHERE user_id=?",
      ).bind(claimant!.id).first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_organization").first("n"),
    ).toBe(1);
    const details = await request(
      testEnv,
      `/browser/${op.id}/details`,
      { submissionToken: new URL(op.url).hash.slice(1) },
      { origin: "https://example.test", cookie },
    );
    expect(details.status).toBe(200);
    // The page shows who would approve, so the registered human is named back —
    // and nothing stands in their way, since this claim is their only account.
    expect((await details.json()) as { viewer: unknown }).toMatchObject({
      viewer: { name: "New person", email: "new-claim@example.test" },
      blockedBy: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_organization",
      ).first("n"),
    ).toBe(1);
    const approved = await request(
      testEnv,
      `/browser/${op.id}/submit`,
      { submissionToken: new URL(op.url).hash.slice(1), approve: true },
      { origin: "https://example.test", cookie },
    );
    expect(approved.status).toBe(200);
    // Claiming is also how its approver got a console, and this browser is
    // signed in to it, so the page is told to offer it rather than the terminal.
    await expect(approved.json()).resolves.toMatchObject({ continueTo: "console" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_organization",
      ).first("n"),
    ).toBe(1);
  }, 15_000);
  it("refuses a claim from a human who already belongs to another account", async () => {
    const testEnv = runtime();
    const { data } = await start(testEnv);
    const human = await seedHuman();
    const op = (await (
      await request(
        testEnv,
        "/operations",
        { kind: "claim", payload: {}, pollToken: random() },
        { authorization: `Bearer ${data.credential.token}` },
      )
    ).json()) as { id: string; url: string };
    const submissionToken = new URL(op.url).hash.slice(1);
    const headers = { origin: "https://example.test", cookie: human.cookie };
    const details = await request(
      testEnv,
      `/browser/${op.id}/details`,
      { submissionToken },
      headers,
    );
    expect(details.status).toBe(200);
    // The page is told the verdict rather than left to offer a button that fails.
    await expect(details.json()).resolves.toMatchObject({ blockedBy: "sign_out_required" });
    const refused = await request(
      testEnv,
      `/browser/${op.id}/submit`,
      { submissionToken, approve: true },
      headers,
    );
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "account_exists" },
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
         WHERE m.organization_id=? AND u.kind='human'`,
      )
        .bind(data.account.id)
        .first("n"),
    ).toBe(0);
  });
  it("still approves a claim that already landed, for the owner it landed on", async () => {
    const testEnv = runtime();
    const { data } = await start(testEnv);
    const human = await seedUnaffiliatedHuman();
    const op = (await (
      await request(
        testEnv,
        "/operations",
        { kind: "claim", payload: {}, pollToken: random() },
        { authorization: `Bearer ${data.credential.token}` },
      )
    ).json()) as { id: string; url: string };
    const submissionToken = new URL(op.url).hash.slice(1);
    const headers = { origin: "https://example.test", cookie: human.cookie };
    const approve = () =>
      request(testEnv, `/browser/${op.id}/submit`, { submissionToken, approve: true }, headers);
    expect((await approve()).status).toBe(200);
    // The account the claim landed on is excluded from what counts as another
    // one, so the retry a dropped connection provokes still works.
    await expect(
      (
        await request(testEnv, `/browser/${op.id}/details`, { submissionToken }, headers)
      ).json(),
    ).resolves.toMatchObject({ blockedBy: null });
    expect((await approve()).status).toBe(200);
  });
  it("checks the approving session again inside the claim transaction", async () => {
    const testEnv = runtime();
    const { data } = await start(testEnv);
    const human = await seedUnaffiliatedHuman();
    const op = (await (
      await request(
        testEnv,
        "/operations",
        { kind: "claim", payload: {}, pollToken: random() },
        { authorization: `Bearer ${data.credential.token}` },
      )
    ).json()) as { id: string; url: string };
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare("DELETE FROM mgmt_user_session WHERE user_id=?")
        .bind(human.userId)
        .run();
      return batch(statements);
    });
    const response = await request(
      testEnv,
      `/browser/${op.id}/submit`,
      {
        submissionToken: new URL(op.url).hash.slice(1),
        approve: true,
      },
      { origin: "https://example.test", cookie: human.cookie },
    );
    expect(response.status).toBe(409);
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
       WHERE m.organization_id=? AND m.role='owner' AND u.kind='human'`,
    ).bind(data.account.id).first("n")).toBe(0);
  });
  it("retains account attribution through app deletion, compaction, and monthly folding", async () => {
    const testEnv = runtime();
    const { data } = await start(testEnv);
    const other = await start(testEnv);
    const appId = "retained-app";
    await env.DB.prepare(
      "INSERT INTO app(id,organization_id,name,config_json) VALUES (?,?,'Retained','{}')",
    )
      .bind(appId, data.account.id)
      .run();
    await recordBlockedUsageEvent({
      env: testEnv,
      organizationId: data.account.id,
      appId,
      userId: null,
      authMethod: "api_key",
      provider: "openai",
      model: "test",
      route: "test",
      appVersion: null,
      status: "blocked_billing",
      latencyMs: 0,
    });
    await env.DB.prepare(
      "UPDATE app_usage_event SET created_at='2024-03-01T12:00:00.000Z' WHERE app_id=?",
    )
      .bind(appId)
      .run();
    await env.DB.prepare("DELETE FROM app WHERE id=?").bind(appId).run();
    const read = async (token: string) =>
      (await (
        await request(testEnv, "/usage?month=2024-03", undefined, {
          authorization: `Bearer ${token}`,
        })
      ).json()) as {
        totals: { requests: number };
        apps: Array<{ deleted: boolean }>;
      };
    expect((await read(data.credential.token)).totals.requests).toBe(1);
    expect((await read(data.credential.token)).apps[0]?.deleted).toBe(true);
    expect((await read(other.data.credential.token)).totals.requests).toBe(0);
    await compactUsageEvents(testEnv, Date.parse("2026-09-01T00:00:00Z"));
    await foldUsageRollupMonths(testEnv, Date.parse("2026-09-01T00:00:00Z"));
    expect((await read(data.credential.token)).totals.requests).toBe(1);
    await env.DB.prepare(
      "INSERT INTO app(id,organization_id,name,config_json) VALUES (?,?,'Restored','{}')",
    )
      .bind(appId, data.account.id)
      .run();
    expect((await read(data.credential.token)).apps[0]?.deleted).toBe(false);
  });
  it("binds Google claim registration to a signed short-lived callback grant", async () => {
    const base = runtime(false);
    const testEnv = new Proxy(base, {
      get: (target, key, receiver) =>
        key === "GOOGLE_CLIENT_ID"
          ? "test-google-client"
          : key === "GOOGLE_CLIENT_SECRET"
            ? "test-google-secret"
            : key === "OAUTH_RELAY_URL"
              ? "https://relay.example.test"
              : key === "ALLOW_ADDITIONAL_REGISTRATIONS"
                ? "false"
                : Reflect.get(target, key, receiver),
    });
    const { data } = await start(testEnv);
    const op = (await (
      await request(
        testEnv,
        "/operations",
        { kind: "claim", payload: {}, pollToken: random() },
        { authorization: `Bearer ${data.credential.token}` },
      )
    ).json()) as { id: string; url: string };
    const response = await request(
      testEnv,
      `/browser/${op.id}/google`,
      {
        submissionToken: new URL(op.url).hash.slice(1),
      },
      { origin: "https://example.test" },
    );
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    const grant = cookies.find((value) => value.startsWith("cli_claim_oauth="));
    expect(grant).toContain("HttpOnly");
    expect(grant).toContain("SameSite=Lax");
    const callback = new Request(
      "https://example.test/v1/auth/callback/google",
      { headers: { cookie: grant!.split(";")[0]! } },
    );
    expect(await claimOAuthAuthorized(testEnv, callback)).toBe(true);
    const relay = new URL(((await response.json()) as { url: string }).url);
    expect(relay.origin).toBe("https://relay.example.test");
    expect(relay.searchParams.get("return")).toBe(
      "https://example.test/v1/auth/callback/google",
    );
    const authorization = new URL(relay.searchParams.get("next")!);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://relay.example.test/callback/google",
    );
    const jwt = [
      btoa(JSON.stringify({ alg: "RS256" })),
      btoa(
        JSON.stringify({
          sub: "claim-google-human",
          email: "claim-google@example.test",
          email_verified: true,
          name: "Claim Human",
        }),
      ),
      "test-signature",
    ].join(".");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({
          access_token: "test-google-access",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: jwt,
        }),
      );
    const ordinary = await worker.request(
      "https://example.test/v1/auth/sign-in/social",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "https://example.test/login",
        }),
      },
      testEnv,
    );
    const ordinaryRelay = new URL(
      ((await ordinary.json()) as { url: string }).url,
    );
    const ordinaryState = new URL(
      ordinaryRelay.searchParams.get("next")!,
    ).searchParams.get("state")!;
    const denied = await worker.request(
      `https://example.test/v1/auth/callback/google?code=mock-code&state=${encodeURIComponent(ordinaryState)}`,
      {
        headers: {
          cookie: ordinary.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; "),
        },
      },
      testEnv,
    );
    expect(denied.status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM mgmt_user WHERE kind='human'",
      ).first("n"),
    ).toBe(0);
    const complete = await worker.request(
      `https://example.test/v1/auth/callback/google?code=mock-code&state=${encodeURIComponent(authorization.searchParams.get("state")!)}`,
      {
        headers: {
          cookie: cookies.map((value) => value.split(";")[0]).join("; "),
        },
      },
      testEnv,
    );
    expect(complete.status).toBe(302);
    expect(complete.headers.get("location")).toBe(
      `https://example.test/cli/approve/${encodeURIComponent(op.id)}`,
    );
    expect(
      complete.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith("cli_claim_oauth=;") &&
            value.includes("Max-Age=0"),
        ),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM mgmt_user WHERE kind='human' AND email='claim-google@example.test'",
      ).first("n"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_organization").first(
        "n",
      ),
    ).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokenRequest = fetchMock.mock.calls[0]![1];
    expect(String(tokenRequest?.body)).toContain(
      "redirect_uri=https%3A%2F%2Frelay.example.test%2Fcallback%2Fgoogle",
    );

    await env.DB.prepare(
      "UPDATE mgmt_handoff SET consumed_at=? WHERE id=?",
    )
      .bind(Date.now(), op.id)
      .run();
    expect(await claimOAuthAuthorized(testEnv, callback)).toBe(false);
  });
  it("leaves the CLI's own access in place and mints no replacement credential", async () => {
    const testEnv = runtime();
    const { data } = await start(testEnv);
    const human = await seedUnaffiliatedHuman();
    const pollToken = random();
    const op = (await (
      await request(
        testEnv,
        "/operations",
        { kind: "claim", payload: {}, pollToken },
        { authorization: `Bearer ${data.credential.token}` },
      )
    ).json()) as { id: string; url: string };
    expect(
      (
        await request(
          testEnv,
          `/browser/${op.id}/submit`,
          { submissionToken: new URL(op.url).hash.slice(1), approve: true },
          { origin: "https://example.test", cookie: human.cookie },
        )
      ).status,
    ).toBe(200);
    const result = (await (
      await request(testEnv, `/operations/${op.id}`, undefined, {
        authorization: `Bearer ${pollToken}`,
      })
    ).json()) as { credential?: unknown };
    // No second credential is handed out, and the one the CLI already holds is
    // exactly the one that still works afterwards.
    expect(result.credential).toBeUndefined();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mgmt_api_key WHERE enabled=1 AND organization_id=?",
      )
        .bind(data.account.id)
        .first("n"),
    ).toBe(1);
    expect(
      (
        await request(testEnv, "/account", undefined, {
          authorization: `Bearer ${data.credential.token}`,
        })
      ).status,
    ).toBe(200);
  });
  it("enforces exact account deadlines and never deletes a claimed account", async () => {
    const testEnv = runtime();
    const { data } = await start(testEnv);
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE mgmt_organization SET created_at=?,expires_at=? WHERE id=?",
    )
      .bind(
        new Date(now - 30 * 86400000).toISOString(),
        new Date(now + 60 * 86400000).toISOString(),
        data.account.id,
      )
      .run();
    // Only a test moves an account's own instants; the gate caches the row.
    clearAccountLifecycleCache();
    await expect(
      assertAccountAccess(resolveDeployment(testEnv), testEnv, data.account.id, "proxy"),
    ).rejects.toMatchObject({ code: "billing_trial_expired" });
    await expect(
      assertAccountAccess(resolveDeployment(testEnv), testEnv, data.account.id, "read"),
    ).resolves.toMatchObject({ id: data.account.id });
    await env.DB.prepare(
      "UPDATE mgmt_organization SET expires_at=? WHERE id=?",
    )
      .bind(new Date(now - 1).toISOString(), data.account.id)
      .run();
    clearAccountLifecycleCache();
    await expect(
      assertAccountAccess(resolveDeployment(testEnv), testEnv, data.account.id, "claim"),
    ).rejects.toMatchObject({ code: "account_expired" });
    const human = await seedHuman();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mgmt_organization_user(id,organization_id,user_id,role,status,joined_at) VALUES (?,?,?,'owner','active',?)",
      ).bind(random(), data.account.id, human.userId, new Date(now).toISOString()),
      env.DB.prepare("UPDATE mgmt_organization SET expires_at=NULL WHERE id=?")
        .bind(data.account.id),
    ]);
    await pruneExpiredAccounts(testEnv);
    expect(
      await env.DB.prepare("SELECT id FROM mgmt_organization WHERE id=?")
        .bind(data.account.id)
        .first("id"),
    ).toBe(data.account.id);
  });
});

it("keeps a minimal bootstrap tombstone after account cleanup and refuses resurrection", async () => {
  const testEnv = runtime();
  const { data, input } = await start(testEnv);
  await env.DB.prepare(
    `INSERT INTO app_usage_spend(
       organization_id, app_id, scope, user_key, month, microusd, revision, pending
     ) VALUES (?, 'expired-spend-app', 'app', '', '2026-07', 10, 1, 1)`,
  ).bind(data.account.id).run();
  await env.DB.prepare(
    "UPDATE mgmt_organization SET expires_at=? WHERE id=?",
  )
    .bind(new Date(Date.now() - 1000).toISOString(), data.account.id)
    .run();
  await pruneExpiredAccounts(testEnv);
  await pruneExpiredAccounts(testEnv);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_organization").first(
      "n",
    ),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM app_usage_spend").first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM mgmt_user WHERE kind='service'",
    ).first("n"),
  ).toBe(0);
  const row = await env.DB.prepare(
    "SELECT * FROM mgmt_resource_receipt WHERE kind='bootstrap'",
  ).first<Record<string, unknown>>();
  expect(row?.outcome).toBe('{"expired":true}');
  for (const field of [
    "organization_id",
    "initiating_user_id",
    "initiating_credential_id",
    "protected_credential",
  ])
    expect(row?.[field]).toBeNull();
  const replay = await request(testEnv, "/bootstrap", input);
  expect(replay.status).toBe(403);
  expect(await replay.json()).toMatchObject({
    error: { code: "account_expired" },
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_organization").first(
      "n",
    ),
  ).toBe(0);
  expect(
    (await request(testEnv, "/bootstrap", { ...input, pollToken: random() }))
      .status,
  ).toBe(403);
});

it("collects expired accounts on the nightly run only where account deadlines exist", async () => {
  const { data } = await start(runtime());
  await env.DB.prepare("UPDATE mgmt_organization SET expires_at=? WHERE id=?")
    .bind(new Date(Date.now() - 1000).toISOString(), data.account.id)
    .run();
  const nightly = async (cloud: boolean) => {
    const ctx = createExecutionContext();
    worker.scheduled(
      { cron: "17 3 * * *", scheduledTime: Date.now() } as ScheduledController,
      runtime(cloud),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return env.DB.prepare("SELECT id FROM mgmt_organization WHERE id=?")
      .bind(data.account.id)
      .first("id");
  };

  // A self-host writes no account deadline and so can never have one to
  // collect. Running the sweep there would spend a sixth of a Free plan's
  // nightly D1 allowance on a query that cannot match a row, at the expense of
  // the usage compaction that plan actually needs.
  expect(await nightly(false)).toBe(data.account.id);
  expect(await nightly(true)).toBeNull();
});

it("rejects browser submissions on the API host with explicit and fallback console origins", async () => {
  for (const [label, consoleOrigin] of [
    ["explicit", "https://example.test"],
    ["fallback", undefined],
  ] as const) {
    const baseEnv = runtime();
    const testEnv = new Proxy(baseEnv, {
      get: (target, key, receiver) =>
        key === "PUBLIC_API_URL"
          ? "https://api.example.test"
          : key === "CLI_CONSOLE_ORIGIN"
            ? consoleOrigin
            : Reflect.get(target, key, receiver),
    });
    const { data } = await start(testEnv);
    const op = (await (
      await request(
        testEnv,
        "/operations",
        { kind: "claim", payload: {}, pollToken: random() },
        { authorization: `Bearer ${data.credential.token}` },
      )
    ).json()) as { id: string; url: string };
    const email = `blocked-api-${label}@example.test`;
    const input = {
      submissionToken: new URL(op.url).hash.slice(1),
      email,
      password: "test-password-with-length",
      name: "Blocked",
      approve: true,
    };
    for (const action of ["details", "submit", "register", "google"]) {
      const response = await worker.request(
        `https://api.example.test/v1/cli/browser/${op.id}/${action}`,
        {
          method: "POST",
          headers: {
            origin: "https://api.example.test",
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        },
        testEnv,
      );
      expect([label, action, response.status]).toEqual([label, action, 404]);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM mgmt_user WHERE email=?")
        .bind(email)
        .first("n"),
    ).toBe(0);
    expect(
      (
        await request(testEnv, `/browser/${op.id}/details`, input, {
          origin: "https://example.test",
        })
      ).status,
    ).toBe(200);
  }
});

it("keeps the completed trial counter readable during recovery without renewing it", async () => {
  const testEnv = runtime();
  const { data } = await start(testEnv);
  const headers = { authorization: `Bearer ${data.credential.token}` };
  const first = await request(testEnv, "/account", undefined, headers);
  expect(first.status).toBe(200);
  const origin = new Date(Date.now() - 31 * 86400000).toISOString();
  await env.DB.prepare("UPDATE mgmt_organization SET created_at=? WHERE id=?")
    .bind(origin, data.account.id).run();
  // Only this test moves an account's creation instant; the gate caches the row.
  clearAccountLifecycleCache();
  const response = await request(testEnv, "/account", undefined, headers);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    account: { createdAt: origin, claimed: false },
    billing: { access: { subscription: null }, limit: 1000 },
    usage: { used: 0, periodStart: origin, periodEnd: new Date(Date.parse(origin) + 30 * 86400000).toISOString() },
  });
  await expect(assertAccountAccess(resolveDeployment(testEnv), testEnv, data.account.id, "setup"))
    .rejects.toMatchObject({ code: "billing_trial_expired" });
});
