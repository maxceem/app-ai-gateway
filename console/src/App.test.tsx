import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import App from "./App";
import { CAPABILITIES_URL, capabilities, renderPublic, stubApi, testSession } from "@/test/render";

const SESSION_URL = "/v1/admin/session";

afterEach(() => vi.unstubAllGlobals());

describe("console bootstrap", () => {
  it("waits for identity before deciding what to show", async () => {
    // Capabilities resolve immediately; the session never settles.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(CAPABILITIES_URL)) {
        return new Response(JSON.stringify(capabilities().body), { status: 200 });
      }
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { router } = renderPublic(<App />, { route: "/apps" });

    // Neither the console nor the sign-in screen may appear on a guess.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /management keys/i })).toBeNull();
    expect(router.location.pathname).toBe("/apps");
  });

  it("sends an unauthenticated operator to sign-in, preserving the deep link", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      [SESSION_URL]: { status: 401, body: { error: { code: "auth_required" } } },
    });

    const { router } = renderPublic(<App />, { route: "/apps/my-app/usage" });

    await waitFor(() => expect(router.location.pathname).toBe("/login"));
    expect(router.location.search).toBe("?from=%2Fapps%2Fmy-app%2Fusage");
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeTruthy();
  });

  it("settles on the sign-in screen rather than looping between routes", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      [SESSION_URL]: { status: 401, body: { error: { code: "auth_required" } } },
    });

    const { router } = renderPublic(<App />, { route: "/apps" });

    await waitFor(() => expect(router.location.pathname).toBe("/login"));
    const settled = router.location.pathname;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A redirect loop would bounce back to /apps and re-trigger the guard.
    expect(router.location.pathname).toBe(settled);
  });

  it("renders the console once identity resolves", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      [SESSION_URL]: { body: { session: testSession() } },
      "/v1/admin/apps": { body: { apps: [], totals: null } },
    });

    renderPublic(<App />, { route: "/apps" });

    expect(await screen.findByRole("link", { name: /providers/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^sign in$/i })).toBeNull();
  });

  it("keeps an already-signed-in operator off the sign-in screen", async () => {
    stubApi({
      [CAPABILITIES_URL]: capabilities(),
      [SESSION_URL]: { body: { session: testSession() } },
      "/v1/admin/apps": { body: { apps: [], totals: null } },
    });

    const { router } = renderPublic(<App />, { route: "/login" });

    await waitFor(() => expect(router.location.pathname).toBe("/apps"));
  });
});
