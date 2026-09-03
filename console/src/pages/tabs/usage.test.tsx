import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageTab, pivot } from "./usage";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { TimeseriesBucket, UsageEvent } from "@/lib/types";

const APP_ID = "my-app";

function event(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    id: 1,
    user_id: "user-1",
    api_key_id: null,
    provider: "openai",
    provider_gateway_id: null,
    provider_gateway_type: null,
    credential_source: "direct",
    model_author: "OpenAI",
    served_provider: null,
    served_model: null,
    model: "gpt-5.6-sol",
    route: "openai/v1/responses",
    endpoint_slug: null,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    reported_cost_usd: null,
    cost_source: "computed",
    app_version: null,
    auth_method: "api_key",
    status: "ok",
    latency_ms: 12,
    created_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderUsage(events: UsageEvent[]) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}/usage/timeseries`]: {
      body: { app_id: APP_ID, from: "2026-08-01", to: "2026-08-01", buckets: [] },
    },
    [`/v1/admin/apps/${APP_ID}/usage/breakdown`]: {
      body: { app_id: APP_ID, by: "model", from: "2026-08-01", to: "2026-08-01", rows: [] },
    },
    [`/v1/admin/apps/${APP_ID}/events`]: {
      body: { app_id: APP_ID, limit: 25, next_before_id: null, events },
    },
  });
  return renderAuthenticated(<UsageTab appId={APP_ID} />, { route: `/apps/${APP_ID}/usage` });
}

afterEach(() => vi.unstubAllGlobals());

describe("pivot", () => {
  const day = (provider: string, cost: number, date = "2026-08-01"): TimeseriesBucket => ({
    date,
    provider,
    requests: 1,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: cost,
    errors: 0,
    blocked: 0,
  });

  it("folds every provider past the palette's hues into one Other band", () => {
    // Ten providers: the seven busiest keep a band, the rest are summed.
    const chart = pivot(
      [
        day("openai", 10),
        day("anthropic", 9),
        day("gemini", 8),
        day("xai", 7),
        day("perplexity", 6),
        day("groq", 5),
        day("mistral", 4),
        day("deepseek", 3),
        day("together", 2),
        day("cerebras", 1),
      ],
      "2026-08-01",
      "2026-08-01",
      "cost_usd",
    );

    expect(chart.providers).toEqual([
      "openai",
      "anthropic",
      "gemini",
      "xai",
      "perplexity",
      "groq",
      "mistral",
      "__other",
    ]);
    expect(chart.foldedCount).toBe(3);
    // Nothing is dropped: the tail is summed rather than discarded.
    expect(chart.rows[0]!.__other).toBe(6);
  });

  it("leaves the stack alone when it already fits the palette", () => {
    const chart = pivot(
      [day("openai", 2), day("anthropic", 1)],
      "2026-08-01",
      "2026-08-01",
      "cost_usd",
    );

    expect(chart.providers).toEqual(["openai", "anthropic"]);
    expect(chart.foldedCount).toBe(0);
  });

  it("ranks on the metric being plotted, not always on cost", () => {
    // Cheap but busy outranks costly but rare once the chart counts requests.
    const buckets = [
      { ...day("openai", 100), requests: 1 },
      { ...day("groq", 1), requests: 50 },
    ];

    expect(pivot(buckets, "2026-08-01", "2026-08-01", "cost_usd").providers)
      .toEqual(["openai", "groq"]);
    expect(pivot(buckets, "2026-08-01", "2026-08-01", "requests").providers)
      .toEqual(["groq", "openai"]);
  });

  it("keeps a provider in one band across every day of the range", () => {
    // Ranked on the range total, so a provider that leads one day and trails
    // the next does not swap bands — and colours — column to column.
    const chart = pivot(
      [day("openai", 1), day("anthropic", 9, "2026-08-02"), day("openai", 9, "2026-08-02")],
      "2026-08-01",
      "2026-08-02",
      "cost_usd",
    );

    expect(chart.providers).toEqual(["openai", "anthropic"]);
    expect(chart.rows.map((row) => row.date)).toEqual(["2026-08-01", "2026-08-02"]);
  });
});

describe("UsageTab event costs", () => {
  it("says an unresolved event was not metered instead of showing it as free", async () => {
    renderUsage([
      event({ id: 2, cost_source: "unresolved", model: "cohere-command" }),
      event({ id: 1, cost_usd: 0, cost_source: "computed", model: "free-model" }),
    ]);

    expect(await screen.findByText("unresolved")).toBeTruthy();
    // The genuinely-zero event keeps its measured cost, so the two are not
    // collapsed into one appearance.
    expect(screen.getAllByText("$0.00").length).toBe(1);
  });

  it("shows a plain cost when the event was metered", async () => {
    renderUsage([event({ cost_usd: 0.25, cost_source: "computed" })]);

    expect(await screen.findByText("$0.25")).toBeTruthy();
    expect(screen.queryByText("unresolved")).toBeNull();
  });

  it("names the gateway a request was routed through", async () => {
    renderUsage([event({ provider_gateway_type: "cf_aig", credential_source: "byok" })]);
    expect(await screen.findByText(/via cf_aig/u)).toBeTruthy();
  });

  it("names the host that actually served a request, when one was reported", async () => {
    // Observed, not configured: it appears alongside the route rather than
    // replacing it, because the two answer different questions.
    renderUsage([
      event({
        provider: "openrouter",
        model: "google/gemini-3.6-flash",
        model_author: "Google",
        served_provider: "Google AI Studio",
        served_model: "google/gemini-3.6-flash",
        cost_usd: 0.0012,
        reported_cost_usd: 0.0012,
        cost_source: "reported",
      }),
    ]);
    expect(await screen.findByText(/Served by Google AI Studio/u)).toBeTruthy();
    // A reported cost is shown as the plain figure it is, never as unresolved.
    expect(screen.getByText("$0.0012")).toBeTruthy();
    expect(screen.queryByText("unresolved")).toBeNull();
  });

  it("names no serving host when the upstream reported none", async () => {
    renderUsage([event({ served_provider: null })]);
    expect(await screen.findByText("gpt-5.6-sol")).toBeTruthy();
    expect(screen.queryByText(/Served by/u)).toBeNull();
  });

  it("names no gateway for a direct request, which had none", async () => {
    renderUsage([event({ provider_gateway_type: null, credential_source: "direct" })]);
    expect(await screen.findByText("gpt-5.6-sol")).toBeTruthy();
    expect(screen.queryByText(/via /u)).toBeNull();
  });
});

describe("UsageTab event statuses", () => {
  /**
   * The stored value is the API's filter argument and what a log line says, so
   * the badge keeps showing it. What it means is the hover — and `blocked_rate`
   * is the one that needs it, its name predating the single organization-wide
   * allowance it now reports.
   */
  it("explains a monthly-quota rejection behind its stored status value", async () => {
    renderUsage([event({ status: "blocked_rate" })]);

    const badge = await screen.findByText("blocked_rate");
    expect(badge.getAttribute("title"))
      .toBe("Refused: the organization's monthly request allowance was exhausted");
  });

  /**
   * Spending budgets are gone, but rows recorded while they existed are not:
   * they still have to render, and to say why that status cannot recur.
   */
  it("still renders a historical spending-budget rejection", async () => {
    renderUsage([event({ status: "blocked_budget" })]);

    const badge = await screen.findByText("blocked_budget");
    expect(badge.getAttribute("title"))
      .toBe("Refused by a spending budget, a quota the gateway no longer has");
  });

  it("offers no filter for a status nothing can write any more", async () => {
    renderUsage([event({})]);
    await screen.findByText("gpt-5.6-sol");

    // Several pickers share the toolbar; this is the one showing the status.
    const trigger = screen.getAllByRole("combobox")
      .find((option) => option.textContent === "All statuses")!;
    await userEvent.click(trigger);
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual([
      "All statuses",
      "ok",
      "provider_error",
      "blocked_rate — monthly quota",
      "blocked_user",
    ]);
  });
});
