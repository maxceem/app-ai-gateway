import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCache, loadApp } from "../src/apps/app-records.ts";
import { readOrKnown, resetStallHold, STALE_READ_MAX_MS, STALL_HOLD_MS } from "../src/core/stale-read.ts";
import { clearCaches, seedAccount, seedApp, slowFakes, useFakeClock, watch } from "./helpers.ts";

const BUDGET_MS = 20;
const transient = () => new Error("D1_ERROR: Network connection lost.");
const slow = slowFakes();
/** A read that answers only once the test lets it: past any budget, with no real timer. */
const late = async <V>(value: V): Promise<V> => {
  await slow.held();
  return value;
};

beforeEach(() => {
  clearCaches();
  resetStallHold();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  slow.release();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readOrKnown", () => {
  const known = (ageMs = 60_000) => ({ value: "known", storedAt: Date.now() - ageMs });

  it("hands back the read's own promise when nothing usable is known", () => {
    const pending = Promise.resolve("read");
    expect(readOrKnown("t", undefined, () => pending, BUDGET_MS)).toBe(pending);
    expect(readOrKnown("t", known(STALE_READ_MAX_MS + 1), () => pending, BUDGET_MS)).toBe(pending);
  });

  it("answers what the read answers in time, even a refusal", async () => {
    useFakeClock();
    const read = readOrKnown("t", known(), () => late("fresh"), BUDGET_MS);
    await slow.reached();
    await vi.advanceTimersByTimeAsync(1);
    slow.release();
    await expect(read).resolves.toBe("fresh");
    const refusal = new Error("App is not registered");
    await expect(readOrKnown("t", known(), () => Promise.reject(refusal), BUDGET_MS)).rejects.toBe(refusal);
  });

  it("serves the known record when the read fails with a platform error, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(readOrKnown("t", known(), () => Promise.reject(transient()), BUDGET_MS)).resolves.toBe("known");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"known_record_served"'));
  });

  it("serves the known record at the budget, then skips D1 while the stall holds", async () => {
    useFakeClock();
    const stalled = vi.fn(() => late("fresh"));
    const read = readOrKnown("t", known(), stalled, BUDGET_MS);
    const answered = watch(read);
    await slow.reached();
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(answered.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(answered.settled).toBe(true);
    await expect(read).resolves.toBe("known");
    const skipped = vi.fn(() => Promise.resolve("fresh"));
    await expect(readOrKnown("t", known(), skipped, BUDGET_MS)).resolves.toBe("known");
    expect(skipped).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + STALL_HOLD_MS + 1);
    await expect(readOrKnown("t", known(), skipped, BUDGET_MS)).resolves.toBe("fresh");
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

describe("loadApp for an account still waiting on its owner's address (Sol 7b-7 round 2)", () => {
  /** A deployment that sends email, so the account gate is on. */
  const verifying = { ...env, EMAIL: { send: async () => ({ messageId: "m" }) }, EMAIL_FROM: "gateway@example.test", CONSOLE_ORIGIN: "https://console.gateway.test" } as unknown as Env;

  /** A server app of a fresh account with no activation row and no owner: it waits. */
  async function pendingApp(): Promise<string> {
    await seedAccount();
    const appId = `app_pending_${crypto.randomUUID().slice(0, 8)}`;
    const accountId = `acc_pending_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const config = { authentication: { type: "api_key", end_user: { source: "none" } } };
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Pending', 'usr_test', ?, ?)",
      ).bind(accountId, new Date(now).toISOString(), new Date(now).toISOString()),
      env.DB.prepare(
        "INSERT INTO app(id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)",
      ).bind(appId, accountId, appId, JSON.stringify(config), now, now),
    ]);
    return appId;
  }

  /** Ages the cached record past its life, as time passing would. */
  function expire(appId: string): void {
    const entry = appCache.peek(appId)!;
    appCache.set(appId, entry.value, { storedAt: entry.storedAt - 11_000, ttlMs: 10_000 });
  }

  it("asks for retry, never email_unverified, when the fresh read fails", async () => {
    const appId = await pendingApp();
    expect((await loadApp(verifying, appId)).accountActivated).toBe(false);
    expire(appId);
    const failing = { ...verifying, DB: { prepare: () => { throw transient(); } } } as unknown as Env;
    await expect(loadApp(failing, appId)).rejects.toMatchObject({ status: 503, code: "service_unavailable" });
  });

  it("reads afresh even while a stall holds, so an owner who verified is served", async () => {
    const appId = await pendingApp();
    const first = await loadApp(verifying, appId);
    expect(first.accountActivated).toBe(false);
    await env.DB.prepare("INSERT INTO account_activation (account_id, activated_at) VALUES (?, ?)").bind(first.accountId, Date.now()).run();
    expire(appId);
    // A stall elsewhere: reads with a known record would skip D1 for a while.
    useFakeClock();
    const stalled = readOrKnown("t", { value: "known", storedAt: Date.now() - 60_000 }, () => late("fresh"), BUDGET_MS);
    await slow.reached();
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await expect(stalled).resolves.toBe("known");
    vi.useRealTimers();
    expect((await loadApp(verifying, appId)).accountActivated).toBe(true);
  });

  it("keeps the stale fallback for an activated app", async () => {
    const appId = await pendingApp();
    const first = await loadApp(verifying, appId);
    await env.DB.prepare("INSERT INTO account_activation (account_id, activated_at) VALUES (?, ?)").bind(first.accountId, Date.now()).run();
    appCache.delete(appId);
    const activated = await loadApp(verifying, appId);
    expect(activated.accountActivated).toBe(true);
    const entry = appCache.peek(appId)!;
    appCache.set(appId, entry.value, { storedAt: entry.storedAt - 61_000 });
    const failing = { ...verifying, DB: { prepare: () => { throw transient(); } } } as unknown as Env;
    await expect(loadApp(failing, appId)).resolves.toEqual(activated);
  });
});
