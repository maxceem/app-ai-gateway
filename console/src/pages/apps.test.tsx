import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { AppsPage } from "./apps";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { AppSummary } from "@/lib/types";

afterEach(() => vi.unstubAllGlobals());

const APPS_URL = "/v1/admin/apps";

const app: AppSummary = {
  id: "app-1",
  name: "Calorie Tracker",
  status: "active",
  authentication_type: "apple_app_attest",
  apple_bundle_id: "com.example.calories",
  created_at: "2026-09-01T00:00:00.000Z",
  providers: ["openai"],
  referenced_providers: ["openai"],
  allowed_model_count: 3,
  monthly_budget_usd: null,
  users: { total: 4, blocked: 0 },
  usage: {
    requests: 12,
    input_tokens: 100,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 40,
    cost_usd: 0.02,
    errors: 0,
  },
};

function renderApps(
  {
    apps = [],
    hasProxiedRequests = false,
  }: { apps?: AppSummary[]; hasProxiedRequests?: boolean },
  options: Parameters<typeof renderAuthenticated>[1] = {},
) {
  stubApi({
    [APPS_URL]: {
      body: { month: "2026-09", has_proxied_requests: hasProxiedRequests, apps },
    },
  });
  return renderAuthenticated(<AppsPage />, { route: "/apps", ...options });
}

describe("the apps list", () => {
  it("says so when there are no apps, with the totals above it reading zero", async () => {
    renderApps({});

    expect(await screen.findByText(/no apps yet/i)).toBeTruthy();
    // Setup as a whole is walked through in the rail; the page offers only
    // the one thing it is for, under the same name the header gives it.
    expect(screen.getAllByRole("button", { name: /new app/i })).toHaveLength(2);
    expect(screen.queryByText(/start in 3 steps/i)).toBeNull();
    expect(screen.getByText("Requests")).toBeTruthy();
    expect(screen.getByText("Spend")).toBeTruthy();
  });

  it("lists the apps, and nothing about setup, once there are any", async () => {
    renderApps({ apps: [app] });

    expect(await screen.findByRole("link", { name: /calorie tracker/i })).toBeTruthy();
    expect(screen.queryByText(/no apps yet/i)).toBeNull();
    expect(screen.getAllByRole("button", { name: /new app/i })).toHaveLength(1);
    // "Requests" is both a stat-card label and a table column by now; Spend is not.
    expect(screen.getByText("Spend")).toBeTruthy();
  });

  it("guards the empty state's control for a read-only member", async () => {
    renderApps({}, { session: { role: "member" } });

    expect(await screen.findByText(/no apps yet/i)).toBeTruthy();
    for (const button of screen.getAllByRole("button", { name: /new app/i })) {
      expect(button).toHaveProperty("disabled", true);
    }
  });
});

describe("the budget column", () => {
  /** The listed app with `budget` set, and whatever the row spent that month. */
  function budgeted(budget: number | null, cost: number): AppSummary {
    return {
      ...app,
      monthly_budget_usd: budget,
      usage: { ...app.usage, cost_usd: cost },
    };
  }

  it("draws the share of the budget spent, and reads it out as money", async () => {
    renderApps({ apps: [budgeted(40, 20)], hasProxiedRequests: true });

    const bar = await screen.findByRole("progressbar", { name: /monthly budget used/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("20");
    expect(bar.getAttribute("aria-valuemax")).toBe("40");
    // The figures, not the ratio: the column above it is in dollars.
    expect(bar.getAttribute("aria-valuetext")).toBe("$20.00 of $40.00");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("50%");
  });

  it("warns in amber past four fifths, and never overflows its track", async () => {
    const { unmount } = renderApps({ apps: [budgeted(10, 9)], hasProxiedRequests: true });
    const warning = await screen.findByRole("progressbar", { name: /monthly budget used/i });
    expect((warning.firstElementChild as HTMLElement).className).toContain("bg-amber-500");
    unmount();

    // Spending past the budget settles after the request that crossed it, so a
    // row really can report more than its own ceiling. It reads as full.
    renderApps({ apps: [budgeted(10, 14)], hasProxiedRequests: true });
    const over = await screen.findByRole("progressbar", { name: /monthly budget used/i });
    const fill = over.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-destructive");
    expect(fill.style.width).toBe("100%");
  });

  it("keeps a spent-against budget visible rather than rounding it away", async () => {
    renderApps({ apps: [budgeted(1000, 0.02)], hasProxiedRequests: true });

    const bar = await screen.findByRole("progressbar", { name: /monthly budget used/i });
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("2%");
  });

  it("draws every bar at one width, so two rows can be compared by eye", async () => {
    renderApps({
      apps: [
        { ...budgeted(2.5, 1.81), id: "small", name: "Small" },
        { ...budgeted(40000, 22377.82), id: "large", name: "Large" },
      ],
      hasProxiedRequests: true,
    });

    const bars = await screen.findAllByRole("progressbar", { name: /monthly budget used/i });
    expect(bars).toHaveLength(2);
    // The figures differ in length by half a dozen characters; the track they
    // sit under does not, or the two fills would not mean the same thing.
    expect(bars[0]!.className).toBe(bars[1]!.className);
    expect(bars[0]!.className).toContain("w-28");
  });

  it("draws no bar for an app with no budget, which says so with a sign", async () => {
    renderApps({ apps: [budgeted(null, 5)], hasProxiedRequests: true });

    expect(await screen.findByTitle(/no monthly budget/i)).toBeTruthy();
    // An empty track would read as an untouched budget rather than an absent one.
    expect(screen.queryByRole("progressbar", { name: /monthly budget used/i })).toBeNull();
  });
});

describe("returning from a completed checkout", () => {
  it("announces the purchase and spends the marker", async () => {
    const success = vi.spyOn(toast, "success");
    const { router } = renderApps({}, { route: "/apps?checkout=success" });

    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(success.mock.calls[0]?.[0]).toBe("Payment complete");
    // Spent, so a reload of the page it left behind announces nothing.
    await waitFor(() => expect(router.location.search).toBe(""));
  });

  it("keeps the rest of the query when it strips the marker", async () => {
    vi.spyOn(toast, "success");
    const { router } = renderApps({}, { route: "/apps?checkout=success&month=2026-08" });

    await waitFor(() => expect(router.location.search).toBe("?month=2026-08"));
  });

  it("says nothing on an ordinary visit", async () => {
    const success = vi.spyOn(toast, "success");
    renderApps({}, { route: "/apps" });

    // Waits for the page to have actually settled, so "nothing was announced"
    // is a conclusion rather than a race won.
    expect(await screen.findByText(/no apps yet/i)).toBeTruthy();
    expect(success).not.toHaveBeenCalled();
  });

});
