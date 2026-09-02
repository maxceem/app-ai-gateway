import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { AuthEventsTab, foldOutcomes, formatDuration } from "./auth-events";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { AuthEvent, AuthEventSummary } from "@/lib/types";

const APP_ID = "my-app";

function summary(overrides: Partial<AuthEventSummary> = {}): AuthEventSummary {
  return {
    app_id: APP_ID,
    days: 30,
    from: "2026-08-01",
    to: "2026-08-30",
    daily: [],
    usage_failures: [],
    token_exchange: { total: 0, ok: 0, success_rate: null },
    claim_delay: { count: 0, avg_ms: null, p50_ms: null, p95_ms: null },
    pending_users: 0,
    ...overrides,
  };
}

function event(overrides: Partial<AuthEvent> = {}): AuthEvent {
  return {
    id: 1,
    user_id: "user-1",
    event: "token_exchange",
    auth_method: "api_key",
    outcome: "ok",
    reason: null,
    app_version: "1.0.0",
    latency_ms: 12,
    claim_delay_ms: null,
    created_at: "2026-08-30T10:00:00.000Z",
    ...overrides,
  };
}

function renderTab(data: AuthEventSummary, events: AuthEvent[]) {
  stubApi({
    // The more specific route first: `stubApi` matches on prefix.
    [`/v1/admin/apps/${APP_ID}/auth-events/summary`]: { body: data },
    [`/v1/admin/apps/${APP_ID}/auth-events`]: {
      body: { app_id: APP_ID, limit: 25, next_before_id: null, events },
    },
  });
  return renderAuthenticated(<AuthEventsTab appId={APP_ID} />, {
    route: `/apps/${APP_ID}/auth-events`,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("formatDuration", () => {
  it("reads at the scale of the wait it describes", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(4_500)).toBe("4.5 s");
    expect(formatDuration(180_000)).toBe("3 min");
    expect(formatDuration(7_200_000)).toBe("2.0 h");
  });
});

describe("foldOutcomes", () => {
  it("keeps failures apart by reason and drops the successful majority", () => {
    const rows = foldOutcomes(summary({
      daily: [
        { date: "2026-08-01", event: "token_exchange", outcome: "ok", reason: null, count: 500 },
        {
          date: "2026-08-01",
          event: "token_exchange",
          outcome: "issuer_token_rejected",
          reason: "bad_signature",
          count: 1,
        },
        {
          date: "2026-08-01",
          event: "token_exchange",
          outcome: "issuer_token_rejected",
          reason: "expired",
          count: 4,
        },
        {
          date: "2026-08-02",
          event: "token_exchange",
          outcome: "issuer_token_rejected",
          reason: "expired",
          count: 3,
        },
      ],
    }));

    // `ok` is already reported as the success rate; leaving it here would bury
    // the handful of rows this table exists to surface.
    expect(rows.map((row) => row.outcome)).toEqual([
      "issuer_token_rejected",
      "issuer_token_rejected",
    ]);
    // Busiest first, and the two causes stay separate rather than summing into
    // one uninformative total.
    expect(rows[0]).toMatchObject({ reason: "expired", total: 7 });
    expect(rows[0]!.days.length).toBe(2);
    expect(rows[1]).toMatchObject({ reason: "bad_signature", total: 1 });
  });

  it("counts a day once when both call types failed the same way on it", () => {
    // The API groups by event as well, so one bad day arrives as two buckets.
    // Appending them would report two days affected out of one, and split that
    // day's count in half.
    const rows = foldOutcomes(summary({
      daily: [
        {
          date: "2026-08-01",
          event: "token_exchange",
          outcome: "issuer_claims_missing",
          reason: "claims_missing",
          count: 2,
        },
        {
          date: "2026-08-01",
          event: "register",
          outcome: "issuer_claims_missing",
          reason: "claims_missing",
          count: 3,
        },
        {
          date: "2026-08-02",
          event: "register",
          outcome: "issuer_claims_missing",
          reason: "claims_missing",
          count: 1,
        },
      ],
    }));

    expect(rows).toEqual([
      {
        outcome: "issuer_claims_missing",
        reason: "claims_missing",
        total: 6,
        days: [
          { date: "2026-08-01", count: 5 },
          { date: "2026-08-02", count: 1 },
        ],
      },
    ]);
  });

  it("folds proxied failures into the same table", () => {
    const rows = foldOutcomes(summary({
      usage_failures: [{ date: "2026-08-01", status: "provider_error", count: 2 }],
    }));
    expect(rows).toEqual([
      {
        outcome: "provider_error",
        reason: "proxied request",
        total: 2,
        days: [{ date: "2026-08-01", count: 2 }],
      },
    ]);
  });
});

describe("AuthEventsTab", () => {
  it("leads with the success rate, the claim delays, and who is waiting now", async () => {
    renderTab(
      summary({
        token_exchange: { total: 200, ok: 190, success_rate: 0.95 },
        claim_delay: { count: 4, avg_ms: 90_000, p50_ms: 45_000, p95_ms: 300_000 },
        pending_users: 2,
      }),
      [],
    );

    expect(await screen.findByText("95.0%")).toBeTruthy();
    expect(screen.getByText("45.0 s")).toBeTruthy();
    expect(screen.getByText("5 min")).toBeTruthy();
    expect(screen.getByText("avg 2 min")).toBeTruthy();
    expect(screen.getByText("waiting on a claim now")).toBeTruthy();
  });

  it("says an unused window has no success rate rather than a perfect one", async () => {
    renderTab(summary(), []);

    expect(await screen.findByText("No failed requests in this range.")).toBeTruthy();
    expect(screen.getByText("Exchange success")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("100.0%")).toBeNull();
    expect(screen.getByText("none waiting")).toBeTruthy();
  });

  it("marks the exchange that ended a wait with how long it lasted", async () => {
    renderTab(summary(), [
      event({
        id: 2,
        outcome: "ok",
        claim_delay_ms: 132_000,
        user_id: "recovered-user",
      }),
      event({
        id: 1,
        outcome: "issuer_claims_missing",
        reason: "claims_missing",
        user_id: "recovered-user",
      }),
    ]);

    expect(await screen.findByText("2 min")).toBeTruthy();
    expect(screen.getByText("issuer_claims_missing")).toBeTruthy();
    expect(screen.getByText("claims_missing")).toBeTruthy();
  });

  it("says plainly when an attempt established no identity at all", async () => {
    renderTab(summary(), [
      event({ user_id: null, outcome: "issuer_token_rejected", reason: "bad_signature" }),
    ]);

    expect(await screen.findByText("unknown")).toBeTruthy();
    expect(screen.getByText("bad_signature")).toBeTruthy();
  });
});
