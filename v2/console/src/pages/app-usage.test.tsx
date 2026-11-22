import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageTab } from "./app-usage";
import { testApp } from "@/test/fixtures";
import { findByHint, renderAuthenticated, stubApi } from "@/test/render";
import type { App, Charge } from "@/lib/types";

const BASE = "/v2/admin/apps/my-app";

function charge(overrides: Partial<Charge> = {}): Charge {
  return {
    id: "c1",
    kind: "attempt",
    owner_type: "call",
    owner_id: "call-1",
    corrects_charge_id: null,
    correction_kind: null,
    status: "ok",
    http_status: 200,
    error_code: null,
    provider_type: "openai",
    provider_connection_id: "p1",
    operation: "openai.chat",
    preset: null,
    model: "gpt-4o-mini",
    end_user_id: "user-1",
    install_id: null,
    cost_nano: 1_250_000,
    cost_usd: 0.00125,
    measured: "complete",
    price_source: "list_rate",
    price_is_estimate: false,
    input_tokens: 100,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 20,
    unit: null,
    units: null,
    session_ms: null,
    latency_ms: 340,
    app_version: "1.2.3",
    auth_method: "api_key",
    client_trace_id: null,
    used_at: "2026-08-01T10:00:00.000Z",
    usage_day: "2026-08-01",
    ...overrides,
  };
}

const totals = { charges: 0, failed: 0, unpriced: 0, cost_nano: 0, cost_usd: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, session_ms: 0 };

function renderUsage({
  charges = [] as Charge[],
  nextBefore = null as string | null,
  rows = [] as Record<string, unknown>[],
  app = testApp() as unknown as App,
} = {}) {
  const fetchMock = stubApi({
    [`${BASE}/usage/timeseries`]: { body: { app_id: "my-app", from: "2026-08-01", to: "2026-08-30", buckets: [] } },
    [`${BASE}/usage/breakdown`]: { body: { app_id: "my-app", by: "model", from: "2026-08-01", to: "2026-08-30", rows } },
    [`${BASE}/charges`]: { body: { app_id: "my-app", limit: 25, next_before: nextBefore, charges } },
  });
  return { fetchMock, ...renderAuthenticated(<UsageTab app={app} />, { route: "/apps/my-app/usage" }) };
}

const urls = (fetchMock: ReturnType<typeof stubApi>, path: string) =>
  fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith(`${BASE}${path}`));

afterEach(() => vi.unstubAllGlobals());

describe("Usage tab", () => {
  it("marks an estimate with ≈, says unpriced rather than $0, and shows — for a failure that cost nothing", async () => {
    renderUsage({
      charges: [
        charge({ id: "est", kind: "estimate", owner_type: "job", price_is_estimate: true, cost_usd: 0.05, cost_nano: 50_000_000 }),
        charge({ id: "unpriced", price_source: "unresolved", cost_usd: 0, cost_nano: 0 }),
        charge({ id: "fail", status: "provider_error", http_status: 500, error_code: "upstream_error", cost_usd: null, cost_nano: null }),
      ],
    });
    expect(await screen.findByText("≈$0.05")).toBeTruthy();
    await findByHint(/^An estimate: a job's charge before/u);
    expect(screen.getByText("unpriced")).toBeTruthy();
    expect(screen.getByText("upstream_error")).toBeTruthy();
    const failedRow = screen.getByText("upstream_error").closest("tr")!;
    expect(within(failedRow).getByText("—", { selector: "span" })).toBeTruthy();
    // A job estimate names its kind, so it is not read as an ordinary call.
    expect(screen.getByText("estimate")).toBeTruthy();
  });

  it("shows a correction as its own row naming the charge it corrects", async () => {
    renderUsage({ charges: [charge({ id: "corr", kind: "correction", corrects_charge_id: "c1", correction_kind: "units", cost_usd: -0.001, cost_nano: -1_000_000 })] });
    expect(await screen.findByText("correction (units)")).toBeTruthy();
    await findByHint(/^Corrects charge c1/u);
  });

  it("goes back a page with the API's before cursor, and forward again", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderUsage({ charges: [charge()], nextBefore: "cursor-1" });
    await screen.findByText("gpt-4o-mini");
    const older = screen.getByRole("button", { name: "Older" });
    await waitFor(() => expect(older.hasAttribute("disabled")).toBe(false));
    await user.click(older);
    await waitFor(() => expect(urls(fetchMock, "/charges").some((url) => url.includes("before=cursor-1"))).toBe(true));
    const newer = screen.getByRole("button", { name: "Newer" });
    await waitFor(() => expect(newer.hasAttribute("disabled")).toBe(false));
    await user.click(newer);
    await waitFor(() => expect(newer.hasAttribute("disabled")).toBe(true));
  });

  it("reads a breakdown from the charges over at most 31 days", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderUsage();
    await screen.findByText("No charges.");
    await user.click(screen.getByRole("combobox", { name: "Date range" }));
    await user.click(await screen.findByRole("option", { name: "Last 90 days" }));
    await user.click(screen.getByRole("combobox", { name: "Breakdown" }));
    await user.click(await screen.findByRole("option", { name: "By user" }));
    await waitFor(() => expect(urls(fetchMock, "/usage/breakdown").some((url) => url.includes("by=user"))).toBe(true));
    const byUser = new URL(urls(fetchMock, "/usage/breakdown").find((url) => url.includes("by=user"))!, "http://x");
    const span = (Date.parse(byUser.searchParams.get("to")!) - Date.parse(byUser.searchParams.get("from")!)) / 86_400_000 + 1;
    expect(span).toBe(31);
    // The day totals keep 400 days, so a model breakdown reads the whole 90.
    const modelSpans = urls(fetchMock, "/usage/breakdown")
      .filter((url) => url.includes("by=model"))
      .map((url) => new URL(url, "http://x"))
      .map((url) => (Date.parse(url.searchParams.get("to")!) - Date.parse(url.searchParams.get("from")!)) / 86_400_000 + 1);
    expect(modelSpans).toContain(90);
  });

  it("says how many charges in a breakdown row are still without a price", async () => {
    renderUsage({ rows: [{ key: "gpt-4o-mini", label: null, ...totals, charges: 4, failed: 1, unpriced: 2, cost_usd: 0.5, cost_nano: 500_000_000 }] });
    expect(await screen.findByText("2 unpriced")).toBeTruthy();
    expect(screen.getByText("1 failed")).toBeTruthy();
    expect(screen.getByText("$0.50")).toBeTruthy();
  });

  it("filters charges by status, starting again from the newest page", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderUsage();
    await screen.findByText("No charges.");
    await user.click(screen.getByRole("combobox", { name: "Charge status" }));
    await user.click(await screen.findByRole("option", { name: "Every failure" }));
    await waitFor(() => expect(urls(fetchMock, "/charges").some((url) => url.includes("status=failed") && !url.includes("before="))).toBe(true));
  });
});
