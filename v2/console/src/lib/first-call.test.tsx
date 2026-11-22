/**
 * The overview's first-call check stops asking once it has an answer, after a
 * refusal asking again cannot change, and when the page goes away (Sol 7b-6).
 * On fake timers: ten-second waits are advanced, never slept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/render";
import { FIRST_CALL_MAX_POLLS, FIRST_CALL_POLL_MS, firstCallInterval, useFirstCall } from "./queries";

const USAGE_URL = "/v2/admin/apps/my-app/usage";
const NO_USAGE = { charges: 0, failed: 0, unpriced: 0, cost_nano: 0, cost_usd: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, session_ms: 0 };

/** Answers each usage read in turn with the next of `answers`, repeating the last. */
function stubUsage(answers: { status?: number; firstDay?: string | null }[]) {
  let index = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).startsWith(USAGE_URL)) return new Response("{}", { status: 404 });
    const answer = answers[Math.min(index, answers.length - 1)]!;
    index += 1;
    const body =
      (answer.status ?? 200) === 200
        ? { app_id: "my-app", month: "2026-11", ...NO_USAGE, first_usage_day: answer.firstDay ?? null }
        : { error: { code: "forbidden", message: "No" } };
    return new Response(JSON.stringify(body), { status: answer.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderFirstCall() {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useFirstCall("my-app"), { wrapper });
}

/** Lets the timers and the fetches they start run, `ms` of fake time at once. */
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

// Only the clocks React Query waits on: a response body is still read the ordinary way.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the first-call check", () => {
  it("asks every ten seconds until a call is found, then stops", async () => {
    const fetchMock = stubUsage([{ firstDay: null }, { firstDay: null }, { firstDay: "2026-11-20" }]);
    const { result } = renderFirstCall();
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(FIRST_CALL_POLL_MS);
    await advance(FIRST_CALL_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The answer's body is read the ordinary way, so give it a turn of the event loop.
    await vi.waitFor(() => expect(result.current.firstDay).toBe("2026-11-20"));
    await advance(FIRST_CALL_POLL_MS * 6);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops at a refusal asking again cannot change", async () => {
    const fetchMock = stubUsage([{ status: 403 }]);
    const { result } = renderFirstCall();
    await advance(0);
    await advance(FIRST_CALL_POLL_MS * 6);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.isError).toBe(true);
  });

  it("stops when the page goes away", async () => {
    const fetchMock = stubUsage([{ firstDay: null }]);
    const { unmount } = renderFirstCall();
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    await advance(FIRST_CALL_POLL_MS * 6);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after its cap, saying it stopped", () => {
    const state = { error: null, dataUpdateCount: FIRST_CALL_MAX_POLLS, errorUpdateCount: 0 };
    expect(firstCallInterval(state, false)).toBe(false);
    expect(firstCallInterval({ ...state, dataUpdateCount: 1 }, false)).toBe(FIRST_CALL_POLL_MS);
  });
});
