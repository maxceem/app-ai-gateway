/**
 * A page cursor never outlives the query it was read under: any filter change,
 * or a move of the days, starts at page one in the same update, and so does
 * clearing a filter after paging (Sol 7b-6 round 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePagedList } from "./paged-list";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-22T15:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const setup = () => renderHook(() => usePagedList({ user: "", status: "all" }));

describe("a paged list", () => {
  it("goes older and newer through its cursors", () => {
    const { result } = setup();
    expect(result.current.before).toBeUndefined();
    act(() => result.current.older("c1"));
    act(() => result.current.older("c2"));
    expect(result.current.before).toBe("c2");
    act(() => result.current.newer());
    expect(result.current.before).toBe("c1");
    expect(result.current.canNewer).toBe(true);
  });

  it("starts at page one when a filter is set, and again when it is cleared after paging", () => {
    const { result } = setup();
    act(() => result.current.older("unfiltered-page-2"));
    act(() => result.current.setFilters({ user: "user-9" }));
    expect(result.current.before).toBeUndefined();
    act(() => result.current.older("filtered-page-2"));
    act(() => result.current.setFilters({ user: "" }));
    // Never back to the unfiltered list's old page two.
    expect(result.current.before).toBeUndefined();
    expect(result.current.canNewer).toBe(false);
  });

  it("keeps its pages when a filter is set to the value it already has", () => {
    const { result } = setup();
    act(() => result.current.older("c1"));
    act(() => result.current.setFilters({ user: "" }));
    expect(result.current.before).toBe("c1");
  });

  it("starts at page one when the days move, and at the newest days when a filter changes", () => {
    const { result } = setup();
    act(() => result.current.earlier());
    act(() => result.current.older("c1"));
    act(() => result.current.later());
    expect(result.current.before).toBeUndefined();
    act(() => result.current.earlier());
    act(() => result.current.setFilters({ status: "failed" }));
    expect(result.current.range.canLater).toBe(false);
    expect(result.current.range.to).toBe("2026-11-22");
  });
});
