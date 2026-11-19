import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCache, loadApp } from "../src/apps/app-records.ts";
import { readOrKnown, resetStallHold, STALE_READ_MAX_MS, STALL_HOLD_MS } from "../src/core/stale-read.ts";
import { clearCaches, seedApp } from "./helpers.ts";

const BUDGET_MS = 20;
const transient = () => new Error("D1_ERROR: Network connection lost.");
const later = <V>(value: V, ms: number) => new Promise<V>((resolve) => setTimeout(() => resolve(value), ms));

beforeEach(() => {
  clearCaches();
  resetStallHold();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("readOrKnown", () => {
  const known = (ageMs = 60_000) => ({ value: "known", storedAt: Date.now() - ageMs });

  it("hands back the read's own promise when nothing usable is known", () => {
    const pending = Promise.resolve("read");
    expect(readOrKnown("t", undefined, () => pending, BUDGET_MS)).toBe(pending);
    expect(readOrKnown("t", known(STALE_READ_MAX_MS + 1), () => pending, BUDGET_MS)).toBe(pending);
  });

  it("answers what the read answers in time, even a refusal", async () => {
    await expect(readOrKnown("t", known(), () => later("fresh", 1), BUDGET_MS)).resolves.toBe("fresh");
    const refusal = new Error("App is not registered");
    await expect(readOrKnown("t", known(), () => Promise.reject(refusal), BUDGET_MS)).rejects.toBe(refusal);
  });

  it("serves the known record when the read fails with a platform error, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(readOrKnown("t", known(), () => Promise.reject(transient()), BUDGET_MS)).resolves.toBe("known");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"known_record_served"'));
  });

  it("serves the known record at the budget, then skips D1 while the stall holds", async () => {
    const slow = vi.fn(() => later("fresh", BUDGET_MS * 10));
    await expect(readOrKnown("t", known(), slow, BUDGET_MS)).resolves.toBe("known");
    const skipped = vi.fn(() => later("fresh", 1));
    await expect(readOrKnown("t", known(), skipped, BUDGET_MS)).resolves.toBe("known");
    expect(skipped).not.toHaveBeenCalled();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + STALL_HOLD_MS + 1);
    await expect(readOrKnown("t", { value: "known", storedAt: clock() - 60_000 }, skipped, BUDGET_MS)).resolves.toBe("fresh");
  });
});

describe("loadApp", () => {
  it("serves the last known app when D1 fails after the cache expired", async () => {
    const appId = await seedApp({ type: "api_key", end_user: { source: "none" } });
    const first = await loadApp(env, appId);
    const entry = appCache.peek(appId)!;
    appCache.set(appId, entry.value, { storedAt: entry.storedAt - 61_000 });
    const failing = { ...env, DB: { prepare: () => { throw transient(); } } } as unknown as Env;
    await expect(loadApp(failing, appId)).resolves.toEqual(first);
  });

  it("never brings back a deleted app", async () => {
    const appId = await seedApp({ type: "api_key", end_user: { source: "none" } });
    await loadApp(env, appId);
    const entry = appCache.peek(appId)!;
    appCache.set(appId, entry.value, { storedAt: entry.storedAt - 61_000 });
    await env.DB.prepare("DELETE FROM app WHERE id = ?").bind(appId).run();
    await expect(loadApp(env, appId)).rejects.toMatchObject({ code: "app_not_found" });
  });
});
