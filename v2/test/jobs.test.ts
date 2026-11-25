/**
 * The job lifecycle on fal's queue (plan D9, step 6a): submit, the estimate,
 * free polls, settlement from the final figure, the sweep, and the four
 * failure cases every lifecycle gets.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { timeOrderedId } from "../src/core/ids.ts";
import worker from "../src/index.ts";
import { readJobId, signJobId, userDigest, type JobClaimsInput } from "../src/jobs/job-id.ts";
import { BODY_READ_LIMIT } from "../src/core/bounded-body.ts";
import { LEDGER_LATE_BOOKING_DAYS } from "../src/ledger/late-booking.ts";
import { applyFinalResult, boundedJson, checkJob, fetchJob, jobContext, FIGURE_D1_DEADLINE_MS, figureWork, JOB_BODY_READ_DEADLINE_MS, JOB_POLL_TIMEOUT_MS, jobCheckId, jobEstimate, jobFinalFigure, providerRequestId, readResultFacts, settleFigure, type JobRef } from "../src/jobs/jobs.ts";
import { LEDGER_D1_DEADLINE_MS, recordLedgerEntry, writeOpenWork } from "../src/ledger/write.ts";
import { MAX_PENDING } from "../src/do/ChargeStore.ts";
import { runSweep } from "../src/ledger/sweep.ts";
import { chargeFromRow, readCharge, type ChargeRow } from "../src/ledger/write.ts";
import { assertModesSelectable, ratesFromPricing } from "../src/admin/providers.ts";
import { fal } from "../src/providers/fal.ts";
import { rewrittenModel } from "../src/providers/operation.ts";
import type { CallAttempt } from "../src/proxy/call-charge.ts";
import { JOB_DISCONNECT_GRACE_MS } from "../src/proxy/serve.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedAccount, seedAppKey, seedManagementKey, seedRoutedApp, withLedgerDb, writeAtTheirTime, ledger } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const SECRET = "sk-test-fal-key-4321";
const QUEUE = fal.operations.find((one) => one.name === "fal.queue")!;
const SPEC = QUEUE.job!;


async function setup(rates: Record<string, unknown> | null = null, baseUrl: string | null = null) {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `fal-${id.slice(0, 6)}`;
  // The key is sealed to where it is sent: the base URL, or the provider's own hosts.
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, "fal", baseUrl ?? ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'fal', ?, 'fal', 'active', ?, '4321', ?, ?, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, slug, blob, baseUrl, rates === null ? null : JSON.stringify(rates), now, now)
    .run();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: { operations: ["fal.queue"] } } },
  );
  const { key } = await seedAppKey(appId);
  return { appId, slug, key, connectionId: id };
}

async function call(method: string, path: string, key: string, init: { body?: string; user?: string; env?: Env } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "x-end-user-id": init.user ?? "user-1",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
    init.env ?? env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } })() };
}

async function charges(appId: string): Promise<Record<string, unknown>[]> {
  // Each charge before its corrections, whatever times the test gave them.
  const { results } = await ledger().prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY kind = 'correction', written_at, id").bind(appId).all();
  return results;
}

async function openWork(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await ledger().prepare("SELECT * FROM open_work WHERE app_id = ? ORDER BY id").bind(appId).all();
  return results;
}

/** fal's answers, by the URL asked for. */
function falAnswers(answers: {
  submit?: () => Response | Promise<Response>;
  status?: () => Response;
  result?: () => Response;
  cancel?: () => Response;
}): void {
  fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/cancel")) return (answers.cancel ?? (() => Response.json({ status: "CANCELLATION_REQUESTED" }, { status: 202 })))();
    if (url.endsWith("/status")) return (answers.status ?? (() => Response.json({ status: "COMPLETED" })))();
    if (url.includes("/requests/")) return (answers.result ?? (() => Response.json({ images: [{ url: "https://fal.media/a.png" }] })))();
    return (
      answers.submit ??
      (() =>
        Response.json({
          request_id: "req-1",
          status: "IN_QUEUE",
          status_url: "https://queue.fal.run/fal-ai/flux/requests/req-1/status",
          response_url: "https://queue.fal.run/fal-ai/flux/requests/req-1",
          cancel_url: "https://queue.fal.run/fal-ai/flux/requests/req-1/cancel",
        }))
    )();
  });
}

/** Submits a two-image flux/dev job: 2 units at $0.025 is the estimate. */
async function submit(appId: string, slug: string, key: string, body = { prompt: "a cat", num_images: 2 }, init: { user?: string; env?: Env } = {}) {
  return call("POST", `/v2/apps/${appId}/proxy/${slug}/queue/fal-ai/flux/dev`, key, { body: JSON.stringify(body), ...init });
}

let fetchSpy: MockInstance<typeof fetch>;
let logs: string[];

beforeEach(() => {
  clearCaches();
  logs = [];
  const keep = (line: unknown) => {
    logs.push(String(line));
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const logged = (message: string) => logs.some((line) => line.includes(`"message":"${message}"`));

describe("job ids", () => {
  const claims: JobClaimsInput = {
    job: "job-1",
    connectionId: "c1",
    slug: "fal-1",
    operation: "fal.queue",
    model: "fal-ai/flux/dev",
    requestId: "req-1",
    route: "r0",
    accountId: "acc",
    appId: "app",
    userId: null,
  };

  it("signs and reads nothing without a JWT_SECRET of at least 32 bytes, never a predictable key", async () => {
    for (const secret of ["", "short-secret", undefined]) {
      await expect(signJobId(secret as string, claims)).rejects.toMatchObject({ status: 500 });
    }
    const id = await signJobId(env.JWT_SECRET, claims);
    expect(await readJobId("", id)).toBeNull();
    expect(await readJobId(undefined, id)).toBeNull();
    expect(logged("job_signing_secret_invalid")).toBe(true);
  });

  it("carries a long end-user id as a short digest, so its job id stays readable", async () => {
    const userId = "u".repeat(1_600);
    const id = await signJobId(env.JWT_SECRET, { ...claims, userId });
    expect(id.length).toBeLessThan(2048);
    expect((await readJobId(env.JWT_SECRET, id))!.userDigest).toBe(await userDigest(userId));
  });

  it("reads back what the gateway signed, and nothing forged or altered", async () => {
    const id = await signJobId(env.JWT_SECRET, claims);
    const { userId: _user, ...rest } = claims;
    expect(await readJobId(env.JWT_SECRET, id)).toEqual({ ...rest, userDigest: null });
    // Another secret, a changed claim, a changed signature, junk.
    expect(await readJobId("another-secret-that-is-long-enough-123", id)).toBeNull();
    const [prefix, body, signature] = id.split(".");
    const changed = btoa(JSON.stringify({ ...JSON.parse(atob(body!.replaceAll("-", "+").replaceAll("_", "/"))), p: "other" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    expect(await readJobId(env.JWT_SECRET, `${prefix}.${changed}.${signature}`)).toBeNull();
    expect(await readJobId(env.JWT_SECRET, `${prefix}.${body}.${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`)).toBeNull();
    // The same signature spelled another way (its last character's unused bits set) is not read either.
    const last = signature!.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const respelled = alphabet[alphabet.indexOf(last) ^ 1]!;
    expect(await readJobId(env.JWT_SECRET, `${prefix}.${body}.${signature!.slice(0, -1)}${respelled}`)).toBeNull();
    expect(await readJobId(env.JWT_SECRET, "j1.not.valid")).toBeNull();
  });
});

describe("submitting a job", () => {
  it("submits to fal's queue, answers with a signed job id and gateway links, and charges the estimate at once", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const { response, json } = await submit(appId, slug, key);
    expect(response.status).toBe(200);
    const [input, init] = fetchSpy.mock.calls[0]!;
    expect(String(input)).toBe("https://queue.fal.run/fal-ai/flux/dev");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Key ${SECRET}`);
    const jobId = String(json!.request_id);
    expect(jobId.startsWith("j1.")).toBe(true);
    expect(json!.status_url).toBe(`${ORIGIN}/v2/apps/${appId}/jobs/${jobId}/status`);
    expect(json!.response_url).toBe(`${ORIGIN}/v2/apps/${appId}/jobs/${jobId}`);
    // The cancel link is the gateway's own too.
    expect(json!.cancel_url).toBe(`${ORIGIN}/v2/apps/${appId}/jobs/${jobId}/cancel`);
    expect(JSON.stringify(json)).not.toContain("queue.fal.run");
    // Two images of one megapixel at $0.025, as an estimate.
    const [estimate] = await charges(appId);
    expect(estimate).toMatchObject({
      kind: "estimate",
      owner_type: "job",
      operation: "fal.queue",
      model: "fal-ai/flux/dev",
      cost_nano: 50_000_000,
      measured: "estimated",
      price_is_estimate: 1,
      unit: "model_units",
    });
    const claims = (await readJobId(env.JWT_SECRET, jobId))!;
    expect(claims).toMatchObject({ requestId: "req-1", appId, userDigest: await userDigest("user-1"), job: estimate!.owner_id });
    // The job is checked within minutes, in the same batch as its estimate.
    expect(await openWork(appId)).toMatchObject([{ id: jobCheckId(claims.job), kind: "job_check", charge_id: estimate!.id }]);
  });

  it("sends every request of a connection with a base URL there, the queue under `queue/`, never to fal's own hosts", async () => {
    const { appId, slug, key } = await setup(null, "https://fal-proxy.example.com/");
    falAnswers({});
    const { json } = await submit(appId, slug, key);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://fal-proxy.example.com/queue/fal-ai/flux/dev");
    await call("GET", `/v2/apps/${appId}/jobs/${String(json!.request_id)}/status`, key);
    expect(String(fetchSpy.mock.calls.at(-1)![0])).toBe("https://fal-proxy.example.com/queue/fal-ai/flux/requests/req-1/status");
  });

  it("removes fal's webhook, so a bill can never grow where the gateway cannot see it", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await call("POST", `/v2/apps/${appId}/proxy/${slug}/queue/fal-ai/flux/dev?fal_webhook=https://example.com/hook`, key, {
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://queue.fal.run/fal-ai/flux/dev");
  });

  it("passes a refused submission on as it is, with no estimate and nothing to check", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({ submit: () => Response.json({ detail: "bad input" }, { status: 422 }) });
    const { response } = await submit(appId, slug, key);
    expect(response.status).toBe(422);
    expect(await charges(appId)).toMatchObject([{ kind: "attempt", owner_type: "call", status: "provider_error", cost_nano: null }]);
    expect(await openWork(appId)).toEqual([]);
  });

  it("keeps the estimate of a submission whose answer was lost, never sends it again, and logs it", async () => {
    const { appId, slug, key } = await setup();
    fetchSpy.mockRejectedValue(new TypeError("connection reset"));
    const { response } = await submit(appId, slug, key);
    expect(response.status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await charges(appId)).toMatchObject([
      { kind: "estimate", owner_type: "job", status: "network_error", cost_nano: 50_000_000, measured: "estimated" },
    ]);
    expect(await openWork(appId)).toEqual([]);
    expect(logged("job_submission_lost")).toBe(true);
  });

  it("treats an accepted answer with no request id as lost: the estimate stays, and the app gets an error", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({ submit: () => Response.json({ status: "IN_QUEUE" }) });
    const { response } = await submit(appId, slug, key);
    expect(response.status).toBe(502);
    // The provider answered, so its time is in server-timing even though the gateway refused its answer.
    expect((response.headers.get("server-timing") ?? "").split(", ").map((entry) => entry.split(";")[0])).toEqual(["auth", "prepare", "limiter", "provider_ttfb"]);
    expect(await charges(appId)).toMatchObject([{ kind: "estimate", cost_nano: 50_000_000 }]);
    expect(await openWork(appId)).toEqual([]);
    expect(logged("job_submission_lost")).toBe(true);
  });
});

describe("polling a job", () => {
  async function submitted(rates: Record<string, unknown> | null = null) {
    const setupResult = await setup(rates);
    falAnswers({});
    const { json } = await submit(setupResult.appId, setupResult.slug, setupResult.key);
    return { ...setupResult, jobId: String(json!.request_id) };
  }

  it("answers the status through the gateway, with gateway links, free: no charge and no limit used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    vi.setSystemTime(minute + 30_000);
    const { appId, slug, key } = await setup();
    // One request a minute per user: the submit uses it.
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, '$.limits', json(?)) WHERE id = ?")
      .bind(JSON.stringify({ per_user: { requests: { per_minute: 1 } } }), appId)
      .run();
    clearCaches();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    falAnswers({
      // The provider's own server-timing is replaced by the gateway's.
      status: () =>
        Response.json(
          { status: "IN_PROGRESS", request_id: "req-1", response_url: "https://queue.fal.run/fal-ai/flux/requests/req-1" },
          { headers: { "server-timing": "upstream;dur=9" } },
        ),
    });
    for (let poll = 0; poll < 3; poll += 1) {
      const { response, json } = await call("GET", `/v2/apps/${appId}/jobs/${jobId}/status`, key);
      expect(response.status).toBe(200);
      // A served poll says how long it took to check the caller, find the job, and hear from the provider (no limits).
      expect((response.headers.get("server-timing") ?? "").split(", ").map((entry) => entry.split(";")[0])).toEqual(["auth", "prepare", "provider_ttfb"]);
      expect(json).toEqual({ status: "IN_PROGRESS", request_id: jobId, response_url: `${ORIGIN}/v2/apps/${appId}/jobs/${jobId}` });
    }
    // The upstream URL comes from the signed id: the model's first two segments and fal's request id.
    expect(String(fetchSpy.mock.calls.at(-1)![0])).toBe("https://queue.fal.run/fal-ai/flux/requests/req-1/status");
    // Only the estimate: polls write nothing.
    expect(await charges(appId)).toHaveLength(1);
    // A new submission is the one refused by the limit.
    const { response } = await submit(appId, slug, key);
    expect(response.status).toBe(429);
  });

  it("settles the job from the units fal bills on its result, at the estimate's stored rate, and stops checking it", async () => {
    const { appId, key, jobId } = await submitted();
    falAnswers({ result: () => Response.json({ images: [{}, {}] }, { headers: { "x-fal-billable-units": "3" } }) });
    const { response, json } = await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(response.status).toBe(200);
    expect(json).toEqual({ images: [{}, {}] });
    expect(String(fetchSpy.mock.calls.at(-1)![0])).toBe("https://queue.fal.run/fal-ai/flux/requests/req-1");
    const [estimate, correction] = await charges(appId);
    // 3 units at $0.025 is $0.075; the estimate was $0.05.
    expect(correction).toMatchObject({
      kind: "correction",
      correction_kind: "units",
      corrects_charge_id: estimate!.id,
      cost_nano: 25_000_000,
      units: 1000,
      measured: "complete",
      usage_day: estimate!.usage_day,
    });
    expect(await openWork(appId)).toEqual([]);
  });

  it("serves a client's poll past the ledger's late-booking window as usual, and books nothing: a job id never expires (Astra 7b-2 round 4)", async () => {
    const { appId, key, jobId } = await submitted();
    // The sweep's check ended long ago; only the client still polls.
    await ledger().prepare("DELETE FROM open_work WHERE app_id = ?").bind(appId).run();
    const before = await ledger().prepare("SELECT charges, cost_nano FROM usage_day WHERE app_id = ?").bind(appId).all();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (LEDGER_LATE_BOOKING_DAYS + 1) * 86_400_000);
    falAnswers({ result: () => Response.json({ images: [{}, {}] }, { headers: { "x-fal-billable-units": "3" } }) });
    const { response, json } = await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(response.status).toBe(200);
    expect(json).toEqual({ images: [{}, {}] });
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
    expect(await openWork(appId)).toEqual([]);
    expect((await ledger().prepare("SELECT charges, cost_nano FROM usage_day WHERE app_id = ?").bind(appId).all()).results).toEqual(before.results);
    expect(logged("ledger_booking_too_late")).toBe(true);
  });

  it("settles once however often the result is read: a second poll and the sweep add nothing", async () => {
    const { appId, key, jobId } = await submitted();
    falAnswers({ result: () => Response.json({ images: [{}] }, { headers: { "x-fal-billable-units": "1" } }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    const claims = (await readJobId(env.JWT_SECRET, jobId))!;
    await ledger().prepare(
      `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
       VALUES (?, 'job_check', ?, ?, 'job', ?, NULL, ?, 0, 0, 0)`,
    )
      .bind(jobCheckId(claims.job), ACCOUNT_ID, appId, claims.job, JSON.stringify({ providerType: "fal", jobId }))
      .run();
    await runSweep(env, ledger(), { now: Date.now() + 10 * 60_000 });
    const rows = await charges(appId);
    expect(rows.map((row) => row.kind)).toEqual(["estimate", "correction"]);
    // 1 unit: the $0.05 estimate comes down to $0.025.
    expect(rows[1]).toMatchObject({ cost_nano: -25_000_000 });
  });

  it("keeps the estimate when fal's result has no units header: never read as 0", async () => {
    const { appId, key, jobId } = await submitted();
    falAnswers({ result: () => Response.json({ images: [{}, {}] }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect((await charges(appId)).map((row) => [row.kind, row.measured])).toEqual([["estimate", "estimated"]]);
    expect(logged("job_units_missing")).toBe(true);
    // A poll only settles or saves a figure; its check is ended by the sweep, which finds the same.
    expect((await openWork(appId)).map((row) => row.id)).toEqual([expect.stringMatching(/^job:/)]);
    await ledger().prepare("DELETE FROM open_work WHERE app_id != ?").bind(appId).run();
    await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 });
    expect(await openWork(appId)).toEqual([]);
    expect((await charges(appId)).map((row) => [row.kind, row.measured])).toEqual([["estimate", "estimated"]]);
  });

  it("charges nothing for a job that failed with 0 units: fal says COMPLETED, the result says 422", async () => {
    const { appId, key, jobId } = await submitted();
    falAnswers({ result: () => Response.json({ detail: [{ msg: "bad image" }] }, { status: 422, headers: { "x-fal-billable-units": "0" } }) });
    const { response } = await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(response.status).toBe(422);
    const rows = await charges(appId);
    expect(rows.reduce((sum, row) => sum + Number(row.cost_nano), 0)).toBe(0);
    expect(rows[1]).toMatchObject({ kind: "correction", cost_nano: -50_000_000 });
  });

  it("settles a model priced per output with no units header by counting the result's outputs", async () => {
    const { appId, key, jobId } = await submitted({ "fal-ai/flux/dev": { per_image: 10_000_000 } });
    // Estimated at two images; three came back.
    falAnswers({ result: () => Response.json({ images: [{}, {}, {}] }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    const rows = await charges(appId);
    expect(rows[0]).toMatchObject({ kind: "estimate", unit: "images", cost_nano: 20_000_000 });
    expect(rows[1]).toMatchObject({ kind: "correction", cost_nano: 10_000_000, units: 1 });
  });

  it("does not settle a result that is not final yet", async () => {
    const { appId, key, jobId } = await submitted();
    falAnswers({ result: () => Response.json({ detail: "Request is still in progress" }, { status: 400 }) });
    const { response } = await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(response.status).toBe(400);
    expect(await charges(appId)).toHaveLength(1);
    expect(await openWork(appId)).toHaveLength(1);
  });

  it("answers a forged, altered, other app's or other user's job id as unknown, and asks fal nothing", async () => {
    const { appId, key, jobId } = await submitted();
    const other = await setup();
    fetchSpy.mockClear();
    const [prefix, body, signature] = jobId.split(".");
    // A signature with its first character changed, always to a different one.
    const altered = `${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`;
    for (const [path, user] of [
      [`/v2/apps/${appId}/jobs/j1.e30.AAAA`, "user-1"],
      [`/v2/apps/${appId}/jobs/${prefix}.${body}.${altered}`, "user-1"],
      [`/v2/apps/${other.appId}/jobs/${jobId}`, "user-1"],
      [`/v2/apps/${appId}/jobs/${jobId}`, "user-2"],
    ] as const) {
      const usedKey = path.includes(other.appId) ? other.key : key;
      const { response, json } = await call("GET", path, usedKey, { user });
      expect(response.status).toBe(404);
      expect(json).toMatchObject({ error: { code: "job_not_found" } });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the sweep and the four failure cases", () => {
  function attempt(appId: string, requestId: string): CallAttempt {
    return {
      requestId,
      seq: 1,
      accountId: ACCOUNT_ID,
      appId,
      identity: { accountId: ACCOUNT_ID, appId, userId: "user-1", installId: null, appleAccountId: null, authMethod: "api_key", credentialType: "api_key" } as never,
      providerType: "fal",
      connectionId: "c",
      providerSlug: "fal",
      operation: "fal.queue",
      model: "fal-ai/flux/dev",
      price: { price: { rates: { per_unit: 25_000_000 } } as never, source: "list_rate" },
      reportsCost: false,
      requestedMode: { tier: "standard", region: "global" } as never,
      startedAt: 1_000,
      appVersion: null,
      clientTraceId: null,
      requestUsage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true, units: { model_units: 2000 }, estimatedUnits: ["model_units"] },
    };
  }

  it("writes an accepted job's estimate unpriced, and logs it, when pricing throws: the job is never failed for it", async () => {
    const { appId } = await setup();
    const broken = new Proxy({}, { get: () => { throw new Error("pricing broke"); } });
    const entry = jobEstimate({ ...attempt(appId, `job_${crypto.randomUUID()}`), price: { price: broken as never, source: "list_rate" } }, QUEUE, {
      status: "ok", httpStatus: 200, latencyMs: 1, signedId: "j1.x.y", now: 2_000,
    });
    expect(entry.charge.costNano).toBeNull();
    expect(entry.openWork.map((row) => row.kind)).toContain("job_check");
    expect(logged("usage_pricing_failed")).toBe(true);
  });

  it("a lost ledger reply: the estimate written again is skipped, with its check, so nothing counts twice", async () => {
    const { appId } = await setup();
    const entry = jobEstimate(attempt(appId, `job_${crypto.randomUUID()}`), QUEUE, { status: "ok", httpStatus: 200, latencyMs: 1, signedId: "j1.x.y", now: 2_000 });
    await writeAtTheirTime([entry]);
    await writeAtTheirTime([entry]);
    expect(await charges(appId)).toHaveLength(1);
    expect(await openWork(appId)).toHaveLength(1);
  });

  it("a restart before delivery: the app never got its job id, and the sweep still settles the job", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    falAnswers({ result: () => Response.json({ images: [{}, {}] }, { headers: { "x-fal-billable-units": "2" } }) });
    // Not due yet: nothing happens to it.
    await runSweep(env, ledger(), { now: Date.now() });
    expect(await openWork(appId)).toHaveLength(1);
    await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 });
    const rows = await charges(appId);
    expect(rows.map((row) => [row.kind, row.cost_nano])).toEqual([
      ["estimate", 50_000_000],
      ["correction", 0],
    ]);
    expect(await openWork(appId)).toEqual([]);
  });

  it("waits while fal says the job is not done, and checks again later", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    falAnswers({ status: () => Response.json({ status: "IN_QUEUE" }) });
    await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 });
    const [work] = await openWork(appId);
    expect(work).toMatchObject({ tries: 1, last_error: "job not done (200)" });
    expect(await charges(appId)).toHaveLength(1);
  });

  it("the settlement barrier: a figure read before the estimate is in the ledger settles nothing, and settles later", async () => {
    const { appId } = await setup();
    const job = `job_${crypto.randomUUID()}`;
    const ref: JobRef = { job, accountId: ACCOUNT_ID, appId };
    const facts = { status: 200, units: 3, outputs: { images: 0 } };
    expect(await settleFigure(ledger(), ref, facts, 3_000)).toBe("waiting");
    await writeAtTheirTime([jobEstimate(attempt(appId, job), QUEUE, { status: "ok", httpStatus: 200, latencyMs: 1, signedId: null, now: 2_000 })]);
    expect(await settleFigure(ledger(), ref, facts, 3_000)).toBe("settled");
    expect((await charges(appId)).map((row) => row.cost_nano)).toEqual([50_000_000, 25_000_000]);
  });

  it("a figure for a job past the late-booking window, with no estimate left, ends at once instead of waiting (Sol 7b-2 date rule)", async () => {
    const { appId } = await setup();
    const now = Date.parse("2026-11-22T12:00:00Z");
    const recent = timeOrderedId(now - 29 * 86_400_000);
    const old = timeOrderedId(now - 31 * 86_400_000);
    const facts = { status: 200, units: 3, outputs: { images: 0 } };
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
    // Inside the window the estimate may still land: the figure waits for it.
    expect(await settleFigure(ledger(), { job: recent, accountId: ACCOUNT_ID, appId }, facts, now)).toBe("waiting");
    // Past it, an estimate would be refused anyway (or retention deleted it): nothing to wait for.
    expect(await settleFigure(ledger(), { job: old, accountId: ACCOUNT_ID, appId }, facts, now)).toBe("estimate_kept");
    expect(warned.filter((line) => line.includes('"message":"ledger_booking_too_late"'))).toHaveLength(1);
    expect(await charges(appId)).toEqual([]);
  });

  it("a duplicate completion: a client poll and the sweep settling at once write one correction", async () => {
    const { appId } = await setup();
    const job = `job_${crypto.randomUUID()}`;
    await writeAtTheirTime([jobEstimate(attempt(appId, job), QUEUE, { status: "ok", httpStatus: 200, latencyMs: 1, signedId: null, now: 2_000 })]);
    const ref: JobRef = { job, accountId: ACCOUNT_ID, appId };
    const facts = { status: 200, units: 4, outputs: { images: 0 } };
    expect(await Promise.all([settleFigure(ledger(), ref, facts, 3_000), settleFigure(ledger(), ref, facts, 3_001)])).toEqual(["settled", "settled"]);
    const rows = await charges(appId);
    expect(rows.map((row) => row.kind)).toEqual(["estimate", "correction"]);
    expect(rows[1]).toMatchObject({ cost_nano: 50_000_000 });
  });
});

describe("the final figure", () => {
  const estimate = { rates: { per_unit: 25_000_000 }, unit: "model_units" } as unknown as ChargeRow;

  it("reads fal's fractional units at their stored scale, and gives none for a status that is not final", () => {
    const facts = (status: number, headers: Record<string, string>, body: unknown = {}) => readResultFacts(SPEC, { status, headers: new Headers(headers) }, { kind: "parsed", value: body });
    expect(jobFinalFigure(estimate, facts(200, { "x-fal-billable-units": "2.7083333333333335" })!)).toEqual({
      kind: "units",
      buckets: { per_unit: 2709 },
      units: 2709,
    });
    expect(facts(499, {})).toBeNull();
    expect(jobFinalFigure(estimate, facts(200, { "x-fal-billable-units": "abc" })!)).toBeNull();
  });

  it("is never settled for a charge read from the ledger that names a rate the result cannot count", async () => {
    const tokens = { rates: { input: 1, output: 1 }, unit: "tokens" } as unknown as ChargeRow;
    expect(jobFinalFigure(tokens, readResultFacts(SPEC, { status: 200, headers: new Headers({ "x-fal-billable-units": "1" }) }, { kind: "parsed", value: {} })!)).toBeNull();
    expect(await readCharge(ledger(), "nothing")).toBeNull();
  });
});

describe("signing, refunds, the sweep's pace and its limits (review fixes)", () => {
  it("refuses a job before it reaches fal when JWT_SECRET cannot sign its id", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const { response } = await submit(appId, slug, key, undefined, { env: { ...env, JWT_SECRET: "" } as Env });
    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await charges(appId)).toEqual([]);
    expect(logged("job_signing_secret_invalid")).toBe(true);
  });

  it("keeps the estimate of a failed per-image job when fal reports no billed units, and refunds only on a reported 0", async () => {
    for (const [headers, kept] of [
      [{}, true],
      [{ "x-fal-billable-units": "0" }, false],
    ] as const) {
      clearCaches();
      const { appId, slug, key } = await setup({ "fal-ai/flux/dev": { per_image: 10_000_000 } });
      falAnswers({});
      const jobId = String((await submit(appId, slug, key)).json!.request_id);
      falAnswers({ result: () => Response.json({ detail: [{ msg: "bad image" }] }, { status: 422, headers }) });
      await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
      const rows = await charges(appId);
      expect(rows[0]).toMatchObject({ kind: "estimate", unit: "images", cost_nano: 20_000_000 });
      if (kept) expect(rows).toHaveLength(1);
      else expect(rows.reduce((sum, row) => sum + Number(row.cost_nano), 0)).toBe(0);
    }
  });

  it("checks a job again every minute, as fal's operation says, whether it is not done or the check failed", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    expect(JSON.parse(String((await openWork(appId))[0]!.detail_json))).toMatchObject({ retryEveryMs: 60_000, maxTries: 60 });
    const now = Date.now() + 5 * 60_000;
    falAnswers({ status: () => Response.json({ status: "IN_QUEUE" }) });
    await runSweep(env, ledger(), { now });
    expect((await openWork(appId))[0]).toMatchObject({ tries: 1, due_at: now + 60_000 });
    fetchSpy.mockRejectedValue(new TypeError("connection reset"));
    await runSweep(env, ledger(), { now: now + 60_000 });
    expect((await openWork(appId))[0]).toMatchObject({ tries: 2, due_at: now + 120_000 });
  });

  it("starts no provider call once the item's time is up", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    const [row] = await openWork(appId);
    fetchSpy.mockClear();
    const item = {
      id: String(row!.id),
      kind: "job_check" as const,
      accountId: ACCOUNT_ID,
      appId,
      ownerType: "job",
      ownerId: String(row!.owner_id),
      chargeId: String(row!.charge_id),
      detail: JSON.parse(String(row!.detail_json)) as Record<string, unknown>,
      dueAt: 0,
      tries: 0,
    };
    await expect(checkJob(env, item, { ledger: ledger(), now: Date.now(), lastTry: false, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await charges(appId)).toHaveLength(1);
  });

  it("opens no key and calls nothing for a job whose connection is paused, and checks it again later", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    await env.DB.prepare("UPDATE provider_connection SET status = 'disabled' WHERE slug = ?").bind(slug).run();
    clearCaches();
    await onlyThisApp(appId);
    fetchSpy.mockClear();
    await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await openWork(appId))[0]).toMatchObject({ tries: 1, last_error: "the job's connection is disabled" });
  });

  it("counts an item whose row is gone by its last try as done, not given up", async () => {
    const { appId } = await setup();
    await onlyThisApp(appId);
    await writeOpenWork(ledger(), [
      { id: "work-gone", kind: "unresolved", accountId: ACCOUNT_ID, appId, ownerType: "call", ownerId: "x", chargeId: null, detail: { maxTries: 1 }, dueAt: 0, createdAt: 0 },
    ]);
    const handlers = {
      unresolved: async () => {
        await ledger().prepare("DELETE FROM open_work WHERE id = 'work-gone'").run();
        return { done: false as const, reason: "settled elsewhere meanwhile" };
      },
    } as never;
    expect(await runSweep(env, ledger(), { now: Date.now(), handlers })).toEqual({ done: 1, retried: 0, gaveUp: 0 });
    expect(logged("open_work_gave_up")).toBe(false);
  });
});

/**
 * A sweep batch that takes every due row: other tests' failed-write stores may
 * still be writing their work into the shared ledger after `onlyThisApp`.
 */
const SWEEP_EVERY_DUE_ROW = 1_000;

/** The test database is shared: the sweep must see only this test's work. */
function onlyThisApp(appId: string) {
  return ledger().prepare("DELETE FROM open_work WHERE app_id != ?").bind(appId).run();
}

describe("a figure is its own row, written once and never changed (review fixes, round 3)", () => {
  function attemptFor(appId: string, requestId: string, startedAt = 1_000): CallAttempt {
    return {
      requestId,
      seq: 1,
      accountId: ACCOUNT_ID,
      appId,
      identity: { accountId: ACCOUNT_ID, appId, userId: "user-1", installId: null, appleAccountId: null, authMethod: "api_key", credentialType: "api_key" } as never,
      providerType: "fal",
      connectionId: "c",
      providerSlug: "fal",
      operation: "fal.queue",
      model: "fal-ai/flux/dev",
      price: { price: { rates: { per_unit: 25_000_000 } } as never, source: "list_rate" },
      reportsCost: false,
      requestedMode: { tier: "standard", region: "global" } as never,
      startedAt,
      appVersion: null,
      clientTraceId: null,
      requestUsage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true, units: { model_units: 2000 }, estimatedUnits: ["model_units"] as never },
    };
  }

  /**
   * A 2-unit estimate, with a check row when it has a job id. Dated at the
   * real time by default: the failed-write store and the sweep write at the
   * real time, and the ledger's late-booking rule takes no row from 1970 then.
   */
  const estimateOf = (appId: string, job: string, jobId: string | null = null, at: number = Date.now()) =>
    jobEstimate(attemptFor(appId, job, at - 1_000), QUEUE, { status: "ok", httpStatus: 200, latencyMs: 1, signedId: jobId, now: at });

  const D1_DOWN = {
    prepare: () => {
      throw new Error("D1 down");
    },
    batch: () => Promise.reject(new Error("D1 down")),
  } as unknown as D1Database;

  const costs = async (appId: string) => (await charges(appId)).map((row) => [row.kind, row.cost_nano]);
  const SETTLED_AT_4 = [
    ["estimate", 50_000_000],
    ["correction", 50_000_000],
  ];
  const FOUR = { status: 200, units: 4, outputs: { images: 2 } };

  async function fresh() {
    const { appId } = await setup();
    await onlyThisApp(appId);
    const job = `job_${crypto.randomUUID()}`;
    const ref: JobRef = { job, accountId: ACCOUNT_ID, appId };
    return { appId, job, ref };
  }

  it("settles a figure, a figure row and a store retry to exactly one correction, in every order", async () => {
    const orders = [
      ["store", "figure", "settle"],
      ["store", "settle", "figure"],
      ["figure", "store", "settle"],
      ["figure", "settle", "store"],
      ["settle", "store", "figure"],
      ["settle", "figure", "store"],
    ] as const;
    for (const order of orders) {
      const { appId, job, ref } = await fresh();
      const store = env.CHARGE_STORE.getByName(appId);
      // The estimate waits in the failed-write store, as after a D1 outage.
      await store.keep([estimateOf(appId, job)]);
      for (const step of order) {
        if (step === "store") await runDurableObjectAlarm(store);
        if (step === "figure") await writeOpenWork(ledger(), [figureWork(ref, FOUR, 3_000)]);
        if (step === "settle") await settleFigure(ledger(), ref, FOUR, 3_000);
      }
      await runSweep(env, ledger(), { now: Date.now() + 60 * 60_000 });
      expect(await costs(appId), order.join(" → ")).toEqual(SETTLED_AT_4);
      expect(await openWork(appId), order.join(" → ")).toEqual([]);
    }
  });

  it("keeps the estimate when no usable figure ever arrives, and saves nothing for a result with no count", async () => {
    const { appId, job, ref } = await fresh();
    await writeAtTheirTime([estimateOf(appId, job)]);
    expect(await applyFinalResult(env, ledger(), ref, { status: 200, units: null, outputs: null }, 3_000)).toBe("estimate_kept");
    expect(await openWork(appId)).toEqual([]);
    // A count the estimate's rate cannot use: the estimate stays, and the row is not kept.
    expect(await applyFinalResult(env, ledger(), ref, { status: 200, units: null, outputs: { images: 2 } }, 3_000)).toBe("estimate_kept");
    await runSweep(env, ledger(), { now: Date.now() + 60 * 60_000 });
    expect(await costs(appId)).toEqual([["estimate", 50_000_000]]);
    expect(await openWork(appId)).toEqual([]);
  });

  it("a later poll with no units header never replaces a saved figure, before or after the estimate lands", async () => {
    const { appId, job, ref } = await fresh();
    expect(await applyFinalResult(env, ledger(), ref, FOUR, 3_000)).toBe("done");
    expect(await applyFinalResult(env, ledger(), ref, { status: 200, units: null, outputs: { images: 2 } }, 3_100)).toBe("done");
    await writeAtTheirTime([estimateOf(appId, job)]);
    // The rate bills units: this result cannot settle it, and leaves the saved 4 alone.
    expect(await applyFinalResult(env, ledger(), ref, { status: 200, units: null, outputs: { images: 2 } }, 3_200)).toBe("estimate_kept");
    await runSweep(env, ledger(), { now: Date.now() + 60 * 60_000 });
    expect(await costs(appId)).toEqual(SETTLED_AT_4);
    expect(await openWork(appId)).toEqual([]);
  });

  it("keeps a figure in the failed-write store while D1 is down, and settles it once both are written", async () => {
    const { appId, job, ref } = await fresh();
    await recordLedgerEntry(withLedgerDb(env, () => D1_DOWN), estimateOf(appId, job, null, Date.now()));
    expect(await applyFinalResult(env, D1_DOWN, ref, FOUR, 3_000)).toBe("done");
    expect(logged("job_result_unrecorded")).toBe(false);
    expect(await runDurableObjectAlarm(env.CHARGE_STORE.getByName(appId))).toBe(true);
    fetchSpy.mockClear();
    await runSweep(env, ledger(), { now: Date.now() + 60 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await costs(appId)).toEqual(SETTLED_AT_4);
  });

  it("keeps the figure when D1 took the estimate but its reply was lost, and the store writes it again", async () => {
    const { appId, job, ref } = await fresh();
    const entry = estimateOf(appId, job, null, Date.now());
    await writeAtTheirTime([entry]);
    const store = env.CHARGE_STORE.getByName(appId);
    await store.keep([entry]);
    expect(await applyFinalResult(env, D1_DOWN, ref, FOUR, 3_000)).toBe("done");
    expect(await runDurableObjectAlarm(store)).toBe(true);
    await runSweep(env, ledger(), { now: Date.now() + 60 * 60_000 });
    expect(await costs(appId)).toEqual(SETTLED_AT_4);
  });

  it("keeps a job's check while JWT_SECRET cannot verify, and settles a saved figure without it", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    const broken = { ...env, JWT_SECRET: "" } as Env;
    fetchSpy.mockClear();
    await runSweep(broken, ledger(), { now: Date.now() + 5 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await openWork(appId))[0]).toMatchObject({ tries: 1, last_error: "JWT_SECRET cannot verify job ids" });

    const job = `job_${crypto.randomUUID()}`;
    const ref: JobRef = { job, accountId: ACCOUNT_ID, appId };
    expect(await applyFinalResult(env, ledger(), ref, FOUR, 3_000)).toBe("done");
    await writeAtTheirTime([estimateOf(appId, job)]);
    await runSweep(broken, ledger(), { now: Date.now() + 60 * 60_000 });
    const rows = await ledger().prepare("SELECT kind, cost_nano FROM charge WHERE owner_id = ? ORDER BY kind DESC").bind(job).all();
    expect(rows.results.map((row) => [row.kind, row.cost_nano])).toEqual(SETTLED_AT_4);
  });

  it("settles a saved figure after its connection was deleted", async () => {
    const { appId, connectionId } = await setup();
    await onlyThisApp(appId);
    const job = `job_${crypto.randomUUID()}`;
    const ref: JobRef = { job, accountId: ACCOUNT_ID, appId };
    expect(await applyFinalResult(env, ledger(), ref, FOUR, 3_000)).toBe("done");
    await writeAtTheirTime([estimateOf(appId, job)]);
    await env.DB.prepare("DELETE FROM provider_connection WHERE id = ?").bind(connectionId).run();
    clearCaches();
    await runSweep(env, ledger(), { now: Date.now() + 60 * 60_000 });
    expect(await costs(appId)).toEqual(SETTLED_AT_4);
  });

  it("ends a late check whose job a figure already settled, with no second correction and no false warning", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    const [check] = await openWork(appId);
    const ref: JobRef = { job: String(check!.owner_id), accountId: ACCOUNT_ID, appId };
    expect(await settleFigure(ledger(), ref, FOUR, Date.now())).toBe("settled");
    fetchSpy.mockClear();
    const answer = await checkJob(
      env,
      {
        id: String(check!.id),
        kind: "job_check",
        accountId: ACCOUNT_ID,
        appId,
        ownerType: "job",
        ownerId: ref.job,
        chargeId: String(check!.charge_id),
        detail: JSON.parse(String(check!.detail_json)) as Record<string, unknown>,
        dueAt: 0,
        tries: 0,
      },
      { ledger: ledger(), now: Date.now(), lastTry: false },
    );
    expect(answer).toEqual({ done: true });
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate", "correction"]);
    expect(logged("job_units_missing")).toBe(false);
  });

  it("stops resolving a job id once its connection points at another backend, or holds another key", async () => {
    for (const change of ["base_url = 'https://other-fal.example/'", "secret_blob = ?"]) {
      clearCaches();
      const { appId, slug, key, connectionId } = await setup();
      falAnswers({});
      const jobId = String((await submit(appId, slug, key)).json!.request_id);
      const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, connectionId, "fal", ""], "sk-another-account-key");
      const update = env.DB.prepare(`UPDATE provider_connection SET ${change} WHERE slug = ?`);
      await (change.includes("?") ? update.bind(blob, slug) : update.bind(slug)).run();
      clearCaches();
      fetchSpy.mockClear();
      const { response, json } = await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
      expect(response.status, change).toBe(404);
      expect(json).toMatchObject({ error: { code: "job_not_found" } });
      await onlyThisApp(appId);
      await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logged("job_check_connection_changed")).toBe(true);
      expect(await costs(appId)).toEqual([["estimate", 50_000_000]]);
      expect(await openWork(appId)).toEqual([]);
    }
  });

  it("reads the connection fresh in the sweep: one paused in another isolate is never used", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    // This isolate has the connection cached as active; another one pauses it.
    await env.DB.prepare("UPDATE provider_connection SET status = 'disabled' WHERE slug = ?").bind(slug).run();
    await onlyThisApp(appId);
    fetchSpy.mockClear();
    await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await openWork(appId))[0]).toMatchObject({ last_error: "the job's connection is disabled" });
  });

  it("spends no request allowance on a job refused for its signing key", async () => {
    const { appId, slug, key } = await setup();
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, '$.limits', json(?)) WHERE id = ?")
      .bind(JSON.stringify({ per_app: { requests: { per_minute: 1 } } }), appId)
      .run();
    clearCaches();
    falAnswers({});
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);
    expect((await submit(appId, slug, key, undefined, { env: { ...env, JWT_SECRET: "short" } as Env })).response.status).toBe(500);
    expect((await submit(appId, slug, key)).response.status).toBe(200);
  });

  it("keeps two user ids apart that encode to the same bytes", async () => {
    expect(await userDigest("a\uD800")).not.toBe(await userDigest("a�"));
  });

  // Review fixes, round 7: the decision is made with the estimate's rate.
  type Case = readonly [name: string, facts: { status: number; units: number | null; outputs: { images?: number } | null; unread?: true }, outcome: string];
  const PER_UNIT_CASES: readonly Case[] = [
    ["200, header, whole body", { status: 200, units: 4, outputs: { images: 2 } }, "done"],
    ["200, header, body unread", { status: 200, units: 4, outputs: null, unread: true }, "done"],
    ["200, no header, whole body", { status: 200, units: null, outputs: { images: 2 } }, "estimate_kept"],
    ["200, no header, body unread", { status: 200, units: null, outputs: null, unread: true }, "estimate_kept"],
    ["200, no header, no outputs", { status: 200, units: null, outputs: null }, "estimate_kept"],
    ["422, header 0, body unread", { status: 422, units: 0, outputs: null, unread: true }, "done"],
    ["422, no header, body unread", { status: 422, units: null, outputs: null, unread: true }, "estimate_kept"],
    ["422, no header, whole body", { status: 422, units: null, outputs: null }, "estimate_kept"],
  ];
  const PER_IMAGE_CASES: readonly Case[] = [
    ["200, header, whole body", { status: 200, units: 4, outputs: { images: 2 } }, "done"],
    ["200, header, body unread", { status: 200, units: 4, outputs: null, unread: true }, "retry"],
    ["200, no header, whole body", { status: 200, units: null, outputs: { images: 3 } }, "done"],
    ["200, no header, body unread", { status: 200, units: null, outputs: null, unread: true }, "retry"],
    ["200, no header, no outputs", { status: 200, units: null, outputs: null }, "estimate_kept"],
    ["422, header 0, body unread", { status: 422, units: 0, outputs: null, unread: true }, "done"],
    ["422, no header, body unread", { status: 422, units: null, outputs: null, unread: true }, "estimate_kept"],
    ["422, no header, whole body", { status: 422, units: null, outputs: null }, "estimate_kept"],
  ];

  /** The 2-unit estimate, or the same job billed per image (2 images at $0.01). */
  function estimateWith(appId: string, job: string, perImage: boolean) {
    const entry = estimateOf(appId, job);
    if (!perImage) return entry;
    return { ...entry, charge: { ...entry.charge, rates: { per_image: 10_000_000 }, unit: "images", costNano: 20_000_000 } as unknown as ChargeRow };
  }

  for (const [rate, cases] of [["per unit", PER_UNIT_CASES], ["per image", PER_IMAGE_CASES]] as const) {
    it(`decides every result with the estimate's rate (${rate}): settle, read again, or keep the estimate`, async () => {
      for (const [name, facts, outcome] of cases) {
        const { appId, job, ref } = await fresh();
        await writeAtTheirTime([estimateWith(appId, job, rate === "per image")]);
        expect(await applyFinalResult(env, ledger(), ref, facts, 3_000), name).toBe(outcome);
        const kinds = (await charges(appId)).map((row) => row.kind);
        expect(kinds, name).toEqual(outcome === "done" ? ["estimate", "correction"] : ["estimate"]);
        // Nothing is kept for later once the rate has decided: settled, or the estimate stays.
        expect(await openWork(appId), name).toEqual([]);
      }
    });
  }

  it("saves a units header from a broken body while the estimate waits in the store, then settles it at 4", async () => {
    const { appId, job, ref } = await fresh();
    const store = env.CHARGE_STORE.getByName(appId);
    await store.keep([estimateOf(appId, job)]);
    // fal sent 4 billed units, and the body broke: the header alone is kept.
    expect(await applyFinalResult(env, ledger(), ref, { status: 200, units: 4, outputs: null, unread: true }, 3_000)).toBe("retry");
    expect((await openWork(appId)).map((row) => row.id)).toEqual([`job_figure:${job}:200:4:-`]);
    expect(await runDurableObjectAlarm(store)).toBe(true);
    await runSweep(env, ledger(), { now: Date.now() + 60 * 60_000 });
    expect(await costs(appId)).toEqual(SETTLED_AT_4);
    expect(await openWork(appId)).toEqual([]);
  });
});

describe("request ids, result bodies and stalled answers (review fixes, round 3)", () => {
  it("signs no provider request id that would change the follow-up path, and keeps that job's estimate", async () => {
    for (const bad of [".", "..", "a/b"]) expect(providerRequestId(SPEC, { request_id: bad }), bad).toBeNull();
    expect(providerRequestId(SPEC, { request_id: "req-1.v2" })).toBe("req-1.v2");
    const { appId, slug, key } = await setup();
    falAnswers({ submit: () => Response.json({ request_id: "..", status: "IN_QUEUE" }) });
    const { response } = await submit(appId, slug, key);
    expect(response.status).toBe(502);
    expect(logged("job_submission_lost")).toBe(true);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
    expect(await openWork(appId)).toEqual([]);
  });

  it("passes a result body back as it came: binary bytes, and a bodiless 204", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 200]);
    falAnswers({ result: () => new Response(bytes, { status: 200, headers: { "content-type": "image/png", "x-fal-billable-units": "2" } }) });
    const ctx = createExecutionContext();
    const binary = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/jobs/${jobId}`, { headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1" } }),
      env,
      ctx,
    );
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(bytes);
    await waitOnExecutionContext(ctx);
    falAnswers({ status: () => new Response(null, { status: 204 }) });
    const { response } = await call("GET", `/v2/apps/${appId}/jobs/${jobId}/status`, key);
    expect(response.status).toBe(204);
  });

  it("treats an accepted submission whose body stalls as lost: the estimate stays, and the app is not held", async () => {
    const { appId, slug, key } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    falAnswers({
      submit: () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode('{"request_id":')) }), { status: 200 }),
    });
    const answer = submit(appId, slug, key);
    await vi.advanceTimersByTimeAsync(31_000);
    const { response } = await answer;
    expect(response.status).toBe(502);
    expect(logged("job_submission_lost")).toBe(true);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
  });
});

/** A D1 whose estimate reads wait for `gate`, and whose batches never answer when `stallWrites` is set. */
function slowD1(gate: Promise<void>, stallWrites = false, onHold?: () => void): D1Database {
  const wrap = <T extends object>(target: T, get: (target: T, prop: string | symbol) => unknown): T =>
    new Proxy(target, { get: (t, prop) => get(t, prop) });
  const pass = (t: object, prop: string | symbol) => {
    const value = (t as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
  };
  return wrap(ledger(), (db, prop) => {
    if (prop === "batch" && stallWrites) return () => new Promise(() => undefined);
    if (prop !== "prepare") return pass(db, prop);
    return (sql: string) => {
      const statement = db.prepare(sql);
      if (!sql.includes("kind = 'estimate'")) return statement;
      return wrap(statement, (st, p) =>
        p === "bind"
          ? (...args: unknown[]) =>
              wrap(st.bind(...args), (bound, q) =>
                q === "first" ? async (...more: unknown[]) => (onHold?.(), await gate, (bound.first as (...a: unknown[]) => unknown)(...more)) : pass(bound, q),
              )
          : pass(st, p),
      );
    };
  });
}

describe("deadlines, store retries, counting and caching (review fixes, round 4)", () => {
  it("hands the sweep's settlement to the cron's waitUntil, so the item's time limit cannot cut it off", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({ result: () => Response.json({ images: [{}, {}, {}, {}] }, { headers: { "x-fal-billable-units": "4" } }) });
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const kept: Promise<unknown>[] = [];
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = runSweep(env, slowD1(gate, false, held), { now: Date.now() + 5 * 60_000, itemTimeLimitMs: 1_000, waitUntil: (work) => kept.push(work) });
    // The item's time passes while the estimate read hangs: the run moves on, the settlement does not stop.
    // The clock moves only once the read is held: the ledger's answers before it take real time.
    await holding;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await run).toMatchObject({ retried: 1 });
    expect(kept).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(FIGURE_D1_DEADLINE_MS * 2);
    await Promise.all(kept);
    vi.useRealTimers();
    await runSweep(env, ledger(), { now: Date.now() + 60 * 60_000 });
    expect((await charges(appId)).map((row) => [row.kind, row.cost_nano])).toEqual([
      ["estimate", 50_000_000],
      ["correction", 50_000_000],
    ]);
  });

  it("keeps a poll's figure in the failed-write store when D1 is slow, inside the poll's waitUntil window", async () => {
    const { appId } = await setup();
    await onlyThisApp(appId);
    const ref: JobRef = { job: `job_${crypto.randomUUID()}`, accountId: ACCOUNT_ID, appId };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const applying = applyFinalResult(env, slowD1(new Promise(() => undefined), true), ref, { status: 200, units: 4, outputs: { images: 2 } }, 3_000);
    await vi.advanceTimersByTimeAsync(FIGURE_D1_DEADLINE_MS); // the settlement read times out
    await vi.advanceTimersByTimeAsync(FIGURE_D1_DEADLINE_MS); // then the D1 figure write
    expect(await applying).toBe("done");
    vi.useRealTimers();
    await runDurableObjectAlarm(env.CHARGE_STORE.getByName(appId));
    expect((await openWork(appId)).map((row) => row.id)).toEqual([`job_figure:${ref.job}:200:4:2images`]);
  });

  it("does not bring back a settled job's check when the store retries its submit batch", async () => {
    const { appId } = await setup();
    await onlyThisApp(appId);
    const job = `job_${crypto.randomUUID()}`;
    const ref: JobRef = { job, accountId: ACCOUNT_ID, appId };
    const entry = jobEstimate(
      {
        requestId: job,
        seq: 1,
        accountId: ACCOUNT_ID,
        appId,
        identity: { accountId: ACCOUNT_ID, appId, userId: "user-1", installId: null, appleAccountId: null, authMethod: "api_key", credentialType: "api_key" } as never,
        providerType: "fal",
        connectionId: "c",
        providerSlug: "fal",
        operation: "fal.queue",
        model: "fal-ai/flux/dev",
        price: { price: { rates: { per_unit: 25_000_000 } } as never, source: "list_rate" },
        reportsCost: false,
        requestedMode: { tier: "standard", region: "global" } as never,
        startedAt: 1_000,
        appVersion: null,
        clientTraceId: null,
        requestUsage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true, units: { model_units: 2000 }, estimatedUnits: ["model_units"] as never },
      } as CallAttempt,
      QUEUE,
      { status: "ok", httpStatus: 200, latencyMs: 1, signedId: "signed-id", now: 2_000 },
    );
    // D1 took the batch but its reply was lost, so the store keeps a copy too.
    await writeAtTheirTime([entry]);
    const store = env.CHARGE_STORE.getByName(appId);
    await store.keep([entry]);
    expect(await settleFigure(ledger(), ref, { status: 200, units: 4, outputs: { images: 2 } }, 3_000)).toBe("settled");
    await runDurableObjectAlarm(store);
    expect(await openWork(appId)).toEqual([]);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate", "correction"]);
  });

  it("counts outputs from never more than a bounded part of the body", async () => {
    expect(await boundedJson(new Response('{"images":[1,2]}'), { limit: 64 })).toEqual({ kind: "parsed", value: { images: [1, 2] } });
    let cancelled = false;
    const big = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(1024)),
      cancel: () => {
        cancelled = true;
      },
    });
    expect(await boundedJson(new Response(big), { limit: 4096 })).toEqual({ kind: "too_large" });
    expect(cancelled).toBe(true);

    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    // No units header and a body over the limit: nothing is counted, so the estimate stays, and the app gets every byte.
    const huge = JSON.stringify({ images: [{ url: "x".repeat(BODY_READ_LIMIT + 10) }] });
    falAnswers({ result: () => new Response(huge, { headers: { "content-type": "application/json" } }) });
    const { text } = await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(text).toBe(huge);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
  });

  it("closes the upstream stream of an accepted submission whose body stalls", async () => {
    const { appId, slug, key } = await setup();
    let cancelled = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    falAnswers({
      submit: () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(new TextEncoder().encode('{"request_id":')),
            cancel: () => {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    });
    const answer = submit(appId, slug, key);
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await answer).response.status).toBe(502);
    expect(cancelled).toBe(true);
  });

  it("lets no cache keep a job's status or result, whatever the provider said", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    const cacheable = { "cache-control": "public, max-age=300", "cdn-cache-control": "max-age=300", "cloudflare-cdn-cache-control": "max-age=300", "surrogate-control": "max-age=300" };
    falAnswers({
      status: () => Response.json({ status: "COMPLETED" }, { headers: cacheable }),
      result: () => Response.json({ images: [{}] }, { headers: { ...cacheable, "x-fal-billable-units": "1" } }),
    });
    for (const path of [`/v2/apps/${appId}/jobs/${jobId}/status`, `/v2/apps/${appId}/jobs/${jobId}`]) {
      const { response } = await call("GET", path, key);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      for (const name of ["cdn-cache-control", "cloudflare-cdn-cache-control", "surrogate-control"]) expect(response.headers.get(name), `${path} ${name}`).toBeNull();
    }
  });
});

describe("per-output counts, stalled writes, read errors, submit deadlines, the store's cap and poll caching (review fixes, round 5)", () => {
  const PER_IMAGE = { "fal-ai/flux/dev": { per_image: 10_000_000 } };

  /** A two-image flux/dev estimate entry with its check, as a submit writes it. */
  function estimateEntry(appId: string, job: string) {
    return jobEstimate(
      {
        requestId: job,
        seq: 1,
        accountId: ACCOUNT_ID,
        appId,
        identity: { accountId: ACCOUNT_ID, appId, userId: "user-1", installId: null, appleAccountId: null, authMethod: "api_key", credentialType: "api_key" } as never,
        providerType: "fal",
        connectionId: "c",
        providerSlug: "fal",
        operation: "fal.queue",
        model: "fal-ai/flux/dev",
        price: { price: { rates: { per_unit: 25_000_000 } } as never, source: "list_rate" },
        reportsCost: false,
        requestedMode: { tier: "standard", region: "global" } as never,
        // At the real time: the failed-write store writes it at the real time too (`../src/ledger/late-booking.ts`).
        startedAt: Date.now() - 1_000,
        appVersion: null,
        clientTraceId: null,
        requestUsage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true, units: { model_units: 2000 }, estimatedUnits: ["model_units"] as never },
      } as CallAttempt,
      QUEUE,
      { status: "ok", httpStatus: 200, latencyMs: 1, signedId: "signed-id", now: Date.now() },
    );
  }

  it("settles a per-image estimate from the outputs, even when fal also sends billed units", async () => {
    const { appId, slug, key } = await setup(PER_IMAGE);
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    // Estimated at two images at $0.01; three came back, and fal also billed 4 units, which a rate per image cannot use.
    falAnswers({ result: () => Response.json({ images: [{}, {}, {}] }, { headers: { "x-fal-billable-units": "4" } }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    const rows = await charges(appId);
    expect(rows.map((row) => row.kind)).toEqual(["estimate", "correction"]);
    expect(rows.reduce((sum, row) => sum + Number(row.cost_nano), 0)).toBe(30_000_000);
  });

  it("sends a job's estimate and its check to the failed-write store together when the D1 write stalls", async () => {
    const { appId } = await setup();
    const job = `job_${crypto.randomUUID()}`;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const recording = recordLedgerEntry(withLedgerDb(env, () => slowD1(Promise.resolve(), true)), estimateEntry(appId, job));
    await vi.advanceTimersByTimeAsync(LEDGER_D1_DEADLINE_MS);
    await recording;
    vi.useRealTimers();
    const store = env.CHARGE_STORE.getByName(appId);
    expect(await store.pendingCount()).toBe(1);
    await runDurableObjectAlarm(store);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
    expect((await openWork(appId)).map((row) => row.id)).toEqual([jobCheckId(job)]);
  });

  it("checks a result again when its body is cut off while the sweep reads it, instead of ending the check", async () => {
    const { appId, slug, key } = await setup(PER_IMAGE);
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    falAnswers({
      result: () =>
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode('{"images":[{},'));
              controller.error(new Error("connection dropped"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    expect(await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 })).toMatchObject({ retried: 1 });
    expect(await openWork(appId)).toHaveLength(1);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
    // Readable on the next check: three images settle it.
    falAnswers({ result: () => Response.json({ images: [{}, {}, {}] }) });
    await runSweep(env, ledger(), { now: Date.now() + 10 * 60_000 });
    expect((await charges(appId)).reduce((sum, row) => sum + Number(row.cost_nano), 0)).toBe(30_000_000);
  });

  it("stops the submit's fetch at the body deadline and answers at once, even when the stream's cleanup never ends", async () => {
    const { appId, slug, key } = await setup();
    let signal: AbortSignal | null = null;
    fetchSpy.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? null;
      return new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode('{"request_id":')),
          cancel: () => new Promise<void>(() => undefined),
        }),
        { status: 200 },
      );
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const answer = submit(appId, slug, key);
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await answer).response.status).toBe(502);
    expect(signal!.aborted).toBe(true);
    expect(logged("job_submission_lost")).toBe(true);
  });

  it("keeps at most MAX_PENDING entries and rows in all, across both of the store's tables", async () => {
    const { appId } = await setup();
    const store = env.CHARGE_STORE.getByName(appId);
    await store.keep([estimateEntry(appId, `job_${crypto.randomUUID()}`)]);
    const ref: JobRef = { job: `job_${crypto.randomUUID()}`, accountId: ACCOUNT_ID, appId };
    const rows = Array.from({ length: MAX_PENDING }, (_, units) => figureWork(ref, { status: 200, units, outputs: null }, 3_000));
    await store.keepWork(rows);
    expect(await store.pendingCount()).toBe(MAX_PENDING);
  });

  it("lets no cache keep a poll's refusal either", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    // Another end user of the same app: refused as unknown, and never cached.
    const other = await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key, { user: "user-2" });
    expect(other.response.status).toBe(404);
    expect(other.response.headers.get("cache-control")).toBe("no-store");
    const forged = await call("GET", `/v2/apps/${appId}/jobs/not-a-job/status`, key);
    expect(forged.response.status).toBe(404);
    expect(forged.response.headers.get("cache-control")).toBe("no-store");
  });

  it("records no other account's connection slug when a blocked user polls a job id it did not make (Gemini Neon 7b-4 round 1)", async () => {
    const { appId, key } = await setup();
    await env.DB.prepare("INSERT INTO app_end_user (app_id, id, status, created_at) VALUES (?, 'blocked-1', 'blocked', ?)").bind(appId, Date.now()).run();
    clearCaches();
    // Signed with the deployment's one secret, naming this app id but another account.
    const foreign = await signJobId(env.JWT_SECRET, {
      job: "job-x",
      connectionId: "c-other",
      slug: "other-accounts-slug",
      operation: "fal.queue",
      model: "fal-ai/flux/dev",
      requestId: "req-x",
      route: "r0",
      accountId: "acc_someone_else",
      appId,
      userId: "blocked-1",
    });
    const { response } = await call("GET", `/v2/apps/${appId}/jobs/${foreign}/status`, key, { user: "blocked-1" });
    expect(response.status).toBe(403);
    const events = (await ledger().prepare("SELECT reason, provider_slug FROM app_rejection_event WHERE app_id = ?").bind(appId).all()).results;
    expect(events).toEqual([{ reason: "blocked_user", provider_slug: null }]);
  });
});

describe("what a broken body still settles, and rewrites (review fixes, round 6)", () => {
  const PER_IMAGE = { "fal-ai/flux/dev": { per_image: 10_000_000 } };

  /** A result body that breaks halfway, the way a dropped connection ends it. */
  const brokenBody = () =>
    new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('{"images":[{},'));
        controller.error(new Error("connection dropped"));
      },
    });

  it("settles a failure that billed 0 units from the header, even when its body breaks", async () => {
    const { appId, slug, key } = await setup(PER_IMAGE);
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    // A failure that fal says billed 0 units: the broken body is not needed to settle it.
    falAnswers({ result: () => new Response(brokenBody(), { status: 422, headers: { "x-fal-billable-units": "0" } }) });
    await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 });
    expect(await openWork(appId)).toEqual([]);
    const rows = await charges(appId);
    expect(rows.map((row) => row.kind)).toEqual(["estimate", "correction"]);
    expect(rows.reduce((sum, row) => sum + Number(row.cost_nano), 0)).toBe(0);
  });

  it("reads a result again when its JSON is cut short but closes normally, while the rate needs the outputs", async () => {
    const { appId, slug, key } = await setup(PER_IMAGE);
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    // A whole stream that is not whole JSON: no units header, and the rate counts images.
    falAnswers({ result: () => new Response('{"images":[{},', { status: 200, headers: { "content-type": "application/json" } }) });
    expect(await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 })).toMatchObject({ retried: 1 });
    expect(await openWork(appId)).toHaveLength(1);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
    falAnswers({ result: () => Response.json({ images: [{}, {}, {}] }) });
    await runSweep(env, ledger(), { now: Date.now() + 10 * 60_000 });
    expect((await charges(appId)).reduce((sum, row) => sum + Number(row.cost_nano), 0)).toBe(30_000_000);
  });

  it("saves a units header as a figure even when the body broke, and keeps checking while the rate is not known", async () => {
    const ref: JobRef = { job: `job_${crypto.randomUUID()}`, accountId: ACCOUNT_ID, appId: "app_unread" };
    const rows = async () =>
      (await ledger().prepare("SELECT id FROM open_work WHERE owner_id = ? ORDER BY id").bind(ref.job).all()).results.map((row) => row.id);
    // No estimate in the ledger yet: a header alone is a usable figure, and the body may still matter.
    expect(await applyFinalResult(env, ledger(), ref, { status: 200, units: 4, outputs: null, unread: true }, 3_000)).toBe("retry");
    expect(await rows()).toEqual([`job_figure:${ref.job}:200:4:-`]);
    // Nothing usable at all: nothing saved, still read again.
    expect(await applyFinalResult(env, ledger(), ref, { status: 200, units: null, outputs: null, unread: true }, 3_000)).toBe("retry");
    // A whole success with no other count is still one job, which a price per request settles: kept for the sweep.
    expect(await applyFinalResult(env, ledger(), ref, { status: 200, units: null, outputs: null }, 3_000)).toBe("done");
    expect(await rows()).toEqual([`job_figure:${ref.job}:200:-:-`, `job_figure:${ref.job}:200:4:-`]);
    // A whole failure with no count: no rate can ever settle it.
    expect(await applyFinalResult(env, ledger(), ref, { status: 422, units: null, outputs: null }, 3_000)).toBe("estimate_kept");
  });

  it("reads a result again when its body is empty, while the rate needs the outputs (review fixes, round 7)", async () => {
    const { appId, slug, key } = await setup(PER_IMAGE);
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    // A success cut off before its first byte, with no units header.
    falAnswers({ result: () => new Response("", { status: 200, headers: { "content-type": "application/json" } }) });
    expect(await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 })).toMatchObject({ retried: 1 });
    expect(await openWork(appId)).toHaveLength(1);
    falAnswers({ result: () => Response.json({ images: [{}, {}, {}] }) });
    await runSweep(env, ledger(), { now: Date.now() + 10 * 60_000 });
    expect((await charges(appId)).reduce((sum, row) => sum + Number(row.cost_nano), 0)).toBe(30_000_000);
  });

  it("does not read a result again when the rate bills units and no header came (review fixes, round 7)", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    // The price file bills flux/dev per billed unit: a whole body could not help, so the check ends.
    falAnswers({ result: () => new Response(brokenBody(), { status: 200 }) });
    expect(await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000 })).toMatchObject({ retried: 0 });
    expect(await openWork(appId)).toEqual([]);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
  });

  it("passes only the fields the operation lists on a status poll's query (review fixes, round 7)", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    fetchSpy.mockClear();
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}/status?logs=1&webhook=https%3A%2F%2Fevil.test`, key);
    const statusUrl = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(statusUrl.search).toBe("?logs=1");
    fetchSpy.mockClear();
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}?logs=1`, key);
    expect(new URL(String(fetchSpy.mock.calls[0]![0])).search).toBe("");
  });

  it("applies model rewrites to calls only, never to a queued job (plan D13)", () => {
    const run = fal.operations.find((one) => one.name === "fal.run")!;
    const rewrites = { "fal-ai/flux/dev": "fal-ai/flux/schnell" };
    expect(rewrittenModel(run, "fal-ai/flux/dev", rewrites)).toBe("fal-ai/flux/schnell");
    expect(rewrittenModel(QUEUE, "fal-ai/flux/dev", rewrites)).toBe("fal-ai/flux/dev");
  });
});

describe("deciding before reading, replays and reply sizes (review fixes, round 8)", () => {
  const PER_IMAGE = { "fal-ai/flux/dev": { per_image: 10_000_000 } };
  /** A body that never sends a byte and never ends. */
  const stalling = () => new ReadableStream<Uint8Array>({ start() {} });
  const itemOf = (row: Record<string, unknown>) => ({
    id: String(row.id),
    kind: "job_check" as const,
    accountId: ACCOUNT_ID,
    appId: String(row.app_id),
    ownerType: "job" as const,
    ownerId: String(row.owner_id),
    chargeId: String(row.charge_id),
    detail: JSON.parse(String(row.detail_json)) as Record<string, unknown>,
    dueAt: 0,
    tries: 0,
  });

  async function submittedCheck(rates: Record<string, unknown> | null = null) {
    const ids = await setup(rates);
    falAnswers({});
    await submit(ids.appId, ids.slug, ids.key);
    await onlyThisApp(ids.appId);
    const [check] = await openWork(ids.appId);
    return { ...ids, check: check! };
  }

  it("ends a per-unit job's check without reading its body when no units header came, even a body that stalls", async () => {
    const { appId, check } = await submittedCheck();
    falAnswers({ result: () => new Response(stalling(), { status: 200 }) });
    expect(await checkJob(env, itemOf(check) as never, { ledger: ledger(), now: Date.now(), lastTry: false })).toEqual({ done: true });
    expect(await openWork(appId)).toEqual([]);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
  });

  it("stops reading a body that stalls past its deadline: a read error, to read again later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reading = boundedJson(new Response(stalling()), { deadlineMs: JOB_BODY_READ_DEADLINE_MS });
    await vi.advanceTimersByTimeAsync(JOB_BODY_READ_DEADLINE_MS + 1);
    expect(await reading).toEqual({ kind: "read_error" });
  });

  it("ends its own check on a final decision, so the decision holds even after the sweep moved on", async () => {
    const { appId, check } = await submittedCheck(PER_IMAGE);
    // A whole success that counts nothing: the estimate stays, and the handler itself ends the check.
    falAnswers({ result: () => Response.json({}) });
    expect(await checkJob(env, itemOf(check) as never, { ledger: ledger(), now: Date.now(), lastTry: false })).toEqual({ done: true });
    expect(await openWork(appId)).toEqual([]);
  });

  it("never brings back a check when a committed submit batch is replayed", async () => {
    const { appId, check } = await submittedCheck();
    const estimateRow = (await ledger().prepare("SELECT * FROM charge WHERE id = ?").bind(String(check.charge_id)).first<Record<string, unknown>>())!;
    const entry = {
      charge: chargeFromRow(estimateRow),
      openWork: [
        {
          id: String(check.id),
          kind: "job_check" as const,
          accountId: ACCOUNT_ID,
          appId,
          ownerType: "job" as const,
          ownerId: String(check.owner_id),
          chargeId: String(check.charge_id),
          detail: JSON.parse(String(check.detail_json)) as Record<string, unknown>,
          dueAt: Number(check.due_at),
          createdAt: Number(check.created_at),
        },
      ],
    };
    // The sweep ends the check: a whole result, no units header, a rate per billed unit.
    falAnswers({ result: () => Response.json({ images: [{}] }) });
    expect(await checkJob(env, itemOf(check) as never, { ledger: ledger(), now: Date.now(), lastTry: false })).toEqual({ done: true });
    expect(await openWork(appId)).toEqual([]);
    // The failed-write store replays the submit batch that had committed.
    await writeAtTheirTime([entry]);
    expect(await openWork(appId)).toEqual([]);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
  });

  it("treats an accepted submission whose answer is over the read limit as lost: the estimate stays", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({ submit: () => Response.json({ request_id: "req-1", status: "IN_QUEUE", padding: "x".repeat(BODY_READ_LIMIT) }) });
    const { response } = await submit(appId, slug, key);
    expect(response.status).toBe(502);
    expect(await charges(appId)).toMatchObject([{ kind: "estimate", cost_nano: 50_000_000 }]);
    expect(await openWork(appId)).toEqual([]);
    expect(logged("job_submission_lost")).toBe(true);
  });

  it("never holds a status answer over the read limit whole: the gateway answers with its own links", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    const big = JSON.stringify({ status: "IN_PROGRESS", logs: "y".repeat(BODY_READ_LIMIT) });
    falAnswers({ status: () => new Response(big, { status: 200, headers: { "content-type": "application/json" } }) });
    const { response, json } = await call("GET", `/v2/apps/${appId}/jobs/${jobId}/status`, key);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-agw-status-trimmed")).toBe("body");
    expect(json).toMatchObject({ request_id: jobId });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("a final result's body after the sweep item's time, and the provider's own host as base URL (review fixes, round 9)", () => {
  const PER_IMAGE = { "fal-ai/flux/dev": { per_image: 10_000_000 } };

  it("reads a final result's body to its own deadline, even when the sweep item's time runs out meanwhile", async () => {
    const { appId, slug, key } = await setup(PER_IMAGE);
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let resultAsked!: () => void;
    const asked = new Promise<void>((resolve) => (resultAsked = resolve));
    let sendHeaders!: () => void;
    const headers = new Promise<void>((resolve) => (sendHeaders = resolve));
    let bodyStream!: ReadableStreamDefaultController<Uint8Array>;
    let reading!: () => void;
    const readStarted = new Promise<void>((resolve) => (reading = resolve));
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/status")) return Response.json({ status: "COMPLETED" });
      // The test sends the headers 4.8 s into the item and the body at 5.2 s: after the item's 5 s limit.
      // Like a real fetch, the stream fails if its request is aborted.
      resultAsked();
      await headers;
      const signal = init?.signal ?? null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyStream = controller;
          signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        },
        pull() {
          reading();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    const kept: Promise<unknown>[] = [];
    const sweeping = runSweep(env, ledger(), { now: Date.now() + 5 * 60_000, waitUntil: (work) => kept.push(work) });
    await asked;
    await vi.advanceTimersByTimeAsync(4_800);
    sendHeaders();
    // The body is read once the estimate is read from the ledger, which takes real time.
    await readStarted;
    await vi.advanceTimersByTimeAsync(400); // the item's 5 s limit passes
    bodyStream.enqueue(new TextEncoder().encode(JSON.stringify({ images: [{}, {}, {}] })));
    bodyStream.close();
    await sweeping;
    vi.useRealTimers();
    await vi.waitFor(async () => {
      await Promise.all(kept);
      // Two images estimated at $0.01; three came back.
      expect((await charges(appId)).reduce((sum, row) => sum + Number(row.cost_nano), 0)).toBe(30_000_000);
    });
  });

  it("sends a job to the provider's own declared host when the base URL is that host", async () => {
    const { appId, slug, key } = await setup(null, "https://queue.fal.run/");
    falAnswers({});
    const submitted = await submit(appId, slug, key);
    expect(submitted.response.status).toBe(200);
    const urls = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(urls).toContain("https://queue.fal.run/fal-ai/flux/dev");
    expect(urls.some((url) => url.includes("/queue/"))).toBe(false);
  });

  it("starts no provider request when the item's time runs out while the key is opened", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const submitted = await submit(appId, slug, key);
    const claims = (await readJobId(env.JWT_SECRET, String(submitted.json!.request_id)))!;
    const context = (await jobContext(env, claims))!;
    fetchSpy.mockClear();
    // Not yet out of time when fetchJob starts; out of time once the key is open.
    let checks = 0;
    const reason = new Error("the item's time is up");
    const signal = {
      get aborted() {
        return checks > 1;
      },
      reason,
      throwIfAborted() {
        checks += 1;
        if (checks > 1) throw reason;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    await expect(fetchJob(env, context, "status", claims, null, signal)).rejects.toBe(reason);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps sending other hosts under the base URL for a custom proxy", async () => {
    const { appId, slug, key } = await setup(null, "https://proxy.example.net/fal/");
    falAnswers({});
    await submit(appId, slug, key);
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toContain("https://proxy.example.net/fal/queue/fal-ai/flux/dev");
  });
});

describe("Fable's review fixes", () => {
  it("reads a settled job's result again quietly once fal's units header is gone: no false warning, no new charge", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({ result: () => Response.json({ images: [{}] }, { headers: { "x-fal-billable-units": "4" } }) });
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate", "correction"]);
    // Later the header has expired, but the result is still readable (T15), and the app reads it again.
    falAnswers({ result: () => Response.json({ images: [{}] }) });
    logs.length = 0;
    const again = await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(again.response.status).toBe(200);
    expect(logged("job_units_missing")).toBe(false);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate", "correction"]);
  });

  it("ends a poll's own time limit once the headers arrive, so a slow body is never cut off by it", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const submitted = await submit(appId, slug, key);
    const claims = (await readJobId(env.JWT_SECRET, String(submitted.json!.request_id)))!;
    const context = (await jobContext(env, claims))!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Headers that never come: the poll gives up at its time limit.
    let stalled: AbortSignal | null = null;
    fetchSpy.mockImplementation((_input, init) => {
      stalled = init?.signal ?? null;
      return new Promise<Response>(() => undefined);
    });
    void fetchJob(env, context, "result", claims, null).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(JOB_POLL_TIMEOUT_MS + 1);
    expect(stalled!.aborted).toBe(true);
    // Headers in time, then a body slower than the limit: nothing aborts it.
    let sent: AbortSignal | null = null;
    fetchSpy.mockImplementation(async (_input, init) => {
      sent = init?.signal ?? null;
      return new Response(new ReadableStream<Uint8Array>(), { status: 200 });
    });
    await fetchJob(env, context, "result", claims, null);
    await vi.advanceTimersByTimeAsync(JOB_POLL_TIMEOUT_MS * 2);
    expect(sent!.aborted).toBe(false);
  });
});

describe("disconnects, stalled bodies and oversized status answers (review fixes, Astra round 1)", () => {
  const encoder = new TextEncoder();

  it("writes an accepted job's estimate even when the app goes away while its answer is on its way", async () => {
    const { appId, slug, key } = await setup();
    let finish: (() => void) | null = null;
    falAnswers({
      submit: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('{"request_id":'));
              finish = () => {
                controller.enqueue(encoder.encode('"req-1","status":"IN_QUEUE"}'));
                controller.close();
              };
            },
          }),
          { status: 200 },
        ),
    });
    const ctx = createExecutionContext();
    // The app's answer is never read: the app went away.
    void worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/queue/fal-ai/flux/dev`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json" },
        body: JSON.stringify({ prompt: "a cat", num_images: 2 }),
      }),
      env,
      ctx,
    );
    await vi.waitFor(() => expect(finish).not.toBeNull());
    // From the moment the submit was sent, the request is kept alive.
    let settled = false;
    const waiting = waitOnExecutionContext(ctx).then(() => {
      settled = true;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled).toBe(false);
    finish!();
    await waiting;
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
    expect((await openWork(appId)).length).toBe(1);
  });

  it("applies a final units header when the result body stalls past the read deadline", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    falAnswers({
      result: () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { "x-fal-billable-units": "4" } }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/jobs/${jobId}`, { headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1" } }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await vi.advanceTimersByTimeAsync(JOB_BODY_READ_DEADLINE_MS + 1);
    vi.useRealTimers();
    await waitOnExecutionContext(ctx);
    const rows = await charges(appId);
    expect(rows.map((row) => row.kind)).toEqual(["estimate", "correction"]);
    // Four units at $0.025 against an estimate of two: +$0.05.
    expect(rows[1]).toMatchObject({ cost_nano: 50_000_000 });
  });

  it("never passes on a status answer too large to rewrite: it asks again without logs, then answers with its own links", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    const huge = {
      status: "IN_PROGRESS",
      request_id: "req-1",
      status_url: "https://queue.fal.run/fal-ai/flux/requests/req-1/status",
      response_url: "https://queue.fal.run/fal-ai/flux/requests/req-1",
      cancel_url: "https://queue.fal.run/fal-ai/flux/requests/req-1/cancel",
      logs: [{ message: "x".repeat(BODY_READ_LIMIT + 10) }],
    };
    const urls: string[] = [];
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const { logs: _logs, ...small } = huge;
      return Response.json(String(input).includes("logs=1") ? huge : small);
    });
    const withLogs = await call("GET", `/v2/apps/${appId}/jobs/${jobId}/status?logs=1`, key);
    expect(withLogs.response.status).toBe(200);
    expect(withLogs.response.headers.get("x-agw-status-trimmed")).toBe("query");
    expect(withLogs.json).toMatchObject({ status: "IN_PROGRESS", status_url: `${ORIGIN}/v2/apps/${appId}/jobs/${jobId}/status` });
    expect(withLogs.text).not.toContain("queue.fal.run");
    expect(urls).toHaveLength(2);

    // Still too large without its query: the gateway's own links and the job id only.
    fetchSpy.mockImplementation(async () => Response.json(huge));
    const without = await call("GET", `/v2/apps/${appId}/jobs/${jobId}/status`, key);
    expect(without.response.headers.get("x-agw-status-trimmed")).toBe("body");
    expect(without.json).toEqual({
      request_id: jobId,
      status_url: `${ORIGIN}/v2/apps/${appId}/jobs/${jobId}/status`,
      response_url: `${ORIGIN}/v2/apps/${appId}/jobs/${jobId}`,
      cancel_url: `${ORIGIN}/v2/apps/${appId}/jobs/${jobId}/cancel`,
    });
    expect(without.text).not.toContain("queue.fal.run");
  });
});

describe("disconnects, stalled retries and redirects (review fixes, Astra round 2)", () => {
  const encoder = new TextEncoder();

  it("writes an accepted job's estimate when the app leaves before fal answers and fal answers too late", async () => {
    const { appId, slug, key } = await setup();
    // fal never answers on its own: only the gateway's cut ends the wait.
    let sent: AbortSignal | null = null;
    fetchSpy.mockImplementation((_input, init) => {
      sent = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const app = new AbortController();
    const ctx = createExecutionContext();
    const answer = worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/queue/fal-ai/flux/dev`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json" },
        body: JSON.stringify({ prompt: "a cat", num_images: 2 }),
        signal: app.signal,
      }),
      env,
      ctx,
    );
    await vi.waitFor(() => expect(sent).not.toBeNull());
    app.abort();
    await vi.advanceTimersByTimeAsync(JOB_DISCONNECT_GRACE_MS + 1);
    expect(sent!.aborted).toBe(true);
    vi.useRealTimers();
    expect((await answer).status).toBe(504);
    await waitOnExecutionContext(ctx);
    const rows = await charges(appId);
    expect(rows.map((row) => row.kind)).toEqual(["estimate"]);
    expect(logged("job_submission_lost")).toBe(true);
  });

  it("answers with its own links when the status retry without logs stalls", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    const huge = { status: "IN_PROGRESS", logs: [{ message: "x".repeat(BODY_READ_LIMIT + 10) }] };
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes("logs=1")
        ? Response.json(huge)
        : new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('{"status":"IN_'));
              },
            }),
            { status: 200 },
          ),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ctx = createExecutionContext();
    const pending = worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/jobs/${jobId}/status?logs=1`, { headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1" } }),
      env,
      ctx,
    );
    await vi.advanceTimersByTimeAsync(JOB_POLL_TIMEOUT_MS + 1);
    vi.useRealTimers();
    const response = await pending;
    expect(response.headers.get("x-agw-status-trimmed")).toBe("stalled");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      request_id: jobId,
      status_url: `${ORIGIN}/v2/apps/${appId}/jobs/${jobId}/status`,
      response_url: `${ORIGIN}/v2/apps/${appId}/jobs/${jobId}`,
      cancel_url: `${ORIGIN}/v2/apps/${appId}/jobs/${jobId}/cancel`,
    });
    await waitOnExecutionContext(ctx);
  });

  it("turns a redirect to this job's result into the gateway's link, and refuses any other redirect", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    falAnswers({
      status: () => new Response(null, { status: 303, headers: { location: "https://queue.fal.run/fal-ai/flux/requests/req-1" } }),
    });
    const moved = await call("GET", `/v2/apps/${appId}/jobs/${jobId}/status`, key);
    expect(moved.response.status).toBe(303);
    expect(moved.response.headers.get("location")).toBe(`${ORIGIN}/v2/apps/${appId}/jobs/${jobId}`);

    falAnswers({ result: () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/x" } }) });
    const refused = await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(refused.response.status).toBe(502);
    expect(refused.response.headers.get("location")).toBeNull();
    expect(logged("job_poll_redirect_refused")).toBe(true);
  });
});


describe("one rule for provider redirects on every job route (review fixes, Astra round 3)", () => {
  it("refuses a status redirect to another host with this job's exact path", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    falAnswers({
      status: () => new Response(null, { status: 303, headers: { location: "https://elsewhere.example.com/fal-ai/flux/requests/req-1" } }),
    });
    const refused = await call("GET", `/v2/apps/${appId}/jobs/${jobId}/status`, key);
    expect(refused.response.status).toBe(502);
    expect(refused.response.headers.get("location")).toBeNull();
    expect(logged("job_poll_redirect_refused")).toBe(true);
  });

  it("never passes a 300 Multiple Choices' Location to the app", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    falAnswers({ result: () => new Response("pick one", { status: 300, headers: { location: "https://elsewhere.example.com/x" } }) });
    const refused = await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(refused.response.status).toBe(502);
    expect(refused.response.headers.get("location")).toBeNull();
    expect(logged("job_poll_redirect_refused")).toBe(true);
  });

  it("refuses a redirected submit: no Location for the app, and nothing charged", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({ submit: () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example.com/submit" } }) });
    const refused = await submit(appId, slug, key);
    expect(refused.response.status).toBe(502);
    expect(refused.response.headers.get("location")).toBeNull();
    expect(logged("job_submit_redirect_refused")).toBe(true);
    const rows = await charges(appId);
    expect(rows.filter((row) => row.kind === "estimate")).toEqual([]);
    expect(rows.every((row) => row.cost_nano === null)).toBe(true);
    expect(await openWork(appId)).toEqual([]);
  });

  it("drops the provider's Location from a refused submit, keeping its status and body", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({
      submit: () =>
        Response.json(
          { detail: "a job with this key already exists" },
          { status: 409, headers: { location: "https://queue.fal.run/fal-ai/flux/requests/existing-1/status" } },
        ),
    });
    const refused = await submit(appId, slug, key);
    expect(refused.response.status).toBe(409);
    expect(refused.response.headers.get("location")).toBeNull();
    expect(refused.json).toEqual({ detail: "a job with this key already exists" });
    expect((await charges(appId)).filter((row) => row.kind === "estimate")).toEqual([]);
  });

  it("never passes an accepted submit's Location on: this job's status becomes the gateway's link, anything else is dropped", async () => {
    const { appId, slug, key } = await setup();
    const accepted = (location: string) => () =>
      Response.json(
        {
          request_id: "req-1",
          status: "IN_QUEUE",
          status_url: "https://queue.fal.run/fal-ai/flux/requests/req-1/status",
          response_url: "https://queue.fal.run/fal-ai/flux/requests/req-1",
        },
        { status: 202, headers: { location } },
      );
    falAnswers({ submit: accepted("https://queue.fal.run/fal-ai/flux/requests/req-1/status") });
    const pointed = await submit(appId, slug, key);
    expect(pointed.response.status).toBe(202);
    const jobId = String(pointed.json!.request_id);
    expect(pointed.response.headers.get("location")).toBe(`${ORIGIN}/v2/apps/${appId}/jobs/${jobId}/status`);

    falAnswers({ submit: accepted("https://elsewhere.example.com/fal-ai/flux/requests/req-1/status") });
    const elsewhere = await submit(appId, slug, key);
    expect(elsewhere.response.status).toBe(202);
    expect(elsewhere.response.headers.get("location")).toBeNull();
  });

  it("never passes a status answer's own Location on to the app", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    falAnswers({
      status: () => Response.json({ status: "IN_PROGRESS" }, { status: 202, headers: { location: "https://elsewhere.example.com/x" } }),
    });
    const polled = await call("GET", `/v2/apps/${appId}/jobs/${jobId}/status`, key);
    expect(polled.response.status).toBe(202);
    expect(polled.response.headers.get("location")).toBeNull();
  });

  it("settles from the result when the app never polls and the status redirects to this job's result", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    falAnswers({
      status: () => new Response(null, { status: 303, headers: { location: "https://queue.fal.run/fal-ai/flux/requests/req-1" } }),
      result: () => Response.json({ images: [{}] }, { headers: { "x-fal-billable-units": "1" } }),
    });
    await runSweep(env, ledger(), { now: Date.now() + 10 * 60_000 });
    const rows = await charges(appId);
    expect(rows.map((row) => row.kind)).toEqual(["estimate", "correction"]);
    // 1 unit: the $0.05 estimate comes down to $0.025.
    expect(rows[1]).toMatchObject({ cost_nano: -25_000_000 });
    expect(await openWork(appId)).toEqual([]);
  });
});

describe("cancels, unlisted and video models (step 6b)", () => {
  // The job list is a management route: its code loads once, here, not inside a test's time.
  beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

  /** Submits one job for `model` with `body`, and answers its gateway job id. */
  async function submitModel(appId: string, slug: string, key: string, model: string, body: Record<string, unknown>) {
    const { response, json } = await call("POST", `/v2/apps/${appId}/proxy/${slug}/queue/${model}`, key, { body: JSON.stringify(body) });
    return { response, jobId: json === null ? null : String(json.request_id) };
  }

  const total = async (appId: string) => (await charges(appId)).reduce((sum, row) => sum + Number(row.cost_nano ?? 0), 0);

  /** fal's answer for a job cancelled while queued (T15's `54_cq_result`). */
  const cancelledResult = () =>
    Response.json({ detail: "Request cancelled by the client." }, { status: 499, headers: { "x-fal-error-type": "client_cancelled" } });

  it("cancels through the gateway, free, and settles a job cancelled while queued to zero", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a cat", num_images: 2 });
    expect(await total(appId)).toBe(50_000_000);
    fetchSpy.mockClear();
    const { response, json } = await call("PUT", `/v2/apps/${appId}/jobs/${jobId}/cancel`, key);
    expect(response.status).toBe(202);
    expect(json).toEqual({ status: "CANCELLATION_REQUESTED" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The cancel is only forwarded: one call, and nothing written.
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual(["https://queue.fal.run/fal-ai/flux/requests/req-1/cancel"]);
    expect(fetchSpy.mock.calls[0]![1]?.method).toBe("PUT");
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
    expect((await openWork(appId)).filter((row) => String(row.id).includes("cancel"))).toEqual([]);
    // fal confirms it: status COMPLETED, then the result's 499 with client_cancelled.
    falAnswers({ status: () => Response.json({ status: "COMPLETED", error_type: "client_cancelled" }), result: cancelledResult });
    await onlyThisApp(appId);
    await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000, batch: SWEEP_EVERY_DUE_ROW });
    expect(await total(appId)).toBe(0);
    expect(await openWork(appId)).toEqual([]);
  });

  it("settles a confirmed cancel from fal's units when fal reports them", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a cat", num_images: 2 });
    await call("PUT", `/v2/apps/${appId}/jobs/${jobId}/cancel`, key);
    // A 499 that still reports 3 billed units: the units win, at $0.025 each.
    falAnswers({
      result: () =>
        Response.json({ detail: "cancelled" }, { status: 499, headers: { "x-fal-error-type": "client_cancelled", "x-fal-billable-units": "3" } }),
    });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(75_000_000);
  });

  it("settles a job cancelled at fal directly to zero, read by the sweep alone", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a cat", num_images: 2 });
    expect(await total(appId)).toBe(50_000_000);
    // The gateway never saw the cancel: fal's 499 with client_cancelled and no units is its final word.
    falAnswers({ status: () => Response.json({ status: "COMPLETED", error_type: "client_cancelled" }), result: cancelledResult });
    await onlyThisApp(appId);
    await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000, batch: SWEEP_EVERY_DUE_ROW });
    expect(await total(appId)).toBe(0);
    expect(await openWork(appId)).toEqual([]);
  });

  it("charges a running job that finishes despite its cancel in full, from fal's units (T15)", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a cat", num_images: 2 });
    await call("PUT", `/v2/apps/${appId}/jobs/${jobId}/cancel`, key);
    falAnswers({ result: () => Response.json({ images: [{}, {}] }, { headers: { "x-fal-billable-units": "4" } }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(100_000_000);
  });

  it("does not read a 499 without fal's client_cancelled header as a free cancel", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a cat", num_images: 2 });
    falAnswers({ result: () => Response.json({ detail: "closed" }, { status: 499 }) });
    await onlyThisApp(appId);
    await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000, batch: SWEEP_EVERY_DUE_ROW });
    expect((await openWork(appId)).map((row) => row.tries)).toEqual([1]);
    expect(await total(appId)).toBe(50_000_000);
  });

  it("answers another user's cancel as an unknown job, and asks fal nothing", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a cat" });
    fetchSpy.mockClear();
    const { response } = await call("PUT", `/v2/apps/${appId}/jobs/${jobId}/cancel`, key, { user: "user-2" });
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the four failure cases on a cancel: a lost provider answer, a repeat, a restart before delivery, a duplicate completion", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a cat", num_images: 2 });
    // A lost provider answer: a provider error, and no charge.
    fetchSpy.mockRejectedValueOnce(new TypeError("network"));
    expect((await call("PUT", `/v2/apps/${appId}/jobs/${jobId}/cancel`, key)).response.status).toBe(502);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate"]);
    // Sent again while the job is still queued: fal takes it.
    falAnswers({});
    expect((await call("PUT", `/v2/apps/${appId}/jobs/${jobId}/cancel`, key)).response.status).toBe(202);
    // A repeat after the job finished: fal's own answer, passed on.
    falAnswers({ cancel: () => Response.json({ detail: "ALREADY_COMPLETED" }, { status: 400 }) });
    expect((await call("PUT", `/v2/apps/${appId}/jobs/${jobId}/cancel`, key)).response.status).toBe(400);
    // A restart before delivery, then a duplicate completion: polls and the sweep settle the zero once.
    falAnswers({ result: cancelledResult });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    await onlyThisApp(appId);
    await runSweep(env, ledger(), { now: Date.now() + 5 * 60_000, batch: SWEEP_EVERY_DUE_ROW });
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate", "correction"]);
    expect(await total(appId)).toBe(0);
  });

  it("serves a model off the price list at the customer's flat price per job", async () => {
    const { appId, slug, key } = await setup({ "fal-ai/some-model": { per_request: 20_000_000 } });
    falAnswers({});
    const { response, jobId } = await submitModel(appId, slug, key, "fal-ai/some-model", { prompt: "x" });
    expect(response.status).toBe(200);
    expect(await total(appId)).toBe(20_000_000);
    // A success is one job: the estimate was right.
    falAnswers({ result: () => Response.json({ images: [{}] }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(20_000_000);
    expect(await openWork(appId)).toEqual([]);
  });

  it("refunds a flat-priced job only when fal reports 0 billed units", async () => {
    const { appId, slug, key } = await setup({ "fal-ai/some-model": { per_request: 20_000_000 } });
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/some-model", { prompt: "x" });
    falAnswers({ result: () => Response.json({ detail: "bad input" }, { status: 422, headers: { "x-fal-billable-units": "0" } }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(0);
  });

  it("serves a model off the price list at the customer's rate per reported unit", async () => {
    const { appId, slug, key } = await setup({ "fal-ai/some-model": { per_unit: 10_000_000 } });
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/some-model", { prompt: "x" });
    expect(await total(appId)).toBe(10_000_000);
    falAnswers({ result: () => Response.json({ images: [{}] }, { headers: { "x-fal-billable-units": "3" } }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(30_000_000);
  });

  it("refuses to save a job model priced with two unit rates, and leaves a stored one alone", () => {
    // Fable round 1: a job settles from the one rate its estimate stored, so per unit plus per job could settle on the wrong one.
    const two = ratesFromPricing({ "fal-ai/some-model": { per_unit: 0.01, per_request: 0.02 } } as Parameters<typeof ratesFromPricing>[0], "fal", fal.operations);
    expect(() => assertModesSelectable(fal, null, two, null)).toThrow(/a job model takes one rate/);
    expect(() => assertModesSelectable(fal, null, two, two)).not.toThrow();
    const one = ratesFromPricing({ "fal-ai/some-model": { per_unit: 0.01 } } as Parameters<typeof ratesFromPricing>[0], "fal", fal.operations);
    expect(() => assertModesSelectable(fal, null, one, null)).not.toThrow();
  });

  it("refuses a model with no price at all, and asks fal nothing", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    fetchSpy.mockClear();
    const { response } = await submitModel(appId, slug, key, "fal-ai/not-priced", { prompt: "x" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await charges(appId)).toEqual([]);
  });

  it("estimates a video priced per second from its frames over its frame rate, and settles from fal's units", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    // T15: 65 frames at 24 fps is 2.708 s at $0.02.
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/ltxv-13b-098-distilled", { prompt: "x", num_frames: 65, frame_rate: 24 });
    expect(await total(appId)).toBe(54_180_000);
    falAnswers({ result: () => Response.json({ video: { url: "https://fal.media/v.mp4" } }, { headers: { "x-fal-billable-units": "2.7083333333333335" } }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(54_180_000);
  });

  it("keeps an image model's megapixel estimate when its request also names video fields", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    // fal-ai/flux/dev is $0.025 per megapixel: two 1440 × 1440 images are 2 × 2 units, so $0.10.
    await submitModel(appId, slug, key, "fal-ai/flux/dev", {
      prompt: "x",
      num_images: 2,
      image_size: { width: 1440, height: 1440 },
      num_frames: 1,
      frame_rate: 24,
    });
    expect(await total(appId)).toBe(100_000_000);
  });

  it("estimates a video with no frame count as one unit, and corrects it from fal's units", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/ltxv-13b-098-distilled", { prompt: "x" });
    expect(await total(appId)).toBe(20_000_000);
    falAnswers({ result: () => Response.json({ video: {} }, { headers: { "x-fal-billable-units": "5.0416666666666667" } }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(100_840_000);
  });

  it("settles a video model with no units header by counting its video", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    // ltx-video: $0.02 per video, and fal sends no units header for it (T15).
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/ltx-video", { prompt: "x" });
    expect(await total(appId)).toBe(20_000_000);
    falAnswers({ result: () => Response.json({ video: { url: "https://fal.media/v.mp4" } }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(20_000_000);
    expect(await openWork(appId)).toEqual([]);
  });

  it("counts a result's videos for a customer's price per video", async () => {
    const { appId, slug, key } = await setup({ "fal-ai/many-videos": { per_video: 30_000_000 } });
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/many-videos", { prompt: "x" });
    expect(await total(appId)).toBe(30_000_000);
    falAnswers({ result: () => Response.json({ videos: [{}, {}] }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(60_000_000);
  });

  it("keeps a figure's output unit when it is saved for the sweep", async () => {
    const ref: JobRef = { job: `job_${crypto.randomUUID()}`, accountId: ACCOUNT_ID, appId: "app_videos" };
    const facts = { status: 200, units: null, outputs: { videos: 2 } };
    expect(await applyFinalResult(env, ledger(), ref, facts, 1_000)).toBe("done");
    const row = await ledger().prepare("SELECT id, detail_json FROM open_work WHERE owner_id = ?").bind(ref.job).first<{ id: string; detail_json: string }>();
    expect(row!.id).toBe(`job_figure:${ref.job}:200:-:2videos`);
    expect(JSON.parse(row!.detail_json).result).toMatchObject({ outputs: { videos: 2 } });
  });

  it("lists an app's jobs with their estimate, correction, total and state, read-only", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const settled = await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a cat", num_images: 2 });
    falAnswers({ result: () => Response.json({ images: [{}, {}] }, { headers: { "x-fal-billable-units": "4" } }) });
    await call("GET", `/v2/apps/${appId}/jobs/${settled.jobId}`, key);
    falAnswers({});
    await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a dog" });
    const management = await seedManagementKey({ grant: "read" });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/admin/apps/${appId}/jobs`, { headers: { authorization: `Bearer ${management}` } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; jobs: Record<string, unknown>[] };
    expect(body.total).toBe(2);
    const byState = Object.fromEntries(body.jobs.map((job) => [job.state, job]));
    expect(byState.settled).toMatchObject({
      provider_slug: slug,
      operation: "fal.queue",
      model: "fal-ai/flux/dev",
      estimate_nano: 50_000_000,
      correction_nano: 50_000_000,
      total_nano: 100_000_000,
    });
    // Once settled, the label is the settlement row's, not the estimate's.
    const settlement = await ledger().prepare("SELECT measured FROM charge WHERE id = ?").bind(`settle:job:${String(byState.settled!.id)}`).first<{ measured: string }>();
    expect(settlement!.measured).not.toBe("estimated");
    expect(byState.settled!.measured).toBe(settlement!.measured);
    expect(byState.settled!.settled_at).not.toBeNull();
    expect(byState.settled).not.toHaveProperty("next_check_at");
    expect(byState.checking).toMatchObject({ estimate_nano: 25_000_000, correction_nano: null, total_nano: 25_000_000, settled_at: null, measured: "estimated" });
    // A job still being checked says when its next check is due.
    expect(Number.isFinite(Date.parse(String(byState.checking!.next_check_at)))).toBe(true);
  });

  it("lists only the caller's account's jobs when another account's deleted app left rows under the same app id", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a cat" });
    // Another account once owned this app id: its ledger rows stay after the app is deleted.
    const own = await ledger().prepare("SELECT * FROM charge WHERE app_id = ? AND owner_type = 'job' AND kind = 'estimate'").bind(appId).first<Record<string, unknown>>();
    const copy: Record<string, unknown> = { ...own!, id: `other:${String(own!.id)}`, account_id: "acc_other_account", owner_id: "other-job", end_user_id: "someone-else" };
    const columns = Object.keys(copy);
    await ledger().prepare(`INSERT INTO charge (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .bind(...columns.map((column) => copy[column] ?? null))
      .run();
    await ledger().prepare(
      `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, due_at, created_at)
       VALUES ('other:work', 'job_check', 'acc_other_account', ?, 'job', 'other-job', 0, 0)`,
    ).bind(appId).run();
    const management = await seedManagementKey({ grant: "read" });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/admin/apps/${appId}/jobs`, { headers: { authorization: `Bearer ${management}` } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await response.json()) as { total: number; jobs: Record<string, unknown>[] };
    expect(body.total).toBe(1);
    expect(body.jobs.map((job) => job.end_user_id)).not.toContain("someone-else");
    expect(body.jobs.map((job) => job.id)).not.toContain("other-job");
    await ledger().prepare("DELETE FROM open_work WHERE id = 'other:work'").run();
  });

  it("reads fal's confirmed cancel as final, with its units when fal reports them, and nothing else", () => {
    const headers = new Headers({ "x-fal-error-type": "client_cancelled" });
    expect(readResultFacts(SPEC, { status: 499, headers }, null)).toEqual({ status: 499, units: null, outputs: null, cancelled: true });
    const billed = new Headers({ "x-fal-error-type": "client_cancelled", "x-fal-billable-units": "3" });
    expect(readResultFacts(SPEC, { status: 499, headers: billed }, null)).toEqual({ status: 499, units: 3, outputs: null, cancelled: true });
    // A units header that is there but cannot be read is not a free cancel: the estimate stays.
    const garbled = new Headers({ "x-fal-error-type": "client_cancelled", "x-fal-billable-units": "4, 4" });
    expect(readResultFacts(SPEC, { status: 499, headers: garbled }, null)).toEqual({ status: 499, units: null, outputs: null });
    expect(readResultFacts(SPEC, { status: 499, headers: new Headers() }, null)).toBeNull();
  });

  it("keeps the estimate when a confirmed cancel's units header cannot be read, and logs the raw value", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/flux/dev", { prompt: "a cat" });
    const before = await total(appId);
    const warn = vi.spyOn(console, "warn");
    falAnswers({
      status: () => new Response(JSON.stringify({ detail: "cancelled" }), { status: 499, headers: { "x-fal-error-type": "client_cancelled", "x-fal-billable-units": "4, 4" } }),
      result: () => new Response(JSON.stringify({ detail: "cancelled" }), { status: 499, headers: { "x-fal-error-type": "client_cancelled", "x-fal-billable-units": "4, 4" } }),
    });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(before);
    expect(warn.mock.calls.some((args) => String(args[0]).includes("job_units_unreadable") && String(args[0]).includes("4, 4"))).toBe(true);
    warn.mockRestore();
  });

  it("settles a cancel fal billed at a flat price per job as one job", async () => {
    const { appId, slug, key } = await setup({ "fal-ai/some-model": { per_request: 20_000_000 } });
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/some-model", { prompt: "x" });
    falAnswers({
      result: () => new Response(JSON.stringify({ detail: "cancelled" }), { status: 499, headers: { "x-fal-error-type": "client_cancelled", "x-fal-billable-units": "4" } }),
    });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    const rows = await charges(appId);
    expect(rows.map((row) => row.kind)).toEqual(["estimate", "correction"]);
    expect(await total(appId)).toBe(20_000_000);
  });

  it("settles a failure fal billed at a flat price per job as one job", async () => {
    const { appId, slug, key } = await setup({ "fal-ai/some-model": { per_request: 20_000_000 } });
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/some-model", { prompt: "x" });
    falAnswers({
      result: () => new Response(JSON.stringify({ detail: "bad input" }), { status: 422, headers: { "x-fal-billable-units": "3" } }),
    });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    const rows = await charges(appId);
    expect(rows.map((row) => row.kind)).toEqual(["estimate", "correction"]);
    expect(await total(appId)).toBe(20_000_000);
  });

  it("counts a result's outputs by unit, so a price per video bills its videos beside an empty image list", async () => {
    const { appId, slug, key } = await setup({ "fal-ai/some-model": { per_video: 30_000_000 } });
    falAnswers({});
    const { jobId } = await submitModel(appId, slug, key, "fal-ai/some-model", { prompt: "x" });
    expect(await total(appId)).toBe(30_000_000);
    falAnswers({ result: () => Response.json({ images: [], videos: [{}, {}] }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    expect(await total(appId)).toBe(60_000_000);
  });
});
