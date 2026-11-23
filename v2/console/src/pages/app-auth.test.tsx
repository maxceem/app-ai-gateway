import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { AppDetailPage } from "./app-detail";
import { appServer } from "@/test/app-server";
import { testApp } from "@/test/fixtures";
import { renderAuthenticated } from "@/test/render";
import { chooseOption } from "@/test/select";

const IOS_AUTH = {
  type: "apple_app_attest",
  end_user: { source: "app_install" },
  app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.app", environments: ["production"], verify_on: "every_request" },
};

const FIREBASE_ISSUER = {
  provider: "firebase",
  jwks_url: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  issuer: ["https://securetoken.google.com/my-project"],
  audience: ["my-project"],
  user_id_claim: "sub",
  required_claims: [],
  max_token_lifetime_seconds: 86400,
};

function appWith(authentication: unknown) {
  return testApp({ config: { ...testApp().config, authentication } });
}

function renderSignIn() {
  return renderAuthenticated(
    <Routes>
      <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
    </Routes>,
    { route: "/apps/my-app/sign-in" },
  );
}

/** The field a label names: its label, input and any problem said under it. */
const fieldOf = (label: string) => screen.getByLabelText(label).closest("div.space-y-2") as HTMLElement;

const saveButton = () => screen.getByRole("button", { name: "Save sign-in" });

/** Saves, and waits until the page shows the save went through and the form is clean again. */
async function saveAndSettle() {
  const saved = vi.spyOn(toast, "success");
  await userEvent.click(saveButton());
  await waitFor(() => expect(saved).toHaveBeenCalledWith("Sign-in saved"));
  await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(true));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sign-in tab", () => {
  it("saves only the App Attest fields that changed, at the read revision", async () => {
    const server = appServer(appWith(IOS_AUTH));
    renderSignIn();

    const team = await screen.findByLabelText("Apple Team ID");
    await userEvent.clear(team);
    await userEvent.type(team, "zyxwv98765");
    await userEvent.click(screen.getByRole("checkbox", { name: /Development/ }));
    await userEvent.click(screen.getByRole("radio", { name: /Token exchange/ }));
    await saveAndSettle();

    expect(server.patches).toEqual([
      {
        revision: 2,
        operations: [
          { op: "replace", path: "/config/authentication/app_attest/team_id", value: "ZYXWV98765" },
          { op: "replace", path: "/config/authentication/app_attest/environments", value: ["production", "development"] },
          { op: "replace", path: "/config/authentication/app_attest/verify_on", value: "token_exchange" },
        ],
      },
    ]);
    expect(server.state.app.revision).toBe(3);
  });

  it("says what is wrong with a team id inside its field, and will not save it", async () => {
    appServer(appWith(IOS_AUTH));
    renderSignIn();

    const team = await screen.findByLabelText("Apple Team ID");
    await userEvent.clear(team);
    await userEvent.type(team, "short");

    expect(within(fieldOf("Apple Team ID")).getByRole("alert").textContent).toBe("team_id must contain ten uppercase letters or digits");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("signs a server app's users in through Auth0, paid users only, with a RevenueCat entitlement", async () => {
    const server = appServer(testApp());
    renderSignIn();

    await userEvent.click(await screen.findByRole("radio", { name: /Signed-in users only/ }));
    await chooseOption("Identity provider", "Auth0");
    await userEvent.type(screen.getByLabelText("Tenant domain"), "my-tenant.us.auth0.com");
    await userEvent.type(screen.getByLabelText("API identifier"), "https://api.my-app.com");
    await userEvent.click(screen.getByRole("radio", { name: /Paid users only/ }));
    await userEvent.type(screen.getByLabelText("Entitlement identifier"), "pro");
    await saveAndSettle();

    expect(server.state.app.config).toEqual({
      ...testApp().config,
      authentication: {
        type: "api_key",
        end_user: {
          source: "issuer",
          issuer: {
            provider: "auth0",
            jwks_url: "https://my-tenant.us.auth0.com/.well-known/jwks.json",
            issuer: "https://my-tenant.us.auth0.com/",
            audience: "https://api.my-app.com",
            user_id_claim: "sub",
            required_claims: [{ path: "revenueCatEntitlements", contains: "pro" }],
            max_token_lifetime_seconds: 86400,
            entitlement: "revenuecat",
          },
        },
      },
    });
  });

  it("reopens a Firebase issuer on its project, and saves only the paid check, leaving the stored lists and fields alone", async () => {
    const server = appServer(appWith({ type: "api_key", end_user: { source: "issuer", issuer: { ...FIREBASE_ISSUER, token_header: "x-user-token" } } }));
    renderSignIn();

    expect(((await screen.findByLabelText("Firebase project id")) as HTMLInputElement).value).toBe("my-project");
    await userEvent.click(screen.getByRole("radio", { name: /Paid users only/ }));
    await userEvent.type(screen.getByLabelText("Entitlement identifier"), "pro, pro_test");
    await saveAndSettle();

    expect(server.patches[0]!.operations).toEqual([
      { op: "replace", path: "/config/authentication/end_user/issuer/required_claims", value: [{ path: "revenueCatEntitlements", contains: ["pro", "pro_test"] }] },
      { op: "add", path: "/config/authentication/end_user/issuer/entitlement", value: "revenuecat" },
    ]);
  });

  it("opens an issuer no preset reproduces in the custom editor, one input per audience", async () => {
    const server = appServer(
      appWith({ type: "api_key", end_user: { source: "issuer", issuer: { ...FIREBASE_ISSUER, audience: ["my-project", "my-other-project"] } } }),
    );
    renderSignIn();

    expect((await screen.findByRole("combobox", { name: "Identity provider" })).textContent).toContain("Custom issuer");
    expect((screen.getByLabelText("Audience (aud)") as HTMLInputElement).value).toBe("my-project");
    expect((screen.getByLabelText("Audience 2") as HTMLInputElement).value).toBe("my-other-project");
    await userEvent.click(screen.getByRole("button", { name: "Add audience" }));
    await userEvent.type(screen.getByLabelText("Audience 3"), "third");
    await saveAndSettle();

    expect(server.patches[0]!.operations).toEqual([
      { op: "replace", path: "/config/authentication/end_user/issuer/audience", value: ["my-project", "my-other-project", "third"] },
    ]);
  });

  it("brings a source's settings back when it is chosen again", async () => {
    appServer(appWith({ type: "api_key", end_user: { source: "issuer", issuer: FIREBASE_ISSUER } }));
    renderSignIn();

    await userEvent.click(await screen.findByRole("radio", { name: /Your server sends the user id/ }));
    expect(screen.queryByLabelText("Firebase project id")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: /Signed-in users only/ }));

    expect((screen.getByLabelText("Firebase project id") as HTMLInputElement).value).toBe("my-project");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("asks for a provider's own inputs, such as a Supabase project ref", async () => {
    appServer(appWith({ type: "api_key", end_user: { source: "issuer", issuer: FIREBASE_ISSUER } }));
    renderSignIn();

    await screen.findByLabelText("Firebase project id");
    await chooseOption("Identity provider", "Supabase Auth");

    expect(screen.getByText("Enter the project ref.")).toBeTruthy();
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("stores an equals claim as the type chosen, and asks for a claim when a paid check has none", async () => {
    const server = appServer(appWith({ type: "api_key", end_user: { source: "issuer", issuer: FIREBASE_ISSUER } }));
    renderSignIn();

    await userEvent.click(await screen.findByRole("radio", { name: /Paid users only/ }));
    await chooseOption("Which claim says the user has paid", "Custom claims");
    await userEvent.click(screen.getByRole("button", { name: "Remove claim 1" }));
    expect(screen.getByText("Add at least one claim, or choose Any signed-in user.")).toBeTruthy();
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Add claim" }));
    await userEvent.type(screen.getByLabelText("Path"), "tier");
    await chooseOption("Match", "equals number");
    await userEvent.type(screen.getByLabelText("Value"), "x");
    expect(screen.getByText("Enter a number, such as 3 or 1.05.")).toBeTruthy();
    await userEvent.clear(screen.getByLabelText("Value"));
    await userEvent.type(screen.getByLabelText("Value"), "1.05");
    expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("1.05");
    await saveAndSettle();

    const issuer = (server.state.app.config as { authentication: { end_user: { issuer: { required_claims: unknown } } } }).authentication.end_user.issuer;
    expect(issuer.required_claims).toEqual([{ path: "tier", equals: 1.05 }]);
  });

  it("keeps a paid check made outside the console when its last claim is removed, until Any signed-in user is chosen", async () => {
    const server = appServer(appWith({ type: "api_key", end_user: { source: "issuer", issuer: { ...FIREBASE_ISSUER, required_claims: [{ path: "paid", equals: true }] } } }));
    renderSignIn();

    expect((await screen.findByRole("radio", { name: /Paid users only/ })).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Value" }).textContent).toContain("true");
    await userEvent.click(screen.getByRole("button", { name: "Remove claim 1" }));

    expect(screen.getByRole("radio", { name: /Paid users only/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Add at least one claim, or choose Any signed-in user.")).toBeTruthy();
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: /Any signed-in user/ }));
    await saveAndSettle();
    expect(server.patches[0]!.operations).toEqual([{ op: "replace", path: "/config/authentication/end_user/issuer/required_claims", value: [] }]);
  });

  it("forgets what another caller choice held once a new draft starts", async () => {
    const server = appServer(appWith({ type: "api_key", end_user: { source: "header", header: "x-user" } }));
    renderSignIn();

    await userEvent.click(await screen.findByRole("radio", { name: /No end users/ }));
    await saveAndSettle();
    await userEvent.click(screen.getByRole("radio", { name: /Your server sends the user id/ }));

    // Not the header the last draft held: the saved app has none, so this starts afresh.
    expect((screen.getByLabelText("Header name") as HTMLInputElement).value).toBe("x-end-user-id");
    expect(server.patches).toHaveLength(1);
  });

  it("keeps each stored audience exactly as stored, line breaks and spaces included, when another is edited", async () => {
    const server = appServer(
      appWith({ type: "api_key", end_user: { source: "issuer", issuer: { ...FIREBASE_ISSUER, audience: ["staff\ninternal", "main"] } } }),
    );
    renderSignIn();

    // The value with a line break is shown as it is, not in an input that would change it.
    const first = await screen.findByLabelText("Audience 1");
    expect(first.tagName).toBe("PRE");
    expect(first.textContent).toBe("staff\ninternal");
    expect(screen.getByText(/Contains a line break, so it cannot be edited here/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Audience 2"), "-2");
    await saveAndSettle();

    expect(server.patches[0]!.operations).toEqual([
      { op: "replace", path: "/config/authentication/end_user/issuer/audience", value: ["staff\ninternal", "main-2"] },
    ]);
  });

  it("can remove a value with a line break", async () => {
    const server = appServer(
      appWith({ type: "api_key", end_user: { source: "issuer", issuer: { ...FIREBASE_ISSUER, audience: ["staff\ninternal", "main"] } } }),
    );
    renderSignIn();

    await userEvent.click(await screen.findByRole("button", { name: "Remove audience 1" }));
    await saveAndSettle();

    expect(server.patches[0]!.operations).toEqual([{ op: "replace", path: "/config/authentication/end_user/issuer/audience", value: ["main"] }]);
  });

  it("saves a paid claim for an issuer whose stored values a preset would not accept", async () => {
    const server = appServer(appWith({ type: "api_key", end_user: { source: "issuer", issuer: { ...FIREBASE_ISSUER, issuer: [" ", "main"] } } }));
    renderSignIn();

    await userEvent.click(await screen.findByRole("radio", { name: /Paid users only/ }));
    await userEvent.type(screen.getByLabelText("Entitlement identifier"), "pro");
    await saveAndSettle();

    expect(server.patches[0]!.operations.map((operation) => operation.path)).toEqual([
      "/config/authentication/end_user/issuer/required_claims",
      "/config/authentication/end_user/issuer/entitlement",
    ]);
  });

  it("keeps a RevenueCat check's stored claim path when its entitlement is edited", async () => {
    const issuer = { ...FIREBASE_ISSUER, entitlement: "revenuecat", required_claims: [{ path: "entitlements", contains: "pro" }] };
    const server = appServer(appWith({ type: "api_key", end_user: { source: "issuer", issuer } }));
    renderSignIn();

    await userEvent.type(await screen.findByLabelText("Entitlement identifier"), ", max");
    await saveAndSettle();

    expect(server.patches[0]!.operations).toEqual([
      { op: "replace", path: "/config/authentication/end_user/issuer/required_claims", value: [{ path: "entitlements", contains: ["pro", "max"] }] },
    ]);
  });

  it("saves a change of a claim's match type alone, text 3 becoming the number 3", async () => {
    const issuer = { ...FIREBASE_ISSUER, entitlement: "custom", required_claims: [{ path: "tier", equals: "3" }] };
    const server = appServer(appWith({ type: "api_key", end_user: { source: "issuer", issuer } }));
    renderSignIn();

    await screen.findByLabelText("Path");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    await chooseOption("Match", "equals number");
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    await saveAndSettle();

    expect(server.patches[0]!.operations).toEqual([{ op: "replace", path: "/config/authentication/end_user/issuer/required_claims", value: [{ path: "tier", equals: 3 }] }]);
  });

  it("lets a field a newer gateway wrote through, sending only what changed", async () => {
    const server = appServer(appWith({ ...IOS_AUTH, app_attest: { ...IOS_AUTH.app_attest, future_setting: "kept" } }));
    renderSignIn();

    await userEvent.click(await screen.findByRole("radio", { name: /Token exchange/ }));
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    await saveAndSettle();

    expect(server.patches[0]!.operations).toEqual([{ op: "replace", path: "/config/authentication/app_attest/verify_on", value: "token_exchange" }]);
  });

  it("shows a refusal about the sign-in inside the field it names", async () => {
    const server = appServer(testApp());
    server.state.refuse = { status: 400, code: "invalid_request", message: "config.authentication.end_user.header: cannot be xi-api-key: the gateway already uses that header" };
    renderSignIn();

    const header = await screen.findByLabelText("Header name");
    await userEvent.clear(header);
    await userEvent.type(header, "x-user");
    await userEvent.click(saveButton());

    await waitFor(() => expect(within(fieldOf("Header name")).queryByRole("alert")).not.toBeNull());
    expect(within(fieldOf("Header name")).getByRole("alert").textContent).toBe("cannot be xi-api-key: the gateway already uses that header");
  });

  it("explains a refusal about another part of the app, such as per-user limits", async () => {
    const server = appServer(testApp());
    server.state.refuse = { status: 400, code: "invalid_request", message: "config.limits.per_user: needs an authentication.end_user source other than none" };
    renderSignIn();

    await userEvent.click(await screen.findByRole("radio", { name: /No end users/ }));
    await userEvent.click(saveButton());

    const notice = (await screen.findByText("Not saved")).closest("[role=alert]") as HTMLElement;
    expect(within(notice).getByText("needs an authentication.end_user source other than none")).toBeTruthy();
  });

  it("keeps an edit made before the app changed elsewhere, and will not save it at the newer revision", async () => {
    const server = appServer(appWith(IOS_AUTH));
    const { client } = renderSignIn();

    const team = await screen.findByLabelText("Apple Team ID");
    await userEvent.clear(team);
    await userEvent.type(team, "ZYXWV98765");
    server.changeElsewhere((app) => ({ ...app, name: "Renamed elsewhere" }));
    await act(() => client.invalidateQueries());

    expect(await screen.findByText("This app changed since you started editing")).toBeTruthy();
    expect((screen.getByLabelText("Apple Team ID") as HTMLInputElement).value).toBe("ZYXWV98765");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    expect(server.patches).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Discard my edits" }));
    expect((screen.getByLabelText("Apple Team ID") as HTMLInputElement).value).toBe("ABCDE12345");
    expect(screen.queryByText("This app changed since you started editing")).toBeNull();
  });

  it("follows a newer version of the app while nothing is edited", async () => {
    const server = appServer(appWith(IOS_AUTH));
    const { client } = renderSignIn();

    await screen.findByLabelText("Apple Team ID");
    server.changeElsewhere((app) => ({ ...app, config: { ...(app.config as object), authentication: { ...IOS_AUTH, app_attest: { ...IOS_AUTH.app_attest, team_id: "NEWTEAM123" } } } }));
    await act(() => client.invalidateQueries());

    await waitFor(() => expect((screen.getByLabelText("Apple Team ID") as HTMLInputElement).value).toBe("NEWTEAM123"));
    await userEvent.click(screen.getByRole("radio", { name: /Token exchange/ }));
    await saveAndSettle();
    expect(server.patches[0]!.revision).toBe(3);
  });

  it("offers nothing to save until something changes", async () => {
    appServer(appWith(IOS_AUTH));
    renderSignIn();
    expect((await screen.findByRole("button", { name: "Save sign-in" })).hasAttribute("disabled")).toBe(true);
  });
});
