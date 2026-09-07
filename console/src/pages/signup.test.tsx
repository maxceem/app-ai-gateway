import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignupPage } from "./signup";
import { CAPABILITIES_URL, capabilities, renderPublic, stubApi } from "@/test/render";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SignupPage", () => {
  it("replaces the form with an explanation when registration is disabled", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities({ registrationOpen: false }),
    });

    renderPublic(<SignupPage />, { route: "/signup" });

    expect(await screen.findByText(/registration is closed/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^name$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /create account/i })).toBeNull();
    expect(screen.getByRole("link", { name: /back to sign in/i })).toBeTruthy();
  });

  it("creates an account when registration is open", async () => {
    const fetchMock = stubApi({
      [CAPABILITIES_URL]: capabilities(),
      "/v1/auth/sign-up/email": { body: { token: "t", user: {} } },
    });

    renderPublic(<SignupPage />, { route: "/signup" });

    await userEvent.type(await screen.findByLabelText(/^name$/i), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.test");
    await userEvent.type(screen.getByLabelText(/^password$/i), "correct-horse-42");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/sign-up/email"));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({
        name: "Ada Lovelace",
        email: "ada@example.test",
      });
    });
  });

  it("puts Google sign-up before the email and password form", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities({ googleAuth: true }),
    });

    renderPublic(<SignupPage />, { route: "/signup" });

    const google = await screen.findByRole("button", { name: /sign up with google/i });
    const name = screen.getByLabelText(/^name$/i);
    expect(
      Boolean(google.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("keeps submission disabled until the password is long enough", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
    });

    renderPublic(<SignupPage />, { route: "/signup" });

    await userEvent.type(await screen.findByLabelText(/^name$/i), "Ada");
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.test");
    await userEvent.type(screen.getByLabelText(/^password$/i), "short");

    expect(screen.getByRole("button", { name: /create account/i })).toHaveProperty("disabled", true);
    expect(screen.getByText(/use at least 8 characters/i)).toBeTruthy();
  });

  it("falls back to the closed screen if the server refuses mid-flight", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      "/v1/auth/sign-up/email": {
        status: 403,
        body: { error: { code: "registration_disabled", message: "Public registration is disabled" } },
      },
    });

    renderPublic(<SignupPage />, { route: "/signup" });

    await userEvent.type(await screen.findByLabelText(/^name$/i), "Ada");
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.test");
    await userEvent.type(screen.getByLabelText(/^password$/i), "correct-horse-42");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/registration is closed/i)).toBeTruthy();
  });
});
