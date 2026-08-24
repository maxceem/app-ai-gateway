import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginPage } from "./login";
import { renderPublic } from "@/test/render";

const CAPABILITIES = "/v1/console/capabilities";

/** Routes fetches by URL so a test only states the responses it cares about. */
function stubApi(routes: Record<string, { status?: number; body: unknown }>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = Object.keys(routes).find((key) => url.startsWith(key));
    if (!match) return new Response("{}", { status: 404 });
    const route = routes[match]!;
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("signs in with email and password", async () => {
    const fetchMock = stubApi({
      [CAPABILITIES]: { body: { billing: false, registrationOpen: true, googleAuth: false } },
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
      [CAPABILITIES]: { body: { billing: false, registrationOpen: true, googleAuth: false } },
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
      [CAPABILITIES]: { body: { billing: false, registrationOpen: true, googleAuth: false } },
    });

    renderPublic(<LoginPage />, { route: "/login" });

    await screen.findByRole("button", { name: /sign in/i });
    expect(screen.queryByRole("button", { name: /google/i })).toBeNull();
  });

  it("offers Google sign-in when the capability is present", async () => {
    stubApi({
      [CAPABILITIES]: { body: { billing: false, registrationOpen: true, googleAuth: true } },
    });

    renderPublic(<LoginPage />, { route: "/login" });

    expect(await screen.findByRole("button", { name: /continue with google/i })).toBeTruthy();
  });

  it("hides the sign-up link when registration is closed", async () => {
    stubApi({
      [CAPABILITIES]: { body: { billing: false, registrationOpen: false, googleAuth: false } },
    });

    renderPublic(<LoginPage />, { route: "/login" });

    await screen.findByRole("button", { name: /sign in/i });
    await waitFor(() => expect(screen.queryByRole("link", { name: /create one/i })).toBeNull());
  });

  it("links to sign-up when registration is open", async () => {
    stubApi({
      [CAPABILITIES]: { body: { billing: false, registrationOpen: true, googleAuth: false } },
    });

    renderPublic(<LoginPage />, { route: "/login" });

    expect(await screen.findByRole("link", { name: /create one/i })).toBeTruthy();
  });
});
