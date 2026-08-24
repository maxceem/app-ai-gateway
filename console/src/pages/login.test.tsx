import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginPage } from "./login";
import { CAPABILITIES_URL, capabilities, renderPublic, stubApi } from "@/test/render";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("signs in with email and password", async () => {
    const fetchMock = stubApi({
      [CAPABILITIES_URL]: capabilities(),
      "/v1/auth/sign-in/email": { body: { redirect: false, token: "t", user: {} } },
    });

    renderPublic(<LoginPage />, { route: "/login" });

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.test");
    await userEvent.type(screen.getByLabelText(/password/i), "correct-horse-42");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/sign-in/email"));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({
        email: "ada@example.test",
        password: "correct-horse-42",
      });
    });
  });

  it("shows a readable message when the credentials are wrong", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      "/v1/auth/sign-in/email": {
        status: 401,
        body: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
      },
    });

    renderPublic(<LoginPage />, { route: "/login" });

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.test");
    await userEvent.type(screen.getByLabelText(/password/i), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/email and password combination is not correct/i);
  });

  it("hides the Google button unless the deployment enables it", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
    });

    renderPublic(<LoginPage />, { route: "/login" });

    await screen.findByRole("button", { name: /sign in/i });
    expect(screen.queryByRole("button", { name: /google/i })).toBeNull();
  });

  it("offers Google sign-in when the capability is present", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities({ googleAuth: true }),
    });

    renderPublic(<LoginPage />, { route: "/login" });

    expect(await screen.findByRole("button", { name: /continue with google/i })).toBeTruthy();
  });

  it("hides the sign-up link when registration is closed", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities({ registrationOpen: false }),
    });

    renderPublic(<LoginPage />, { route: "/login" });

    await screen.findByRole("button", { name: /sign in/i });
    await waitFor(() => expect(screen.queryByRole("link", { name: /create one/i })).toBeNull());
  });

  it("links to sign-up when registration is open", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
    });

    renderPublic(<LoginPage />, { route: "/login" });

    expect(await screen.findByRole("link", { name: /create one/i })).toBeTruthy();
  });
});

describe("LoginPage OAuth failures", () => {
  it("explains a cancelled Google consent instead of showing a bare form", async () => {
    stubApi({ [CAPABILITIES_URL]: capabilities({ googleAuth: true }) });

    renderPublic(<LoginPage />, { route: "/login?error=access_denied" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/google sign-in was cancelled/i);
  });

  it("explains a Google account rejected by closed registration", async () => {
    stubApi({ [CAPABILITIES_URL]: capabilities({ googleAuth: true }) });

    renderPublic(<LoginPage />, { route: "/login?error=registration_disabled" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/does not accept new accounts/i);
  });

  it("shows nothing extra on an ordinary sign-in visit", async () => {
    stubApi({ [CAPABILITIES_URL]: capabilities() });

    renderPublic(<LoginPage />, { route: "/login" });

    await screen.findByRole("button", { name: /sign in/i });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("LoginPage deep links", () => {
  it("returns the operator to the page they were sent away from", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      "/v1/auth/sign-in/email": { body: { redirect: false, token: "t", user: {} } },
      "/v1/admin/session": { body: { session: {} } },
    });

    const { router } = renderPublic(<LoginPage />, {
      route: "/login?from=%2Fapps%2Fmy-app%2Fusage",
    });

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.test");
    await userEvent.type(screen.getByLabelText(/password/i), "correct-horse-42");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(router.location.pathname).toBe("/apps/my-app/usage");
    });
  });

  it("lands on the console default when there is nothing to return to", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      "/v1/auth/sign-in/email": { body: { redirect: false, token: "t", user: {} } },
      "/v1/admin/session": { body: { session: {} } },
    });

    const { router } = renderPublic(<LoginPage />, { route: "/login" });

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.test");
    await userEvent.type(screen.getByLabelText(/password/i), "correct-horse-42");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(router.location.pathname).toBe("/apps"));
  });
});
