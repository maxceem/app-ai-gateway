import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAppDraft } from "./use-app-draft";
import { stubApi, testQueryClient } from "@/test/render";
import { emptyIssuer, type AuthenticationDraft } from "@/lib/config-types";
import { fromWireApp } from "@/lib/config-conversion";

const APP_ID = "my-app";

const SERVER_AUTH: AuthenticationDraft = {
  type: "api_key",
};

const APPLE_ISSUER = {
  jwks_url: "https://issuer.example.test/jwks.json",
  issuer: ["https://issuer.example.test"],
  audience: ["com.example.test"],
  user_id_claim: "sub",
  required_claims: [],
  max_token_lifetime_seconds: 3600,
};

const APPLE_AUTH: AuthenticationDraft = {
  type: "apple_app_attest",
  app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.test" },
  end_user: { source: "issuer", issuer: APPLE_ISSUER },
};

function appRow(authentication: AuthenticationDraft) {
  return {
    id: APP_ID,
    revision: 1,
    name: "My app",
    status: "active" as const,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    config: {
      authentication,
      routing: { providers: { mode: "all" }, model_rewrites: {} },
    },
  };
}

async function loadedDraft(authentication: AuthenticationDraft) {
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
    const stored: AuthenticationDraft = {
      type: "api_key",
      end_user: {
        source: "issuer",
        issuer: {
          jwks_url: "https://issuer.example.test/jwks.json",
          issuer: ["https://issuer.example.test"],
          audience: ["my-app"],
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
    } as AuthenticationDraft);

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


describe("application revision protection", () => {
  it("retains a dirty draft and its original revision across background refresh", async () => {
    const initial = appRow(SERVER_AUTH);
    let writtenBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writtenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ error: { code: "app_revision_conflict", message: "Reload before saving" } }), { status: 409 });
      }
      return new Response(JSON.stringify({ app: initial, resolved: null, config_error: null }));
    }));
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useAppDraft(APP_ID), { wrapper });
    await waitFor(() => expect(view.result.current.draft).not.toBeNull());
    act(() => view.result.current.update({ name: "My unsaved edit" }));
    act(() => client.setQueryData(["app", APP_ID], fromWireApp({
      app: { ...initial, name: "Other editor", revision: 2 },
      resolved: null,
      config_error: null,
    })));
    await waitFor(() => expect(view.result.current.query.data?.kind).toBe("valid"));
    expect(view.result.current.draft?.name).toBe("My unsaved edit");
    await act(async () => { expect(await view.result.current.save()).toBe(false); });
    // The revision the draft was opened at, carried in the resource itself.
    expect(writtenBody?.revision).toBe(1);
    expect(view.result.current.dirty).toBe(true);
  });

  it("preserves structured edits made while a save is in flight", async () => {
    const initial = appRow(SERVER_AUTH);
    let finishPut!: (response: Response) => void;
    const put = new Promise<Response>((resolve) => { finishPut = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return put;
      return new Response(JSON.stringify({ app: initial, resolved: null, config_error: null }));
    }));
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useAppDraft(APP_ID), { wrapper });
    await waitFor(() => expect(view.result.current.draft).not.toBeNull());
    act(() => view.result.current.update({ name: "Submitted name" }));
    let saving!: Promise<boolean>;
    act(() => { saving = view.result.current.save(); });
    act(() => view.result.current.update({ name: "Newer unsaved name" }));
    finishPut(new Response(JSON.stringify({
      app: { ...initial, name: "Submitted name", revision: 2 },
      resolved: null,
      config_error: null,
    })));
    await act(async () => { expect(await saving).toBe(true); });

    expect(view.result.current.draft?.name).toBe("Newer unsaved name");
    expect(view.result.current.dirty).toBe(true);
  });
});

const VALID_CONFIG = {
  authentication: { type: "api_key" as const },
  routing: { providers: { mode: "all" as const }, model_rewrites: {} },
};

function wireApp(id: string, revision: number, config: Record<string, unknown>) {
  return {
    id,
    revision,
    name: `App ${id}`,
    status: "active" as const,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    config,
  };
}

describe("malformed configuration repair", () => {
  it("keeps raw edits and the opened revision across a valid background refresh", async () => {
    const invalid = fromWireApp({
      app: wireApp(APP_ID, 7, { authentication: { type: "api_key" } }),
      resolved: null,
      config_error: "Invalid routing configuration",
    });
    const client = testQueryClient();
    client.setQueryData(["app", APP_ID], invalid);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useAppDraft(APP_ID), { wrapper });
    await waitFor(() => expect(view.result.current.repair).not.toBeNull());
    const edited = `${JSON.stringify(VALID_CONFIG, null, 2)}\n`;
    act(() => view.result.current.updateRepair(edited));

    act(() => client.setQueryData(["app", APP_ID], fromWireApp({
      app: wireApp(APP_ID, 8, VALID_CONFIG),
      resolved: {},
      config_error: null,
    })));
    await waitFor(() => expect(view.result.current.query.data?.kind).toBe("valid"));

    expect(view.result.current.repair?.text).toBe(edited);
    expect(view.result.current.repair?.revision).toBe(7);
    expect(view.result.current.repairDirty).toBe(true);
  });

  it("keeps a dirty structured draft when a background response becomes invalid", async () => {
    const client = testQueryClient();
    client.setQueryData(["app", APP_ID], fromWireApp({
      app: wireApp(APP_ID, 7, VALID_CONFIG),
      resolved: {},
      config_error: null,
    }));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useAppDraft(APP_ID), { wrapper });
    await waitFor(() => expect(view.result.current.draft).not.toBeNull());
    act(() => view.result.current.update({ name: "Unsaved name" }));

    act(() => client.setQueryData(["app", APP_ID], fromWireApp({
      app: wireApp(APP_ID, 8, { authentication: { type: "api_key" } }),
      resolved: null,
      config_error: "Invalid routing configuration",
    })));
    await waitFor(() => expect(view.result.current.query.data?.kind).toBe("invalid"));

    expect(view.result.current.draft?.name).toBe("Unsaved name");
    expect(view.result.current.repair).toBeNull();
    expect(view.result.current.dirty).toBe(true);
  });

  it("validates the correction locally and sends the original revision", async () => {
    let written: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        written = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          app: wireApp(APP_ID, 8, VALID_CONFIG),
          resolved: {},
          config_error: null,
        }));
      }
      return new Response(JSON.stringify({
        app: wireApp(APP_ID, 7, { authentication: { type: "api_key" } }),
        resolved: null,
        config_error: "Invalid routing configuration",
      }));
    }));
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useAppDraft(APP_ID), { wrapper });
    await waitFor(() => expect(view.result.current.repair).not.toBeNull());
    act(() => view.result.current.updateRepair(JSON.stringify(VALID_CONFIG)));

    await act(async () => { expect(await view.result.current.saveRepair()).toBe(true); });

    expect(written?.revision).toBe(7);
    expect(view.result.current.draft?.config).toEqual(VALID_CONFIG);
    expect(view.result.current.repair).toBeNull();
  });

  it("preserves edits made while a repair save is in flight", async () => {
    let finishPut!: (response: Response) => void;
    const put = new Promise<Response>((resolve) => { finishPut = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return put;
      return new Response(JSON.stringify({
        app: wireApp(APP_ID, 7, { authentication: { type: "api_key" } }),
        resolved: null,
        config_error: "Invalid routing configuration",
      }));
    }));
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useAppDraft(APP_ID), { wrapper });
    await waitFor(() => expect(view.result.current.repair).not.toBeNull());
    const submitted = JSON.stringify(VALID_CONFIG);
    act(() => view.result.current.updateRepair(submitted));
    let saving!: Promise<boolean>;
    act(() => { saving = view.result.current.saveRepair(); });
    const newer = `${submitted}\n`;
    act(() => view.result.current.updateRepair(newer));
    finishPut(new Response(JSON.stringify({
      app: wireApp(APP_ID, 8, VALID_CONFIG),
      resolved: {},
      config_error: null,
    })));
    await act(async () => { expect(await saving).toBe(true); });

    expect(view.result.current.repair?.text).toBe(newer);
    expect(view.result.current.repair?.revision).toBe(8);
    expect(view.result.current.repairDirty).toBe(true);
  });

  it("does not let an old app's deferred save replace the navigated session", async () => {
    let finishPut!: (response: Response) => void;
    const put = new Promise<Response>((resolve) => { finishPut = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return put;
      const id = path.includes("other-app") ? "other-app" : APP_ID;
      return new Response(JSON.stringify(id === APP_ID ? {
        app: wireApp(APP_ID, 7, { authentication: { type: "api_key" } }),
        resolved: null,
        config_error: "Invalid routing configuration",
      } : {
        app: wireApp(id, 2, VALID_CONFIG),
        resolved: {},
        config_error: null,
      }));
    }));
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(({ id }) => useAppDraft(id), {
      wrapper,
      initialProps: { id: APP_ID },
    });
    await waitFor(() => expect(view.result.current.repair).not.toBeNull());
    act(() => view.result.current.updateRepair(JSON.stringify(VALID_CONFIG)));
    let saving!: Promise<boolean>;
    act(() => { saving = view.result.current.saveRepair(); });
    view.rerender({ id: "other-app" });
    await waitFor(() => expect(view.result.current.draft?.name).toBe("App other-app"));
    finishPut(new Response(JSON.stringify({
      app: wireApp(APP_ID, 8, VALID_CONFIG),
      resolved: {},
      config_error: null,
    })));
    await act(async () => { await saving; });

    expect(view.result.current.draft?.name).toBe("App other-app");
  });
});
