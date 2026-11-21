/**
 * The job lifecycle on fal's queue (plan D9, step 6a): submit, the estimate,
 * free polls, settlement from the final figure, the sweep, and the four
 * failure cases every lifecycle gets.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { readJobId, signJobId, userDigest, type JobClaims, type JobClaimsInput } from "../src/jobs/job-id.ts";
import { checkJob, jobCheckId, jobEstimate, jobFinalFigure, jobResultFacts, settleJobFromFacts, settleJobFromResult } from "../src/jobs/jobs.ts";
import { recordLedgerEntry } from "../src/ledger/write.ts";
import { runSweep } from "../src/ledger/sweep.ts";
import { readCharge, writeToLedger, type ChargeRow } from "../src/ledger/write.ts";
import { fal } from "../src/providers/fal.ts";
import type { CallAttempt } from "../src/proxy/call-charge.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";

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
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
  return results;
}

async function openWork(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM open_work WHERE app_id = ? ORDER BY id").bind(appId).all();
  return results;
}

/** fal's answers, by the URL asked for. */
function falAnswers(answers: {
  submit?: () => Response | Promise<Response>;
  status?: () => Response;
  result?: () => Response;
}): void {
  fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
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
    accountId: "acc",
    appId: "app",
    userId: null,
    issuedAt: 1,
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
    // Cancels come in step 6b: no provider link is passed on.
    expect(json).not.toHaveProperty("cancel_url");
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
      status: () =>
        Response.json({ status: "IN_PROGRESS", request_id: "req-1", response_url: "https://queue.fal.run/fal-ai/flux/requests/req-1" }),
    });
    for (let poll = 0; poll < 3; poll += 1) {
      const { response, json } = await call("GET", `/v2/apps/${appId}/jobs/${jobId}/status`, key);
      expect(response.status).toBe(200);
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

  it("settles once however often the result is read: a second poll and the sweep add nothing", async () => {
    const { appId, key, jobId } = await submitted();
    falAnswers({ result: () => Response.json({ images: [{}] }, { headers: { "x-fal-billable-units": "1" } }) });
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    await call("GET", `/v2/apps/${appId}/jobs/${jobId}`, key);
    const claims = (await readJobId(env.JWT_SECRET, jobId))!;
    await env.DB.prepare(
      `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
       VALUES (?, 'job_check', ?, ?, 'job', ?, NULL, ?, 0, 0, 0)`,
    )
      .bind(jobCheckId(claims.job), ACCOUNT_ID, appId, claims.job, JSON.stringify({ providerType: "fal", jobId }))
      .run();
    await runSweep(env, { now: Date.now() + 10 * 60_000 });
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
    expect(await openWork(appId)).toEqual([]);
    expect(logged("job_units_missing")).toBe(true);
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

  it("a lost ledger reply: the estimate written again is skipped, with its check, so nothing counts twice", async () => {
    const { appId } = await setup();
    const entry = jobEstimate(attempt(appId, `job_${crypto.randomUUID()}`), QUEUE, { status: "ok", httpStatus: 200, latencyMs: 1, signedId: "j1.x.y", now: 2_000 });
    await writeToLedger(env.DB, [entry]);
    await writeToLedger(env.DB, [entry]);
    expect(await charges(appId)).toHaveLength(1);
    expect(await openWork(appId)).toHaveLength(1);
  });

  it("a restart before delivery: the app never got its job id, and the sweep still settles the job", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    falAnswers({ result: () => Response.json({ images: [{}, {}] }, { headers: { "x-fal-billable-units": "2" } }) });
    // Not due yet: nothing happens to it.
    await runSweep(env, { now: Date.now() });
    expect(await openWork(appId)).toHaveLength(1);
    await runSweep(env, { now: Date.now() + 5 * 60_000 });
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
    await runSweep(env, { now: Date.now() + 5 * 60_000 });
    const [work] = await openWork(appId);
    expect(work).toMatchObject({ tries: 1, last_error: "job not done (200)" });
    expect(await charges(appId)).toHaveLength(1);
  });

  it("the settlement barrier: a result read before the estimate is in the ledger settles nothing, and settles later", async () => {
    const { appId, connectionId, slug } = await setup();
    const job = `job_${crypto.randomUUID()}`;
    const claims: JobClaims = {
      job,
      connectionId,
      slug,
      operation: "fal.queue",
      model: "fal-ai/flux/dev",
      requestId: "req-1",
      accountId: ACCOUNT_ID,
      appId,
      userDigest: await userDigest("user-1"),
      issuedAt: 1,
    };
    const result = { status: 200, headers: new Headers({ "x-fal-billable-units": "3" }), body: { images: [] } };
    expect(await settleJobFromResult(env, claims, "j1.x.y", SPEC, result, 3_000)).toBe("waiting");
    await writeToLedger(env.DB, [jobEstimate(attempt(appId, job), QUEUE, { status: "ok", httpStatus: 200, latencyMs: 1, signedId: null, now: 2_000 })]);
    expect(await settleJobFromResult(env, claims, "j1.x.y", SPEC, result, 3_000)).toBe("settled");
    expect((await charges(appId)).map((row) => row.cost_nano)).toEqual([50_000_000, 25_000_000]);
  });

  it("a duplicate completion: a client poll and the sweep settling at once write one correction", async () => {
    const { appId, connectionId, slug } = await setup();
    const job = `job_${crypto.randomUUID()}`;
    await writeToLedger(env.DB, [jobEstimate(attempt(appId, job), QUEUE, { status: "ok", httpStatus: 200, latencyMs: 1, signedId: null, now: 2_000 })]);
    const claims: JobClaims = { job, connectionId, slug, operation: "fal.queue", model: "fal-ai/flux/dev", requestId: "r", accountId: ACCOUNT_ID, appId, userDigest: null, issuedAt: 1 };
    const result = { status: 200, headers: new Headers({ "x-fal-billable-units": "4" }), body: {} };
    expect(await Promise.all([settleJobFromResult(env, claims, "j1.x.y", SPEC, result, 3_000), settleJobFromResult(env, claims, "j1.x.y", SPEC, result, 3_001)])).toEqual([
      "settled",
      "settled",
    ]);
    const rows = await charges(appId);
    expect(rows.map((row) => row.kind)).toEqual(["estimate", "correction"]);
    expect(rows[1]).toMatchObject({ cost_nano: 50_000_000 });
  });
});

describe("the final figure", () => {
  const estimate = { rates: { per_unit: 25_000_000 }, unit: "model_units" } as unknown as ChargeRow;

  it("reads fal's fractional units at their stored scale, and gives none for a status that is not final", () => {
    const facts = (status: number, headers: Record<string, string>, body: unknown = {}) => jobResultFacts(SPEC, { status, headers: new Headers(headers), body });
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
    expect(jobFinalFigure(tokens, jobResultFacts(SPEC, { status: 200, headers: new Headers({ "x-fal-billable-units": "1" }), body: {} })!)).toBeNull();
    expect(await readCharge(env.DB, "nothing")).toBeNull();
  });
});

describe("signing, refunds, saved results and the sweep's pace (review fixes)", () => {
  function attemptFor(appId: string, requestId: string, rates: Record<string, number>, units: Record<string, number>): CallAttempt {
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
      price: { price: { rates } as never, source: "list_rate" },
      reportsCost: false,
      requestedMode: { tier: "standard", region: "global" } as never,
      startedAt: 1_000,
      appVersion: null,
      clientTraceId: null,
      requestUsage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true, units, estimatedUnits: Object.keys(units) as never },
    };
  }

  async function signedFor(appId: string, connectionId: string, slug: string, job: string): Promise<{ claims: JobClaims; jobId: string }> {
    const jobId = await signJobId(env.JWT_SECRET, {
      job,
      connectionId,
      slug,
      operation: "fal.queue",
      model: "fal-ai/flux/dev",
      requestId: "req-1",
      accountId: ACCOUNT_ID,
      appId,
      userId: null,
      issuedAt: 1,
    });
    return { claims: (await readJobId(env.JWT_SECRET, jobId))!, jobId };
  }

  /** The test database is shared: the sweep must see only this test's work. */
  async function onlyThisApp(appId: string): Promise<void> {
    await env.DB.prepare("DELETE FROM open_work WHERE app_id != ?").bind(appId).run();
  }

  const D1_DOWN = {
    prepare: () => {
      throw new Error("D1 down");
    },
    batch: () => Promise.reject(new Error("D1 down")),
  } as unknown as D1Database;

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

  it("saves a final result whose estimate is not in the ledger yet, and settles it once from those facts", async () => {
    const { appId, connectionId, slug } = await setup();
    const job = `job_${crypto.randomUUID()}`;
    const { claims, jobId } = await signedFor(appId, connectionId, slug, job);
    const facts = { status: 200, units: 4, outputs: 2 };
    expect(await settleJobFromFacts(env, claims, jobId, SPEC, facts, 3_000)).toBe("waiting");
    // The estimate arrives later, with its own check row, which keeps the saved result.
    const entry = jobEstimate(attemptFor(appId, job, { per_unit: 25_000_000 }, { model_units: 2000 }), QUEUE, {
      status: "ok",
      httpStatus: 200,
      latencyMs: 1,
      signedId: jobId,
      now: 2_000,
    });
    await writeToLedger(env.DB, [entry]);
    await onlyThisApp(appId);
    fetchSpy.mockClear();
    await runSweep(env, { now: Date.now() + 60 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    const rows = await charges(appId);
    // 4 units against the 2-unit estimate: +2 units at $0.025, exactly once.
    expect(rows.map((row) => [row.kind, row.cost_nano])).toEqual([
      ["estimate", 50_000_000],
      ["correction", 50_000_000],
    ]);
    expect(await openWork(appId)).toEqual([]);
  });

  it("keeps a final result with its estimate in the failed-write store while D1 is down, and settles it after both are written", async () => {
    const { appId, connectionId, slug } = await setup();
    const job = `job_${crypto.randomUUID()}`;
    const { claims, jobId } = await signedFor(appId, connectionId, slug, job);
    const entry = jobEstimate(attemptFor(appId, job, { per_unit: 25_000_000 }, { model_units: 2000 }), QUEUE, {
      status: "ok",
      httpStatus: 200,
      latencyMs: 1,
      signedId: jobId,
      now: 2_000,
    });
    await recordLedgerEntry({ ...env, DB: D1_DOWN } as Env, entry);
    const down = { ...env, DB: D1_DOWN } as Env;
    expect(await settleJobFromFacts(down, claims, jobId, SPEC, { status: 200, units: 4, outputs: 2 }, 3_000)).toBe("waiting");
    expect(logged("job_result_unrecorded")).toBe(false);
    const store = env.CHARGE_STORE.getByName(appId);
    expect(await runDurableObjectAlarm(store)).toBe(true);
    await onlyThisApp(appId);
    fetchSpy.mockClear();
    await runSweep(env, { now: Date.now() + 60 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await charges(appId)).map((row) => [row.kind, row.cost_nano])).toEqual([
      ["estimate", 50_000_000],
      ["correction", 50_000_000],
    ]);
  });

  it("checks a job again every minute, as fal's operation says, whether it is not done or the check failed", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    expect(JSON.parse(String((await openWork(appId))[0]!.detail_json))).toMatchObject({ retryEveryMs: 60_000, maxTries: 60 });
    const now = Date.now() + 5 * 60_000;
    falAnswers({ status: () => Response.json({ status: "IN_QUEUE" }) });
    await runSweep(env, { now });
    expect((await openWork(appId))[0]).toMatchObject({ tries: 1, due_at: now + 60_000 });
    fetchSpy.mockRejectedValue(new TypeError("connection reset"));
    await runSweep(env, { now: now + 60_000 });
    expect((await openWork(appId))[0]).toMatchObject({ tries: 2, due_at: now + 120_000 });
  });

  it("starts no result call and settles nothing once the item's time is up", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    const [row] = await openWork(appId);
    falAnswers({ result: () => Response.json({ images: [{}] }, { headers: { "x-fal-billable-units": "1" } }) });
    fetchSpy.mockClear();
    const answer = await checkJob(
      env,
      {
        id: String(row!.id),
        kind: "job_check",
        accountId: ACCOUNT_ID,
        appId,
        ownerType: "job",
        ownerId: String(row!.owner_id),
        chargeId: String(row!.charge_id),
        detail: JSON.parse(String(row!.detail_json)) as Record<string, unknown>,
        dueAt: 0,
        tries: 0,
      },
      { now: Date.now(), lastTry: false, signal: AbortSignal.abort() },
    );
    expect(answer).toEqual({ done: false, reason: "timed out" });
    // Only the status call: no result call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
    await runSweep(env, { now: Date.now() + 5 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await openWork(appId))[0]).toMatchObject({ tries: 1, last_error: "the job's connection is disabled" });
  });
});
