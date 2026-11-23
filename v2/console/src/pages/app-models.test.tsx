import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { AppDetailPage } from "./app-detail";
import { presetOperations, rewriteProblem } from "./app-models";
import { testApp } from "@/test/fixtures";
import { renderAuthenticated } from "@/test/render";

const APP_URL = "/v2/admin/apps/my-app";

const PROVIDERS = {
  providers: [
    { id: "p1", type: "openai", slug: "openai", name: "OpenAI main", status: "active", secretHint: "abcd", baseUrl: null, pricing: null, revision: 1, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
    { id: "p2", type: "anthropic", slug: "anthropic", name: "Anthropic", status: "active", secretHint: "efgh", baseUrl: null, pricing: null, revision: 1, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
  ],
};

type Answer = { status?: number; body: unknown };

function stub(app: unknown, put?: Answer) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const answer = method === "PUT" && url === APP_URL ? (put ?? { body: { app } }) : url === "/v2/admin/providers" ? { body: PROVIDERS } : { body: { app } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const putBody = (fetchMock: ReturnType<typeof stub>) => {
  const found = fetchMock.mock.calls.find(([input, init]) => String(input) === APP_URL && init?.method === "PUT");
  return found ? JSON.parse(String(found[1]!.body)) : undefined;
};

function renderTab(tab: string) {
  return renderAuthenticated(
    <Routes>
      <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
    </Routes>,
    { route: `/apps/my-app/${tab}` },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("rewriteProblem and presetOperations", () => {
  it("asks for both sides of every rewrite, once per model", () => {
    expect(rewriteProblem([{ from: "a", to: "b" }])).toBeUndefined();
    expect(rewriteProblem([{ from: "a", to: "" }])).toMatch(/both models/);
    expect(rewriteProblem([{ from: "a", to: "b" }, { from: " a ", to: "c" }])).toMatch(/rewritten twice/);
  });

  it("offers only the operations a preset can use", () => {
    const operations = presetOperations({ type: "openai" });
    expect(operations).toContain("openai.chat");
    expect(operations.every((name) => name.startsWith("openai."))).toBe(true);
    expect(operations).not.toContain("passthrough");
  });
});

describe("Rewrites tab", () => {
  it("adds a rewrite and saves it, keeping the providers", async () => {
    const fetchMock = stub(testApp());
    renderTab("rewrites");

    await userEvent.click(await screen.findByRole("button", { name: "Add rewrite" }));
    await userEvent.type(screen.getByLabelText("Rewrite 1: model asked for"), "house-model");
    expect(screen.getByRole("button", { name: "Save rewrites" }).hasAttribute("disabled")).toBe(true);
    await userEvent.type(screen.getByLabelText("Rewrite 1: model sent"), "gpt-5.5-mini");
    await userEvent.click(screen.getByRole("button", { name: "Save rewrites" }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    const body = putBody(fetchMock);
    expect(body.config.routing).toEqual({ providers: testApp().config.routing.providers, model_rewrites: { "house-model": "gpt-5.5-mini" } });
  });

  it("leaves the field out once the last rewrite is removed", async () => {
    const app = testApp({ config: { ...testApp().config, routing: { ...testApp().config.routing, model_rewrites: { a: "b" } } } });
    const fetchMock = stub(app);
    renderTab("rewrites");

    await userEvent.click(await screen.findByRole("button", { name: "Remove rewrite 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save rewrites" }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    expect(putBody(fetchMock).config.routing).toEqual({ providers: testApp().config.routing.providers });
  });
});

describe("Presets tab", () => {
  it("adds a preset with parameters, a cap and a fallback, and saves it", async () => {
    const fetchMock = stub(testApp());
    renderTab("presets");

    await userEvent.click(await screen.findByRole("button", { name: "Add preset" }));
    await userEvent.type(screen.getByLabelText("Name"), "summarize");
    await userEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    await userEvent.click(await screen.findByRole("option", { name: "openai" }));
    expect(screen.getByRole("combobox", { name: "Operation" }).textContent).toContain("openai.chat");
    await userEvent.type(screen.getByLabelText("Model"), "gpt-5.5-mini");
    await userEvent.type(screen.getByLabelText("Most output tokens"), "500");
    await userEvent.click(screen.getByLabelText("Fixed parameters (JSON)"));
    await userEvent.paste('{"temperature": 0.2}');
    await userEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    await userEvent.click(screen.getAllByRole("combobox", { name: "Provider" })[1]!);
    await userEvent.click(await screen.findByRole("option", { name: "openai" }));
    await userEvent.type(screen.getAllByLabelText("Model")[1]!, "gpt-5.5-nano");
    await userEvent.click(screen.getByRole("button", { name: "Save presets" }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    const body = putBody(fetchMock);
    expect(body.config.presets).toEqual({
      summarize: {
        provider: "openai",
        operation: "openai.chat",
        model: "gpt-5.5-mini",
        params: { temperature: 0.2 },
        max_output_tokens: 500,
        fallback: [{ provider: "openai", model: "gpt-5.5-nano" }],
      },
    });
    expect(body.config.routing).toEqual(testApp().config.routing);
  });

  it("checks the name and the parameters before saving", async () => {
    stub(testApp());
    renderTab("presets");

    await userEvent.click(await screen.findByRole("button", { name: "Add preset" }));
    await userEvent.type(screen.getByLabelText("Name"), "Bad Name");
    await userEvent.type(screen.getByLabelText("Fixed parameters (JSON)"), "not json");

    expect(screen.getByText("Use 1 to 64 characters from a-z, 0-9 and -.")).toBeTruthy();
    expect(screen.getByText("Not valid JSON.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows a refusal about one preset's field beside that field", async () => {
    const app = testApp({ config: { ...testApp().config, presets: { quick: { provider: "openai", operation: "openai.chat", model: "gpt-5.5-mini" } } } });
    stub(app, { status: 400, body: { error: { code: "invalid_request", message: "config.presets.quick.model: gpt-unknown has no price" } } });
    renderTab("presets");

    const model = await screen.findByLabelText("Model");
    await userEvent.clear(model);
    await userEvent.type(model, "gpt-unknown");
    await userEvent.click(screen.getByRole("button", { name: "Save presets" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getAllByText("gpt-unknown has no price").length).toBeGreaterThan(0);
  });

  it("removes a preset, leaving the field out when none is left", async () => {
    const app = testApp({ config: { ...testApp().config, presets: { quick: { provider: "openai", operation: "openai.chat", model: "gpt-5.5-mini" } } } });
    const fetchMock = stub(app);
    renderTab("presets");

    await userEvent.click(await screen.findByRole("button", { name: "Remove preset quick" }));
    await userEvent.click(screen.getByRole("button", { name: "Save presets" }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    expect(putBody(fetchMock).config).not.toHaveProperty("presets");
  });
});
