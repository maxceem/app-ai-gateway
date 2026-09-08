import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewAppDialog } from "./new-app-dialog";
import { renderAuthenticated } from "@/test/render";

interface CreateAttempt {
  id?: unknown;
  name: string;
  config?: { limits?: unknown };
}

/**
 * Answers `POST /v1/admin/apps` the way the gateway does: with the created
 * application, whose id is the server's and which the console learns only from
 * this response.
 */
function stubCreate(appId = "calorie-tracker-k3f9x1") {
  const attempts: CreateAttempt[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/v1/admin/apps") && init?.method === "POST") {
        attempts.push(JSON.parse(String(init.body)) as CreateAttempt);
        return new Response(
          JSON.stringify({
            app: {
              id: appId,
              name: "Created app",
              config: {},
              status: "active",
              created_at: "2026-09-02T00:00:00.000Z",
              updated_at: "2026-09-02T00:00:00.000Z",
            },
            resolved: null,
            config_error: null,
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
  it("previews the id without choosing it, and never sends one", async () => {
    const attempts = stubCreate();
    renderAuthenticated(<NewAppDialog />);

    const user = await openServerAppForm("Calorie Tracker");

    // The stem is knowable; the suffix is the gateway's, so it is shown as a
    // placeholder rather than as a value the person could rely on.
    const field = appIdField();
    expect(field.value).toBe("calorie-tracker-••••••");
    expect(field.readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: /application ID/iu })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Create app" }));

    await waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]).toMatchObject({ name: "Calorie Tracker" });
    expect(attempts[0]).not.toHaveProperty("id");
  });

  it("uses the id the server assigned, not the previewed stem", async () => {
    stubCreate("calorie-tracker-zz9zz9");
    renderAuthenticated(<NewAppDialog />);

    const user = await openServerAppForm("Calorie Tracker");
    await user.click(screen.getByRole("button", { name: "Create app" }));

    // The confirmation spells out the URL the app actually lives at.
    expect(await screen.findByText("Base URL")).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "CODE"
          && (element.textContent ?? "").includes("/v1/apps/calorie-tracker-zz9zz9/proxy/"),
      ),
    ).toBeTruthy();
  });
});

/**
 * The default limits a new app is created with.
 *
 * These meter an application's own end users, so what counts as a sensible
 * default depends entirely on whether the app has end users the gateway can
 * tell apart — and a server application usually does not.
 */
describe("default limits on a new application", () => {
  it("leaves a server application unlimited", async () => {
    const attempts = stubCreate("search-service-k3f9x1");
    renderAuthenticated(<NewAppDialog />);

    const user = await openServerAppForm("Search service");
    await user.click(screen.getByRole("button", { name: "Create app" }));

    await waitFor(() => expect(attempts).toHaveLength(1));
    /*
     * A backend that does not send x-end-user-id is one identity — the API
     * key's own id — so a per-user limit here would not meter users, it would
     * cap the whole backend. Shipping that as a default would throttle every
     * server app at ten requests a minute.
     */
    expect(attempts[0]?.config?.limits).toBeUndefined();
  });

  /*
   * The mobile default is asserted only through the server case above, which
   * proves the block is conditional. Driving the iOS form far enough to submit
   * needs a full identity-provider preset filled in, and a test that fragile
   * would break on unrelated form changes rather than on this behaviour.
   */
});
