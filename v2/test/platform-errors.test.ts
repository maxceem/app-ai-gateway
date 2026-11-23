/**
 * Telling the platform failing (D1, a Durable Object, the runtime) from the
 * gateway's own faults, and what a log line may say about an error.
 *
 * Ported from v1's `platform-errors.test.ts`. v2's `errorFacts` is smaller
 * than v1's (class, gateway code and platform reason only: no stack frames,
 * library codes or causes), so v1's cases for those fields have nothing to
 * test here. Client-call deadlines are in `deadline.test.ts`; serving the last
 * known record through a D1 failure is in `stale-read.test.ts`.
 */
import { DrizzleQueryError } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contained } from "../src/core/background.ts";
import { errorFacts } from "../src/core/error-facts.ts";
import { GatewayError } from "../src/core/errors.ts";
import { asGatewayError, platformFailure, recognisedFailure } from "../src/core/platform-errors.ts";

/** An error shaped like the ones a Durable Object stub throws. */
function stubError(message: string, flags: { retryable?: boolean; overloaded?: boolean }): Error {
  return Object.assign(new Error(message), flags);
}

afterEach(() => vi.restoreAllMocks());

describe("platform failure classification", () => {
  it("trusts the flags a Durable Object stub sets", () => {
    expect(platformFailure(stubError("Network connection lost.", { retryable: true }))).toBe("platform_unavailable");
    expect(platformFailure(stubError("Durable Object is overloaded.", { overloaded: true }))).toBe("platform_overloaded");
  });

  it("recognises D1's documented transient and overload messages", () => {
    expect(platformFailure(new Error("D1_ERROR: Network connection lost."))).toBe("platform_unavailable");
    expect(platformFailure(new Error("D1_ERROR: Replica disconnected from primary."))).toBe("platform_unavailable");
    expect(platformFailure(new Error("D1_ERROR: D1 DB is overloaded. Too many requests queued."))).toBe("platform_overloaded");
  });

  it("recognises the runtime's own failures, with or without a flag", () => {
    expect(platformFailure(new Error("Network connection lost."))).toBe("platform_unavailable");
    expect(platformFailure(new Error("internal error; reference = c26r4312qjkuaef6181kt8en"))).toBe("platform_unavailable");
  });

  it("recognises a Durable Object whose storage was reset while it started, which carries no flag", () => {
    const reset = new Error(
      "Internal error while starting up Durable Object storage caused object to be reset; reference = 8hbc9khnm56v4ik8u5cskmg4",
    );
    expect(platformFailure(reset)).toBe("platform_unavailable");
    expect(recognisedFailure(reset)).toEqual({
      reason: "platform_unavailable",
      message: "Internal error while starting up Durable Object storage caused object to be reset",
    });
  });

  it("looks through Drizzle's wrapper to the D1 error it holds", () => {
    const wrapped = new DrizzleQueryError("select 1", [], new Error("D1_ERROR: Network connection lost."));
    expect(platformFailure(wrapped)).toBe("platform_unavailable");
  });

  it("leaves the gateway's own faults, and the query's own cost, as internal errors", () => {
    expect(platformFailure(new SyntaxError("Unexpected token"))).toBeNull();
    expect(platformFailure(new Error("D1_ERROR: D1 DB exceeded its CPU time limit and was reset."))).toBeNull();
    expect(platformFailure(new Error("D1_ERROR: no such column: nope"))).toBeNull();
    expect(platformFailure(stubError("thrown by the object", { retryable: false }))).toBeNull();
    expect(platformFailure("Network connection lost.")).toBeNull();
  });

  it("answers a platform failure as a retryable 503 and leaves the gateway's own faults alone", () => {
    const refusal = asGatewayError(new Error("D1_ERROR: Network connection lost."));
    expect(refusal).toMatchObject({ status: 503, code: "service_unavailable" });
    expect(refusal?.headers).toMatchObject({ "retry-after": "5" });
    const own = new GatewayError(400, "invalid_request", "bad");
    expect(asGatewayError(own)).toBe(own);
    expect(asGatewayError(new TypeError("x is undefined"))).toBeNull();
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
    return [
      named,
      coded,
      custom,
      new GatewayError(400, "invalid_request", SECRET, { "x-planted": SECRET }),
      new DrizzleQueryError(`select '${SECRET}'`, [SECRET], new Error(`D1_ERROR: ${SECRET}`)),
      new Error(`internal error; reference = ${SECRET}`),
      new SyntaxError(`Unexpected token, "${SECRET}" is not valid JSON`),
      new DOMException(SECRET, SECRET),
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
    const hostileName = new Error("x");
    Object.defineProperty(hostileName, "name", { get: () => { throw new Error(SECRET); } });
    const hostileCause = new Error("x");
    Object.defineProperty(hostileCause, "cause", { get: () => { throw new Error(SECRET); } });
    const trap = new Proxy(new Error("x"), {
      getPrototypeOf: () => { throw new Error(SECRET); },
      get: () => { throw new Error(SECRET); },
    });
    for (const error of [hostileName, hostileCause, trap]) {
      expect(() => errorFacts(error)).not.toThrow();
      expect(JSON.stringify(errorFacts(error))).not.toContain(SECRET);
      expect(() => platformFailure(error)).not.toThrow();
    }
    expect(errorFacts(trap)).toEqual({ class: "unreadable" });
  });

  it("says only what the gateway itself spells", () => {
    expect(errorFacts(new DrizzleQueryError("select 1", [SECRET], stubError("Network connection lost.", { retryable: true }))))
      .toEqual({ class: expect.any(String), platform: "platform_unavailable" });
    expect(errorFacts(new Error("internal error; reference = c26r4312qjkuaef6181kt8en")))
      .toEqual({ class: "Error", platform: "platform_unavailable" });
    expect(errorFacts(new GatewayError(503, "issuer_verification_unavailable", SECRET)))
      .toEqual({ class: "GatewayError", code: "issuer_verification_unavailable" });
    expect(errorFacts(new (class Unlisted extends Error {})("x"))).toEqual({ class: "other" });
    expect(errorFacts(SECRET)).toEqual({ class: "not_an_error" });
  });

  it("contains a failed background task, logging it as facts", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(contained("auth_event", Promise.reject(new Error(SECRET)))).resolves.toBeUndefined();
    const lines = errors.mock.calls.flat().map((line) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toEqual([
      expect.objectContaining({ message: "background_task_failed", task: "auth_event", error: { class: "Error" } }),
    ]);
    expect(errors.mock.calls.flat().join(" ")).not.toContain(SECRET);
  });
});
