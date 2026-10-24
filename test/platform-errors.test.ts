import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { DrizzleQueryError } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contained } from "../src/core/background";
import { errorFacts, refusalFacts } from "../src/core/error-facts";
import { GatewayError, type GatewayErrorReason } from "../src/core/errors";
import { platformFailure } from "../src/core/platform-errors";
import app from "../src/index";
import { CLIENT_CALL_DEADLINE_MS } from "../src/middleware/deadline";
import { TEST_AUDIENCE, TEST_ISSUER, clearIsolateCaches, seedServerApp } from "./helpers";

interface Line {
  level: string;
  message: string;
  [field: string]: unknown;
}

/** The structured lines written at warn and error, in order. */
function captureLogs(): Line[] {
  const lines: Line[] = [];
  const collect = (value: unknown) => {
    if (typeof value !== "string") return;
    try {
      lines.push(JSON.parse(value) as Line);
    } catch {
      // Not one of ours.
    }
  };
  vi.spyOn(console, "warn").mockImplementation(collect);
  vi.spyOn(console, "error").mockImplementation(collect);
  return lines;
}

/**
 * A fetch that hangs until released: the issuer's key fetch stands in for
 * whatever hangs, being the first outbound call the exchange makes.
 */
function hungFetch(): { reached: Promise<void>; release: (response: Response) => void } {
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let release!: (response: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    arrived();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  return { reached, release: (response) => release(response) };
}

/** Runs the deadline out on a request already waiting on `reached`, and returns its answer. */
async function pastDeadline(pending: Response | Promise<Response>, reached: Promise<void>): Promise<Response> {
  await reached;
  await vi.advanceTimersByTimeAsync(CLIENT_CALL_DEADLINE_MS);
  const response = await pending;
  vi.useRealTimers();
  return response;
}

async function pendingSince(appId: string, userId: string): Promise<string | null> {
  const row = await env.DB
    .prepare("SELECT claim_pending_since FROM app_user WHERE app_id = ? AND id = ?")
    .bind(appId, userId)
    .first<{ claim_pending_since: string | null }>();
  return row?.claim_pending_since ?? null;
}

/** An error shaped like the ones a Durable Object stub throws. */
function stubError(message: string, flags: { retryable?: boolean; overloaded?: boolean }): Error {
  return Object.assign(new Error(message), flags);
}

async function outcomesFor(appId: string): Promise<{ outcome: string; reason: string | null }[]> {
  const rows = await env.DB
    .prepare("SELECT outcome, reason FROM app_auth_event WHERE app_id = ? ORDER BY id")
    .bind(appId)
    .all<{ outcome: string; reason: string | null }>();
  return rows.results;
}

/**
 * A D1 binding that loses its connection on every read of `app_api_key`, the
 * way D1 reports a lost connection, and behaves normally for everything else.
 */
function apiKeyReadsLost(): D1Database {
  const lost = () => Promise.reject(new Error("D1_ERROR: Network connection lost."));
  const statement = { bind: () => statement, all: lost, raw: lost, first: lost, run: lost };
  return {
    prepare: (query: string) => (query.includes('"app_api_key"') ? statement : env.DB.prepare(query)),
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as unknown as D1Database;
}

async function signingFixture(
  kid: string,
): Promise<{ publicJwk: JWK; token: (claims?: Record<string, unknown>) => Promise<string> }> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  return {
    publicJwk,
    token: (claims = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject("platform-user")
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(pair.privateKey),
  };
}

function tokenRequest(appId: string, body: Record<string, unknown>): Request {
  return new Request(`https://example.test/v1/apps/${appId}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  clearIsolateCaches();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("platform failure classification", () => {
  it("trusts the flags a Durable Object stub sets", () => {
    expect(platformFailure(stubError("Network connection lost.", { retryable: true }))).toBe("platform_unavailable");
    expect(platformFailure(stubError("Durable Object is overloaded.", { overloaded: true }))).toBe("platform_overloaded");
  });

  it("recognises D1's documented transient and overload messages", () => {
    expect(platformFailure(new Error("D1_ERROR: Network connection lost."))).toBe("platform_unavailable");
    expect(platformFailure(new Error("D1_ERROR: Replica disconnected from primary."))).toBe("platform_unavailable");
    expect(platformFailure(new Error("D1_ERROR: D1 DB is overloaded. Too many requests queued.")))
      .toBe("platform_overloaded");
  });

  it("recognises the runtime's own failures, with or without a flag", () => {
    expect(platformFailure(new Error("Network connection lost."))).toBe("platform_unavailable");
    expect(platformFailure(new Error("internal error; reference = c26r4312qjkuaef6181kt8en")))
      .toBe("platform_unavailable");
  });

  it("looks through Drizzle's wrapper to the D1 error it holds", () => {
    const wrapped = new DrizzleQueryError(
      "select 1",
      [],
      new Error("D1_ERROR: Network connection lost."),
    );
    expect(platformFailure(wrapped)).toBe("platform_unavailable");
  });

  it("leaves the gateway's own faults, and the query's own cost, as internal errors", () => {
    expect(platformFailure(new SyntaxError("Unexpected token"))).toBeNull();
    expect(platformFailure(new Error("D1_ERROR: D1 DB exceeded its CPU time limit and was reset."))).toBeNull();
    expect(platformFailure(new Error("D1_ERROR: no such column: nope"))).toBeNull();
    expect(platformFailure(stubError("thrown by the object", { retryable: false }))).toBeNull();
    expect(platformFailure("Network connection lost.")).toBeNull();
  });
});

describe("error facts", () => {
  const SECRET = "sk-planted-credential-0123456789";

  /** An error of every shape, with the secret in every text-bearing slot it has. */
  function planted(): unknown[] {
    const named = new Error(SECRET);
    named.name = SECRET;
    const coded = Object.assign(new Error(SECRET), { code: SECRET, retryable: SECRET, remote: SECRET });
    const custom = new (class extends Error {
      override name = SECRET;
    })(SECRET);
    const gateway = new GatewayError(400, "invalid_request", SECRET, { "x-planted": SECRET }, {
      // Typed as a closed set; cast here to prove the log re-checks it at runtime.
      reason: SECRET as GatewayErrorReason,
      userId: SECRET,
      data: { planted: SECRET },
      cause: new Error(SECRET),
    });
    return [
      named,
      coded,
      custom,
      gateway,
      new DrizzleQueryError(`select '${SECRET}'`, [SECRET, `label\n    at ${SECRET}`], new Error(`D1_ERROR: ${SECRET}`)),
      new Error(`D1_TYPE_ERROR: Type 'object' not supported for value '${SECRET}'`),
      new Error(`internal error; reference = ${SECRET}`),
      new SyntaxError(`Unexpected token, "${SECRET}" is not valid JSON`),
      new DOMException(SECRET, SECRET),
      new DOMException(SECRET, "TimeoutError"),
      new AggregateError([new Error(SECRET)], SECRET),
      new Error(SECRET, { cause: new Error(SECRET, { cause: SECRET }) }),
      SECRET,
      { message: SECRET, stack: SECRET },
      null,
    ];
  }

  it("copies nothing an error carries, whatever slot it is in", () => {
    for (const error of planted()) {
      expect(JSON.stringify(errorFacts(error))).not.toContain(SECRET);
    }
  });

  it("never throws, whatever reading the error does", () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "cause", { get: () => { throw new Error(SECRET); } });
    const trap = new Proxy(new Error("x"), {
      getPrototypeOf: () => { throw new Error(SECRET); },
      get: () => { throw new Error(SECRET); },
    });
    for (const error of [hostile, trap]) {
      expect(() => errorFacts(error)).not.toThrow();
      expect(JSON.stringify(errorFacts(error))).not.toContain(SECRET);
      expect(() => platformFailure(error)).not.toThrow();
    }
    expect(errorFacts(hostile)).toEqual({ class: "unreadable" });
  });

  it("contains a failed background task, logging it as facts", async () => {
    const logs = captureLogs();
    await expect(contained("maintenance", Promise.reject(new Error(SECRET)))).resolves.toBeUndefined();
    expect(logs).toEqual([
      expect.objectContaining({ message: "background_task_failed", task: "maintenance", error: { class: "Error" } }),
    ]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("logs a refusal by its code and reason only, each checked against its list", () => {
    const forged = new GatewayError(400, SECRET as "invalid_request", SECRET, undefined, {
      reason: SECRET as GatewayErrorReason,
    });
    expect(refusalFacts(forged)).toEqual({});
    expect(refusalFacts(new GatewayError(403, "issuer_token_rejected", SECRET, undefined, { reason: "bad_signature" })))
      .toEqual({ code: "issuer_token_rejected", reason: "bad_signature" });
  });

  it("says only what the gateway itself spells", () => {
    expect(errorFacts(new DrizzleQueryError(
      "select 1",
      [SECRET],
      Object.assign(new Error("Network connection lost."), { retryable: true, remote: false }),
    ))).toEqual({
      class: "DrizzleQueryError",
      // Recognised by the Durable Object flag, so no message is named.
      cause: { class: "Error", platform: "platform_unavailable", retryable: true, remote: false },
    });
    expect(errorFacts(new Error("internal error; reference = c26r4312qjkuaef6181kt8en"))).toEqual({
      class: "Error",
      platform: "platform_unavailable",
      platformMessage: "internal error",
    });
    expect(errorFacts(new DOMException("timed out", "TimeoutError"))).toEqual({
      class: "DOMException",
      domException: "TimeoutError",
    });
    expect(errorFacts(new GatewayError(503, "issuer_verification_unavailable", SECRET))).toEqual({
      class: "GatewayError",
      code: "issuer_verification_unavailable",
    });
    expect(errorFacts(new (class Unlisted extends Error {})("x"))).toEqual({ class: "other" });
    expect(errorFacts(SECRET)).toEqual({ class: "not_an_error" });
  });
});

describe("platform failures on a client call", () => {
  it("answers a lost database as a retryable 503, and records it as one", async () => {
    const fixture = await signingFixture("platform-lost");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("platform-lost", { issuer: {} });
    const logs = captureLogs();

    const ctx = createExecutionContext();
    const response = await app.fetch(
      tokenRequest("platform-lost", { api_key: key, issuer_token: await fixture.token() }),
      { ...env, DB: apiKeyReadsLost() },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "service_unavailable" } });
    const line = logs.find((entry) => entry.message === "gateway_error");
    expect(line).toMatchObject({
      code: "service_unavailable",
      reason: "platform_unavailable",
      status: 503,
      app: "platform-lost",
      cause: {
        class: "DrizzleQueryError",
        cause: { class: "Error", platform: "platform_unavailable", platformMessage: "Network connection lost." },
      },
    });
    expect(logs.some((entry) => entry.message === "unhandled_error")).toBe(false);
    expect(await outcomesFor("platform-lost")).toEqual([
      { outcome: "service_unavailable", reason: "platform_unavailable" },
    ]);
  });

  it("gives up on a call that hangs past its deadline, and records it once", async () => {
    const fixture = await signingFixture("platform-hang");
    const key = await seedServerApp("platform-hang", { issuer: {} });
    const token = await fixture.token();
    const hung = hungFetch();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const logs = captureLogs();

    const ctx = createExecutionContext();
    const response = await pastDeadline(
      app.fetch(tokenRequest("platform-hang", { api_key: key, issuer_token: token }), env, ctx),
      hung.reached,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "service_unavailable" } });

    // The abandoned exchange fails afterwards: logged as what hung, not as a
    // second refusal, and not recorded as a second attempt.
    hung.release(new Response("unavailable", { status: 500 }));
    await vi.waitFor(() => {
      expect(logs.some((entry) => entry.message === "abandoned_call_failed")).toBe(true);
    });
    await waitOnExecutionContext(ctx);
    expect(logs.filter((entry) => entry.message === "gateway_error")).toEqual([
      expect.objectContaining({ code: "service_unavailable", reason: "deadline_exceeded" }),
    ]);
    expect(logs.find((entry) => entry.message === "abandoned_call_failed")).toMatchObject({
      app: "platform-hang",
      error: { class: "GatewayError", code: "issuer_verification_unavailable" },
    });
    expect(await outcomesFor("platform-hang")).toEqual([
      { outcome: "service_unavailable", reason: "deadline_exceeded" },
    ]);
  });

  it("records and does not start an attempt that the steps before it ran past the deadline", async () => {
    const fixture = await signingFixture("platform-late-start");
    const issuerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("platform-late-start", { issuer: {} });
    const token = await fixture.token();
    // The endpoint rate limiter, which runs before the attempt, is what hangs.
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let admit!: () => void;
    const limiter = {
      getByName: () => ({
        check: () => {
          arrived();
          return new Promise((resolve) => {
            admit = () => resolve({ allowed: true, retryAfterSeconds: 0 });
          });
        },
      }),
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const ctx = createExecutionContext();
    const response = await pastDeadline(
      app.fetch(
        tokenRequest("platform-late-start", { api_key: key, issuer_token: token }),
        { ...env, ENDPOINT_RATE_LIMITER: limiter } as unknown as Env,
        ctx,
      ),
      reached,
    );
    expect(response.status).toBe(503);

    admit();
    await vi.waitFor(async () => {
      expect(await outcomesFor("platform-late-start")).toEqual([
        { outcome: "service_unavailable", reason: "deadline_exceeded" },
      ]);
    });
    await waitOnExecutionContext(ctx);
    // Never started: the issuer token was not even verified.
    expect(issuerFetch).not.toHaveBeenCalled();
  });

  it("leaves the claim window alone when an abandoned attempt is refused for a missing claim", async () => {
    const fixture = await signingFixture("platform-claims");
    const key = await seedServerApp("platform-claims", {
      issuer: { required_claims: [{ path: "entitlements", contains: "pro" }] },
    });
    const token = await fixture.token();
    const hung = hungFetch();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const logs = captureLogs();

    const ctx = createExecutionContext();
    const response = await pastDeadline(
      app.fetch(tokenRequest("platform-claims", { api_key: key, issuer_token: token }), env, ctx),
      hung.reached,
    );
    expect(response.status).toBe(503);

    // The keys arrive late and the token verifies without the claim. A retry
    // may have closed the window by now, so the abandoned refusal must not
    // open it.
    hung.release(Response.json({ keys: [fixture.publicJwk] }));
    await vi.waitFor(() => {
      expect(logs.find((entry) => entry.message === "abandoned_call_failed")).toMatchObject({
        error: { class: "GatewayError", code: "issuer_claims_missing" },
      });
    });
    await waitOnExecutionContext(ctx);
    expect(await pendingSince("platform-claims", "platform-user")).toBeNull();
    expect(await outcomesFor("platform-claims")).toEqual([
      { outcome: "service_unavailable", reason: "deadline_exceeded" },
    ]);
  });
});
