import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthPolicyTab, levelStatuses } from "./auth-policy";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { AppDraft, Draft } from "@/hooks/use-app-draft";
import type { AuthConfig, AuthenticationConfig } from "@/lib/config-types";

const APP_ID = "my-app";

/**
 * The tab only reads a slice of the draft, so the fixture supplies that slice
 * rather than reproducing the whole `useAppDraft` surface.
 */
function draftFor(authentication: AuthenticationConfig): AppDraft {
  return {
    draft: { name: "My app", status: "active", config: { authentication } },
    dirty: false,
    save: vi.fn(),
    updateIssuer: vi.fn(),
    updateAuthentication: vi.fn(),
    setEndUserSource: vi.fn(),
    updateEndUserHeader: vi.fn(),
  } as unknown as AppDraft;
}

const FIREBASE: AuthConfig = {
  provider: "firebase",
  jwks_url:
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  issuer: "https://securetoken.google.com/my-app-1a2b3",
  audience: "my-app-1a2b3",
  user_id_claim: "sub",
  required_claims: [],
};

const serverApp = (issuer?: AuthConfig): AuthenticationConfig => ({
  type: "api_key",
  ...(issuer ? { end_user: { source: "issuer" as const, issuer } } : {}),
});

const headerApp = (header = "x-end-user-id"): AuthenticationConfig => ({
  type: "api_key",
  end_user: { source: "header", header },
});

const appleApp = (issuer: AuthConfig = FIREBASE): AuthenticationConfig => ({
  type: "apple_app_attest",
  app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.test" },
  end_user: { source: "issuer", issuer },
});

const appInstallApp = (): AuthenticationConfig => ({
  type: "apple_app_attest",
  app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.test" },
  end_user: { source: "app_install" },
});

const stubKeys = (keys: Array<{ status: string }> = [{ status: "active" }]) =>
  stubApi({ "/v1/admin/apps": { body: { app_id: APP_ID, keys } } });

const option = (name: RegExp) => screen.findByRole("radio", { name });
const levels = () => screen.getByRole("navigation", { name: /auth policy levels/i });
const levelRow = (name: RegExp) =>
  within(levels()).getByText(name).closest("a, [aria-disabled]") as HTMLElement;

function renderTab(state: AppDraft, level?: string, role: "owner" | "member" = "owner") {
  return renderAuthenticated(<AuthPolicyTab appId={APP_ID} level={level} state={state} />, {
    session: { role },
    route: `/apps/${APP_ID}/auth/${level ?? ""}`,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("levelStatuses", () => {
  const draft = (authentication: AuthenticationConfig): Draft => ({
    name: "My app",
    status: "active",
    config: { authentication, routing: { providers: { mode: "all" }, model_rewrites: {} } },
  });

  it("reads the strictest answer as secure and a looser one as weak", () => {
    const strict = levelStatuses(draft(appleApp()), undefined);
    expect(strict.identity.tone).toBe("secure");
    expect(strict.users.tone).toBe("secure");
    expect(strict.subscription.tone).toBe("weak");

    const loose = levelStatuses(draft(appInstallApp()), undefined);
    expect(loose.users).toEqual({ tone: "weak", text: "Unauthenticated users allowed" });
    // Nothing to check when nobody signs in.
    expect(loose.subscription.tone).toBe("off");
  });

  it("flags an answer the gateway could not act on yet", () => {
    const halfDone = levelStatuses(
      draft(appleApp({ ...FIREBASE, issuer: "https://securetoken.google.com/", audience: "" })),
      undefined,
    );
    expect(halfDone.users.tone).toBe("incomplete");

    const paidWithoutClaim = levelStatuses(
      draft(appleApp({ ...FIREBASE, entitlement: "revenuecat", required_claims: [{ path: "entitlements", contains: "" }] })),
      undefined,
    );
    expect(paidWithoutClaim.subscription.tone).toBe("incomplete");
  });

  it("reads a server app's identity off its keys", () => {
    expect(levelStatuses(draft(serverApp()), false).identity)
      .toEqual({ tone: "incomplete", text: "No active API key" });
    expect(levelStatuses(draft(serverApp()), true).identity.tone).toBe("secure");
    // Unknown is not a problem; it is a list still loading.
    expect(levelStatuses(draft(serverApp()), undefined).identity.tone).toBe("secure");
  });
});

describe("AuthPolicyTab levels", () => {
  it("lists the three levels with their standing, and opens on identity", async () => {
    stubKeys();
    renderTab(draftFor(appleApp()));

    expect(await screen.findByRole("heading", { name: /application identity/i })).toBeTruthy();
    expect(levelRow(/application identity/i).getAttribute("aria-current")).toBe("page");
    expect(levelRow(/application identity/i).textContent).toContain("Verified with App Attest");
    expect(levelRow(/user authentication/i).textContent).toContain("Signed-in users only");
    expect(levelRow(/subscription check/i).textContent).toContain("Any signed-in user");
    expect(levelRow(/user authentication/i).getAttribute("href")).toBe(`/apps/${APP_ID}/auth/users`);
  });

  it("keeps the subscription level out of reach until users sign in", async () => {
    stubKeys();
    renderTab(draftFor(appInstallApp()), "subscription");

    const row = levelRow(/subscription check/i);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("Needs signed-in users");
    // Asked for anyway, the page falls back to the first level.
    expect(await screen.findByRole("heading", { name: /application identity/i })).toBeTruthy();
  });
});

describe("AuthPolicyTab application identity", () => {
  it("shows the team and bundle id with where to find them, and no way to drop them", async () => {
    stubKeys();
    renderTab(draftFor(appInstallApp()), "identity");

    expect(await screen.findByLabelText(/apple team id/i)).toHaveProperty("value", "AAAAAAAAAA");
    expect(screen.getByLabelText(/bundle id/i)).toHaveProperty("value", "com.example.test");
    expect(screen.getByRole("link", { name: /membership details/i })).toBeTruthy();
    expect(screen.getByText(/ios app environment/i)).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("shows a server app's keys as how it proves itself", async () => {
    stubKeys([]);
    renderTab(draftFor(serverApp()), "identity");

    expect(await screen.findByText(/proves itself with one of these API keys/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /new key/i })).toBeTruthy();
    // The standing follows the key list once it has loaded.
    expect(await within(levels()).findByText(/no active API key/i)).toBeTruthy();
  });

  it("edits the team id through the draft", async () => {
    stubKeys();
    const state = draftFor(appInstallApp());
    renderTab(state, "identity");

    await userEvent.type(await screen.findByLabelText(/apple team id/i), "B");

    expect(state.updateAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({ app_attest: expect.objectContaining({ team_id: "AAAAAAAAAAB" }) }),
    );
  });
});

describe("AuthPolicyTab user authentication", () => {
  it("asks the wizard's question with the wizard's answers, most secure first", async () => {
    stubKeys();
    renderTab(draftFor(serverApp()), "users");

    const group = await screen.findByRole("radiogroup", { name: /user authentication/i });
    const labels = within(group).getAllByRole("radio").map((radio) => radio.textContent);
    expect(labels[0]).toMatch(/^Signed-in users only/);
    expect(labels[1]).toMatch(/^Your backend sends the user id/);
    expect(labels[2]).toMatch(/^No user identity/);
    expect(labels).toHaveLength(3);
    expect((await option(/no user identity/i)).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("heading", { name: /identity provider/i })).toBeNull();
  });

  it("offers only the answers an attested client can give", async () => {
    stubKeys();
    renderTab(draftFor(appInstallApp()), "users");

    expect((await option(/unauthenticated users/i)).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: /backend sends the user id/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /no user identity/i })).toBeNull();
  });

  it("changes the source through the draft rather than editing it in place", async () => {
    stubKeys();
    const state = draftFor(serverApp());
    renderTab(state, "users");

    await userEvent.click(await option(/signed-in users only/i));
    expect(state.setEndUserSource).toHaveBeenCalledWith("issuer");

    await userEvent.click(await option(/no user identity/i));
    expect(state.setEndUserSource).toHaveBeenCalledWith(undefined);
  });

  it("reveals the header name only for a backend-sent id", async () => {
    stubKeys();
    const state = draftFor(headerApp("x-tenant-user"));
    renderTab(state, "users");

    const header = await screen.findByLabelText(/header name/i);
    expect(header).toHaveProperty("value", "x-tenant-user");
    await userEvent.type(header, "s");
    expect(state.updateEndUserHeader).toHaveBeenCalledWith("x-tenant-users");
  });

  it("shows the identity provider on the same page, as the vendor and its input", async () => {
    stubKeys();
    renderTab(draftFor(appleApp()), "users");

    expect(await screen.findByRole("heading", { name: /identity provider/i })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /identity provider/i }).textContent)
      .toContain("Firebase Authentication");
    expect(screen.getByLabelText(/firebase project id/i)).toHaveProperty("value", "my-app-1a2b3");
    // The three URLs are written from the input, never shown as fields.
    expect(screen.queryByLabelText(/jwks url/i)).toBeNull();
    expect(screen.queryByText(/advanced/i)).toBeNull();
  });

  it("rewrites the issuer from the input on every keystroke, naming the provider", async () => {
    stubKeys();
    const state = draftFor(appleApp());
    renderTab(state, "users");

    await userEvent.type(await screen.findByLabelText(/firebase project id/i), "x");

    expect(state.updateIssuer).toHaveBeenCalledWith({
      provider: "firebase",
      jwks_url: FIREBASE.jwks_url,
      issuer: "https://securetoken.google.com/my-app-1a2b3x",
      audience: "my-app-1a2b3x",
      user_id_claim: "sub",
    });
  });

  it("opens the custom form on the stored URLs when no vendor wrote them", async () => {
    stubKeys();
    const custom: AuthConfig = {
      jwks_url: "https://issuer.example.test/jwks.json",
      issuer: "https://issuer.example.test",
      audience: "my-api",
      required_claims: [],
    };
    renderTab(draftFor(serverApp(custom)), "users");

    expect((await screen.findByRole("combobox", { name: /identity provider/i })).textContent)
      .toContain("Custom issuer");
    expect(screen.getByLabelText(/jwks url/i)).toHaveProperty("value", custom.jwks_url);
  });

  it("disables the question for a read-only member and says why", async () => {
    stubKeys();
    renderTab(draftFor(serverApp()), "users", "member");

    const choice = await option(/signed-in users only/i);
    expect(choice).toHaveProperty("disabled", true);
    const describedBy = choice.closest("[aria-describedby]")?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/read-only|cannot/i);
  });
});

describe("AuthPolicyTab subscription check", () => {
  it("reads the answer off the required claims and opens the check inline", async () => {
    stubKeys();
    const paid = {
      ...FIREBASE,
      entitlement: "revenuecat" as const,
      required_claims: [{ path: "entitlements", contains: "pro" }],
    };
    renderTab(draftFor(appleApp(paid)), "subscription");

    expect((await option(/paid users only/i)).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("combobox", { name: /paid check/i }).textContent)
      .toContain("RevenueCat entitlement");
    expect(screen.getByLabelText(/claim path/i)).toHaveProperty("value", "entitlements");
    expect(screen.getByLabelText(/entitlement id/i)).toHaveProperty("value", "pro");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts a paid check from the RevenueCat shape, to be filled in here", async () => {
    stubKeys();
    const state = draftFor(appleApp());
    renderTab(state, "subscription");

    expect((await option(/any signed-in user/i)).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(await option(/paid users only/i));

    expect(state.updateIssuer).toHaveBeenCalledWith({
      entitlement: "revenuecat",
      required_claims: [{ path: "entitlements", contains: "" }],
    });
  });

  it("drops every claim when any signed-in user may call", async () => {
    stubKeys();
    const paid = { ...FIREBASE, required_claims: [{ path: "entitlements", contains: "pro" }] };
    const state = draftFor(appleApp(paid));
    renderTab(state, "subscription");

    await userEvent.click(await option(/any signed-in user/i));

    expect(state.updateIssuer).toHaveBeenCalledWith({ entitlement: undefined, required_claims: [] });
  });

  it("writes the RevenueCat claim from its two fields", async () => {
    stubKeys();
    const paid = {
      ...FIREBASE,
      entitlement: "revenuecat" as const,
      required_claims: [{ path: "entitlements", contains: "pro" }],
    };
    const state = draftFor(appleApp(paid));
    renderTab(state, "subscription");

    await userEvent.type(await screen.findByLabelText(/entitlement id/i), "x");

    expect(state.updateIssuer).toHaveBeenCalledWith({
      required_claims: [{ path: "entitlements", contains: "prox" }],
    });
  });

  it("opens the full claim editor for a custom check", async () => {
    stubKeys();
    const paid = {
      ...FIREBASE,
      entitlement: "custom" as const,
      required_claims: [{ path: "scope", contains: "ai" }, { path: "tier", equals: "pro" }],
    };
    renderTab(draftFor(appleApp(paid)), "subscription");

    expect((await screen.findByRole("combobox", { name: /paid check/i })).textContent)
      .toContain("Custom claim");
    expect(screen.getByRole("button", { name: /add claim/i })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /remove claim/i })).toHaveLength(2);
  });
});
