import { describe, expect, it } from "vitest";
import {
  reduceAppDraft,
  type AppDraftAction,
  type EditorSession,
  type StructuredSession,
} from "./app-draft";
import { emptyIssuer } from "@/lib/config-types";
import { parseAppConfig } from "@shared/app-config";
import type { AppResponse, AppRow } from "@/lib/types";

const APP_ID = "my-app";

const SERVER = {
  authentication: { type: "api_key" },
  routing: { providers: { mode: "all" }, model_rewrites: {} },
};

const STORED_ISSUER = {
  provider: "firebase",
  jwks_url: "https://issuer.example.test/jwks.json",
  issuer: ["https://issuer.example.test"],
  audience: ["my-app"],
  user_id_claim: "uid",
  required_claims: [],
  max_token_lifetime_seconds: 3600,
};

const APPLE_IDENTIFIERS = {
  team_id: "AAAAAAAAAA",
  bundle_id: "com.example.test",
  environments: ["production"],
};

function row(config: Record<string, unknown>, revision = 1): AppRow {
  return {
    id: APP_ID,
    revision,
    name: "My app",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    config: parseAppConfig(config),
  };
}

const valid = (config: Record<string, unknown>, revision = 1): AppResponse =>
  ({ kind: "valid", app: row(config, revision), config_error: null });

/** The session a first read of this configuration opens. */
function opened(config: Record<string, unknown>): StructuredSession {
  const session = reduceAppDraft(null, {
    kind: "loaded",
    appId: APP_ID,
    response: valid(config),
  });
  if (session?.kind !== "structured") throw new Error("expected a structured session");
  return session;
}

/** Several actions in a row, as a screen would dispatch them. */
function run(session: EditorSession | null, ...actions: AppDraftAction[]): StructuredSession {
  const next = actions.reduce<EditorSession | null>(
    (current, action) => reduceAppDraft(current, action),
    session,
  );
  if (next?.kind !== "structured") throw new Error("expected a structured session");
  return next;
}

const source = (value: "issuer" | "header" | "app_install" | undefined): AppDraftAction =>
  ({ kind: "setEndUserSource", appId: APP_ID, source: value });

const authOf = (session: StructuredSession) => session.draft.config.authentication;

describe("setEndUserSource on an api_key application", () => {
  it("starts a header source on the default name", () => {
    expect(authOf(run(opened(SERVER), source("header")))).toEqual({
      type: "api_key",
      end_user: { source: "header", header: "x-end-user-id" },
    });
  });

  it("keeps a header name the operator typed while the source stays selected", () => {
    const session = run(
      opened(SERVER),
      source("header"),
      { kind: "updateEndUserHeader", appId: APP_ID, header: "x-tenant-user" },
      source("header"),
    );

    expect(authOf(session)).toMatchObject({ end_user: { header: "x-tenant-user" } });
  });

  it("starts an issuer source on the Worker's own defaults", () => {
    expect(authOf(run(opened(SERVER), source("issuer")))).toEqual({
      type: "api_key",
      end_user: { source: "issuer", issuer: emptyIssuer() },
    });
  });

  it("drops the block on the way back to no users rather than blanking it", () => {
    const session = run(opened(SERVER), source("issuer"), source(undefined));

    expect("end_user" in authOf(session)).toBe(false);
  });

  it("ignores app_install, which only an attested application can mean", () => {
    // The picker offers it nowhere else; a stale dispatch must not write a
    // source the schema refuses for this application type.
    const session = run(opened(SERVER), source("app_install"));

    expect(authOf(session)).toEqual({ type: "api_key" });
  });
});

describe("the issuer the editor remembers", () => {
  const withIssuerConfig = {
    authentication: { type: "api_key", end_user: { source: "issuer", issuer: STORED_ISSUER } },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
  };

  it("restores a configured issuer after passing through another source", () => {
    const start = opened(withIssuerConfig);
    const session = run(start, source("header"), source("issuer"));

    expect(authOf(session)).toEqual(authOf(start));
    expect(JSON.stringify(session.draft)).toBe(JSON.stringify(session.baseline));
  });

  it("keeps unsaved issuer edits across a change of source rather than reverting to defaults", () => {
    const session = run(
      opened(SERVER),
      source("issuer"),
      {
        kind: "updateIssuer",
        appId: APP_ID,
        partial: { jwks_url: "https://issuer.example.test/jwks.json" },
      },
      source(undefined),
      source("issuer"),
    );

    expect(authOf(session)).toMatchObject({
      end_user: { issuer: { jwks_url: "https://issuer.example.test/jwks.json" } },
    });
  });

  it("belongs to the session, so another application opens with nothing remembered", () => {
    const edited = run(opened(withIssuerConfig), source(undefined));
    expect(edited.rememberedIssuer).not.toBeNull();

    const other = reduceAppDraft(edited, {
      kind: "loaded",
      appId: "other-app",
      response: { kind: "invalid", app: { ...row(SERVER), config: {} }, config_error: "Invalid" },
    });

    expect(other?.rememberedIssuer).toBeNull();
  });
});

describe("per-user limits and the users they belong to", () => {
  const limited = {
    authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
    limits: {
      per_user: { requests: { per_minute: 10, per_day: null }, spending: { monthly_usd: 5 } },
      per_app: { requests: { per_minute: 100, per_day: null }, spending: { monthly_usd: null } },
    },
  };

  it("clears them when the application stops having users", () => {
    // The gateway refuses `per_user` on an application that identifies nobody,
    // and the Limits tab hides the card once there is no source.
    const session = run(opened(limited), source(undefined));

    expect(session.draft.config.limits?.per_user).toEqual({
      requests: { per_minute: null, per_day: null },
      spending: { monthly_usd: null },
    });
    // The application-wide limits are untouched: they still mean something.
    expect(session.draft.config.limits?.per_app?.requests.per_minute).toBe(100);
  });

  it("leaves them alone while the application still names its users", () => {
    const session = run(opened(limited), source("issuer"));

    expect(session.draft.config.limits?.per_user?.requests.per_minute).toBe(10);
  });

  it("clears them to a scope of this draft's own, not one shared with the next", () => {
    // The forms edit through the draft, so the cleared scope has to be a fresh
    // object: a default handed out twice would let one app's typed limit
    // reappear in another's.
    const first = run(opened(limited), source(undefined));
    const cleared = first.draft.config.limits!.per_user!;
    cleared.requests.per_minute = 99;

    const second = run(opened(limited), source(undefined));

    expect(second.draft.config.limits?.per_user).toEqual({
      requests: { per_minute: null, per_day: null },
      spending: { monthly_usd: null },
    });
  });
});

describe("setEndUserSource on an App Attest application", () => {
  const attested = (endUser: Record<string, unknown>) => ({
    authentication: {
      type: "apple_app_attest",
      app_attest: APPLE_IDENTIFIERS,
      end_user: endUser,
    },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
  });

  it("switches to the attested installation, dropping the issuer block", () => {
    const session = run(
      opened(attested({ source: "issuer", issuer: STORED_ISSUER })),
      source("app_install"),
    );

    expect(authOf(session)).toMatchObject({ end_user: { source: "app_install" } });
  });

  it("restores the configured issuer on the way back from app_install", () => {
    const start = opened(attested({ source: "issuer", issuer: STORED_ISSUER }));
    const session = run(start, source("app_install"), source("issuer"));

    expect(authOf(session)).toEqual(authOf(start));
  });

  it("cannot be left with no source at all", () => {
    // An attested client always resolves to some user, so `undefined` keeps
    // what is configured rather than blanking it.
    const start = opened(attested({ source: "issuer", issuer: STORED_ISSUER }));
    const session = run(start, source(undefined));

    expect(authOf(session)).toEqual(authOf(start));
  });

  it("materializes the defaults when an issuer edit arrives with none configured", () => {
    const session = run(opened(attested({ source: "app_install" })), {
      kind: "updateIssuer",
      appId: APP_ID,
      partial: { jwks_url: "https://issuer.example.test/jwks.json" },
    });

    expect(authOf(session)).toMatchObject({
      end_user: {
        source: "issuer",
        issuer: {
          ...emptyIssuer(),
          jwks_url: "https://issuer.example.test/jwks.json",
        },
      },
    });
  });
});

describe("updateIssuer on an application with no issuer", () => {
  it("is ignored rather than storing a bare block", () => {
    const start = opened(SERVER);
    const session = run(start, {
      kind: "updateIssuer",
      appId: APP_ID,
      partial: { jwks_url: "https://issuer.example.test/jwks.json" },
    });

    expect(session).toBe(start);
    expect("end_user" in authOf(session)).toBe(false);
  });
});

describe("reset", () => {
  it("restores the baseline and forgets an issuer that only ever existed in the draft", () => {
    const session = run(
      opened(SERVER),
      source("issuer"),
      {
        kind: "updateIssuer",
        appId: APP_ID,
        partial: { jwks_url: "https://issuer.example.test/jwks.json" },
      },
      { kind: "reset", appId: APP_ID },
    );

    expect(session.draft).toBe(session.baseline);
    expect(session.rememberedIssuer).toBeNull();
    // So enabling one again starts from the defaults, not from the discarded edit.
    expect(authOf(run(session, source("issuer")))).toMatchObject({
      end_user: { issuer: emptyIssuer() },
    });
  });

  it("does nothing for another application's session", () => {
    const start = opened(SERVER);
    expect(reduceAppDraft(start, { kind: "reset", appId: "other-app" })).toBe(start);
  });
});

describe("loaded", () => {
  it("takes a fresh read while the session is clean", () => {
    const session = reduceAppDraft(opened(SERVER), {
      kind: "loaded",
      appId: APP_ID,
      response: valid({ ...SERVER, authentication: { type: "api_key" } }, 4),
    });

    expect(session?.revision).toBe(4);
  });

  it("does not clobber a dirty session, keeping the revision it was opened at", () => {
    const dirty = run(opened(SERVER), {
      kind: "update",
      appId: APP_ID,
      partial: { name: "My unsaved edit" },
    });

    const session = reduceAppDraft(dirty, {
      kind: "loaded",
      appId: APP_ID,
      response: valid(SERVER, 9),
    });

    expect(session).toBe(dirty);
    expect(session?.revision).toBe(1);
  });

  it("opens a session for another application even when this one is dirty", () => {
    // Navigating away is not a background refetch: the edit belonged to the
    // app that is no longer on screen.
    const dirty = run(opened(SERVER), {
      kind: "update",
      appId: APP_ID,
      partial: { name: "My unsaved edit" },
    });

    const session = reduceAppDraft(dirty, {
      kind: "loaded",
      appId: "other-app",
      response: valid(SERVER, 2),
    });

    expect(session?.appId).toBe("other-app");
  });
});
