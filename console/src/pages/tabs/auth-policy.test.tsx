import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthPolicyTab } from "./auth-policy";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { AppDraft } from "@/hooks/use-app-draft";
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
    setIssuerEnabled: vi.fn(),
  } as unknown as AppDraft;
}

const serverApp = (issuer?: AuthConfig): AuthenticationConfig => ({
  type: "api_key",
  end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
  ...(issuer ? { issuer } : {}),
});

const appleApp = (): AuthenticationConfig => ({
  type: "apple_app_attest",
  issuer: { jwks_url: "https://issuer.example.test/jwks.json", required_claims: [] },
  app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.test" },
});

/** Both branches render the server key list, which fetches on mount. */
function stubKeys() {
  return stubApi({ "/v1/admin/apps": { body: { app_id: APP_ID, keys: [] } } });
}

afterEach(() => vi.unstubAllGlobals());

describe("AuthPolicyTab issuer section for an api_key app", () => {
  it("hides the issuer fields until verified user identity is required", async () => {
    stubKeys();
    renderAuthenticated(<AuthPolicyTab appId={APP_ID} state={draftFor(serverApp())} />);

    const toggle = await screen.findByRole("switch", { name: /issuer jwt/i });
    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    expect(screen.queryByLabelText(/jwks url/i)).toBeNull();
    expect(screen.queryByText(/required claims/i)).toBeNull();
  });

  it("explains what configuring an issuer changes", async () => {
    stubKeys();
    renderAuthenticated(<AuthPolicyTab appId={APP_ID} state={draftFor(serverApp())} />);

    expect(await screen.findByText(/short-lived gateway token/i)).toBeTruthy();
    expect(screen.getByText(/user ids are self-reported/i)).toBeTruthy();
  });

  it("enables the issuer through the draft rather than editing it in place", async () => {
    stubKeys();
    const state = draftFor(serverApp());
    renderAuthenticated(<AuthPolicyTab appId={APP_ID} state={state} />);

    await userEvent.click(await screen.findByRole("switch", { name: /issuer jwt/i }));

    expect(state.setIssuerEnabled).toHaveBeenCalledWith(true);
  });

  it("reveals the same issuer fields App Attest apps use once one is configured", async () => {
    stubKeys();
    const issuer: AuthConfig = { jwks_url: "https://issuer.example.test/jwks.json", required_claims: [] };
    const state = draftFor(serverApp(issuer));
    renderAuthenticated(<AuthPolicyTab appId={APP_ID} state={state} />);

    const toggle = await screen.findByRole("switch", { name: /issuer jwt/i });
    expect(toggle.getAttribute("data-state")).toBe("checked");
    const jwks = await screen.findByLabelText(/jwks url/i);
    expect(jwks).toHaveProperty("value", issuer.jwks_url);

    await userEvent.type(jwks, "x");
    expect(state.updateIssuer).toHaveBeenCalledWith({ jwks_url: `${issuer.jwks_url}x` });
  });

  it("disables the toggle for a read-only member", async () => {
    stubKeys();
    renderAuthenticated(<AuthPolicyTab appId={APP_ID} state={draftFor(serverApp())} />, {
      session: { role: "member" },
    });

    expect(await screen.findByRole("switch", { name: /issuer jwt/i }))
      .toHaveProperty("disabled", true);
  });
});

describe("AuthPolicyTab for an App Attest app", () => {
  it("edits the mandatory issuer without any development or environment controls", async () => {
    stubKeys();
    renderAuthenticated(<AuthPolicyTab appId={APP_ID} state={draftFor(appleApp())} />);

    expect(await screen.findByLabelText(/jwks url/i)).toBeTruthy();
    expect(screen.getByText(/required claims/i)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/development/i)).toBeNull();
  });
});
