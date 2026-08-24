import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, isForbidden, isPaymentRequired, isUnauthorized, query } from "./api";

function mockFetch(response: { status?: number; body?: string }) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(response.body ?? "", { status: response.status ?? 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request headers", () => {
  it("sends the console CSRF header and cookies on every admin call", async () => {
    const fetchMock = mockFetch({ body: JSON.stringify({ ok: true }) });
    await api.get("/v1/admin/apps");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init.headers).get("x-console-request")).toBe("1");
    expect(init.credentials).toBe("same-origin");
  });

  it("sets a JSON content type only when there is a body", async () => {
    const fetchMock = mockFetch({ body: "{}" });
    await api.post("/v1/admin/keys", { name: "CI" });
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("content-type"))
      .toBe("application/json");

    vi.unstubAllGlobals();
    const bodyless = mockFetch({ body: "{}" });
    await api.post("/v1/admin/keys/abc/revoke");
    expect(new Headers(bodyless.mock.calls[0]![1].headers).get("content-type")).toBeNull();
  });
});

describe("error normalization", () => {
  it("unwraps the gateway's nested error envelope", async () => {
    mockFetch({
      status: 403,
      body: JSON.stringify({ error: { code: "forbidden", message: "Members cannot mutate" } }),
    });

    const error = await api.get("/v1/admin/apps").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", message: "Members cannot mutate" });
  });

  it("unwraps Better Auth's flat error body", async () => {
    mockFetch({
      status: 401,
      body: JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }),
    });

    const error = await api.post("/v1/auth/sign-in/email", {}).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" });
  });

  it("does not turn a non-JSON error page into a SyntaxError", async () => {
    mockFetch({ status: 502, body: "<html>Bad gateway</html>" });

    const error = await api.get("/v1/admin/apps").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: "unknown" });
  });

  it("classifies the statuses the console reacts to globally", () => {
    expect(isUnauthorized(new ApiError(401, "auth_required", ""))).toBe(true);
    expect(isForbidden(new ApiError(403, "forbidden", ""))).toBe(true);
    expect(isPaymentRequired(new ApiError(402, "payment_required", ""))).toBe(true);
    expect(isUnauthorized(new ApiError(403, "forbidden", ""))).toBe(false);
    expect(isPaymentRequired(new Error("boom"))).toBe(false);
  });
});

describe("query", () => {
  it("omits empty values and encodes the rest", () => {
    expect(query({ month: "2026-08", status: undefined, q: "", limit: 50 }))
      .toBe("?month=2026-08&limit=50");
    expect(query({})).toBe("");
  });
});
