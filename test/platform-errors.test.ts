import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { DrizzleQueryError } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeError, platformFailure } from "../src/core/platform-errors";
import app from "../src/index";
import { CLIENT_CALL_DEADLINE_MS } from "../src/middleware/deadline";
import { TEST_AUDIENCE, TEST_ISSUER, clearIsolateCaches, seedServerApp } from "./helpers";

interface Line {
  level: string;
  message: string;
  [field: string]: unknown;
}

function captureErrors(): Line[] {
  const lines: Line[] = [];
  vi.spyOn(console, "error").mockImplementation((value: unknown) => {
    if (typeof value !== "string") return;
    try {
      lines.push(JSON.parse(value) as Line);
    } catch {
      // Not one of ours.
    }
  });
  return lines;
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

async function signingFixture(kid: string): Promise<{ publicJwk: JWK; token: () => Promise<string> }> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  return {
    publicJwk,
    token: () =>
      new SignJWT({})
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

describe("error descriptions", () => {
  it("names the query that failed without the values bound to it", () => {
    const cause = stubError("Network connection lost.", { retryable: true });
    const wrapped = new DrizzleQueryError(
      'select "id" from "app_api_key" where "key_hash" = ?',
      ["credential-material"],
      cause,
    );

    const description = describeError(wrapped);

    expect(description).toMatchObject({
      name: "DrizzleQueryError",
      message: 'Failed query: select "id" from "app_api_key" where "key_hash" = ?',
      cause: { name: "Error", message: "Network connection lost.", retryable: true },
    });
    expect(description.stack?.every((frame) => frame.startsWith("at "))).toBe(true);
    expect(JSON.stringify(description)).not.toContain("credential-material");
  });
});

describe("platform failures on a client call", () => {
  it("answers a lost database as a retryable 503, and records it as one", async () => {
    const fixture = await signingFixture("platform-lost");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("platform-lost", { issuer: {} });
    const errors = captureErrors();

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
    const line = errors.find((entry) => entry.message === "gateway_error");
    expect(line).toMatchObject({
      code: "service_unavailable",
      reason: "platform_unavailable",
      status: 503,
      app: "platform-lost",
      cause: { name: "DrizzleQueryError", cause: { message: "D1_ERROR: Network connection lost." } },
    });
    expect(errors.some((entry) => entry.message === "unhandled_error")).toBe(false);
    expect(await outcomesFor("platform-lost")).toEqual([
      { outcome: "service_unavailable", reason: "platform_unavailable" },
    ]);
  });

  it("gives up on a call that hangs past its deadline, and records it once", async () => {
    const fixture = await signingFixture("platform-hang");
    const key = await seedServerApp("platform-hang", { issuer: {} });
    const token = await fixture.token();
    let reached!: () => void;
    const hanging = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: (response: Response) => void;
    // The issuer's key fetch stands in for whatever hangs: it is the first
    // outbound call the exchange makes after the deadline is set.
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      reached();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const errors = captureErrors();

    const ctx = createExecutionContext();
    const pending = app.fetch(tokenRequest("platform-hang", { api_key: key, issuer_token: token }), env, ctx);
    await hanging;
    await vi.advanceTimersByTimeAsync(CLIENT_CALL_DEADLINE_MS);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "service_unavailable" } });
    expect(errors.find((entry) => entry.message === "gateway_error")).toMatchObject({
      code: "service_unavailable",
      reason: "deadline_exceeded",
    });

    // The abandoned exchange finishing afterwards must not add a second row.
    // It is done once it has stored the user, a step that follows the key
    // fetch, and its own recording would be in the context's `waitUntil` then.
    vi.useRealTimers();
    release(Response.json({ keys: [fixture.publicJwk] }));
    await vi.waitFor(async () => {
      const user = await env.DB
        .prepare("SELECT id FROM app_user WHERE app_id = ? AND id = ?")
        .bind("platform-hang", "platform-user")
        .first();
      expect(user).not.toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitOnExecutionContext(ctx);
    expect(await outcomesFor("platform-hang")).toEqual([
      { outcome: "service_unavailable", reason: "deadline_exceeded" },
    ]);
  });
});
