import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { createConsoleQueryClient } from "./query-client";
import { keys } from "./queries";

function setup(path = { pathname: "/apps/my-app", search: "" }) {
  const redirectToLogin = vi.fn();
  const client = createConsoleQueryClient({
    redirectToLogin,
    currentPath: () => path,
  });
  return { client, redirectToLogin };
}

/** Drives a failing query through the cache so the global handler runs. */
async function failQuery(
  client: ReturnType<typeof createConsoleQueryClient>,
  error: unknown,
  queryKey: readonly unknown[] = ["probe"],
) {
  await client
    .fetchQuery({ queryKey, queryFn: () => Promise.reject(error), retry: false })
    .catch(() => undefined);
}

describe("401 handling", () => {
  it("drops the session and returns the operator to sign-in with their destination", async () => {
    const { client, redirectToLogin } = setup({ pathname: "/apps/my-app", search: "?tab=usage" });
    client.setQueryData(keys.session, { user: {} });

    await failQuery(client, new ApiError(401, "auth_required", "no session"));

    expect(client.getQueryData(keys.session)).toBeNull();
    expect(redirectToLogin).toHaveBeenCalledWith("/login?from=%2Fapps%2Fmy-app%3Ftab%3Dusage");
  });

  it("does not navigate when the 401 came from the sign-in screen itself", async () => {
    const { client, redirectToLogin } = setup({ pathname: "/login", search: "" });

    await failQuery(client, new ApiError(401, "INVALID_EMAIL_OR_PASSWORD", "bad password"));

    // A rejected password is a form error, not an expired session.
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it("ignores non-auth failures", async () => {
    const { client, redirectToLogin } = setup();
    client.setQueryData(keys.session, { user: {} });

    await failQuery(client, new ApiError(500, "internal_error", "boom"));

    expect(redirectToLogin).not.toHaveBeenCalled();
    expect(client.getQueryData(keys.session)).toEqual({ user: {} });
  });
});

describe("402 handling", () => {
  it("refreshes billing status so the banner appears without a reload", async () => {
    const { client, redirectToLogin } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await failQuery(client, new ApiError(402, "payment_required", "subscription lapsed"));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.billingStatus });
    // A lapsed subscription must not look like a lost session.
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it("refreshes billing status for a failed mutation too", async () => {
    const { client } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(new ApiError(402, "payment_required", "")) })
      .execute(undefined)
      .catch(() => undefined);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.billingStatus });
  });
});

describe("retry policy", () => {
  it("does not retry deterministic client errors", async () => {
    const client = createConsoleQueryClient({ redirectToLogin: vi.fn() });
    const queryFn = vi.fn().mockRejectedValue(new ApiError(403, "forbidden", "read-only"));

    await client.fetchQuery({ queryKey: ["forbidden"], queryFn }).catch(() => undefined);

    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
