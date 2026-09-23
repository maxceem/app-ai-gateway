/**
 * The application editor's state and every transition it can make.
 *
 * One app is edited in one of two ways, and which one is not the operator's
 * choice: a configuration that parses is edited through the forms, and one that
 * does not is edited as raw JSON until it parses. {@link EditorSession} is that
 * pair, and {@link reduceAppDraft} is the whole of how one moves — a pure
 * function of the session and an action, so a transition can be read and tested
 * without a component, a query client or a render.
 *
 * `useAppDraft` in `@/hooks/use-app-draft` is the only caller: it holds this
 * state in a reducer, dispatches `loaded` when the query answers, and owns the
 * two saves. Nothing about React belongs here.
 */

import {
  DEFAULT_END_USER_HEADER,
  authIssuer,
  emptyIssuer,
  withIssuer,
  type AppConfigDraft,
  type AuthConfig,
  type AuthenticationDraft,
  type EndUserIdentity,
  type EndpointsConfig,
  type LimitsConfig,
  type ProxyConfig,
} from "@/lib/config-types";
import { unlimitedScope } from "@shared/app-defaults";
import { identifiesEndUsers } from "@shared/app-config";
import type { AppResponse, AppRow, InvalidAppResponse } from "@/lib/types";

export interface Draft {
  name: string;
  config: AppConfigDraft;
  status: "active" | "disabled";
}

export function toDraft(row: AppRow): Draft {
  return { name: row.name, config: row.config, status: row.status };
}

/**
 * What an issuer held the last time one was configured, so switching the toggle
 * off and back on restores the JWKS URL and claims instead of handing the
 * operator a blank form. It belongs to the session rather than to a ref beside
 * it: navigating to another app opens another session, and the memory of this
 * app's issuer has no business surviving that.
 */
interface IssuerMemory {
  rememberedIssuer: AuthConfig | null;
}

export type StructuredSession = IssuerMemory & {
  kind: "structured";
  appId: string;
  draft: Draft;
  baseline: Draft;
  revision: number;
};

export type RepairSession = IssuerMemory & {
  kind: "repair";
  appId: string;
  row: InvalidAppResponse["app"];
  text: string;
  baseline: string;
  revision: number;
  error: string | null;
};

export type EditorSession = StructuredSession | RepairSession;

export const sessionDirty = (session: EditorSession): boolean => session.kind === "structured"
  ? JSON.stringify(session.draft) !== JSON.stringify(session.baseline)
  : session.text !== session.baseline;

/**
 * Every move the editor can make.
 *
 * Each one names the app it is for, and the reducer drops an action for any
 * other one: a save that lands after the operator navigated away, or an edit
 * from a tab that has not unmounted yet, must not reach the session now open.
 */
export type AppDraftAction =
  /** The query answered. A dirty session outranks it — see the reducer. */
  | { kind: "loaded"; appId: string; response: AppResponse }
  | { kind: "update"; appId: string; partial: Partial<Draft> }
  | { kind: "updateConfig"; appId: string; partial: Partial<AppConfigDraft> }
  | { kind: "updateAuthentication"; appId: string; authentication: AuthenticationDraft }
  | { kind: "updateIssuer"; appId: string; partial: Partial<AuthConfig> }
  | { kind: "setEndUserSource"; appId: string; source: EndUserIdentity["source"] | undefined }
  | { kind: "updateEndUserHeader"; appId: string; header: string }
  | { kind: "updateProxy"; appId: string; partial: Partial<ProxyConfig> }
  | { kind: "updateLimits"; appId: string; limits: LimitsConfig }
  | { kind: "updateEndpoints"; appId: string; endpoints: EndpointsConfig }
  | { kind: "reset"; appId: string }
  | { kind: "updateRepair"; appId: string; text: string }
  | { kind: "resetRepair"; appId: string }
  /** A structured save came back. `submittedRevision` is the race guard. */
  | { kind: "saved"; appId: string; submitted: Draft; submittedRevision: number; app: AppRow }
  /** A repair save came back, which may turn this session into a structured one. */
  | {
      kind: "repaired";
      appId: string;
      submittedText: string;
      submittedRevision: number;
      app: AppRow;
    };

const structuredOf = (
  session: EditorSession | null,
  appId: string,
): StructuredSession | null =>
  session?.kind === "structured" && session.appId === appId ? session : null;

const repairOf = (session: EditorSession | null, appId: string): RepairSession | null =>
  session?.kind === "repair" && session.appId === appId ? session : null;

/** The session that holds this draft, with the draft replaced. */
const withDraft = (session: StructuredSession, draft: Draft): StructuredSession =>
  ({ ...session, draft });

const remembering = (draft: Draft): AuthConfig | null =>
  authIssuer(draft.config.authentication) ?? null;

/** The session a fresh read of a valid application opens. */
function loadedStructured(appId: string, app: AppRow): StructuredSession {
  const draft = toDraft(app);
  return {
    kind: "structured",
    appId,
    draft,
    baseline: draft,
    revision: app.revision,
    rememberedIssuer: remembering(draft),
  };
}

/**
 * Switches which source identifies this application's end users. `undefined`
 * is only reachable on an api_key app and means it has none, which drops the
 * block rather than blanking it — the saved config then matches an app that
 * never had one. An issuer that was configured is kept in memory, so moving
 * away and back returns the JWKS URL and claims instead of a blank form.
 */
function switchEndUserSource(
  session: StructuredSession,
  source: EndUserIdentity["source"] | undefined,
): StructuredSession {
  const current = session.draft;
  const authentication = current.config.authentication;
  const configured = authIssuer(authentication);
  const remembered = configured ?? session.rememberedIssuer;
  const next = ((): AuthenticationDraft => {
    if (source === "issuer") {
      return withIssuer(authentication, configured ?? session.rememberedIssuer ?? emptyIssuer());
    }
    if (source === "app_install") {
      // Only App Attest reaches this; the picker offers it nowhere else.
      return authentication.type === "apple_app_attest"
        ? { ...authentication, end_user: { source: "app_install" } }
        : authentication;
    }
    if (source === "header") {
      return authentication.type === "api_key"
        ? {
          ...authentication,
          end_user: {
            source: "header",
            // Keeps a name the operator already typed rather than resetting
            // it every time the picker passes through another option.
            header: authentication.end_user?.source === "header"
              ? authentication.end_user.header
              : DEFAULT_END_USER_HEADER,
          },
        }
        : authentication;
    }
    return withIssuer(authentication, undefined);
  })();
  /*
   * Per-user limits go with the users. The gateway refuses a `per_user`
   * block on an application that identifies nobody, and the Limits tab hides
   * the card once there is no source — so leaving the numbers behind would
   * be a save that fails against fields the operator can no longer see.
   */
  const config = identifiesEndUsers(next)
    ? current.config
    : {
      ...current.config,
      limits: {
        ...current.config.limits,
        per_user: unlimitedScope(),
      },
    };
  return {
    ...session,
    draft: { ...current, config: { ...config, authentication: next } },
    rememberedIssuer: remembered,
  };
}

/** The issuer block edited in place, materializing one where the app implies it. */
function editIssuer(
  session: StructuredSession,
  partial: Partial<AuthConfig>,
): StructuredSession {
  const current = session.draft;
  const authentication = current.config.authentication;
  // An api_key app has no issuer until the operator enables one. An App
  // Attest app always has one, so a config edited into shape without it
  // starts from the defaults the form is already showing.
  const issuer = authIssuer(authentication)
    ?? (authentication.type === "apple_app_attest" ? emptyIssuer() : undefined);
  if (!issuer) return session;
  return withDraft(session, {
    ...current,
    config: {
      ...current.config,
      authentication: withIssuer(authentication, { ...issuer, ...partial }),
    },
  });
}

/**
 * The one transition table. Returns the session it was given when an action
 * does not apply — a different app, the other editing mode, or a save whose
 * revision has been overtaken — so a stale dispatch is a no-op rather than a
 * lost edit.
 */
export function reduceAppDraft(
  session: EditorSession | null,
  action: AppDraftAction,
): EditorSession | null {
  switch (action.kind) {
    case "loaded": {
      // A dirty editor owns both its working value and the revision it opened
      // at, even when a background refetch changes validity or revision.
      if (session?.appId === action.appId && sessionDirty(session)) return session;
      if (action.response.kind === "valid") {
        return loadedStructured(action.appId, action.response.app);
      }
      const text = JSON.stringify(action.response.app.config, null, 2);
      return {
        kind: "repair",
        appId: action.appId,
        row: action.response.app,
        text,
        baseline: text,
        revision: action.response.app.revision,
        error: action.response.config_error,
        // A malformed configuration has no issuer to remember; the one from
        // whatever was open before belongs to that app, not to this one.
        rememberedIssuer: null,
      };
    }

    case "update": {
      const current = structuredOf(session, action.appId);
      return current ? withDraft(current, { ...current.draft, ...action.partial }) : session;
    }

    case "updateConfig": {
      const current = structuredOf(session, action.appId);
      return current
        ? withDraft(current, {
          ...current.draft,
          config: { ...current.draft.config, ...action.partial },
        })
        : session;
    }

    case "updateAuthentication": {
      const current = structuredOf(session, action.appId);
      return current
        ? withDraft(current, {
          ...current.draft,
          config: { ...current.draft.config, authentication: action.authentication },
        })
        : session;
    }

    case "updateIssuer": {
      const current = structuredOf(session, action.appId);
      return current ? editIssuer(current, action.partial) : session;
    }

    case "setEndUserSource": {
      const current = structuredOf(session, action.appId);
      return current ? switchEndUserSource(current, action.source) : session;
    }

    /** The header name, editable only while a header source is selected. */
    case "updateEndUserHeader": {
      const current = structuredOf(session, action.appId);
      if (!current) return session;
      const authentication = current.draft.config.authentication;
      if (authentication.type !== "api_key" || authentication.end_user?.source !== "header") {
        return session;
      }
      return withDraft(current, {
        ...current.draft,
        config: {
          ...current.draft.config,
          authentication: {
            ...authentication,
            end_user: { source: "header", header: action.header },
          },
        },
      });
    }

    case "updateProxy": {
      const current = structuredOf(session, action.appId);
      return current
        ? withDraft(current, {
          ...current.draft,
          config: {
            ...current.draft.config,
            routing: { ...current.draft.config.routing, ...action.partial },
          },
        })
        : session;
    }

    case "updateLimits": {
      const current = structuredOf(session, action.appId);
      return current
        ? withDraft(current, {
          ...current.draft,
          config: { ...current.draft.config, limits: action.limits },
        })
        : session;
    }

    // Endpoints live inside config_json, so they ride the same draft as the
    // rest. An empty map is dropped so apps without endpoints keep their
    // config clean.
    case "updateEndpoints": {
      const current = structuredOf(session, action.appId);
      if (!current) return session;
      const { endpoints: _previous, ...config } = current.draft.config;
      return withDraft(current, {
        ...current.draft,
        config: Object.keys(action.endpoints).length === 0
          ? config
          : { ...config, endpoints: action.endpoints },
      });
    }

    case "reset": {
      const current = structuredOf(session, action.appId);
      if (!current) return session;
      const restored = current.baseline;
      return {
        ...current,
        draft: restored,
        // Discarding also forgets an issuer that only ever existed in the draft.
        rememberedIssuer: remembering(restored),
      };
    }

    case "updateRepair": {
      const current = repairOf(session, action.appId);
      return current ? { ...current, text: action.text } : session;
    }

    case "resetRepair": {
      const current = repairOf(session, action.appId);
      return current ? { ...current, text: current.baseline } : session;
    }

    case "saved": {
      const current = structuredOf(session, action.appId);
      if (!current || current.revision !== action.submittedRevision) return session;
      const next = toDraft(action.app);
      // An edit made while the save was in flight is the newer answer and
      // stays; only a draft still identical to what was sent takes the reply.
      const draft = JSON.stringify(current.draft) === JSON.stringify(action.submitted)
        ? next
        : current.draft;
      return {
        ...current,
        draft,
        baseline: next,
        revision: action.app.revision,
        rememberedIssuer: remembering(draft),
      };
    }

    case "repaired": {
      const current = repairOf(session, action.appId);
      if (!current || current.revision !== action.submittedRevision) return session;
      // What was sent is still what is typed, so the raw editor has done its
      // job and the forms take over.
      if (current.text === action.submittedText) {
        return loadedStructured(action.appId, action.app);
      }
      // A newer correction is being typed, so the raw editor stays open — with
      // the stored value it now has to beat, and its revision.
      const baseline = JSON.stringify(action.app.config, null, 2);
      return {
        ...current,
        row: {
          ...action.app,
          config: Object.fromEntries(Object.entries(action.app.config)),
        },
        baseline,
        revision: action.app.revision,
        error: null,
      };
    }
  }
}
