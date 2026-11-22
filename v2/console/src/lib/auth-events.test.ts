import { describe, expect, it } from "vitest";
import { foldOutcomes } from "./auth-events";
import type { AuthEventSummary } from "./types";

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

describe("foldOutcomes", () => {
  it("drops successes and merges one failure's days across events", () => {
    const rows = foldOutcomes(
      summary({
        daily: [
          { date: "2026-08-02", event: "token_exchange", outcome: "ok", reason: null, count: 50 },
          { date: "2026-08-02", event: "token_exchange", outcome: "attest_failed", reason: "bad_key", count: 2 },
          { date: "2026-08-02", event: "register", outcome: "attest_failed", reason: "bad_key", count: 1 },
          { date: "2026-08-01", event: "register", outcome: "attest_failed", reason: "bad_key", count: 4 },
        ],
      }),
    );
    expect(rows).toEqual([
      { outcome: "attest_failed", reason: "bad_key", sampled: false, total: 7, days: [{ date: "2026-08-01", count: 4 }, { date: "2026-08-02", count: 3 }] },
    ]);
  });

  it("leaves out recovered challenges: the app got past them on its own (Sol 7b-6)", () => {
    const rows = foldOutcomes(
      summary({ daily: [{ date: "2026-08-02", event: "challenge", outcome: "client_recovered", reason: null, count: 3 }] }),
    );
    expect(rows).toEqual([]);
  });

  it("shows failed charges as one row, and refusals as samples, busiest first", () => {
    const rows = foldOutcomes(
      summary({
        failed_charges: [
          { date: "2026-08-01", count: 2 },
          { date: "2026-08-02", count: 0 },
          { date: "2026-08-03", count: 3 },
        ],
        rejection_samples: [{ date: "2026-08-03", reason: "blocked_app_budget", scope: "app", count: 1 }],
      }),
    );
    expect(rows.map((row) => [row.outcome, row.reason, row.total, row.days.length, row.sampled])).toEqual([
      ["failed", "proxied request", 5, 2, false],
      ["blocked_app_budget", "app", 1, 1, true],
    ]);
  });
});
