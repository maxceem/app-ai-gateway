import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { AppDetailPage } from "./app-detail";
import { testApp } from "@/test/fixtures";
import { renderAuthenticated } from "@/test/render";

const APP_URL = "/v2/admin/apps/my-app";

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

function appWith(authentication: unknown, extra: Record<string, unknown> = {}) {
  return testApp({ config: { ...testApp().config, authentication, ...extra } });
}

type Answer = { status?: number; body: unknown };

function stub(app: unknown, put?: Answer) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const answer = method === "PUT" && String(input) === APP_URL ? (put ?? { body: { app } }) : { body: { app } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const putBody = (fetchMock: ReturnType<typeof stub>) => {
  const found = fetchMock.mock.calls.find(([input, init]) => String(input) === APP_URL && init?.method === "PUT");
  return found ? JSON.parse(String(found[1]!.body)) : undefined;
};

function renderSignIn() {
  return renderAuthenticated(
    <Routes>
      <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
    </Routes>,
    { route: "/apps/my-app/sign-in" },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Sign-in tab", () => {
  it("edits an iOS app's App Attest settings and saves only the sign-in, at the read revision", async () => {
    const app = appWith(IOS_AUTH);
    const fetchMock = stub(app);
    renderSignIn();

    const team = await screen.findByLabelText("Apple Team ID");
    await userEvent.clear(team);
    await userEvent.type(team, "zyxwv98765");
    await userEvent.click(screen.getByRole("checkbox", { name: /Development/ }));
    await userEvent.click(screen.getByRole("radio", { name: /Token exchange/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save sign-in" }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    const body = putBody(fetchMock);
    expect(body.revision).toBe(2);
    expect(body.config.authentication).toEqual({
      type: "apple_app_attest",
      end_user: { source: "app_install" },
      app_attest: { team_id: "ZYXWV98765", bundle_id: "com.example.app", environments: ["production", "development"], verify_on: "token_exchange" },
    });
    // The rest of the configuration goes back as it was read.
    expect(body.config.routing).toEqual(testApp().config.routing);
    expect(body.config.limits).toEqual(testApp().config.limits);
  });

  it("says what is wrong with a team id beside it, and will not save it", async () => {
    stub(appWith(IOS_AUTH));
    renderSignIn();

    const team = await screen.findByLabelText("Apple Team ID");
    await userEvent.clear(team);
    await userEvent.type(team, "short");

    expect(await screen.findByText("team_id must contain ten uppercase letters or digits")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save sign-in" }).hasAttribute("disabled")).toBe(true);
  });

  it("signs a server app's users in through Auth0, paid users only, with a RevenueCat entitlement", async () => {
    const fetchMock = stub(testApp());
    renderSignIn();

    await userEvent.click(await screen.findByRole("radio", { name: /Signed-in users only/ }));
    await userEvent.click(screen.getByRole("combobox", { name: "Identity provider" }));
    await userEvent.click(await screen.findByRole("option", { name: "Auth0" }));
    await userEvent.type(screen.getByLabelText("Tenant domain"), "my-tenant.us.auth0.com");
    await userEvent.type(screen.getByLabelText("API identifier"), "https://api.my-app.com");
    await userEvent.click(screen.getByRole("radio", { name: /Paid users only/ }));
    await userEvent.type(screen.getByLabelText("Entitlement identifier"), "pro");
    await userEvent.click(screen.getByRole("button", { name: "Save sign-in" }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    expect(putBody(fetchMock).config.authentication).toEqual({
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
    });
  });

  it("reopens a stored issuer on its provider and project, and keeps fields the form does not show", async () => {
    const fetchMock = stub(appWith({ type: "api_key", end_user: { source: "issuer", issuer: { ...FIREBASE_ISSUER, token_header: "x-user-token" } } }));
    renderSignIn();

    expect(((await screen.findByLabelText("Firebase project id")) as HTMLInputElement).value).toBe("my-project");
    await userEvent.click(screen.getByRole("radio", { name: /Paid users only/ }));
    await userEvent.type(screen.getByLabelText("Entitlement identifier"), "pro, pro_test");
    await userEvent.click(screen.getByRole("button", { name: "Save sign-in" }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    const issuer = putBody(fetchMock).config.authentication.end_user.issuer;
    expect(issuer.token_header).toBe("x-user-token");
    expect(issuer.required_claims).toEqual([{ path: "revenueCatEntitlements", contains: ["pro", "pro_test"] }]);
  });

  it("asks for a claim before saving a paid check with none", async () => {
    stub(appWith({ type: "api_key", end_user: { source: "issuer", issuer: FIREBASE_ISSUER } }));
    renderSignIn();

    await userEvent.click(await screen.findByRole("radio", { name: /Paid users only/ }));
    await userEvent.click(screen.getByRole("combobox", { name: "Which claim says the user has paid" }));
    await userEvent.click(await screen.findByRole("option", { name: "Custom claims" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove claim 1" }));

    expect(await screen.findByText("Add at least one claim, or choose Any signed-in user.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save sign-in" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows a refusal about the sign-in beside its field", async () => {
    stub(testApp(), {
      status: 400,
      body: { error: { code: "invalid_request", message: "config.authentication.end_user.header: cannot be xi-api-key: the gateway already uses that header" } },
    });
    renderSignIn();

    const header = await screen.findByLabelText("Header name");
    await userEvent.clear(header);
    await userEvent.type(header, "x-user");
    await userEvent.click(screen.getByRole("button", { name: "Save sign-in" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getAllByText("cannot be xi-api-key: the gateway already uses that header").length).toBeGreaterThan(0);
  });

  it("explains a refusal about another part of the app, such as per-user limits", async () => {
    stub(testApp(), {
      status: 400,
      body: { error: { code: "invalid_request", message: "config.limits.per_user: needs an authentication.end_user source other than none" } },
    });
    renderSignIn();

    await userEvent.click(await screen.findByRole("radio", { name: /No end users/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save sign-in" }));

    expect(await screen.findByText("Not saved")).toBeTruthy();
    expect(screen.getAllByText("needs an authentication.end_user source other than none").length).toBeGreaterThan(0);
  });

  it("offers nothing to save until something changes", async () => {
    stub(appWith(IOS_AUTH));
    renderSignIn();
    expect((await screen.findByRole("button", { name: "Save sign-in" })).hasAttribute("disabled")).toBe(true);
  });
});
