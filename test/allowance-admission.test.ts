import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admitAllowance } from "../src/billing/allowance-admission";
import type { QuotaAdmission, QuotaAdmissionInput } from "../src/do/OrgQuota";
import { clearIsolateCaches } from "./helpers";

const PERIOD: QuotaAdmissionInput = {
  periodId: "month:2026-11",
  periodEnd: "2026-12-01T00:00:00.000Z",
  limit: 3,
};
const DEADLINE_MS = 20;

/** A counter that answers `admission` after `delayMs`, or throws `error`. */
function counter(options: { admission?: QuotaAdmission; delayMs?: number; error?: unknown }) {
  return {
    admit: vi.fn(async () => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.error !== undefined) throw options.error;
      return options.admission!;
    }),
  };
}

const allowed = (used: number): QuotaAdmission => ({ allowed: true, used, limit: PERIOD.limit });

function admit(org: string, c: ReturnType<typeof counter>, input = PERIOD) {
  const pending: Promise<unknown>[] = [];
  const outcome = admitAllowance(c, org, input, (p) => pending.push(p), DEADLINE_MS);
  return { outcome, settled: async () => Promise.all(pending) };
}

beforeEach(() => {
  clearIsolateCaches();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admitAllowance", () => {
  it("returns the counter's answer when it answers in time", async () => {
    const { outcome } = admit("org-fast", counter({ admission: allowed(1) }));
    await expect(outcome).resolves.toEqual({ kind: "answered", admission: allowed(1) });
  });

  it("serves a slow counter uncounted at the deadline, and lets its late answer count", async () => {
    const slow = counter({ admission: allowed(1), delayMs: DEADLINE_MS * 5 });
    const { outcome, settled } = admit("org-slow", slow);
    await expect(outcome).resolves.toEqual({ kind: "uncounted" });
    await settled();
    expect(slow.admit).toHaveBeenCalledOnce();
    // The late answer is now the reading: one used, nothing left uncounted.
    const after = admit("org-slow", counter({ error: new Error("still broken") }));
    await expect(after.outcome).resolves.toEqual({ kind: "uncounted" });
  });

  it("serves any failure uncounted, logging a fault in the gateway as an error", async () => {
    const error = vi.spyOn(console, "error");
    const { outcome } = admit("org-fault", counter({ error: new TypeError("bug") }));
    await expect(outcome).resolves.toEqual({ kind: "uncounted" });
    expect(error.mock.calls.flat().join("\n")).toContain("allowance_uncounted");

    const overloaded = Object.assign(new Error("overloaded"), { overloaded: true });
    await expect(admit("org-over", counter({ error: overloaded })).outcome)
      .resolves.toEqual({ kind: "uncounted" });
  });

  it("keeps serving uncounted only while the last reading leaves room in the plan", async () => {
    await admit("org-room", counter({ admission: allowed(1) })).outcome;
    const failing = () => counter({ error: Object.assign(new Error("gone"), { retryable: true }) });
    // Two requests left in a plan of three: both are served uncounted…
    await expect(admit("org-room", failing()).outcome).resolves.toEqual({ kind: "uncounted" });
    await expect(admit("org-room", failing()).outcome).resolves.toEqual({ kind: "uncounted" });
    // …and the plan is then used up, so the next is refused as the counter would.
    await expect(admit("org-room", failing()).outcome).resolves.toMatchObject({
      kind: "exhausted",
      allowed: false,
      used: 3,
      limit: 3,
    });
  });

  it("refuses a plan last seen used up, and forgets that reading in a new period", async () => {
    await admit("org-done", counter({ admission: { ...allowed(3), allowed: false, retryAfterSeconds: 1 } })).outcome;
    const failing = counter({ delayMs: DEADLINE_MS * 5, admission: allowed(4) });
    await expect(admit("org-done", failing).outcome).resolves.toMatchObject({ kind: "exhausted" });

    const nextMonth = { ...PERIOD, periodId: "month:2026-12" };
    await expect(admit("org-done", counter({ error: new Error("gone") }), nextMonth).outcome)
      .resolves.toEqual({ kind: "uncounted" });
  });

  it("serves an organization it has no reading for", async () => {
    await expect(admit("org-unknown", counter({ delayMs: DEADLINE_MS * 5, admission: allowed(1) })).outcome)
      .resolves.toEqual({ kind: "uncounted" });
  });
});
