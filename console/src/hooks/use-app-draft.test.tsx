import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAppDraft } from "./use-app-draft";
import { stubApi, testQueryClient } from "@/test/render";
import type { AuthenticationConfig } from "@/lib/config-types";

const APP_ID = "my-app";

const SERVER_AUTH: AuthenticationConfig = {
  type: "api_key",
  end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
};

const APPLE_AUTH: AuthenticationConfig = {
  type: "apple_app_attest",
  issuer: {
    jwks_url: "https://issuer.example.test/jwks.json",
    user_id_claim: "sub",
    required_claims: [],
    max_token_lifetime_seconds: 3600,
  },
  app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.test" },
};

function appRow(authentication: AuthenticationConfig) {
  return {
    id: APP_ID,
    name: "My app",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    config: {
      authentication,
      routing: { providers: { mode: "all" }, model_rewrites: {} },
      limits: {
        per_user: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
        per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
      },
    },
  };
}

async function loadedDraft(authentication: AuthenticationConfig) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}`]: {
      body: { app: appRow(authentication), resolved: null, config_error: null },
    },
  });
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useAppDraft(APP_ID), { wrapper });
  await waitFor(() => expect(view.result.current.draft).not.toBeNull());
  return view;
}

const auth = (view: Awaited<ReturnType<typeof loadedDraft>>) =>
  view.result.current.draft!.config.authentication;

afterEach(() => vi.unstubAllGlobals());

describe("the optional issuer on an api_key draft", () => {
  it("loads an api_key app with no issuer key at all", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    expect("issuer" in auth(view)).toBe(false);
    expect(view.result.current.dirty).toBe(false);
  });

  it("ignores field edits until an issuer exists, rather than storing a bare block", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.updateIssuer({ jwks_url: "https://issuer.example.test/jwks.json" }));

    expect("issuer" in auth(view)).toBe(false);
    expect(view.result.current.dirty).toBe(false);
  });

  it("enables the issuer on the Worker's own defaults", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.setIssuerEnabled(true));

    expect(auth(view)).toEqual({
      ...SERVER_AUTH,
      issuer: {
        jwks_url: "",
        user_id_claim: "sub",
        required_claims: [],
        max_token_lifetime_seconds: 86400,
      },
    });
    expect(view.result.current.dirty).toBe(true);
  });

  it("edits the enabled issuer in place", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.setIssuerEnabled(true));
    act(() => view.result.current.updateIssuer({ jwks_url: "https://issuer.example.test/jwks.json" }));

    expect(auth(view)).toMatchObject({
      issuer: { jwks_url: "https://issuer.example.test/jwks.json", user_id_claim: "sub" },
    });
  });

  it("drops the key when disabled again, leaving the config byte-identical to the stored one", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.setIssuerEnabled(true));
    act(() => view.result.current.updateIssuer({ jwks_url: "https://issuer.example.test/jwks.json" }));
    act(() => view.result.current.setIssuerEnabled(false));

    expect(auth(view)).toEqual(SERVER_AUTH);
    expect("issuer" in auth(view)).toBe(false);
    // Nothing was left behind, so the save bar goes away too.
    expect(view.result.current.dirty).toBe(false);
  });
});

describe("the mandatory issuer on an App Attest draft", () => {
  it("cannot be disabled, and asking does not blank what is configured", async () => {
    const view = await loadedDraft(APPLE_AUTH);

    act(() => view.result.current.setIssuerEnabled(false));

    expect(auth(view)).toEqual(APPLE_AUTH);
    expect(view.result.current.dirty).toBe(false);
  });

  it("edits the issuer without disturbing the App Attest identifiers", async () => {
    const view = await loadedDraft(APPLE_AUTH);

    act(() => view.result.current.updateIssuer({ user_id_claim: "uid" }));

    expect(auth(view)).toEqual({
      ...APPLE_AUTH,
      issuer: { ...APPLE_AUTH.issuer, user_id_claim: "uid" },
    });
  });

  it("materializes the defaults when a hand-edited config arrives without an issuer", async () => {
    const { issuer: _dropped, ...withoutIssuer } = APPLE_AUTH as Extract<
      AuthenticationConfig,
      { type: "apple_app_attest" }
    >;
    const view = await loadedDraft(withoutIssuer as AuthenticationConfig);

    act(() => view.result.current.updateIssuer({ jwks_url: "https://issuer.example.test/jwks.json" }));

    expect(auth(view)).toMatchObject({
      issuer: {
        jwks_url: "https://issuer.example.test/jwks.json",
        user_id_claim: "sub",
        required_claims: [],
        max_token_lifetime_seconds: 86400,
      },
    });
  });
});
