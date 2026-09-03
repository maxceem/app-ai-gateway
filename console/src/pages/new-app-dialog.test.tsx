import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewAppDialog } from "./new-app-dialog";
import { renderAuthenticated } from "@/test/render";

interface CreateAttempt {
  id: string;
  name: string;
}

/**
 * Answers `POST /v1/admin/apps` by echoing the id the console asked for, which
 * is the property under test: the server never invents a different one, so a
 * test that echoed a fixed id could not tell a rename from a match.
 */
function stubCreate(outcomes: Array<"created" | "taken">) {
  const attempts: CreateAttempt[] = [];
  const remaining = [...outcomes];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/v1/admin/apps") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as CreateAttempt;
        attempts.push(body);
        if ((remaining.shift() ?? "created") === "taken") {
          return new Response(
            JSON.stringify({ error: { code: "app_id_taken", message: `App id ${body.id} is already taken` } }),
            { status: 409 },
          );
        }
        return new Response(
          JSON.stringify({
            app_id: body.id,
            api_key: {
              id: "key-1",
              name: "Default key",
              key: "agw_test_key",
              key_prefix: "agw_test_key",
              created_at: "2026-09-02T00:00:00.000Z",
            },
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    }),
  );
  return attempts;
}

async function openServerAppForm(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New app" }));
  await user.type(screen.getByLabelText("Application name"), name);
  await user.click(screen.getByRole("radio", { name: /Server/u }));
  return user;
}

const appIdField = () => screen.getByLabelText("Application ID") as HTMLInputElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("creating an application", () => {
  it("shows the suffixed id up front and creates exactly that id", async () => {
    const attempts = stubCreate(["created"]);
    renderAuthenticated(<NewAppDialog existingIds={[]} />);

    const user = await openServerAppForm("Calorie Tracker");

    const shown = appIdField().value;
    expect(shown).toMatch(/^calorie-tracker-[0-9a-z]{6}$/u);
    // The URL the id will live in, spelled out before anything is created.
    // One <code> in the dialog, and the id inside it is its own element, so the
    // preview has to be matched on the whole node rather than on a text run.
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "CODE"
          && (element.textContent ?? "").includes(`/v1/apps/${shown}/proxy/`),
      ),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Create app" }));

    await waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]).toMatchObject({ id: shown, name: "Calorie Tracker" });
    // The confirmation repeats the id that was created, in the URL it created it
    // at, so the last thing seen is the same string as the first.
    expect(await screen.findByText("Base URL")).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "CODE"
          && (element.textContent ?? "").includes(`/v1/apps/${shown}/proxy/`),
      ),
    ).toBeTruthy();
  });

  it("never resubmits behind the caller: a taken id is replaced in the form, not on the server", async () => {
    const attempts = stubCreate(["taken", "created"]);
    renderAuthenticated(<NewAppDialog existingIds={[]} />);

    const user = await openServerAppForm("Calorie Tracker");
    const first = appIdField().value;

    await user.click(screen.getByRole("button", { name: "Create app" }));

    // One attempt only, and the dialog stays open showing a different id.
    await waitFor(() => expect(appIdField().value).not.toBe(first));
    expect(attempts).toEqual([expect.objectContaining({ id: first })]);
    const second = appIdField().value;
    expect(second).toMatch(/^calorie-tracker-[0-9a-z]{6}$/u);

    await user.click(screen.getByRole("button", { name: "Create app" }));

    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]).toMatchObject({ id: second });
  });

  it("refuses a custom id the gateway reserves", async () => {
    stubCreate(["created"]);
    renderAuthenticated(<NewAppDialog existingIds={["calorie-tracker-aaaaaa"]} />);

    const user = await openServerAppForm("Calorie Tracker");
    await user.click(screen.getByRole("button", { name: "Edit application ID" }));
    await user.clear(appIdField());
    await user.type(appIdField(), "admin");

    expect(screen.getByText("This ID is reserved. Pick another one.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create app" })).toHaveProperty("disabled", true);
  });
});
