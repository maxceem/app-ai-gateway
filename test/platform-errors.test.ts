import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { DrizzleQueryError } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contained } from "../src/core/background";
import { errorFacts, type ErrorFacts } from "../src/core/error-facts";
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

/**
 * One console argument as text, the whole of it: an error with its message
 * and stack, so a test asserting on this output also catches a raw
 * `console.error(error)`, not only lines written through `log`.
 */
function rendered(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The structured lines written at warn and error, in order, and as `output`
 * every argument of every console call, rendered whole.
 */
function captureLogs(): Line[] & { output: string[] } {
  const lines: Line[] = [];
  const output: string[] = [];
  const collect = (...values: unknown[]) => {
    output.push(...values.map(rendered));
    if (typeof values[0] !== "string") return;
    try {
      lines.push(JSON.parse(values[0]) as Line);
    } catch {
      // Not one of ours; still in `output`.
    }
  };
  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(collect);
  }
  return Object.assign(lines, { output });
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

/** Error facts without where each error was thrown, for comparing the rest exactly. */
function withoutWhere(facts: ErrorFacts): ErrorFacts {
  const { where: _where, cause, ...rest } = facts;
  return cause === undefined ? rest : { ...rest, cause: withoutWhere(cause) };
}

describe("error facts", () => {
  const SECRET = "sk-planted-credential-0123456789";
  const factsOf = errorFacts;

  /** An error of every shape, with the secret in every text-bearing slot it has. */
  function planted(): unknown[] {
    const named = new Error(SECRET);
    named.name = SECRET;
    const coded = Object.assign(new Error(SECRET), { code: SECRET, retryable: SECRET, remote: SECRET });
    const custom = new (class extends Error {
      override name = SECRET;
    })(SECRET);
    const gateway = new GatewayError(400, "invalid_request", SECRET, { "x-planted": SECRET }, {
      // Cast past its closed type only to plant the secret: errorFacts reads
      // neither a refusal's reason nor its message. The reason a refusal log
      // line does carry is checked in the gateway_error tests.
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
    expect([...logs]).toEqual([
      expect.objectContaining({ message: "background_task_failed", task: "maintenance", error: expect.objectContaining({ class: "Error" }) }),
    ]);
    expect(logs.output.join("\n")).not.toContain(SECRET);
  });

  it("says only what the gateway itself spells", () => {
    const errorFacts = (error: unknown) => withoutWhere(factsOf(error));
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
    expect(errorFacts(new DOMException("timed out", "TimeoutError"))).toEqual({ class: "DOMException" });
    expect(errorFacts(new GatewayError(503, "issuer_verification_unavailable", SECRET))).toEqual({
      class: "GatewayError",
      code: "issuer_verification_unavailable",
    });
    expect(errorFacts(new (class Unlisted extends Error {})("x"))).toEqual({ class: "other" });
    expect(errorFacts(SECRET)).toEqual({ class: "not_an_error" });
  });

  it("says where an error was thrown, from the stack below its message", () => {
    // A message can run over lines that look like frames; none of it is read.
    function throwsHere(): never {
      throw new Error(`${SECRET}\n    at planted (${SECRET}.js:1:1)`);
    }
    let thrown: unknown;
    try {
      throwsHere();
    } catch (error) {
      thrown = error;
    }
    const facts = factsOf(thrown);
    expect(facts.where?.[0]).toMatch(/^throwsHere [^\s]+:\d+:\d+$/u);
    expect(JSON.stringify(facts)).not.toContain(SECRET);
    expect(JSON.stringify(facts)).not.toContain("planted");

    // A name changed after the error was made heads its stack too, since the
    // runtime writes the stack when it is first read: still cut off, never copied.
    const renamed = new Error(SECRET);
    renamed.name = SECRET;
    expect(JSON.stringify(factsOf(renamed))).not.toContain(SECRET);

    // A stack that does not begin with the error's own first line gives no frames at all.
    const rewritten = new Error("x");
    rewritten.stack = `Something else: ${SECRET}\n    at planted (${SECRET}.js:1:1)`;
    expect(factsOf(rewritten).where).toBeUndefined();
  });

  it("copies codes only of the shape libraries and SQLite give them", () => {
    const coded = Object.assign(new Error(`D1_ERROR: database is locked: SQLITE_BUSY near '${SECRET}'`), {
      code: "FAILED_TO_GET_SESSION",
      status: "INTERNAL_SERVER_ERROR",
      body: { code: "AKIAIOSFODNN7EXAMPLE" },
    });
    expect(factsOf(coded).codes).toEqual(["FAILED_TO_GET_SESSION", "INTERNAL_SERVER_ERROR", "D1_ERROR", "SQLITE_BUSY"]);
    // Digits, lower case or no underscore: a key, a token or an identifier, never a code.
    for (const code of ["AKIAIOSFODNN7EXAMPLE", "sk_live_secret", "SECRET", SECRET]) {
      expect(factsOf(Object.assign(new Error("x"), { code })).codes, code).toBeUndefined();
    }
  });

  it("names Better Auth's and better-call's errors, and only by a name on its list", () => {
    class APIError extends Error {
      override name = "APIError";
    }
    class Renamed extends Error {
      override name = SECRET;
    }
    expect(factsOf(new APIError("x")).class).toBe("APIError");
    expect(factsOf(new Renamed("x")).class).toBe("other");
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
    // The failed query names its table and binds the key's hash: neither the
    // query nor the key reaches any console output, however it was written.
    const output = logs.output.join("\n");
    expect(output).not.toContain("app_api_key");
    expect(output).not.toContain(key);
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
