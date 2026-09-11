import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewAppDialog } from "./new-app-dialog";
import { renderAuthenticated } from "@/test/render";
import type { AuthenticationConfig } from "@/lib/config-types";

interface CreateAttempt {
  id?: unknown;
  name: string;
  config?: { authentication?: AuthenticationConfig; limits?: unknown };
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

const next = () => screen.getByRole("button", { name: "Next" });
const createButton = () => screen.getByRole("button", { name: "Create app" });
const title = () => screen.getByRole("heading", { level: 2 });
/** The question a step asks, under the constant title. */
const subtitle = () => screen.queryByRole("heading", { level: 3 });
const radio = (name: RegExp) => screen.getByRole("radio", { name });

/** Opens the wizard and completes the first step. */
async function startWizard(name: string, type: "iOS application" | "Server") {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New app" }));
  await user.type(screen.getByLabelText("Application name"), name);
  await user.click(radio(new RegExp(type, "u")));
  await user.click(next());
  return user;
}

/** Fills the iOS identity step, the one that cannot be skipped. */
async function identifyApp(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Apple Team ID"), "ABCDE12345");
  await user.type(screen.getByLabelText("Bundle ID"), "com.example.calories");
  await user.click(next());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the first step", () => {
  it("asks only for a name and a type, and never shows or sends an id", async () => {
    const attempts = stubCreate();
    renderAuthenticated(<NewAppDialog />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New app" }));
    expect(title().textContent).toBe("Create a new application");
    expect(subtitle()).toBeNull();
    expect(screen.queryByLabelText(/Application ID/iu)).toBeNull();
    expect(screen.queryByText(/All AI providers/iu)).toBeNull();

    // Nothing to go on yet.
    expect(next()).toHaveProperty("disabled", true);
    await user.type(screen.getByLabelText("Application name"), "Calorie Tracker");
    expect(next()).toHaveProperty("disabled", true);
    await user.click(radio(/Server/u));
    expect(screen.queryByText(/All AI providers/iu)).toBeNull();
    expect(next()).toHaveProperty("disabled", false);

    await user.click(next());
    await user.click(radio(/No user identity/u));
    await user.click(createButton());

    await waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]).toMatchObject({ name: "Calorie Tracker" });
    expect(attempts[0]).not.toHaveProperty("id");
  });

  it("uses the id the server assigned", async () => {
    stubCreate("calorie-tracker-zz9zz9");
    renderAuthenticated(<NewAppDialog />);

    const user = await startWizard("Calorie Tracker", "Server");
    await user.click(radio(/No user identity/u));
    await user.click(createButton());

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

describe("a server application", () => {
  it("goes straight to user authentication, and no user identity creates an app with no users", async () => {
    const attempts = stubCreate("search-service-k3f9x1");
    renderAuthenticated(<NewAppDialog />);

    const user = await startWizard("Search service", "Server");
    // The title never changes; the step says what it asks underneath.
    expect(title().textContent).toBe("Create a new application");
    expect(subtitle()?.textContent).toBe("User authentication");
    // No App Attest step for a server: its key identifies it.
    expect(screen.queryByLabelText("Bundle ID")).toBeNull();

    // A choice is required, even if that choice is to have no users.
    expect(createButton()).toHaveProperty("disabled", true);
    await user.click(radio(/No user identity/u));
    await user.click(createButton());

    await waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]?.config?.authentication).toEqual({ type: "api_key" });
    /*
     * A backend without users is one identity, so a per-user limit would not
     * meter users, it would cap the whole backend at ten requests a minute.
     */
    expect(attempts[0]?.config?.limits).toBeUndefined();
  });

  it("offers the answers most secure first", async () => {
    stubCreate();
    renderAuthenticated(<NewAppDialog />);

    await startWizard("Search service", "Server");
    const names = screen.getAllByRole("radio").map((element) => element.textContent ?? "");
    expect(names[0]).toContain("Signed-in users only");
    expect(names[2]).toContain("No user identity");
  });

  it("can name its users through the default header", async () => {
    const attempts = stubCreate("search-service-k3f9x1");
    renderAuthenticated(<NewAppDialog />);

    const user = await startWizard("Search service", "Server");
    await user.click(radio(/Your backend sends the user id/u));
    await user.click(createButton());

    await waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]?.config?.authentication).toEqual({
      type: "api_key",
      end_user: { source: "header", header: "x-end-user-id" },
    });
  });
});

describe("an iOS application", () => {
  it("cannot skip saying which app it is", async () => {
    stubCreate();
    renderAuthenticated(<NewAppDialog />);

    const user = await startWizard("Calorie Tracker", "iOS application");
    expect(subtitle()?.textContent).toBe("Application identity");
    expect(next()).toHaveProperty("disabled", true);
    await user.type(screen.getByLabelText("Apple Team ID"), "ABCDE12345");
    expect(next()).toHaveProperty("disabled", true);
    await user.type(screen.getByLabelText("Bundle ID"), "com.example.calories");
    expect(next()).toHaveProperty("disabled", false);
  });

  it("unauthenticated users are told apart by installation and keep the per-user limits", async () => {
    const attempts = stubCreate();
    renderAuthenticated(<NewAppDialog />);

    const user = await startWizard("Calorie Tracker", "iOS application");
    await identifyApp(user);

    expect(subtitle()?.textContent).toBe("User authentication");
    await user.click(radio(/Unauthenticated users/u));
    // No sign-in means no token to check a subscription on, so there is no
    // further step: this is where the app is created.
    await user.click(createButton());

    await waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]?.config?.authentication).toEqual({
      type: "apple_app_attest",
      app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.calories" },
      end_user: { source: "app_install" },
    });
    // Every install is a stranger, so a mobile app starts rate limited.
    expect(attempts[0]?.config?.limits).toMatchObject({
      per_user: { requests: { per_minute: 10, per_day: 300 } },
    });
  });

  it("sign-in adds an identity provider step and a subscription step", async () => {
    const attempts = stubCreate();
    renderAuthenticated(<NewAppDialog />);

    const user = await startWizard("Calorie Tracker", "iOS application");
    await identifyApp(user);

    await user.click(radio(/Signed-in users only/u));
    // The provider is configured on its own step, not under the choice.
    expect(screen.queryByLabelText("Firebase project id")).toBeNull();
    await user.click(next());

    expect(subtitle()?.textContent).toBe("Identity provider");
    // The default provider is Firebase, which needs one value.
    expect(next()).toHaveProperty("disabled", true);
    await user.type(screen.getByLabelText("Firebase project id"), "calories-1a2b3");
    // The preset's long-form warning is a settings-page thing, not a wizard thing.
    expect(screen.queryByText(/shared key set/u)).toBeNull();
    expect(screen.getByRole("link", { name: "Firebase documentation" })).toHaveProperty(
      "href",
      "https://firebase.google.com/docs/auth/admin/verify-id-tokens",
    );
    await user.click(next());

    expect(subtitle()?.textContent).toBe("Subscription check");
    expect(screen.queryByText(/This writes/u)).toBeNull();
    await user.click(createButton());

    await waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]?.config?.authentication).toEqual({
      type: "apple_app_attest",
      app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.calories" },
      end_user: {
        source: "issuer",
        issuer: {
          provider: "firebase",
          jwks_url:
            "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
          issuer: "https://securetoken.google.com/calories-1a2b3",
          audience: "calories-1a2b3",
          user_id_claim: "sub",
          required_claims: [],
          max_token_lifetime_seconds: 86400,
        },
      },
    });
  });

  it("lets someone without provider details fall back to unauthenticated users", async () => {
    const attempts = stubCreate();
    renderAuthenticated(<NewAppDialog />);

    const user = await startWizard("Calorie Tracker", "iOS application");
    await identifyApp(user);
    await user.click(radio(/Signed-in users only/u));
    await user.click(next());
    expect(subtitle()?.textContent).toBe("Identity provider");

    // Nothing filled in: the way out is the fallback, not the disabled Next.
    expect(next()).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Allow unauthenticated users for now" }));

    // Back on the question, with the new answer visible before anything is created.
    expect(subtitle()?.textContent).toBe("User authentication");
    expect(radio(/Unauthenticated users/u).getAttribute("aria-checked")).toBe("true");
    await user.click(createButton());

    await waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]?.config?.authentication).toMatchObject({
      end_user: { source: "app_install" },
    });
  });

  it("writes the chosen environments only when development is enabled", async () => {
    const attempts = stubCreate();
    renderAuthenticated(<NewAppDialog />);

    const user = await startWizard("Calorie Tracker", "iOS application");
    await user.type(screen.getByLabelText("Apple Team ID"), "ABCDE12345");
    await user.type(screen.getByLabelText("Bundle ID"), "com.example.calories");
    await user.click(screen.getByRole("checkbox", { name: "Development" }));
    // The wizard asks the question without the settings page's warning.
    expect(screen.queryByText(/provisioning profile/u)).toBeNull();
    await user.click(next());
    await user.click(radio(/Unauthenticated users/u));
    await user.click(createButton());

    await waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]?.config?.authentication).toMatchObject({
      app_attest: { environments: ["production", "development"] },
    });
  });
});

describe("moving between steps", () => {
  it("keeps what was entered when going back, and drops a user choice when the type changes", async () => {
    stubCreate();
    renderAuthenticated(<NewAppDialog />);

    const user = await startWizard("Calorie Tracker", "Server");
    await user.click(radio(/Your backend sends the user id/u));

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Application name") as HTMLInputElement).value).toBe(
      "Calorie Tracker",
    );
    expect(radio(/Server/u).getAttribute("aria-checked")).toBe("true");

    // Returning without changing anything finds the choice still made.
    await user.click(next());
    expect(radio(/Your backend sends the user id/u).getAttribute("aria-checked")).toBe("true");

    // Changing the type must not carry a server-only source into an iOS app.
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(radio(/iOS application/u));
    await user.click(next());
    await identifyApp(user);
    expect(screen.queryByRole("radio", { name: /Your backend sends the user id/u })).toBeNull();
    expect(createButton()).toHaveProperty("disabled", true);
  });

  it("offers the passed steps as dots to jump back to", async () => {
    stubCreate();
    renderAuthenticated(<NewAppDialog />);

    const user = await startWizard("Calorie Tracker", "iOS application");
    await identifyApp(user);

    await user.click(screen.getByRole("button", { name: "Back to Basics" }));
    expect(subtitle()).toBeNull();
    expect((screen.getByLabelText("Application name") as HTMLInputElement).value).toBe(
      "Calorie Tracker",
    );
  });
});
