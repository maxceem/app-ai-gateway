/**
 * The overview's first-call check stops asking once it has an answer, after a
 * refusal asking again cannot change, and when the page goes away (Sol 7b-6).
 * On fake timers: ten-second waits are advanced, never slept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/render";
import { FirstCall } from "@/pages/app-detail";
import type { App } from "@/lib/types";
import { FIRST_CALL_MAX_POLLS, FIRST_CALL_POLL_MS, firstCallInterval, forgetFirstCallStops, useFirstCall } from "./queries";

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

function renderFirstCall(client: QueryClient = testQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useFirstCall("my-app"), { wrapper });
}

/** Lets the timers and the fetches they start run, `ms` of fake time at once. */
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

// Only the clocks React Query waits on: a response body is still read the ordinary way.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // A stop lasts the page's life; each test is a fresh page.
  forgetFirstCallStops();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  onlineManager.setOnline(true);
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

  it("shows the reload message on the mounted card after the cap, though every answer was the same (Sol 7b-6 round 2)", async () => {
    const fetchMock = stubUsage([{ firstDay: null }]);
    const client = testQueryClient();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <FirstCall app={{ id: "my-app" } as App} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await advance(0);
    for (let poll = 1; poll < FIRST_CALL_MAX_POLLS; poll += 1) await advance(FIRST_CALL_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(FIRST_CALL_MAX_POLLS);
    await vi.waitFor(() => expect(screen.getByText("No calls yet. Reload the page to check again.")).toBeTruthy());
    await advance(FIRST_CALL_POLL_MS * 6);
    expect(fetchMock).toHaveBeenCalledTimes(FIRST_CALL_MAX_POLLS);
  });

  it("does not ask again on reconnect after a refusal (Sol 7b-6 round 2)", async () => {
    const fetchMock = stubUsage([{ status: 403 }]);
    // As the console's own client: answers go stale, so a reconnect would refetch them.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    renderFirstCall(client);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await advance(FIRST_CALL_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still asks again on reconnect while it is asking", async () => {
    const fetchMock = stubUsage([{ firstDay: null }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    renderFirstCall(client);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not ask a 91st time when the card mounts again after the cap (Sol 7b-6 round 3)", async () => {
    const fetchMock = stubUsage([{ firstDay: null }]);
    // As the console's own client: answers go stale, so mounting again would refetch them.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const first = renderFirstCall(client);
    await advance(0);
    for (let poll = 1; poll < FIRST_CALL_MAX_POLLS; poll += 1) await advance(FIRST_CALL_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(FIRST_CALL_MAX_POLLS);
    // Away to another tab, and back to the overview.
    first.unmount();
    await advance(FIRST_CALL_POLL_MS);
    const again = renderFirstCall(client);
    await advance(FIRST_CALL_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(FIRST_CALL_MAX_POLLS);
    await vi.waitFor(() => expect(again.result.current.stopped).toBe(true));
  });

  it("does not ask again when the card mounts again after a refusal (Sol 7b-6 round 3)", async () => {
    const fetchMock = stubUsage([{ status: 403 }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const first = renderFirstCall(client);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.unmount();
    renderFirstCall(client);
    await advance(FIRST_CALL_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The query cache forgets an entry five minutes after the card leaves: the stop must outlive it (Sol 7b-6 round 4).
  const AWAY_MS = 6 * 60_000;

  it("does not ask again after the cap, coming back once the cache has forgotten it (Sol 7b-6 round 4)", async () => {
    const fetchMock = stubUsage([{ firstDay: null }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const first = renderFirstCall(client);
    await advance(0);
    for (let poll = 1; poll < FIRST_CALL_MAX_POLLS; poll += 1) await advance(FIRST_CALL_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(FIRST_CALL_MAX_POLLS);
    first.unmount();
    await advance(AWAY_MS);
    expect(client.getQueryState(["app-usage", "my-app"])).toBeUndefined();
    const again = renderFirstCall(client);
    await advance(FIRST_CALL_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(FIRST_CALL_MAX_POLLS);
    expect(again.result.current.stopped).toBe(true);
  });

  it("does not ask again after a refusal, coming back once the cache has forgotten it (Sol 7b-6 round 4)", async () => {
    const fetchMock = stubUsage([{ status: 403 }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const first = renderFirstCall(client);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(first.result.current.stopped).toBe(true));
    first.unmount();
    await advance(AWAY_MS);
    renderFirstCall(client);
    await advance(FIRST_CALL_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** Holds each matching read until `release()`, then answers `status` with `body`. */
  function heldAnswer(match: string, status: number, body: unknown) {
    const releases: (() => void)[] = [];
    const release = () => releases.splice(0).forEach((go) => go());
    const hold = () => new Promise<void>((go) => releases.push(go));
    return {
      release,
      reply: async () => {
        await hold();
        return new Response(JSON.stringify(body), { status });
      },
      match,
    };
  }
  const REFUSAL = { error: { code: "forbidden", message: "No" } };

  it("records a refusal that arrives after the card has gone, and does not ask again on coming back (Sol 7b-6 round 5)", async () => {
    const held = heldAnswer(USAGE_URL, 403, REFUSAL);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith(held.match) ? held.reply() : new Response("{}", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const first = renderFirstCall(client);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The user leaves while the read is still on its way; the 403 lands afterwards.
    first.unmount();
    held.release();
    await advance(0);
    await advance(AWAY_MS);
    expect(client.getQueryState(["app-usage", "my-app"])).toBeUndefined();
    const again = renderFirstCall(client);
    await advance(FIRST_CALL_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.result.current.stopped).toBe(true);
  });

  it("records the capped answer that arrives after the card has gone (Sol 7b-6 round 5)", async () => {
    let answered = 0;
    const held = heldAnswer(USAGE_URL, 200, { app_id: "my-app", month: "2026-11", ...NO_USAGE, first_usage_day: null });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).startsWith(USAGE_URL)) return new Response("{}", { status: 404 });
      answered += 1;
      // Every answer but the last comes at once; the capped one is held until the card has gone.
      if (answered < FIRST_CALL_MAX_POLLS) {
        return new Response(JSON.stringify({ app_id: "my-app", month: "2026-11", ...NO_USAGE, first_usage_day: null }), { status: 200 });
      }
      return held.reply();
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const first = renderFirstCall(client);
    await advance(0);
    for (let poll = 1; poll < FIRST_CALL_MAX_POLLS; poll += 1) await advance(FIRST_CALL_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(FIRST_CALL_MAX_POLLS);
    first.unmount();
    held.release();
    await advance(0);
    await advance(AWAY_MS);
    renderFirstCall(client);
    await advance(FIRST_CALL_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(FIRST_CALL_MAX_POLLS);
  });

  it("records a refusal of the older gateway's charge read that arrives after the card has gone (Sol 7b-6 round 5)", async () => {
    const CHARGES_URL = "/v2/admin/apps/my-app/charges";
    const held = heldAnswer(CHARGES_URL, 403, REFUSAL);
    // An older gateway: its usage answer has no `first_usage_day`, so the charge read takes over.
    const legacyUsage = { app_id: "my-app", month: "2026-11", ...NO_USAGE };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith(USAGE_URL)) return new Response(JSON.stringify(legacyUsage), { status: 200 });
      if (String(input).startsWith(CHARGES_URL)) return held.reply();
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const chargeReads = () => fetchMock.mock.calls.filter(([input]) => String(input).startsWith(CHARGES_URL)).length;
    const first = renderFirstCall(client);
    await advance(0);
    await vi.waitFor(() => expect(chargeReads()).toBe(1));
    first.unmount();
    held.release();
    await advance(0);
    await advance(AWAY_MS);
    renderFirstCall(client);
    await advance(FIRST_CALL_POLL_MS * 3);
    expect(chargeReads()).toBe(1);
  });

  it("gives up after its cap, saying it stopped", () => {
    const state = { error: null, dataUpdateCount: FIRST_CALL_MAX_POLLS, errorUpdateCount: 0 };
    expect(firstCallInterval(state, false)).toBe(false);
    expect(firstCallInterval({ ...state, dataUpdateCount: 1 }, false)).toBe(FIRST_CALL_POLL_MS);
  });
});
