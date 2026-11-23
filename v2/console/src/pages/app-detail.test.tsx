import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { AppDetailPage, JOB_CHECK_OVERDUE_MS, jobCheckOverdue, routingOf, scopeOf } from "./app-detail";
import { testApp } from "@/test/fixtures";
import { renderAuthenticated, settled } from "@/test/render";

const APP_URL = "/v2/admin/apps/my-app";

const PROVIDERS = {
  providers: [
    { id: "p1", type: "openai", slug: "openai", name: "OpenAI main", status: "active", secretHint: "abcd", baseUrl: null, pricing: null, revision: 1, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
    { id: "p2", type: "openai", slug: "openai-eu", name: "OpenAI EU", status: "active", secretHint: "efgh", baseUrl: null, pricing: null, revision: 1, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
  ],
};

const USERS = {
  app_id: "my-app",
  month: "2026-11",
  total: 2,
  limit: 50,
  offset: 0,
  users: [
    { id: "user-a", status: "active", installs: 0, is_install: false, created_at: "2026-11-01T00:00:00.000Z", last_seen_at: null, is_virtual: false, usage: { charges: 3, failed: 0, cost_nano: 1_500_000_000, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    { id: "header-only", status: "active", installs: 0, is_install: false, created_at: null, last_seen_at: null, is_virtual: true, usage: { charges: 1, failed: 0, cost_nano: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
  ],
};

type Answer = { status?: number; body: unknown };

/** Routes by method and path; anything else is the app itself. */
const NO_USAGE = { charges: 0, failed: 0, unpriced: 0, cost_nano: 0, cost_usd: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, session_ms: 0 };

function stub(routes: Record<string, Answer> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const answer =
      routes[`${method} ${url}`] ??
      (url === "/v2/admin/providers"
        ? { body: PROVIDERS }
        : url === `${APP_URL}/snippet`
          ? { body: { app_id: "my-app", base_url: "https://gateway.test", examples: [], notes: [] } }
          : url.startsWith(`${APP_URL}/charges`)
          ? { body: { app_id: "my-app", limit: 1, next_before: null, charges: [] } }
          : url.startsWith(`${APP_URL}/usage`)
            ? { body: { app_id: "my-app", month: "2026-11", ...NO_USAGE, first_usage_day: null } }
            : { body: { app: testApp() } });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const putBody = (fetchMock: ReturnType<typeof stub>) => {
  const found = fetchMock.mock.calls.find(([input, init]) => String(input) === APP_URL && init?.method === "PUT");
  return found ? JSON.parse(String(found[1]!.body)) : undefined;
};

function renderTab(tab: string, capabilities: { conversationStorage?: boolean } = {}) {
  return renderAuthenticated(
    <Routes>
      <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
    </Routes>,
    { route: `/apps/my-app/${tab}`, capabilities },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("routingOf and scopeOf", () => {
  it("saves a connection's draft as its routing entry, or nothing when it is not allowed", () => {
    expect(routingOf({ allowed: false, operations: ["openai.chat"], models: "", maxOutputTokens: "" })).toBeNull();
    expect(routingOf({ allowed: true, operations: ["openai.chat"], models: " gpt-a, gpt-b, gpt-a ", maxOutputTokens: "500" })).toEqual({
      operations: ["openai.chat"],
      models: ["gpt-a", "gpt-b"],
      max_output_tokens: 500,
    });
  });

  it("turns typed limits into numbers and nano-dollars, refusing what is not a number", () => {
    expect(scopeOf({ perMinute: "10", perDay: "", monthlyDollars: "2.5" })).toEqual({
      requests: { per_minute: 10, per_day: null },
      monthly_nano: 2_500_000_000,
    });
    expect(scopeOf({ perMinute: "0", perDay: "", monthlyDollars: "" })).toBeNull();
    expect(scopeOf({ perMinute: "", perDay: "", monthlyDollars: "lots" })).toBeNull();
  });
});

describe("AppDetailPage", () => {
  it("allows another connection with its first operation, saving at the read revision", async () => {
    const fetchMock = stub({ [`PUT ${APP_URL}`]: { body: { app: testApp({ revision: 3 }) } } });
    renderTab("providers");

    await userEvent.click(await screen.findByRole("checkbox", { name: "Allow openai-eu" }));
    await userEvent.click(screen.getByRole("button", { name: /save providers/i }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    const body = putBody(fetchMock);
    expect(body.revision).toBe(2);
    expect(body.config.routing.providers).toEqual({
      openai: { operations: ["openai.chat"] },
      "openai-eu": { operations: ["openai.chat"] },
    });
  });

  it("keeps the app's model rewrites when the providers are saved", async () => {
    const withRewrites = testApp({ config: { ...testApp().config, routing: { ...testApp().config.routing, model_rewrites: { house: "gpt-a" } } } });
    const fetchMock = stub({ [`GET ${APP_URL}`]: { body: { app: withRewrites } }, [`PUT ${APP_URL}`]: { body: { app: withRewrites } } });
    renderTab("providers");

    await userEvent.click(await screen.findByRole("checkbox", { name: "Allow openai-eu" }));
    await userEvent.click(screen.getByRole("button", { name: /save providers/i }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    expect(putBody(fetchMock).config.routing.model_rewrites).toEqual({ house: "gpt-a" });
  });

  it("saves limits in nano-dollars", async () => {
    const fetchMock = stub({ [`PUT ${APP_URL}`]: { body: { app: testApp({ revision: 3 }) } } });
    renderTab("limits");

    const budgets = await screen.findAllByLabelText(/monthly budget/i);
    await userEvent.type(budgets[0]!, "1.25");
    await userEvent.type(screen.getAllByLabelText(/requests per minute/i)[1]!, "600");
    await userEvent.click(screen.getByRole("button", { name: /save limits/i }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    const { limits } = putBody(fetchMock).config;
    expect(limits.per_user.spending.monthly_nano).toBe(1_250_000_000);
    expect(limits.per_app.requests.per_minute).toBe(600);
  });

  it("explains a save refused because the app changed meanwhile", async () => {
    stub({ [`PUT ${APP_URL}`]: { status: 409, body: { error: { code: "app_revision_conflict", message: "stale" } } } });
    const error = vi.spyOn(toast, "error");
    renderTab("limits");
    await userEvent.type((await screen.findAllByLabelText(/requests per day/i))[1]!, "5");
    await userEvent.click(screen.getByRole("button", { name: /save limits/i }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/changed since you opened it/i)));
  });

  it("lists users with their spend, and blocks only real ones", async () => {
    const fetchMock = stub({
      "GET /v2/admin/apps/my-app/users?limit=50&offset=0": { body: USERS },
      "POST /v2/admin/apps/my-app/users/user-a/block": { body: { app_id: "my-app", user_id: "user-a", blocked: true } },
    });
    renderTab("users");

    const row = (await screen.findByText("user-a")).closest("tr")!;
    expect(within(row).getByText("$1.50")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions for header-only" })).toBeNull();

    await userEvent.click(within(row).getByRole("button", { name: "Actions for user-a" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /block/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input, init]) => String(input) === "/v2/admin/apps/my-app/users/user-a/block" && init?.method === "POST")).toBe(true),
    );
  });

  it("lists the app's jobs with their estimate, correction, total and state", async () => {
    stub({
      "GET /v2/admin/apps/my-app/jobs?limit=50&offset=0": {
        body: {
          app_id: "my-app",
          total: 2,
          limit: 50,
          offset: 0,
          jobs: [
            { id: "job-1", provider_slug: "fal", operation: "fal.queue", model: "fal-ai/flux/dev", end_user_id: "u", submitted_at: "2026-11-01T00:00:00.000Z", estimate_nano: 50_000_000, correction_nano: 50_000_000, total_nano: 100_000_000, measured: "estimated", price_source: "list_rate", state: "settled", settled_at: "2026-11-01T00:01:00.000Z" },
            { id: "job-2", provider_slug: "fal", operation: "fal.queue", model: "fal-ai/ltx-video", end_user_id: "u", submitted_at: "2026-11-01T00:00:00.000Z", estimate_nano: 20_000_000, correction_nano: null, total_nano: 20_000_000, measured: "estimated", price_source: "list_rate", state: "checking", settled_at: null },
          ],
        },
      },
    });
    renderTab("jobs");
    const settledRow = (await screen.findByText("fal-ai/flux/dev")).closest("tr")!;
    expect(within(settledRow).getByText("Settled")).toBeTruthy();
    expect(within(settledRow).getByText("$0.10")).toBeTruthy();
    const checkingRow = screen.getByText("fal-ai/ltx-video").closest("tr")!;
    expect(within(checkingRow).getByText("Checking")).toBeTruthy();
    expect(within(checkingRow).getByText("—")).toBeTruthy();
  });

  it("flags a job check that is well past its due time as overdue", async () => {
    stub({
      "GET /v2/admin/apps/my-app/jobs?limit=50&offset=0": {
        body: {
          app_id: "my-app",
          total: 2,
          limit: 50,
          offset: 0,
          jobs: [
            { id: "late", provider_slug: "fal", operation: "fal.queue", model: "fal-ai/flux/dev", end_user_id: "u", submitted_at: "2020-01-01T00:00:00.000Z", estimate_nano: 1, correction_nano: null, total_nano: 1, measured: "estimated", price_source: "list_rate", state: "checking", settled_at: null, next_check_at: "2020-01-01T00:02:00.000Z" },
            { id: "on-time", provider_slug: "fal", operation: "fal.queue", model: "fal-ai/ltx-video", end_user_id: "u", submitted_at: "2020-01-01T00:00:00.000Z", estimate_nano: 1, correction_nano: null, total_nano: 1, measured: "estimated", price_source: "list_rate", state: "checking", settled_at: null, next_check_at: "2999-01-01T00:00:00.000Z" },
          ],
        },
      },
    });
    renderTab("jobs");
    const lateRow = (await screen.findByText("fal-ai/flux/dev")).closest("tr")!;
    expect(within(lateRow).getByText(/overdue/i)).toBeTruthy();
    const onTimeRow = screen.getByText("fal-ai/ltx-video").closest("tr")!;
    expect(within(onTimeRow).queryByText(/overdue/i)).toBeNull();
  });

  it("marks a check overdue while the tab stays open, and asks for the jobs again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse("2026-11-01T12:00:00.000Z") });
    try {
      const fetchMock = stub({
        "GET /v2/admin/apps/my-app/jobs?limit=50&offset=0": {
          body: {
            app_id: "my-app",
            total: 1,
            limit: 50,
            offset: 0,
            jobs: [
              { id: "soon", provider_slug: "fal", operation: "fal.queue", model: "fal-ai/flux/dev", end_user_id: "u", submitted_at: "2026-11-01T11:59:00.000Z", estimate_nano: 1, correction_nano: null, total_nano: 1, measured: "estimated", price_source: "list_rate", state: "checking", settled_at: null, next_check_at: "2026-11-01T12:01:00.000Z" },
            ],
          },
        },
      });
      renderTab("jobs");
      const row = (await screen.findByText("fal-ai/flux/dev")).closest("tr")!;
      expect(within(row).queryByText(/overdue/i)).toBeNull();
      const jobCalls = () => fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/v2/admin/apps/my-app/jobs")).length;
      const before = jobCalls();
      await vi.advanceTimersByTimeAsync(7 * 60_000);
      await waitFor(() => expect(within(screen.getByText("fal-ai/flux/dev").closest("tr")!).getByText(/overdue/i)).toBeTruthy());
      expect(jobCalls()).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last jobs and their warnings when a background refresh fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse("2026-11-01T12:10:00.000Z") });
    try {
      const routes: Record<string, Answer> = {
        "GET /v2/admin/apps/my-app/jobs?limit=50&offset=0": {
          body: {
            app_id: "my-app",
            total: 1,
            limit: 50,
            offset: 0,
            jobs: [
              { id: "late", provider_slug: "fal", operation: "fal.queue", model: "fal-ai/flux/dev", end_user_id: "u", submitted_at: "2026-11-01T11:59:00.000Z", estimate_nano: 1, correction_nano: null, total_nano: 1, measured: "estimated", price_source: "list_rate", state: "checking", settled_at: null, next_check_at: "2026-11-01T12:01:00.000Z" },
            ],
          },
        },
      };
      stub(routes);
      renderTab("jobs");
      const row = (await screen.findByText("fal-ai/flux/dev")).closest("tr")!;
      expect(within(row).getByText(/overdue/i)).toBeTruthy();
      routes["GET /v2/admin/apps/my-app/jobs?limit=50&offset=0"] = { status: 503, body: { error: { code: "unavailable", message: "Try again" } } };
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await waitFor(() => expect(screen.getByText(/could not refresh the jobs/i)).toBeTruthy());
      expect(within(screen.getByText("fal-ai/flux/dev").closest("tr")!).getByText(/overdue/i)).toBeTruthy();
      expect(screen.queryByText(/could not load the jobs/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Previous while the next page loads or fails", async () => {
    const job = (id: string) => ({ id, provider_slug: "fal", operation: "fal.queue", model: `model-${id}`, end_user_id: "u", submitted_at: "2026-11-01T11:59:00.000Z", estimate_nano: 1, correction_nano: null, total_nano: 1, measured: "estimated", price_source: "list_rate", state: "settled", settled_at: "2026-11-01T12:00:00.000Z" });
    stub({
      "GET /v2/admin/apps/my-app/jobs?limit=50&offset=0": {
        body: { app_id: "my-app", total: 51, limit: 50, offset: 0, jobs: Array.from({ length: 50 }, (_, i) => job(`j${i}`)) },
      },
      "GET /v2/admin/apps/my-app/jobs?limit=50&offset=50": { status: 503, body: { error: { code: "unavailable", message: "Try again" } } },
    });
    renderTab("jobs");
    await screen.findByText("model-j0");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText(/could not load the jobs/i)).toBeTruthy());
    const previous = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    expect(previous.disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(previous);
    expect(await screen.findByText("model-j0")).toBeTruthy();
  });

  it("calls a check overdue only once it is more than five minutes late", () => {
    const due = Date.parse("2026-11-01T00:00:00.000Z");
    const job = { state: "checking" as const, next_check_at: new Date(due).toISOString() };
    expect(jobCheckOverdue(job, due + JOB_CHECK_OVERDUE_MS)).toBe(false);
    expect(jobCheckOverdue(job, due + JOB_CHECK_OVERDUE_MS + 1)).toBe(true);
    expect(jobCheckOverdue({ ...job, state: "settled" }, due + 10 * JOB_CHECK_OVERDUE_MS)).toBe(false);
    expect(jobCheckOverdue({ state: "checking", next_check_at: undefined }, due)).toBe(false);
  });

  it("creates an app key and shows it once", async () => {
    stub({
      "GET /v2/admin/apps/my-app/keys": { body: { app_id: "my-app", keys: [] } },
      "POST /v2/admin/apps/my-app/keys": { body: { id: "k2", name: "CI", key: "agw_app_new", key_prefix: "agw_app_", created_at: "2026-11-01T00:00:00.000Z" } },
    });
    renderTab("keys");
    await userEvent.click(await screen.findByRole("button", { name: /new key/i }));
    await userEvent.type(screen.getByLabelText(/key name/i), "CI");
    await userEvent.click(screen.getByRole("button", { name: /create key/i }));
    expect(await screen.findByDisplayValue("agw_app_new")).toBeTruthy();
  });

  it("has no keys tab for an App Attest app", async () => {
    stub({
      [`GET ${APP_URL}`]: {
        body: {
          app: testApp({
            config: {
              ...testApp().config,
              authentication: { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.app", environments: ["production"], verify_on: "every_request" } },
            },
          }),
        },
      },
    });
    renderTab("overview");
    expect(await screen.findByRole("link", { name: "Providers" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Keys" })).toBeNull();
  });

  const CHECK = { [`GET ${APP_URL}/check`]: { body: { app_id: "my-app", ready: true, providers: [], limitations: [] } } };

  it("says on the overview when the app has made no call yet", async () => {
    stub(CHECK);
    renderTab("overview");
    expect(await screen.findByText(/No calls yet/u)).toBeTruthy();
  });

  it("says on the overview when the app has made calls, from its usage totals, linking to its usage", async () => {
    stub({
      ...CHECK,
      [`GET ${APP_URL}/usage`]: { body: { app_id: "my-app", month: "2026-11", ...NO_USAGE, first_usage_day: "2026-08-02" } },
    });
    renderTab("overview");
    expect(await screen.findByText(/This app has made calls, the first on 2026-08-02/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See usage" }).getAttribute("href")).toBe("/apps/my-app/usage");
  });

  it("asks an older gateway, whose usage has no first day, for its newest charge instead", async () => {
    stub({
      ...CHECK,
      [`GET ${APP_URL}/usage`]: { body: { app_id: "my-app", month: "2026-11", ...NO_USAGE } },
      [`GET ${APP_URL}/charges?limit=1`]: {
        body: { app_id: "my-app", limit: 1, next_before: null, charges: [{ id: "c1", used_at: "2026-11-02T10:00:00.000Z", usage_day: "2026-11-02" }] },
      },
    });
    renderTab("overview");
    expect(await screen.findByText(/This app has made calls, one on 2026-11-02/u)).toBeTruthy();
  });

  it("shows the first requests the gateway builds for the app, each ready to copy, with its notes", async () => {
    const curl = "printf 'header = \"Authorization: Bearer %s\"\\n' \"$APP_AI_GATEWAY_KEY\" | curl --config - 'https://gateway.test/v2/apps/my-app/proxy/openai/v1/chat/completions'";
    const described = 'POST https://gateway.test/v2/apps/my-app/presets/support\nContent-Type: application/json\n(The Swift SDK adds the gateway token and the App Attest proof.)\n\n{\n  "messages": []\n}';
    stub({
      ...CHECK,
      [`GET ${APP_URL}/snippet`]: {
        body: {
          app_id: "my-app",
          base_url: "https://gateway.test",
          examples: [
            { provider: "openai", operation: "openai.chat", style: "openai-chat", method: "POST", url: "https://gateway.test/v2/apps/my-app/proxy/openai/v1/chat/completions", model: "gpt-4o-mini", headers: {}, curl, text: curl },
            {
              preset: "support",
              operation: "openai.chat",
              style: "openai-chat",
              method: "POST",
              url: "https://gateway.test/v2/apps/my-app/presets/support",
              model: null,
              headers: { "Content-Type": "application/json" },
              body: { messages: [] },
              text: described,
            },
          ],
          notes: ["Set APP_AI_GATEWAY_KEY to one of this app's keys."],
        },
      },
    });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderTab("overview");
    const chat = await screen.findByRole("region", { name: "openai openai-chat" });
    expect(within(chat).getByText(/gpt-4o-mini/u)).toBeTruthy();
    expect(chat.querySelector("pre")!.textContent).toBe(curl);
    // Without curl, the whole request as the gateway described it.
    const preset = screen.getByRole("region", { name: "Preset support openai-chat" });
    expect(preset.querySelector("pre")!.textContent).toBe(described);
    expect(screen.getByText("Set APP_AI_GATEWAY_KEY to one of this app's keys.")).toBeTruthy();
    await userEvent.click(within(chat).getByRole("button", { name: "Copy: openai openai-chat" }));
    expect(writeText).toHaveBeenCalledWith(curl);
  });

  it("shows an issuer app's token exchange as a whole command block, never inside a note", async () => {
    const exchange = "( set +x; printf 'data = {}\\n' | curl --disable --config - 'https://gateway.test/v2/apps/my-app/auth/token' \\\n  -H 'Content-Type: application/json' )";
    stub({
      ...CHECK,
      [`GET ${APP_URL}/snippet`]: { body: { app_id: "my-app", base_url: "https://gateway.test", examples: [], notes: ["Exchange first."], exchange } },
    });
    renderTab("overview");
    const block = await screen.findByRole("region", { name: "Exchange for a gateway token" });
    expect(block.querySelector("pre")!.textContent).toBe(exchange);
  });

  it("offers the Usage and Errors tabs beside the others", async () => {
    stub(CHECK);
    renderTab("overview");
    expect((await screen.findByRole("link", { name: "Usage" })).getAttribute("href")).toBe("/apps/my-app/usage");
    expect(screen.getByRole("link", { name: "Errors" }).getAttribute("href")).toBe("/apps/my-app/errors");
  });

  it("starts an app's tabs afresh when moving straight from one app to another (Neon 7b-6)", async () => {
    // Each app answers as itself, with an older page of sign-ins and refusals to go to. The
    // Errors tab pages like the Usage tab, with no chart to load.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const id = /^\/v2\/admin\/apps\/([^/?]+)/u.exec(url)?.[1] ?? "";
      const page = { app_id: id, limit: 25, next_before: `cursor-of-${id}`, events: [] };
      const body = url.includes("/auth-events/summary")
        ? {
            app_id: id,
            days: 30,
            from: "2026-08-01",
            to: "2026-08-30",
            daily: [],
            failing_networks: [],
            failed_charges: [],
            rejection_samples: [],
            token_exchange: { total: 0, ok: 0, success_rate: null },
            claim_delay: { count: 0, avg_ms: null, p50_ms: null, p95_ms: null },
            pending_users: 0,
          }
        : url.includes("/auth-events") || url.includes("/rejection-events")
          ? page
          : url === "/v2/admin/providers"
            ? PROVIDERS
            : { app: testApp({ id, name: id }) };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ delay: null });
    const { client } = renderAuthenticated(
      <>
        <Link to="/apps/app-one/errors">To app one</Link>
        <Link to="/apps/app-two/errors">To app two</Link>
        <Routes>
          <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
        </Routes>
      </>,
      { route: "/apps/app-two/errors" },
    );
    // App two is read once, so it is cached when the person comes back to it.
    await screen.findByRole("heading", { name: "app-two" });
    await user.click(screen.getByRole("link", { name: "To app one" }));
    await screen.findByRole("heading", { name: "app-one" });
    await settled(client);
    const listUrls = () =>
      fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => /\/(auth|rejection)-events\?/u.test(url));
    for (const older of screen.getAllByRole("button", { name: "Older" })) await user.click(older);
    await waitFor(() => expect(listUrls().some((url) => url.includes("cursor-of-app-one"))).toBe(true));
    const before = listUrls().length;
    await user.click(screen.getByRole("link", { name: "To app two" }));
    await screen.findByRole("heading", { name: "app-two" });
    await settled(client);
    // Back on app two, straight from the cache: its own first pages, never app one's cursors.
    expect(listUrls().slice(before).every((url) => !url.includes("before="))).toBe(true);
    for (const newer of screen.getAllByRole("button", { name: "Newer" })) expect(newer.hasAttribute("disabled")).toBe(true);
  });

  it("sends an explicit null configuration as typed, for the gateway to refuse", async () => {
    const fetchMock = stub({ [`PUT ${APP_URL}`]: { status: 400, body: { error: { code: "invalid_request", message: "config: required" } } } });
    renderTab("settings");
    const editor = await screen.findByLabelText("Configuration");
    await userEvent.clear(editor);
    await userEvent.type(editor, "null");
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    await waitFor(() => expect(putBody(fetchMock)).toMatchObject({ config: null }));
  });

  it("deletes the app only with the typed id, which the request repeats", async () => {
    const fetchMock = stub({ [`DELETE ${APP_URL}?confirm=my-app`]: { body: { deleted: true } } });
    renderTab("settings");
    await userEvent.click(await screen.findByRole("button", { name: /^delete app$/i }));
    await userEvent.type(await screen.findByLabelText(/to continue/i), "my-app");
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^delete app$/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `${APP_URL}?confirm=my-app` && init?.method === "DELETE")).toBe(true),
    );
  });

  it("asks before leaving Settings with an unsaved conversation-history change, once for the whole tab", async () => {
    stub();
    const { router } = renderTab("settings", { conversationStorage: true });
    await userEvent.click(await screen.findByRole("switch", { name: "Store conversations" }));
    await userEvent.click(screen.getByRole("link", { name: "Limits" }));
    expect(await screen.findAllByText(/leave without saving/i)).toHaveLength(1);
    expect(router.location.pathname).toBe("/apps/my-app/settings");
    await userEvent.click(screen.getByRole("button", { name: /^leave$/i }));
    await waitFor(() => expect(router.location.pathname).toBe("/apps/my-app/limits"));
  });

  it("asks before leaving Settings with an unsaved configuration", async () => {
    stub();
    const { router } = renderTab("settings");
    const box = await screen.findByRole("textbox", { name: "Configuration" });
    fireEvent.change(box, { target: { value: "{}" } });
    await userEvent.click(screen.getByRole("link", { name: "Limits" }));
    expect(await screen.findByText(/leave without saving/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText(/leave without saving/i)).toBeNull());
    expect(router.location.pathname).toBe("/apps/my-app/settings");
  });

  it("leaves without asking once the app it edits is deleted", async () => {
    stub({ [`DELETE ${APP_URL}?confirm=my-app`]: { body: { deleted: true } } });
    const { router } = renderTab("settings");
    const box = await screen.findByRole("textbox", { name: "Configuration" });
    fireEvent.change(box, { target: { value: "{}" } });
    await userEvent.click(screen.getByRole("button", { name: /^delete app$/i }));
    await userEvent.type(await screen.findByLabelText(/to continue/i), "my-app");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^delete app$/i }));
    await waitFor(() => expect(router.location.pathname).toBe("/apps"));
    expect(screen.queryByText(/leave without saving/i)).toBeNull();
  });

  it("keeps an unsaved configuration when the app changed meanwhile, and says so", async () => {
    // Someone else changed the configuration; the rename's answer and every
    // later read carry that change.
    const changed = testApp({ name: "Renamed", revision: 3, config: { ...testApp().config, routing: { providers: {} } } });
    let renamed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === APP_URL && init?.method === "PUT") renamed = true;
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        return new Response(JSON.stringify({ app: renamed ? changed : testApp() }));
      }),
    );
    renderTab("settings");
    const editor = await screen.findByLabelText("Configuration");
    await userEvent.clear(editor);
    await userEvent.type(editor, '{{"mine":true}');
    const rename = screen.getByLabelText("Name");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    expect(await screen.findByText(/changed since you started editing/i)).toBeTruthy();
    expect((screen.getByLabelText("Configuration") as HTMLTextAreaElement).value).toBe('{"mine":true}');
    await userEvent.click(screen.getByRole("button", { name: /discard my edits/i }));
    expect((screen.getByLabelText("Configuration") as HTMLTextAreaElement).value).toBe(JSON.stringify(changed.config, null, 2));
  });

  it("ends the conflict notice once the kept draft is saved, so a fresh edit does not bring it back", async () => {
    const changed = testApp({ name: "Renamed", revision: 3, config: { ...testApp().config, routing: { providers: {} } } });
    let current = testApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        if (url === APP_URL && init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          // The rename lands on top of someone else's change; a later save
          // stores what it sent.
          // Like the gateway, the stored config gets its omitted defaults.
          const withDefaults = (config: Record<string, unknown>) => ({ ...config, limits: testApp().config.limits });
          current = current.revision === 2 ? changed : testApp({ ...body, config: withDefaults(body.config), revision: current.revision + 1 });
        }
        return new Response(JSON.stringify({ app: current }));
      }),
    );
    const { client } = renderTab("settings");
    // The draft leaves out `limits`, which the gateway fills in on save.
    const { limits: _omitted, ...withoutLimits } = testApp().config;
    const mine = { ...withoutLimits, routing: { providers: { openai: { operations: ["openai.chat"], models: ["gpt-a"] } } } };
    fireEvent.change(await screen.findByLabelText("Configuration"), { target: { value: JSON.stringify(mine) } });
    const rename = screen.getByLabelText("Name");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    expect(await screen.findByText(/changed since you started editing/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    await waitFor(() => expect(screen.queryByText(/changed since you started editing/i)).toBeNull());
    const next = { ...mine, routing: { providers: { openai: { operations: ["openai.chat"], models: ["gpt-b"] } } } };
    fireEvent.change(screen.getByLabelText("Configuration"), { target: { value: JSON.stringify(next) } });
    await settled(client);
    expect(screen.queryByText(/changed since you started editing/i)).toBeNull();
  });

  it("locks the name and configuration while a save runs", async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        if (url === APP_URL && init?.method === "PUT") return new Promise<Response>((resolve) => (answer = resolve));
        return new Response(JSON.stringify({ app: testApp() }));
      }),
    );
    renderTab("settings");
    const rename = await screen.findByLabelText("Name");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true));
    expect((screen.getByLabelText("Configuration") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^check$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /save configuration/i }) as HTMLButtonElement).disabled).toBe(true);
    answer(new Response(JSON.stringify({ app: testApp({ name: "Renamed", revision: 3 }) })));
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false));
  });

  it("locks the limits and providers forms while their save runs", async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        if (url === APP_URL && init?.method === "PUT") return new Promise<Response>((resolve) => (answer = resolve));
        return new Response(JSON.stringify({ app: testApp() }));
      }),
    );
    const view = renderTab("limits");
    await userEvent.type((await screen.findAllByLabelText(/requests per minute/i))[1]!, "600");
    await userEvent.click(screen.getByRole("button", { name: /save limits/i }));
    await waitFor(() => expect((screen.getAllByLabelText(/requests per minute/i)[1] as HTMLInputElement).disabled).toBe(true));
    answer(new Response(JSON.stringify({ app: testApp({ revision: 3 }) })));
    view.unmount();

    renderTab("providers");
    await userEvent.click(await screen.findByLabelText("Allow openai-eu"));
    await userEvent.click(screen.getByRole("button", { name: /save providers/i }));
    await waitFor(() => expect((screen.getByLabelText("Allow openai") as HTMLButtonElement).disabled).toBe(true));
    answer(new Response(JSON.stringify({ app: testApp({ revision: 3 }) })));
  });

  it("keeps the conflict notice after a rename while the configuration draft is still unsaved", async () => {
    const changed = testApp({ name: "Renamed", revision: 3, config: { ...testApp().config, routing: { providers: {} } } });
    let current = testApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        if (url === APP_URL && init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          current = current.revision === 2 ? changed : testApp({ ...current, name: body.name, revision: current.revision + 1 });
        }
        return new Response(JSON.stringify({ app: current }));
      }),
    );
    const { client } = renderTab("settings");
    const editor = await screen.findByLabelText("Configuration");
    await userEvent.clear(editor);
    await userEvent.type(editor, '{{"mine":true}');
    const rename = screen.getByLabelText("Name");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    expect(await screen.findByText(/changed since you started editing/i)).toBeTruthy();

    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Renamed again");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false));
    await settled(client);
    expect(screen.getByText(/changed since you started editing/i)).toBeTruthy();
  });

  it("says the providers could not load, rather than that every connection was removed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === "/v2/admin/providers"
          ? new Response(JSON.stringify({ error: { code: "internal_error", message: "boom" } }), { status: 500 })
          : new Response(JSON.stringify({ app: testApp() })),
      ),
    );
    renderTab("providers");
    expect(await screen.findByText(/could not load your providers/i)).toBeTruthy();
    expect(screen.queryByText(/was removed/i)).toBeNull();
  });

  it("keeps the conflict notice after a configuration save while the name draft is still unresolved", async () => {
    let current = testApp();
    let puts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        if (url === APP_URL && init?.method === "PUT") {
          puts += 1;
          if (puts === 1) {
            current = testApp({ name: "Production", revision: 3 });
            return new Response(JSON.stringify({ error: { code: "app_revision_conflict", message: "stale" } }), { status: 409 });
          }
          const body = JSON.parse(String(init.body));
          current = testApp({ ...current, config: body.config, revision: current.revision + 1 });
        }
        return new Response(JSON.stringify({ app: current }));
      }),
    );
    const { client } = renderTab("settings");
    const rename = await screen.findByLabelText("Name");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Mobile");
    fireEvent.change(screen.getByLabelText("Configuration"), {
      target: { value: JSON.stringify({ ...testApp().config, routing: { providers: {} } }) },
    });
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    expect(await screen.findByText(/changed since you started editing/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    await waitFor(() => expect(puts).toBe(2));
    await waitFor(() => expect((screen.getByLabelText("Configuration") as HTMLTextAreaElement).disabled).toBe(false));
    await settled(client);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Mobile");
    expect(screen.getByText(/changed since you started editing/i)).toBeTruthy();
  });

  it("says the keys or users could not load, rather than that there are none", async () => {
    stub({
      "GET /v2/admin/apps/my-app/keys": { status: 503, body: { error: { code: "internal_error", message: "boom" } } },
      "GET /v2/admin/apps/my-app/users?limit=50&offset=0": { status: 503, body: { error: { code: "internal_error", message: "boom" } } },
    });
    const view = renderTab("keys");
    expect(await screen.findByText(/could not load the keys/i)).toBeTruthy();
    expect(screen.queryByText("No keys.")).toBeNull();
    view.unmount();
    renderTab("users");
    expect(await screen.findByText(/could not load the users/i)).toBeTruthy();
    expect(screen.queryByText(/no users yet/i)).toBeNull();
  });

  it("saves the whole configuration as typed", async () => {
    const fetchMock = stub({ [`PUT ${APP_URL}`]: { body: { app: testApp({ revision: 3 }) } } });
    renderTab("settings");
    const editor = await screen.findByLabelText("Configuration");
    await userEvent.clear(editor);
    // The editor takes braces literally only when escaped for userEvent.
    await userEvent.type(editor, '{{"authentication":{{"type":"api_key","end_user":{{"source":"none"}}}');
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    await waitFor(() => expect(putBody(fetchMock)?.config).toEqual({ authentication: { type: "api_key", end_user: { source: "none" } } }));
  });

  it("turns conversation history on with the kept media and days, keeping the rest of the configuration", async () => {
    const fetchMock = stub({ [`PUT ${APP_URL}`]: { body: { app: testApp({ revision: 3 }) } } });
    renderTab("settings", { conversationStorage: true });

    await userEvent.click(await screen.findByRole("switch", { name: "Store conversations" }));
    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    const days = screen.getByLabelText("Keep for (days)");
    await userEvent.clear(days);
    await userEvent.type(days, "30");
    await userEvent.click(screen.getByRole("button", { name: /save conversation history/i }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    const { config } = putBody(fetchMock);
    expect(config.conversations).toEqual({ store: true, keep: { images: true, audio: false, files: true }, retention_days: 30 });
    expect(config.routing).toEqual(testApp().config.routing);
  });

  it("refuses days out of range before saving", async () => {
    stub();
    renderTab("settings", { conversationStorage: true });
    await userEvent.click(await screen.findByRole("switch", { name: "Store conversations" }));
    const days = screen.getByLabelText("Keep for (days)");
    await userEvent.clear(days);
    await userEvent.type(days, "401");
    expect(screen.getByText(/whole number from 1 to 400/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /save conversation history/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("cannot turn conversation history on where the deployment has no bucket", async () => {
    stub();
    renderTab("settings");
    expect(((await screen.findByRole("switch", { name: "Store conversations" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/not set up on this deployment/i)).toBeTruthy();
  });

  it("can still turn conversation history off where the deployment has no bucket", async () => {
    const storing = testApp({ config: { ...testApp().config, conversations: { store: true, keep: { images: true, audio: true, files: true }, retention_days: 180 } } });
    const fetchMock = stub({ [`GET ${APP_URL}`]: { body: { app: storing } }, [`PUT ${APP_URL}`]: { body: { app: testApp({ revision: 3 }) } } });
    renderTab("settings");
    await userEvent.click(await screen.findByRole("switch", { name: "Store conversations" }));
    await userEvent.click(screen.getByRole("button", { name: /save conversation history/i }));
    await waitFor(() => expect(putBody(fetchMock)?.config.conversations).toEqual({ store: false, keep: { images: true, audio: true, files: true }, retention_days: 180 }));
  });
});
