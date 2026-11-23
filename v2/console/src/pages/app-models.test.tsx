import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { AppDetailPage } from "./app-detail";
import { presetOperations, rewriteProblem } from "./app-models";
import { appServer } from "@/test/app-server";
import { testApp } from "@/test/fixtures";
import { renderAuthenticated } from "@/test/render";
import { chooseOption } from "@/test/select";

const connection = (id: string, type: string, slug: string) => ({
  id, type, slug, name: slug, status: "active", secretHint: "abcd", baseUrl: null, pricing: null, revision: 1,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
});

const PROVIDERS = {
  "/v2/admin/providers": {
    providers: [
      connection("p1", "openai", "openai"),
      connection("p2", "openai", "openai-eu"),
      connection("p3", "anthropic", "anthropic"),
      connection("p4", "gemini", "gemini"),
      connection("p5", "gemini", "gemini-eu"),
    ],
  },
};

function appWith(config: Record<string, unknown>) {
  return testApp({ config: { ...testApp().config, ...config } });
}

function renderTab(tab: string) {
  return renderAuthenticated(
    <Routes>
      <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
    </Routes>,
    { route: `/apps/my-app/${tab}` },
  );
}

/** The field a label names: its label, input and any problem said under it. */
const fieldOf = (label: string | HTMLElement) =>
  (typeof label === "string" ? screen.getByLabelText(label) : label).closest("div.space-y-2") as HTMLElement;

/** Saves, and waits until the save went through and the form is clean again. */
async function saveAndSettle(button: string, done: string) {
  const saved = vi.spyOn(toast, "success");
  await userEvent.click(screen.getByRole("button", { name: button }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(done));
  await waitFor(() => expect(screen.getByRole("button", { name: button }).hasAttribute("disabled")).toBe(true));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rewriteProblem and presetOperations", () => {
  it("asks for both sides of every rewrite, once per model, within the contract's limits", () => {
    expect(rewriteProblem([{ from: "a", to: "b" }])).toBeUndefined();
    expect(rewriteProblem([{ from: "a", to: "" }])).toMatch(/both models/);
    expect(rewriteProblem([{ from: "a", to: "b" }, { from: " a ", to: "c" }])).toMatch(/rewritten twice/);
    expect(rewriteProblem([{ from: "a", to: "m".repeat(201) }])).toMatch(/^a: /);
  });

  it("offers only the operations a preset can use", () => {
    const operations = presetOperations({ type: "openai" });
    expect(operations).toContain("openai.chat");
    expect(operations.every((name) => name.startsWith("openai."))).toBe(true);
    expect(operations).not.toContain("passthrough");
  });

  it("offers a custom provider's operation only at a path a preset can use, as the gateway judges it", () => {
    const custom = (path: string) => ({ type: "custom", baseUrl: "https://llm.example.test", passthrough: [{ method: "POST" as const, path, style: "openai-chat" as const }] });
    expect(presetOperations(custom("v1/chat/{deployment}/completions"))).toEqual([]);
    expect(presetOperations(custom("v1/chat/completions"))).toEqual(["custom.openai-chat"]);
  });
});

describe("Rewrites tab", () => {
  it("adds the first rewrite as one operation, and the saved form is clean", async () => {
    const server = appServer(testApp());
    renderTab("rewrites");

    await userEvent.click(await screen.findByRole("button", { name: "Add rewrite" }));
    await userEvent.type(screen.getByLabelText("Rewrite 1: model asked for"), "house-model");
    expect(screen.getByRole("button", { name: "Save rewrites" }).hasAttribute("disabled")).toBe(true);
    await userEvent.type(screen.getByLabelText("Rewrite 1: model sent"), "gpt-5.5-mini");
    await saveAndSettle("Save rewrites", "Rewrites saved");

    expect(server.patches).toEqual([
      { revision: 2, operations: [{ op: "add", path: "/config/routing/model_rewrites", value: { "house-model": "gpt-5.5-mini" } }] },
    ]);
    expect((screen.getByLabelText("Rewrite 1: model sent") as HTMLInputElement).value).toBe("gpt-5.5-mini");
  });

  it("removes the field once the last rewrite is removed", async () => {
    const server = appServer(appWith({ routing: { ...testApp().config.routing, model_rewrites: { a: "b" } } }));
    renderTab("rewrites");

    await userEvent.click(await screen.findByRole("button", { name: "Remove rewrite 1" }));
    await saveAndSettle("Save rewrites", "Rewrites saved");

    expect(server.patches[0]!.operations).toEqual([{ op: "remove", path: "/config/routing/model_rewrites" }]);
  });

  it("refuses a model name longer than the contract allows", async () => {
    appServer(testApp());
    renderTab("rewrites");

    await userEvent.click(await screen.findByRole("button", { name: "Add rewrite" }));
    await userEvent.type(screen.getByLabelText("Rewrite 1: model asked for"), "a");
    await userEvent.click(screen.getByLabelText("Rewrite 1: model sent"));
    await userEvent.paste("m".repeat(201));

    expect(screen.getByRole("alert").textContent).toMatch(/^a: /);
    expect(screen.getByRole("button", { name: "Save rewrites" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("Presets tab", () => {
  const QUICK = { provider: "openai", operation: "openai.responses", model: "gpt-5.5-mini", fallback: [] };

  it("adds a preset with parameters, a cap and a fallback, as one operation", async () => {
    const server = appServer(testApp(), PROVIDERS);
    renderTab("presets");

    await userEvent.click(await screen.findByRole("button", { name: "Add preset" }));
    await userEvent.type(screen.getByLabelText("Name"), "summarize");
    await chooseOption("Provider", "openai");
    // No operation is picked for the person.
    expect(within(fieldOf(screen.getByRole("combobox", { name: "Operation" }))).getByRole("alert").textContent).toBe("Choose an operation.");
    await chooseOption("Operation", "openai.chat");
    await userEvent.type(screen.getByLabelText("Model"), "gpt-5.5-mini");
    await userEvent.type(screen.getByLabelText("Most output tokens"), "500");
    await userEvent.click(screen.getByLabelText("Fixed parameters (JSON)"));
    await userEvent.paste('{"temperature": 0.2}');
    await userEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    await chooseOption(screen.getAllByRole("combobox", { name: "Provider" })[1]!, "anthropic");
    await userEvent.type(screen.getAllByLabelText("Model")[1]!, "claude-haiku-5-5");
    await saveAndSettle("Save presets", "Presets saved");

    expect(server.patches).toEqual([
      {
        revision: 2,
        operations: [
          {
            op: "add",
            path: "/config/presets",
            value: {
              summarize: {
                provider: "openai",
                operation: "openai.chat",
                model: "gpt-5.5-mini",
                max_output_tokens: 500,
                params: { temperature: 0.2 },
                fallback: [{ provider: "anthropic", model: "claude-haiku-5-5" }],
              },
            },
          },
        ],
      },
    ]);
  });

  it("saves only the field changed, leaving other presets and a stored empty fallback list alone", async () => {
    const server = appServer(appWith({ presets: { quick: QUICK, other: { provider: "openai", operation: "openai.chat", model: "gpt-a" } } }), PROVIDERS);
    renderTab("presets");

    const model = (await screen.findAllByLabelText("Model"))[0]!;
    await userEvent.clear(model);
    await userEvent.type(model, "gpt-5.5");
    await saveAndSettle("Save presets", "Presets saved");

    expect(server.patches[0]!.operations).toEqual([{ op: "replace", path: "/config/presets/quick/model", value: "gpt-5.5" }]);
    expect((server.state.app.config as { presets: unknown }).presets).toEqual({
      quick: { ...QUICK, model: "gpt-5.5" },
      other: { provider: "openai", operation: "openai.chat", model: "gpt-a" },
    });
  });

  it("keeps the operation when the new provider has it too", async () => {
    const server = appServer(appWith({ presets: { quick: QUICK } }), PROVIDERS);
    renderTab("presets");

    await screen.findByLabelText("Model");
    await chooseOption("Provider", "openai-eu");
    expect(screen.getByRole("combobox", { name: "Operation" }).textContent).toContain("openai.responses");
    await saveAndSettle("Save presets", "Presets saved");

    expect(server.patches[0]!.operations).toEqual([{ op: "replace", path: "/config/presets/quick/provider", value: "openai-eu" }]);
  });

  it("keeps a fallback's named operation when its new provider offers it too", async () => {
    const preset = { provider: "gemini", operation: "gemini.generate.v1", model: "gemini-a", fallback: [{ provider: "gemini", operation: "gemini.generate.v1", model: "gemini-b" }] };
    const server = appServer(appWith({ presets: { quick: preset } }), PROVIDERS);
    renderTab("presets");

    await screen.findAllByLabelText("Model");
    await chooseOption(screen.getAllByRole("combobox", { name: "Provider" })[1]!, "gemini-eu");
    expect(screen.getAllByRole("combobox", { name: "Operation" })[1]!.textContent).toContain("gemini.generate.v1");
    await saveAndSettle("Save presets", "Presets saved");

    expect(server.patches[0]!.operations).toEqual([
      { op: "replace", path: "/config/presets/quick/fallback", value: [{ provider: "gemini-eu", operation: "gemini.generate.v1", model: "gemini-b" }] },
    ]);
  });

  it("leaves the operation to choose when the new provider does not have it, never another API", async () => {
    const server = appServer(appWith({ presets: { quick: { provider: "openai", operation: "openai.chat", model: "gpt-a" } } }), PROVIDERS);
    renderTab("presets");

    await screen.findByLabelText("Model");
    await chooseOption("Provider", "anthropic");
    expect(within(fieldOf(screen.getByRole("combobox", { name: "Operation" }))).getByRole("alert").textContent).toBe("Choose an operation.");
    expect(screen.getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(true);

    await chooseOption("Operation", "anthropic.messages");
    await saveAndSettle("Save presets", "Presets saved");
    expect(server.patches[0]!.operations).toEqual([
      { op: "replace", path: "/config/presets/quick/provider", value: "anthropic" },
      { op: "replace", path: "/config/presets/quick/operation", value: "anthropic.messages" },
    ]);
  });

  it("keeps a fallback's named operation through a provider that lacks it, asking for a choice, and finds it again on the way back", async () => {
    const preset = { provider: "openai", operation: "openai.images", model: "gpt-image", fallback: [{ provider: "openai", operation: "openai.images.edits", model: "gpt-image-2" }] };
    appServer(appWith({ presets: { quick: preset } }), PROVIDERS);
    renderTab("presets");

    await screen.findAllByLabelText("Model");
    const fallbackProvider = () => screen.getAllByRole("combobox", { name: "Provider" })[1]!;
    await chooseOption(fallbackProvider(), "anthropic");
    expect(screen.getAllByRole("combobox", { name: "Operation" })[1]!.textContent).toContain("openai.images.edits");
    expect(screen.getByText("anthropic does not offer openai.images.edits. Choose an operation for this fallback.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(true);

    await chooseOption(fallbackProvider(), "openai");
    expect(screen.getAllByRole("combobox", { name: "Operation" })[1]!.textContent).toContain("openai.images.edits");
    expect(screen.queryByText(/does not offer/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(true);
  });

  it("applies the chosen operation's rules before saving", async () => {
    appServer(appWith({ presets: { quick: QUICK } }), PROVIDERS);
    renderTab("presets");

    await screen.findByLabelText("Model");
    await chooseOption("Operation", "openai.transcription");
    await userEvent.type(screen.getByLabelText("Fixed parameters (JSON)"), "{{}");
    expect(within(fieldOf("Fixed parameters (JSON)")).getByRole("alert").textContent).toMatch(/takes an upload/);

    await chooseOption("Operation", "openai.embeddings");
    await userEvent.clear(screen.getByLabelText("Fixed parameters (JSON)"));
    await userEvent.type(screen.getByLabelText("Most output tokens"), "100");
    expect(within(fieldOf("Most output tokens")).getByRole("alert").textContent).toMatch(/has no output to cap/);
    await userEvent.clear(screen.getByLabelText("Most output tokens"));

    await userEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    await chooseOption(screen.getAllByRole("combobox", { name: "Provider" })[1]!, "anthropic");
    await userEvent.type(screen.getAllByLabelText("Model")[1]!, "claude-haiku-5-5");
    expect(screen.getByText(/anthropic has no openai-embeddings operation/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(true);
  });

  it("judges only new or changed presets by their operation's rules", async () => {
    const legacy = { provider: "openai", operation: "openai.embeddings", model: "text-embed", max_output_tokens: 100 };
    const server = appServer(appWith({ presets: { legacy, quick: QUICK } }), PROVIDERS);
    renderTab("presets");

    const model = (await screen.findAllByLabelText("Model"))[1]!;
    await userEvent.clear(model);
    await userEvent.type(model, "gpt-5.5");
    expect(screen.queryByText(/has no output to cap/)).toBeNull();
    await saveAndSettle("Save presets", "Presets saved");

    expect(server.patches[0]!.operations).toEqual([{ op: "replace", path: "/config/presets/quick/model", value: "gpt-5.5" }]);
  });

  it("does not count reformatted parameters as a change", async () => {
    const legacy = { provider: "openai", operation: "openai.embeddings", model: "text-embed", max_output_tokens: 100, params: { dimensions: 256 } };
    appServer(appWith({ presets: { legacy } }), PROVIDERS);
    renderTab("presets");

    const params = await screen.findByLabelText("Fixed parameters (JSON)");
    await userEvent.clear(params);
    await userEvent.type(params, '{{ "dimensions":256 }');

    // Saved as stored, so the preset is unchanged and its stored cap is not judged anew.
    expect(screen.queryByText(/has no output to cap/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(false);
  });

  it("does not count parameters whose keys only moved as a change, so an older preset's cap does not block another's save", async () => {
    const legacy = { provider: "openai", operation: "openai.embeddings", model: "text-embed", max_output_tokens: 100, params: { b: 1, a: 2 } };
    const server = appServer(appWith({ presets: { legacy, quick: QUICK } }), PROVIDERS);
    renderTab("presets");

    const params = (await screen.findAllByLabelText("Fixed parameters (JSON)"))[0]!;
    await userEvent.clear(params);
    await userEvent.click(params);
    await userEvent.paste('{"a": 2, "b": 1}');
    const model = screen.getAllByLabelText("Model")[1]!;
    await userEvent.clear(model);
    await userEvent.type(model, "gpt-5.5");
    expect(screen.queryByText(/has no output to cap/)).toBeNull();
    await saveAndSettle("Save presets", "Presets saved");

    expect(server.patches[0]!.operations).toEqual([{ op: "replace", path: "/config/presets/quick/model", value: "gpt-5.5" }]);
  });

  it("says a rule of the contract under the field it is about, such as a model name too long", async () => {
    appServer(appWith({ presets: { quick: QUICK } }), PROVIDERS);
    renderTab("presets");

    const model = await screen.findByLabelText("Model");
    await userEvent.clear(model);
    await userEvent.click(model);
    await userEvent.paste("m".repeat(201));

    expect(within(fieldOf("Model")).getByRole("alert").textContent).toMatch(/200/);
    expect(screen.getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(true);
  });

  it("refuses a number in the parameters too large to send", async () => {
    appServer(testApp(), PROVIDERS);
    renderTab("presets");

    await userEvent.click(await screen.findByRole("button", { name: "Add preset" }));
    await userEvent.click(screen.getByLabelText("Fixed parameters (JSON)"));
    await userEvent.paste('{"temperature": {"max": 1e400}}');

    expect(within(fieldOf("Fixed parameters (JSON)")).getByRole("alert").textContent).toMatch(/too large to send/);
  });

  it("checks a fallback's own operation when it names one", async () => {
    const withFallback = { provider: "openai", operation: "openai.chat", model: "gpt-a", fallback: [{ provider: "anthropic", operation: "anthropic.messages", model: "claude-haiku-5-5" }] };
    appServer(appWith({ presets: { quick: withFallback } }), PROVIDERS);
    renderTab("presets");

    const model = (await screen.findAllByLabelText("Model"))[0]!;
    await userEvent.type(model, "-2");

    expect(screen.getByText("anthropic.messages does not speak openai-chat, the preset's API. A fallback must speak it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(true);
  });

  it("checks the name and the parameters before saving", async () => {
    appServer(testApp(), PROVIDERS);
    renderTab("presets");

    await userEvent.click(await screen.findByRole("button", { name: "Add preset" }));
    await userEvent.type(screen.getByLabelText("Name"), "Bad Name");
    await userEvent.type(screen.getByLabelText("Fixed parameters (JSON)"), "not json");

    expect(within(fieldOf("Name")).getByRole("alert").textContent).toBe("Use 1 to 64 characters from a-z, 0-9 and -.");
    expect(within(fieldOf("Fixed parameters (JSON)")).getByRole("alert").textContent).toBe("Not valid JSON.");
    expect(screen.getByRole("button", { name: "Save presets" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows a refusal about one preset's field inside that field", async () => {
    const server = appServer(appWith({ presets: { quick: QUICK } }), PROVIDERS);
    server.state.refuse = { status: 400, code: "invalid_request", message: "config.presets.quick.model: gpt-unknown has no price" };
    renderTab("presets");

    const model = await screen.findByLabelText("Model");
    await userEvent.clear(model);
    await userEvent.type(model, "gpt-unknown");
    await userEvent.click(screen.getByRole("button", { name: "Save presets" }));

    await waitFor(() => expect(within(fieldOf("Model")).queryByRole("alert")).not.toBeNull());
    expect(within(fieldOf("Model")).getByRole("alert").textContent).toBe("gpt-unknown has no price");
  });

  it("removes the field when the last preset is removed", async () => {
    const server = appServer(appWith({ presets: { quick: QUICK } }), PROVIDERS);
    renderTab("presets");

    await userEvent.click(await screen.findByRole("button", { name: "Remove preset quick" }));
    await saveAndSettle("Save presets", "Presets saved");

    expect(server.patches[0]!.operations).toEqual([{ op: "remove", path: "/config/presets" }]);
  });
});
