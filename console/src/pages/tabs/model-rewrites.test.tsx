import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelRewritesTab } from "./model-rewrites";
import { useAppDraft } from "@/hooks/use-app-draft";
import { renderAuthenticated, stubApi } from "@/test/render";

const APP_ID = "my-app";

function Harness() {
  const state = useAppDraft(APP_ID);
  if (!state.draft) return null;
  return (
    <>
      <ModelRewritesTab state={state} />
      {/* What a save would send, so a row on screen can be told from a row in the draft. */}
      <pre data-testid="rewrites">{JSON.stringify(state.draft.config.routing.model_rewrites ?? {})}</pre>
    </>
  );
}

const draftRewrites = () => JSON.parse(screen.getByTestId("rewrites").textContent ?? "null");

function renderTab(model_rewrites: Record<string, string>) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}`]: {
      body: {
        app: {
          id: APP_ID,
          name: "My app",
          status: "active",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          config: {
            authentication: { type: "api_key", end_user: { source: "none" } },
            routing: { providers: { mode: "all" }, model_rewrites },
          },
        },
      },
    },
  });
  return renderAuthenticated(<Harness />);
}

afterEach(() => vi.unstubAllGlobals());

describe("ModelRewritesTab", () => {
  /**
   * The map the draft stores cannot hold a row that has no source yet, so the
   * row lives on the page until it is finished. Adding one used to commit it
   * straight to the map, where it was dropped for having an empty key: the
   * button changed nothing and reported nothing.
   */
  it("adds a rewrite row and keeps it while it is being filled in", async () => {
    renderTab({});

    await userEvent.click(await screen.findByRole("button", { name: /add rewrite/i }));

    const source = screen.getByRole("textbox", { name: /rewrite 1 source model/i });
    expect(screen.queryByText(/no rewrites/i)).toBeNull();

    // Half a rewrite stays on screen, and stays out of the draft: the Worker
    // refuses an entry with an empty target, so saving one would fail.
    await userEvent.type(source, "gpt-5.6-terra");
    expect((source as HTMLInputElement).value).toBe("gpt-5.6-terra");
    expect(draftRewrites()).toEqual({});

    await userEvent.type(
      screen.getByRole("textbox", { name: /rewrite 1 target model/i }),
      "gpt-5.6-luna",
    );
    await waitFor(() =>
      expect(draftRewrites()).toEqual({ "gpt-5.6-terra": "gpt-5.6-luna" }));
  });

  it("adds a second row rather than replacing the first blank one", async () => {
    renderTab({});

    const add = await screen.findByRole("button", { name: /add rewrite/i });
    await userEvent.click(add);
    await userEvent.click(add);

    expect(screen.getAllByRole("button", { name: /remove rewrite/i })).toHaveLength(2);
  });

  it("edits and removes a rewrite the application already has", async () => {
    renderTab({ "gpt-5.6-terra": "gpt-5.6-luna", "old-model": "gpt-5.6-luna" });

    const target = await screen.findByRole("textbox", { name: /rewrite 1 target model/i });
    expect((target as HTMLInputElement).value).toBe("gpt-5.6-luna");

    await userEvent.click(screen.getByRole("button", { name: /remove rewrite 2/i }));

    await waitFor(() => expect(draftRewrites()).toEqual({ "gpt-5.6-terra": "gpt-5.6-luna" }));
    expect(screen.getAllByRole("button", { name: /remove rewrite/i })).toHaveLength(1);
  });
});
