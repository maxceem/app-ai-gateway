/**
 * The first-call check reads once when the page loads, with no live check:
 * "Check again" reads it once more (owner, 2026-11-22). The overview's own
 * tests show the card's texts; these show what the read asks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/render";
import { FirstCall } from "@/pages/app-detail";
import type { App } from "@/lib/types";
import { useFirstCall } from "./queries";

const USAGE_URL = "/v2/admin/apps/my-app/usage";
const CHARGES_URL = "/v2/admin/apps/my-app/charges";
const NO_USAGE = { charges: 0, failed: 0, unpriced: 0, cost_nano: 0, cost_usd: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, session_ms: 0 };

/** Answers the usage read with `usage` and the charge read with `charges`; anything else is a 404. */
function stub(usage: { status: number; body: unknown }, charges?: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const answer = url.startsWith(USAGE_URL) ? usage : url.startsWith(CHARGES_URL) ? charges : undefined;
    if (answer === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderFirstCall() {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useFirstCall("my-app"), { wrapper });
}

afterEach(() => vi.unstubAllGlobals());

describe("the first-call check", () => {
  it("reads the app's first day once, and does not ask again", async () => {
    const fetchMock = stub({ status: 200, body: { app_id: "my-app", month: "2026-11", ...NO_USAGE, first_usage_day: "2026-08-02" } });
    const { result } = renderFirstCall();
    await waitFor(() => expect(result.current.firstDay).toBe("2026-08-02"));
    expect(result.current.isFirst).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says no call yet from one read, with no timer asking again", async () => {
    const fetchMock = stub({ status: 200, body: { app_id: "my-app", month: "2026-11", ...NO_USAGE, first_usage_day: null } });
    const { result } = renderFirstCall();
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.firstDay).toBeNull();
    expect(result.current.isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads an older gateway's newest charge when its usage has no first day", async () => {
    stub(
      { status: 200, body: { app_id: "my-app", month: "2026-11", ...NO_USAGE } },
      { status: 200, body: { app_id: "my-app", limit: 1, next_before: null, charges: [{ id: "c1", used_at: "2026-11-02T10:00:00.000Z", usage_day: "2026-11-02" }] } },
    );
    const { result } = renderFirstCall();
    await waitFor(() => expect(result.current.firstDay).toBe("2026-11-02"));
    expect(result.current.isFirst).toBe(false);
  });

  it("reports an error the read could not get past", async () => {
    stub({ status: 403, body: { error: { code: "forbidden", message: "No" } } });
    const { result } = renderFirstCall();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.firstDay).toBeNull();
  });

  it("reads once more when the person clicks Check again, and shows the new answer", async () => {
    let firstDay: string | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).startsWith(USAGE_URL)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ app_id: "my-app", month: "2026-11", ...NO_USAGE, first_usage_day: firstDay }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter>
          <FirstCall app={{ id: "my-app" } as App} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const button = await screen.findByRole("button", { name: "Check again" });
    expect(screen.getByText(/No calls yet/u)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    firstDay = "2026-11-22";
    await userEvent.click(button);
    expect(await screen.findByText(/This app has made calls, the first on 2026-11-22/u)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
