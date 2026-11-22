import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorsTab, USER_FILTER_DEBOUNCE_MS } from "./app-errors";
import { findByHint, renderAuthenticated, stubApi } from "@/test/render";
import type { AuthEvent, AuthEventSummary, RejectionEvent } from "@/lib/types";

const BASE = "/v2/admin/apps/my-app";

function summary(overrides: Partial<AuthEventSummary> = {}): AuthEventSummary {
  return {
    app_id: "my-app",
    days: 30,
    from: "2026-08-01",
    to: "2026-08-30",
    daily: [],
    failing_networks: [],
    failed_charges: [],
    rejection_samples: [],
    token_exchange: { total: 0, ok: 0, success_rate: null },
    claim_delay: { count: 0, avg_ms: null, p50_ms: null, p95_ms: null },
    pending_users: 0,
    ...overrides,
  };
}

function attempt(overrides: Partial<AuthEvent> = {}): AuthEvent {
  return {
    id: "e1",
    user_id: "user-1",
    event: "token_exchange",
    auth_method: "issuer",
    outcome: "ok",
    reason: null,
    app_version: "1.0.0",
    client_sdk: null,
    network_asn: null,
    network_name: null,
    latency_ms: 12,
    claim_delay_ms: null,
    created_at: "2026-08-30T10:00:00.000Z",
    ...overrides,
  };
}

function refusal(overrides: Partial<RejectionEvent> = {}): RejectionEvent {
  return {
    id: "r1",
    user_id: "user-1",
    install_id: null,
    app_key_id: null,
    reason: "model_not_allowed",
    scope: null,
    provider_slug: "openai",
    model: "gpt-4o",
    operation: "openai.chat",
    app_version: "1.0.0",
    auth_method: "issuer",
    latency_ms: 3,
    created_at: "2026-08-30T10:00:00.000Z",
    ...overrides,
  };
}

function renderTab({
  data = summary(),
  events = [] as AuthEvent[],
  refusals = [] as RejectionEvent[],
  nextRefusal = null as string | null,
  refusalStatus = 200,
} = {}) {
  const fetchMock = stubApi({
    // The more specific route first: `stubApi` matches on prefix.
    [`${BASE}/auth-events/summary`]: { body: data },
    [`${BASE}/rejection-events`]: { status: refusalStatus, body: { app_id: "my-app", limit: 25, next_before: nextRefusal, events: refusals } },
    [`${BASE}/auth-events`]: { body: { app_id: "my-app", limit: 25, next_before: null, events } },
  });
  return { fetchMock, ...renderAuthenticated(<ErrorsTab appId="my-app" />, { route: "/apps/my-app/errors" }) };
}

const urls = (fetchMock: ReturnType<typeof stubApi>, path: string) =>
  fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith(`${BASE}${path}`));

/**
 * Runs a test on fake timers that still move on their own, so the user filter's
 * debounce is stepped past exactly (`settle`) instead of waited out in real time.
 */
async function withFakeDebounce(run: (user: ReturnType<typeof userEvent.setup>, settle: () => Promise<void>) => Promise<void>) {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await run(user, () => act(async () => void vi.advanceTimersByTime(USER_FILTER_DEBOUNCE_MS + 50)));
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("Errors tab", () => {
  it("calls out sign-in failures on Apple's network, where App Review tests", async () => {
    renderTab({
      data: summary({ failing_networks: [{ network_asn: 714, network_name: "Apple Inc.", count: 3, last_seen: "2026-08-29T08:00:00.000Z" }] }),
      events: [attempt({ outcome: "attest_failed", network_asn: 714, network_name: "Apple Inc." })],
    });
    expect(await screen.findByText(/Sign-in failed 3 times on Apple's network/u)).toBeTruthy();
    expect(await screen.findByText("probably App Review")).toBeTruthy();
    expect(screen.getByText("Apple Inc. (AS714)")).toBeTruthy();
  });

  it("shows no App Review alert when Apple's network is not among the failures", async () => {
    renderTab({ data: summary({ failing_networks: [{ network_asn: 7922, network_name: "Comcast", count: 9, last_seen: "2026-08-29T08:00:00.000Z" }] }) });
    await screen.findByText("No failures in this range.");
    expect(screen.queryByText(/on Apple's network/u)).toBeNull();
  });

  it("shows the exchange success, the claim waits and who is waiting now", async () => {
    renderTab({
      data: summary({
        token_exchange: { total: 200, ok: 190, success_rate: 0.95 },
        claim_delay: { count: 4, avg_ms: 3_000, p50_ms: 2_500, p95_ms: 7_000 },
        pending_users: 2,
      }),
      events: [attempt({ claim_delay_ms: 4_500 })],
    });
    expect(await screen.findByText("95.0%")).toBeTruthy();
    expect(screen.getByText("2.5 s")).toBeTruthy();
    expect(screen.getByText("7.0 s")).toBeTruthy();
    expect(screen.getByText("waiting on a claim now")).toBeTruthy();
    expect(await screen.findByText("4.5 s")).toBeTruthy();
    await findByHint(/ended a wait for an entitlement claim/u);
  });

  it("lists failures by cause, failed charges and refusal samples included", async () => {
    renderTab({
      data: summary({
        daily: [{ date: "2026-08-02", event: "token_exchange", outcome: "issuer_claims_missing", reason: null, count: 5 }],
        failed_charges: [{ date: "2026-08-03", count: 2 }],
        rejection_samples: [{ date: "2026-08-04", reason: "blocked_app_budget", scope: "app", count: 1 }],
      }),
    });
    expect(await screen.findByText("issuer_claims_missing")).toBeTruthy();
    expect(screen.getByText("proxied request")).toBeTruthy();
    expect(screen.getByText("blocked_app_budget")).toBeTruthy();
    expect(screen.getByText("sample")).toBeTruthy();
  });

  it("filters refusals by reason, scope and user, and pages with the before cursor", async () => {
    await withFakeDebounce(async (user, settle) => {
      const { fetchMock } = renderTab({ refusals: [refusal()], nextRefusal: "r-cursor" });
      await screen.findByText("model_not_allowed");
      await user.click(screen.getByRole("combobox", { name: "Refusal reason" }));
      await user.click(await screen.findByRole("option", { name: "App budget" }));
      await user.click(screen.getByRole("combobox", { name: "Refusal scope" }));
      await user.click(await screen.findByRole("option", { name: "Your account" }));
      await user.type(screen.getByRole("textbox", { name: "Refusal user ID" }), "user-9");
      await settle();
      await waitFor(() =>
        expect(urls(fetchMock, "/rejection-events").some((url) => url.includes("reason=blocked_app_budget") && url.includes("scope=account") && url.includes("user=user-9"))).toBe(true),
      );
      const older = screen.getAllByRole("button", { name: "Older" })[0]!;
      await waitFor(() => expect(older.hasAttribute("disabled")).toBe(false));
      await user.click(older);
      await waitFor(() => expect(urls(fetchMock, "/rejection-events").some((url) => url.includes("before=r-cursor"))).toBe(true));
    });
  });

  it("says a requested model the gateway did not know was not kept", async () => {
    renderTab({ refusals: [refusal({ model: "unrecognized" })] });
    await findByHint(/named a model the gateway does not know/u);
  });

  it("reads Apple's failures from their own field, so busier networks never hide them (Sol 7b-6)", async () => {
    renderTab({
      data: summary({
        failing_networks: [{ network_asn: 7922, network_name: "Comcast", count: 9, last_seen: "2026-08-29T08:00:00.000Z" }],
        apple_failures: { count: 2, last_seen: "2026-08-28T08:00:00.000Z" },
      }),
    });
    expect(await screen.findByText(/Sign-in failed 2 times on Apple's network/u)).toBeTruthy();
  });

  it("shows no alert when the gateway says Apple had no failures, whatever the network list holds", async () => {
    renderTab({
      data: summary({
        failing_networks: [{ network_asn: 714, network_name: "Apple Inc.", count: 3, last_seen: "2026-08-29T08:00:00.000Z" }],
        apple_failures: null,
      }),
    });
    await screen.findByText("No failures in this range.");
    expect(screen.queryByText(/on Apple's network/u)).toBeNull();
  });

  it("says the figures are unavailable when the summary cannot be read, never zero (Sol 7b-6)", async () => {
    stubApi({
      [`${BASE}/auth-events/summary`]: { status: 500, body: { error: { code: "internal_error", message: "No" } } },
      [`${BASE}/rejection-events`]: { body: { app_id: "my-app", limit: 25, next_before: null, events: [] } },
      [`${BASE}/auth-events`]: { body: { app_id: "my-app", limit: 25, next_before: null, events: [] } },
    });
    renderAuthenticated(<ErrorsTab appId="my-app" />, { route: "/apps/my-app/errors" });
    expect(await screen.findByText("Could not load the summary.")).toBeTruthy();
    expect(screen.getAllByText("unavailable")).toHaveLength(4);
    expect(screen.queryByText("none waiting")).toBeNull();
    expect(screen.queryByText("0 attempts")).toBeNull();
  });

  it("offers every recorded outcome, app_disabled included, and reads it a window of days at a time", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderTab();
    await screen.findByText("No attempts.");
    await user.click(screen.getByRole("combobox", { name: "Outcome" }));
    await user.click(await screen.findByRole("option", { name: "app_disabled" }));
    await waitFor(() =>
      expect(urls(fetchMock, "/auth-events?").some((url) => url.includes("outcome=app_disabled") && url.includes("from=") && url.includes("to="))).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Earlier days" })).toBeTruthy();
  });

  it("reads a typed user once it settles, not once per letter", async () => {
    await withFakeDebounce(async (user, settle) => {
      const { fetchMock } = renderTab();
      await screen.findByText("No refusal samples.");
      await user.type(screen.getByRole("textbox", { name: "Refusal user ID" }), "user-9");
      await settle();
      await waitFor(() => expect(urls(fetchMock, "/rejection-events").some((url) => url.includes("user=user-9"))).toBe(true));
      expect(urls(fetchMock, "/rejection-events").filter((url) => url.includes("user=")).length).toBe(1);
    });
  });

  it("starts a newly typed user at page one, never with the previous page's cursor", async () => {
    await withFakeDebounce(async (user, settle) => {
      const { fetchMock } = renderTab({ refusals: [refusal()], nextRefusal: "r-cursor" });
      await screen.findByText("model_not_allowed");
      const older = screen.getAllByRole("button", { name: "Older" })[0]!;
      await waitFor(() => expect(older.hasAttribute("disabled")).toBe(false));
      await user.click(older);
      await waitFor(() => expect(urls(fetchMock, "/rejection-events").some((url) => url.includes("before=r-cursor"))).toBe(true));
      await user.type(screen.getByRole("textbox", { name: "Refusal user ID" }), "user-9");
      await settle();
      await waitFor(() => expect(urls(fetchMock, "/rejection-events").some((url) => url.includes("user=user-9"))).toBe(true));
      const withUser = urls(fetchMock, "/rejection-events").filter((url) => url.includes("user=user-9"));
      expect(withUser).toHaveLength(1);
      expect(withUser[0]).not.toContain("before=");
    });
  });

  it("starts at page one when a typed user is cleared after paging, never back on the old page", async () => {
    await withFakeDebounce(async (user) => {
      const { fetchMock } = renderTab({ refusals: [refusal()], nextRefusal: "r-cursor" });
      await screen.findByText("model_not_allowed");
      const older = screen.getAllByRole("button", { name: "Older" })[0]!;
      const newer = screen.getAllByRole("button", { name: "Newer" })[0]!;
      await waitFor(() => expect(older.hasAttribute("disabled")).toBe(false));
      await user.click(older);
      await waitFor(() => expect(urls(fetchMock, "/rejection-events").some((url) => url.includes("before=r-cursor"))).toBe(true));
      await waitFor(() => expect(newer.hasAttribute("disabled")).toBe(false));
      const box = screen.getByRole("textbox", { name: "Refusal user ID" });
      await user.type(box, "user-9");
      await act(async () => vi.advanceTimersByTime(USER_FILTER_DEBOUNCE_MS + 50));
      await waitFor(() => expect(urls(fetchMock, "/rejection-events").some((url) => url.includes("user=user-9"))).toBe(true));
      const beforeClear = urls(fetchMock, "/rejection-events").length;
      await user.clear(box);
      await act(async () => vi.advanceTimersByTime(USER_FILTER_DEBOUNCE_MS + 50));
      // Page one of the unfiltered list (perhaps from the cache), never its old page two.
      await waitFor(() => expect(newer.hasAttribute("disabled")).toBe(true));
      expect(urls(fetchMock, "/rejection-events").slice(beforeClear).some((url) => url.includes("before="))).toBe(false);
    });
  });

  it("offers a retry when the refusal samples cannot be read", async () => {
    renderTab({ refusalStatus: 500 });
    expect(await screen.findByText(/Could not load refusal samples/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
