/**
 * The job lifecycle on fal's queue (plan D9, step 6a): submit, the estimate,
 * free polls, settlement from the final figure, the sweep, and the four
 * failure cases every lifecycle gets.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { readJobId, signJobId, userDigest, type JobClaimsInput } from "../src/jobs/job-id.ts";
import { applyFinalResult, boundedJson, checkJob, countNeedsBody, FIGURE_D1_DEADLINE_MS, figureWork, jobCheckId, jobEstimate, jobFinalFigure, jobResultFacts, OUTPUTS_READ_LIMIT, providerRequestId, settleFigure, type JobRef } from "../src/jobs/jobs.ts";
import { recordLedgerEntry, writeOpenWork } from "../src/ledger/write.ts";
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
    route: "r0",
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
    expect(logged("job_units_missing")).toBe(true);
    // A poll only settles or saves a figure; its check is ended by the sweep, which finds the same.
    expect((await openWork(appId)).map((row) => row.id)).toEqual([expect.stringMatching(/^job:/)]);
    await env.DB.prepare("DELETE FROM open_work WHERE app_id != ?").bind(appId).run();
    await runSweep(env, { now: Date.now() + 5 * 60_000 });
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

  it("the settlement barrier: a figure read before the estimate is in the ledger settles nothing, and settles later", async () => {
    const { appId } = await setup();
    const job = `job_${crypto.randomUUID()}`;
    const ref: JobRef = { job, accountId: ACCOUNT_ID, appId };
    const facts = { status: 200, units: 3, outputs: 0 };
    expect(await settleFigure(env, ref, facts, 3_000)).toBe("waiting");
    await writeToLedger(env.DB, [jobEstimate(attempt(appId, job), QUEUE, { status: "ok", httpStatus: 200, latencyMs: 1, signedId: null, now: 2_000 })]);
    expect(await settleFigure(env, ref, facts, 3_000)).toBe("settled");
    expect((await charges(appId)).map((row) => row.cost_nano)).toEqual([50_000_000, 25_000_000]);
  });

  it("a duplicate completion: a client poll and the sweep settling at once write one correction", async () => {
    const { appId } = await setup();
    const job = `job_${crypto.randomUUID()}`;
    await writeToLedger(env.DB, [jobEstimate(attempt(appId, job), QUEUE, { status: "ok", httpStatus: 200, latencyMs: 1, signedId: null, now: 2_000 })]);
    const ref: JobRef = { job, accountId: ACCOUNT_ID, appId };
    const facts = { status: 200, units: 4, outputs: 0 };
    expect(await Promise.all([settleFigure(env, ref, facts, 3_000), settleFigure(env, ref, facts, 3_001)])).toEqual(["settled", "settled"]);
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
    await runSweep(env, { now });
    expect((await openWork(appId))[0]).toMatchObject({ tries: 1, due_at: now + 60_000 });
    fetchSpy.mockRejectedValue(new TypeError("connection reset"));
    await runSweep(env, { now: now + 60_000 });
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
    await expect(checkJob(env, item, { now: Date.now(), lastTry: false, signal: AbortSignal.abort() })).rejects.toThrow();
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
    await runSweep(env, { now: Date.now() + 5 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await openWork(appId))[0]).toMatchObject({ tries: 1, last_error: "the job's connection is disabled" });
  });

  it("counts an item whose row is gone by its last try as done, not given up", async () => {
    const { appId } = await setup();
    await onlyThisApp(appId);
    await writeOpenWork(env.DB, [
      { id: "work-gone", kind: "unresolved", accountId: ACCOUNT_ID, appId, ownerType: "call", ownerId: "x", chargeId: null, detail: { maxTries: 1 }, dueAt: 0, createdAt: 0 },
    ]);
    const handlers = {
      unresolved: async () => {
        await env.DB.prepare("DELETE FROM open_work WHERE id = 'work-gone'").run();
        return { done: false as const, reason: "settled elsewhere meanwhile" };
      },
    } as never;
    expect(await runSweep(env, { now: Date.now(), handlers })).toEqual({ done: 1, retried: 0, gaveUp: 0 });
    expect(logged("open_work_gave_up")).toBe(false);
  });
});

/** The test database is shared: the sweep must see only this test's work. */
function onlyThisApp(appId: string) {
  return env.DB.prepare("DELETE FROM open_work WHERE app_id != ?").bind(appId).run();
}

describe("a figure is its own row, written once and never changed (review fixes, round 3)", () => {
  function attemptFor(appId: string, requestId: string): CallAttempt {
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
      requestUsage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true, units: { model_units: 2000 }, estimatedUnits: ["model_units"] as never },
    };
  }

  /** A 2-unit estimate, with a check row when it has a job id. */
  const estimateOf = (appId: string, job: string, jobId: string | null = null) =>
    jobEstimate(attemptFor(appId, job), QUEUE, { status: "ok", httpStatus: 200, latencyMs: 1, signedId: jobId, now: 2_000 });

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
  const FOUR = { status: 200, units: 4, outputs: 2 };

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
        if (step === "figure") await writeOpenWork(env.DB, [figureWork(ref, FOUR, 3_000)]);
        if (step === "settle") await settleFigure(env, ref, FOUR, 3_000);
      }
      await runSweep(env, { now: Date.now() + 60 * 60_000 });
      expect(await costs(appId), order.join(" → ")).toEqual(SETTLED_AT_4);
      expect(await openWork(appId), order.join(" → ")).toEqual([]);
    }
  });

  it("keeps the estimate when no usable figure ever arrives, and saves nothing for a result with no count", async () => {
    const { appId, job, ref } = await fresh();
    await writeToLedger(env.DB, [estimateOf(appId, job)]);
    expect(await applyFinalResult(env, ref, { status: 200, units: null, outputs: null }, 3_000)).toBe("no_count");
    expect(await openWork(appId)).toEqual([]);
    // A count the estimate's rate cannot use: the estimate stays, and the row is not kept.
    expect(await applyFinalResult(env, ref, { status: 200, units: null, outputs: 2 }, 3_000)).toBe("done");
    await runSweep(env, { now: Date.now() + 60 * 60_000 });
    expect(await costs(appId)).toEqual([["estimate", 50_000_000]]);
    expect(await openWork(appId)).toEqual([]);
  });

  it("a later poll with no units header never replaces a saved figure, before or after the estimate lands", async () => {
    const { appId, job, ref } = await fresh();
    expect(await applyFinalResult(env, ref, FOUR, 3_000)).toBe("done");
    expect(await applyFinalResult(env, ref, { status: 200, units: null, outputs: 2 }, 3_100)).toBe("done");
    await writeToLedger(env.DB, [estimateOf(appId, job)]);
    expect(await applyFinalResult(env, ref, { status: 200, units: null, outputs: 2 }, 3_200)).toBe("done");
    await runSweep(env, { now: Date.now() + 60 * 60_000 });
    expect(await costs(appId)).toEqual(SETTLED_AT_4);
    expect(await openWork(appId)).toEqual([]);
  });

  it("keeps a figure in the failed-write store while D1 is down, and settles it once both are written", async () => {
    const { appId, job, ref } = await fresh();
    const down = { ...env, DB: D1_DOWN } as Env;
    await recordLedgerEntry(down, estimateOf(appId, job));
    expect(await applyFinalResult(down, ref, FOUR, 3_000)).toBe("done");
    expect(logged("job_result_unrecorded")).toBe(false);
    expect(await runDurableObjectAlarm(env.CHARGE_STORE.getByName(appId))).toBe(true);
    fetchSpy.mockClear();
    await runSweep(env, { now: Date.now() + 60 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await costs(appId)).toEqual(SETTLED_AT_4);
  });

  it("keeps the figure when D1 took the estimate but its reply was lost, and the store writes it again", async () => {
    const { appId, job, ref } = await fresh();
    const entry = estimateOf(appId, job);
    await writeToLedger(env.DB, [entry]);
    const store = env.CHARGE_STORE.getByName(appId);
    await store.keep([entry]);
    expect(await applyFinalResult({ ...env, DB: D1_DOWN } as Env, ref, FOUR, 3_000)).toBe("done");
    expect(await runDurableObjectAlarm(store)).toBe(true);
    await runSweep(env, { now: Date.now() + 60 * 60_000 });
    expect(await costs(appId)).toEqual(SETTLED_AT_4);
  });

  it("keeps a job's check while JWT_SECRET cannot verify, and settles a saved figure without it", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    const broken = { ...env, JWT_SECRET: "" } as Env;
    fetchSpy.mockClear();
    await runSweep(broken, { now: Date.now() + 5 * 60_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await openWork(appId))[0]).toMatchObject({ tries: 1, last_error: "JWT_SECRET cannot verify job ids" });

    const job = `job_${crypto.randomUUID()}`;
    const ref: JobRef = { job, accountId: ACCOUNT_ID, appId };
    expect(await applyFinalResult(env, ref, FOUR, 3_000)).toBe("done");
    await writeToLedger(env.DB, [estimateOf(appId, job)]);
    await runSweep(broken, { now: Date.now() + 60 * 60_000 });
    const rows = await env.DB.prepare("SELECT kind, cost_nano FROM charge WHERE owner_id = ? ORDER BY kind DESC").bind(job).all();
    expect(rows.results.map((row) => [row.kind, row.cost_nano])).toEqual(SETTLED_AT_4);
  });

  it("settles a saved figure after its connection was deleted", async () => {
    const { appId, connectionId } = await setup();
    await onlyThisApp(appId);
    const job = `job_${crypto.randomUUID()}`;
    const ref: JobRef = { job, accountId: ACCOUNT_ID, appId };
    expect(await applyFinalResult(env, ref, FOUR, 3_000)).toBe("done");
    await writeToLedger(env.DB, [estimateOf(appId, job)]);
    await env.DB.prepare("DELETE FROM provider_connection WHERE id = ?").bind(connectionId).run();
    clearCaches();
    await runSweep(env, { now: Date.now() + 60 * 60_000 });
    expect(await costs(appId)).toEqual(SETTLED_AT_4);
  });

  it("asks the provider nothing for a check whose job a figure already settled", async () => {
    const { appId, slug, key } = await setup();
    falAnswers({});
    await submit(appId, slug, key);
    await onlyThisApp(appId);
    const [check] = await openWork(appId);
    const ref: JobRef = { job: String(check!.owner_id), accountId: ACCOUNT_ID, appId };
    expect(await settleFigure(env, ref, FOUR, Date.now())).toBe("settled");
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
      { now: Date.now(), lastTry: false },
    );
    expect(answer).toEqual({ done: true });
    expect(fetchSpy).not.toHaveBeenCalled();
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
      await runSweep(env, { now: Date.now() + 5 * 60_000 });
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
    await runSweep(env, { now: Date.now() + 5 * 60_000 });
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
function slowD1(gate: Promise<void>, stallWrites = false): D1Database {
  const wrap = <T extends object>(target: T, get: (target: T, prop: string | symbol) => unknown): T =>
    new Proxy(target, { get: (t, prop) => get(t, prop) });
  const pass = (t: object, prop: string | symbol) => {
    const value = (t as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
  };
  return wrap(env.DB, (db, prop) => {
    if (prop === "batch" && stallWrites) return () => new Promise(() => undefined);
    if (prop !== "prepare") return pass(db, prop);
    return (sql: string) => {
      const statement = db.prepare(sql);
      if (!sql.includes("kind = 'estimate'")) return statement;
      return wrap(statement, (st, p) =>
        p === "bind"
          ? (...args: unknown[]) =>
              wrap(st.bind(...args), (bound, q) =>
                q === "first" ? async (...more: unknown[]) => (await gate, (bound.first as (...a: unknown[]) => unknown)(...more)) : pass(bound, q),
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = runSweep({ ...env, DB: slowD1(gate) } as Env, { now: Date.now() + 5 * 60_000, itemTimeLimitMs: 1_000, waitUntil: (work) => kept.push(work) });
    // The item's time passes while the estimate read hangs: the run moves on, the settlement does not stop.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await run).toMatchObject({ retried: 1 });
    expect(kept).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(FIGURE_D1_DEADLINE_MS * 2);
    await Promise.all(kept);
    vi.useRealTimers();
    await runSweep(env, { now: Date.now() + 60 * 60_000 });
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
    const applying = applyFinalResult({ ...env, DB: slowD1(new Promise(() => undefined), true) } as Env, ref, { status: 200, units: 4, outputs: 2 }, 3_000);
    await vi.advanceTimersByTimeAsync(FIGURE_D1_DEADLINE_MS); // the settlement read times out
    await vi.advanceTimersByTimeAsync(FIGURE_D1_DEADLINE_MS); // then the D1 figure write
    expect(await applying).toBe("done");
    vi.useRealTimers();
    await runDurableObjectAlarm(env.CHARGE_STORE.getByName(appId));
    expect((await openWork(appId)).map((row) => row.id)).toEqual([`job_figure:${ref.job}:200:4:2`]);
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
    await writeToLedger(env.DB, [entry]);
    const store = env.CHARGE_STORE.getByName(appId);
    await store.keep([entry]);
    expect(await settleFigure(env, ref, { status: 200, units: 4, outputs: 2 }, 3_000)).toBe("settled");
    await runDurableObjectAlarm(store);
    expect(await openWork(appId)).toEqual([]);
    expect((await charges(appId)).map((row) => row.kind)).toEqual(["estimate", "correction"]);
  });

  it("counts outputs only without a units header, and never more than a bounded part of the body", async () => {
    expect(countNeedsBody(SPEC, new Headers({ "x-fal-billable-units": "2" }))).toBe(false);
    expect(countNeedsBody(SPEC, new Headers())).toBe(true);
    expect(await boundedJson(new Response('{"images":[1,2]}'), 64)).toEqual({ images: [1, 2] });
    let cancelled = false;
    const big = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(1024)),
      cancel: () => {
        cancelled = true;
      },
    });
    expect(await boundedJson(new Response(big), 4096)).toBeNull();
    expect(cancelled).toBe(true);

    const { appId, slug, key } = await setup();
    falAnswers({});
    const jobId = String((await submit(appId, slug, key)).json!.request_id);
    // No units header and a body over the limit: nothing is counted, so the estimate stays, and the app gets every byte.
    const huge = JSON.stringify({ images: [{ url: "x".repeat(OUTPUTS_READ_LIMIT + 10) }] });
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

