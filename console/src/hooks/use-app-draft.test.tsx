import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAppDraft } from "./use-app-draft";
import { stubApi, testQueryClient } from "@/test/render";
import { emptyIssuer, type AuthenticationConfig } from "@/lib/config-types";

const APP_ID = "my-app";

const SERVER_AUTH: AuthenticationConfig = {
  type: "api_key",
};

const APPLE_ISSUER = {
  jwks_url: "https://issuer.example.test/jwks.json",
  user_id_claim: "sub",
  required_claims: [],
  max_token_lifetime_seconds: 3600,
};

const APPLE_AUTH: AuthenticationConfig = {
  type: "apple_app_attest",
  app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.test" },
  end_user: { source: "issuer", issuer: APPLE_ISSUER },
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

describe("choosing an end-user source on an api_key draft", () => {
  it("loads an application that identifies nobody with no end_user key at all", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    expect("end_user" in auth(view)).toBe(false);
    expect(view.result.current.dirty).toBe(false);
  });

  it("ignores issuer edits until a source exists, rather than storing a bare block", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.updateIssuer({ jwks_url: "https://issuer.example.test/jwks.json" }));

    expect("end_user" in auth(view)).toBe(false);
    expect(view.result.current.dirty).toBe(false);
  });

  it("starts a header source on the default name", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.setEndUserSource("header"));

    expect(auth(view)).toEqual({
      type: "api_key",
      end_user: { source: "header", header: "x-end-user-id" },
    });
    expect(view.result.current.dirty).toBe(true);
  });

  it("keeps a header name the operator typed while the source stays selected", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.setEndUserSource("header"));
    act(() => view.result.current.updateEndUserHeader("x-tenant-user"));
    act(() => view.result.current.setEndUserSource("header"));

    expect(auth(view)).toMatchObject({ end_user: { header: "x-tenant-user" } });
  });

  it("starts an issuer source on the Worker's own defaults", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.setEndUserSource("issuer"));

    expect(auth(view)).toEqual({
      type: "api_key",
      end_user: {
        source: "issuer",
        issuer: {
          // Opens on Firebase, as the creation wizard does.
          provider: "firebase",
          jwks_url: "",
          issuer: "",
          audience: "",
          user_id_claim: "sub",
          required_claims: [],
          max_token_lifetime_seconds: 86400,
        },
      },
    });
  });

  it("edits the selected issuer in place", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.setEndUserSource("issuer"));
    act(() => view.result.current.updateIssuer({ jwks_url: "https://issuer.example.test/jwks.json" }));

    expect(auth(view)).toMatchObject({
      end_user: {
        source: "issuer",
        issuer: { jwks_url: "https://issuer.example.test/jwks.json", user_id_claim: "sub" },
      },
    });
  });

  it("drops the block on the way back to no users, leaving the config byte-identical", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.setEndUserSource("issuer"));
    act(() => view.result.current.updateIssuer({ jwks_url: "https://issuer.example.test/jwks.json" }));
    act(() => view.result.current.setEndUserSource(undefined));

    expect(auth(view)).toEqual(SERVER_AUTH);
    expect("end_user" in auth(view)).toBe(false);
    // Nothing was left behind, so the save bar goes away too.
    expect(view.result.current.dirty).toBe(false);
  });

  it("restores a configured issuer after passing through another source", async () => {
    const stored: AuthenticationConfig = {
      type: "api_key",
      end_user: {
        source: "issuer",
        issuer: {
          jwks_url: "https://issuer.example.test/jwks.json",
          user_id_claim: "uid",
          required_claims: [{ path: "claims.plan", contains: "pro" }],
          max_token_lifetime_seconds: 3600,
        },
      },
    };
    const view = await loadedDraft(stored);

    act(() => view.result.current.setEndUserSource("header"));
    act(() => view.result.current.setEndUserSource("issuer"));

    expect(auth(view)).toEqual(stored);
    expect(view.result.current.dirty).toBe(false);
  });

  it("keeps unsaved issuer edits across a change of source rather than reverting to defaults", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.setEndUserSource("issuer"));
    act(() => view.result.current.updateIssuer({ jwks_url: "https://issuer.example.test/jwks.json" }));
    act(() => view.result.current.setEndUserSource(undefined));
    act(() => view.result.current.setEndUserSource("issuer"));

    expect(auth(view)).toMatchObject({
      end_user: { issuer: { jwks_url: "https://issuer.example.test/jwks.json" } },
    });
  });

  it("clears per-user limits when the application stops having users", async () => {
    // The gateway refuses `per_user` on an application that identifies nobody,
    // and the Limits tab hides the card once there is no source — so leaving
    // the numbers behind would be a save that fails against fields the operator
    // can no longer see.
    stubApi({
      [`/v1/admin/apps/${APP_ID}`]: {
        body: {
          app: {
            ...appRow({ type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }),
            config: {
              authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
              routing: { providers: { mode: "all" }, model_rewrites: {} },
              limits: {
                per_user: { requests: { per_minute: 10, per_day: null }, spending: { monthly_usd: 5 } },
                per_app: { requests: { per_minute: 100, per_day: null }, spending: { monthly_usd: null } },
              },
            },
          },
          resolved: null,
          config_error: null,
        },
      },
    });
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useAppDraft(APP_ID), { wrapper });
    await waitFor(() => expect(view.result.current.draft).not.toBeNull());

    act(() => view.result.current.setEndUserSource(undefined));

    expect(view.result.current.draft!.config.limits!.per_user).toEqual({
      requests: { per_minute: null, per_day: null },
      spending: { monthly_usd: null },
    });
    // The application-wide limits are untouched: they still mean something.
    expect(view.result.current.draft!.config.limits!.per_app.requests.per_minute).toBe(100);
  });

  it("forgets a draft-only issuer once the edits are discarded", async () => {
    const view = await loadedDraft(SERVER_AUTH);

    act(() => view.result.current.setEndUserSource("issuer"));
    act(() => view.result.current.updateIssuer({ jwks_url: "https://issuer.example.test/jwks.json" }));
    act(() => view.result.current.reset());
    act(() => view.result.current.setEndUserSource("issuer"));

    expect(auth(view)).toMatchObject({ end_user: { issuer: emptyIssuer() } });
  });
});

describe("the end-user source on an App Attest draft", () => {
  it("switches to the attested installation, dropping the issuer block", async () => {
    const view = await loadedDraft(APPLE_AUTH);

    act(() => view.result.current.setEndUserSource("app_install"));

    expect(auth(view)).toEqual({
      type: "apple_app_attest",
      app_attest: APPLE_AUTH.app_attest,
      end_user: { source: "app_install" },
    });
  });

  it("restores the configured issuer on the way back from app_install", async () => {
    const view = await loadedDraft(APPLE_AUTH);

    act(() => view.result.current.setEndUserSource("app_install"));
    act(() => view.result.current.setEndUserSource("issuer"));

    expect(auth(view)).toEqual(APPLE_AUTH);
    expect(view.result.current.dirty).toBe(false);
  });

  it("cannot be left with no source at all", async () => {
    const view = await loadedDraft(APPLE_AUTH);

    // An attested client always resolves to some user, so `undefined` keeps
    // what is configured rather than blanking it.
    act(() => view.result.current.setEndUserSource(undefined));

    expect(auth(view)).toEqual(APPLE_AUTH);
    expect(view.result.current.dirty).toBe(false);
  });

  it("edits the issuer without disturbing the App Attest identifiers", async () => {
    const view = await loadedDraft(APPLE_AUTH);

    act(() => view.result.current.updateIssuer({ user_id_claim: "uid" }));

    expect(auth(view)).toEqual({
      ...APPLE_AUTH,
      end_user: { source: "issuer", issuer: { ...APPLE_ISSUER, user_id_claim: "uid" } },
    });
  });

  it("materializes the defaults when an issuer edit arrives with none configured", async () => {
    const view = await loadedDraft({
      type: "apple_app_attest",
      app_attest: APPLE_AUTH.app_attest,
      end_user: { source: "app_install" },
    } as AuthenticationConfig);

    act(() => view.result.current.updateIssuer({ jwks_url: "https://issuer.example.test/jwks.json" }));

    expect(auth(view)).toMatchObject({
      end_user: {
        source: "issuer",
        issuer: {
          jwks_url: "https://issuer.example.test/jwks.json",
          user_id_claim: "sub",
          required_claims: [],
          max_token_lifetime_seconds: 86400,
        },
      },
    });
  });
});
