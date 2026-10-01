import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OAuthConsentPage } from "./oauth-consent";
import { renderPublic, stubApi } from "@/test/render";

const ID = "oauth-0123abcd";
const PATH = `/oauth/consent?id=${ID}`;
const PROOF = "p".repeat(43);
const DETAILS_URL = `/v1/console/oauth/${ID}/details`;
const ALLOW_URL = `/v1/console/oauth/${ID}/allow`;
const GUEST_URL = `/v1/console/oauth/${ID}/guest`;
const DENY_URL = `/v1/console/oauth/${ID}/deny`;
const STORAGE_KEY = `app-ai-gateway:oauth-consent:${PATH}`;
const REDIRECT = "http://127.0.0.1:4567/callback?code=abc&state=xyz&iss=https%3A%2F%2Fexample.test";
/** The client's own claim for itself, which the page must show as text. */
const DECLARED = "<img src=x onerror=alert(1)> Agent";

function details(overrides: Record<string, unknown> = {}) {
  return {
    body: {
      id: ID,
      state: "pending",
      client: { id: "https://agent.example/client.json", name: DECLARED, domain: "agent.example", source: "cimd" },
      redirectHost: "127.0.0.1",
      requestedGrant: "manage",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      viewer: null,
      accounts: [],
      blockedBy: "registration_required",
      guestAvailable: true,
      guestExpiresAt: "2026-12-30T00:00:00.000Z",
      googleEnabled: false,
      registrationOpen: true,
      ...overrides,
    },
  };
}

const SIGNED_IN = {
  viewer: { name: "Ada Lovelace", email: "ada@example.test" },
  accounts: [
    { id: "org-1", name: "Acme", role: "owner" },
    { id: "org-2", name: "Globex", role: "member" },
  ],
  blockedBy: null,
};

function renderConsent(route = `${PATH}#${PROOF}`) {
  return renderPublic(<OAuthConsentPage />, { route, path: "/oauth/consent" });
}

const assign = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  assign.mockReset();
  vi.stubGlobal("location", { ...window.location, assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function bodyOf(fetchMock: ReturnType<typeof stubApi>, url: string) {
  const call = fetchMock.mock.calls.find(([input]) => String(input) === url);
  return call ? JSON.parse(String(call[1]!.body)) : undefined;
}

describe("OAuthConsentPage proof", () => {
  it("reads the proof from the fragment, sends it in a body, strips it and keeps it for the return", async () => {
    const fetchMock = stubApi({ [DETAILS_URL]: details() });
    const { router } = renderConsent();

    await screen.findByText(DECLARED);
    expect(bodyOf(fetchMock, DETAILS_URL)).toEqual({ submissionToken: PROOF });
    await waitFor(() => expect(router.location.hash).toBe(""));
    expect(router.location.search).toBe(`?id=${ID}`);
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)).toMatchObject({ token: PROOF });
  });

  it("comes back to life from session storage after sign-in returns here without the fragment", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token: PROOF, expiresAt: Date.now() + 600_000 }));
    const fetchMock = stubApi({ [DETAILS_URL]: details(SIGNED_IN) });
    renderConsent(PATH);

    expect(await screen.findByRole("button", { name: /^allow$/i })).toBeTruthy();
    expect(bodyOf(fetchMock, DETAILS_URL)).toEqual({ submissionToken: PROOF });
  });

  it("explains a request that can no longer be decided", async () => {
    stubApi({ [DETAILS_URL]: { status: 410, body: { error: { code: "operation_expired", message: "Operation has expired" } } } });
    renderConsent();
    expect((await screen.findByRole("alert")).textContent).toMatch(/can no longer be approved/i);
  });
});

describe("OAuthConsentPage signed in", () => {
  it("shows the client as declared by its domain, as text, and allows with the chosen account and grant", async () => {
    const fetchMock = stubApi({ [DETAILS_URL]: details({ ...SIGNED_IN, requestedGrant: "read" }), [ALLOW_URL]: { body: { redirect: REDIRECT } } });
    const { container } = renderConsent();

    expect(await screen.findByText(DECLARED)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("as declared by agent.example")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();

    // Several accounts: none chosen until the person picks one.
    const allow = screen.getByRole("button", { name: /^allow$/i });
    expect(allow).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("radio", { name: /globex/i }));

    // The grant starts at what the client asked for, and the person may change it.
    const grants = screen.getByRole("radiogroup", { name: /grant for this app/i });
    expect(grants.querySelector('[aria-checked="true"]')!.textContent).toMatch(/^Read only/);
    await userEvent.click(screen.getByRole("radio", { name: /^manage/i }));
    await userEvent.click(allow);

    await waitFor(() => expect(assign).toHaveBeenCalledWith(REDIRECT));
    expect(bodyOf(fetchMock, ALLOW_URL)).toEqual({ submissionToken: PROOF, organizationId: "org-2", grant: "manage" });
    expect(await screen.findByText(/returning you to 127\.0\.0\.1/i)).toBeTruthy();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    // Nobody signed in is offered the guest door; a person is not.
    expect(screen.queryByRole("button", { name: /continue without an account/i })).toBeNull();
  });

  it("names a single account rather than asking", async () => {
    stubApi({ [DETAILS_URL]: details({ ...SIGNED_IN, accounts: [SIGNED_IN.accounts[0]] }) });
    renderConsent();
    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: /account for this app/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^allow$/i })).toHaveProperty("disabled", false);
  });

  it("denies back to the client", async () => {
    const denied = "http://127.0.0.1:4567/callback?error=access_denied&state=xyz";
    const fetchMock = stubApi({ [DETAILS_URL]: details(SIGNED_IN), [DENY_URL]: { body: { redirect: denied } } });
    renderConsent();

    await userEvent.click(await screen.findByRole("button", { name: /^deny$/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(denied));
    expect(bodyOf(fetchMock, DENY_URL)).toEqual({ submissionToken: PROOF });
    expect(await screen.findByText(/connection declined/i)).toBeTruthy();
  });
});

describe("OAuthConsentPage nobody signed in", () => {
  it("offers signing in and registering, each returning here, and continuing without an account", async () => {
    stubApi({ [DETAILS_URL]: details() });
    renderConsent();

    const signIn = await screen.findByRole("link", { name: /^sign in$/i });
    expect(signIn.getAttribute("href")).toBe(`/login?from=${encodeURIComponent(PATH)}`);
    expect(screen.getByRole("link", { name: /create an account/i }).getAttribute("href")).toBe(
      `/signup?from=${encodeURIComponent(PATH)}`,
    );
    expect(screen.getByText(/nobody has claimed yet/i)).toBeTruthy();
    expect(screen.getByText(/deleted on .* unless you claim it/i)).toBeTruthy();
    // The client asked for manage, so there is nothing to warn about.
    expect(screen.queryByText(/asked for read-only access/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /continue with google/i })).toBeNull();
  });

  it("says the guest connection gets manage when the client asked for read, and continues", async () => {
    const fetchMock = stubApi({ [DETAILS_URL]: details({ requestedGrant: "read" }), [GUEST_URL]: { body: { redirect: REDIRECT } } });
    renderConsent();

    expect(await screen.findByText(/asked for read-only access, but a connection without an account always gets the manage grant/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /continue without an account/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(REDIRECT));
    expect(bodyOf(fetchMock, GUEST_URL)).toEqual({ submissionToken: PROOF });
  });

  it("does not offer the guest door where the deployment does not admit one, nor registration where it is closed", async () => {
    stubApi({ [DETAILS_URL]: details({ guestAvailable: false, guestExpiresAt: null, registrationOpen: false, googleEnabled: true }) });
    renderConsent();

    expect(await screen.findByRole("link", { name: /^sign in$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /continue without an account/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /create an account/i })).toBeNull();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeTruthy();
  });

  it("shows the refusal of the guest door the gateway answers with", async () => {
    stubApi({
      [DETAILS_URL]: details(),
      [GUEST_URL]: { status: 429, body: { error: { code: "rate_limited", message: "You can create an account at most 3 times per day." } } },
    });
    renderConsent();

    await userEvent.click(await screen.findByRole("button", { name: /continue without an account/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at most 3 times per day/i);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("OAuthConsentPage refusals", () => {
  it("tells a person with no usable account so, and offers another sign-in", async () => {
    stubApi({ [DETAILS_URL]: details({ viewer: SIGNED_IN.viewer, accounts: [], blockedBy: "no_eligible_organization" }) });
    renderConsent();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no account to connect/i);
    expect(alert.textContent).toMatch(/Ada Lovelace is not a member/i);
    expect(screen.getByRole("button", { name: /sign in as someone else/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^allow$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeTruthy();
  });

  it("offers nothing on an authorization already decided", async () => {
    stubApi({ [DETAILS_URL]: details({ ...SIGNED_IN, state: "completed" }) });
    renderConsent();

    expect(await screen.findByText(/already approved/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^allow$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^deny$/i })).toBeNull();
  });
});
