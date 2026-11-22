/**
 * A filtered list steps back through every day the gateway keeps, the oldest
 * included, and no read covers more than 31 days (Sol 7b-6 round 2). The
 * charges, sign-in and refusal lists all move through this one window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { KEPT_DAYS, oldestKeptDay, WINDOW_DAYS } from "./date-window";
import { usePagedList } from "@/lib/paged-list";

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-22T15:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("the date window", () => {
  it("reaches the oldest day the gateway keeps, 90 days back, in reads of at most 31 days", () => {
    // The gateway's own cutoff on this day: charges dated from August 24 are kept.
    expect(oldestKeptDay()).toBe("2026-08-24");
    const { result } = renderHook(() => usePagedList({}));
    const windows: { from: string; to: string }[] = [];
    for (;;) {
      const range = result.current.range;
      windows.push({ from: range.from, to: range.to });
      expect(daysBetween(range.from, range.to)).toBeLessThanOrEqual(WINDOW_DAYS);
      if (!range.canEarlier) break;
      act(() => result.current.earlier());
    }
    expect(windows[0]!.to).toBe("2026-11-22");
    expect(windows.at(-1)!.from).toBe("2026-08-24");
    // Back to back, with no day skipped between slices.
    for (let index = 1; index < windows.length; index += 1) {
      expect(daysBetween(windows[index]!.to, windows[index - 1]!.from)).toBe(2);
    }
    const covered = windows.reduce((sum, window) => sum + daysBetween(window.from, window.to), 0);
    expect(covered).toBe(KEPT_DAYS + 1);
  });
});
