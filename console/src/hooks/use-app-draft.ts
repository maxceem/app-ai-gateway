import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_END_USER_HEADER,
  authIssuer,
  emptyIssuer,
  withIssuer,
  type AuthConfig,
  type AuthenticationDraft,
  type EndUserIdentity,
  type EndpointsConfig,
  type LimitsConfig,
  type ProxyConfig,
  type AppConfigDraft,
} from "@/lib/config-types";
import { useApp, useSaveApp } from "@/lib/queries";
import { identifiesEndUsers, parseAppConfig } from "@shared/app-config";
import type { AppRow, AppUpsertBody, InvalidAppResponse } from "@/lib/types";

export interface Draft {
  name: string;
  config: AppConfigDraft;
  status: "active" | "disabled";
}

export function toDraft(row: AppRow): Draft {
  return { name: row.name, config: row.config, status: row.status };
}

const asBody = (draft: Draft): AppUpsertBody => draft;

type StructuredSession = {
  kind: "structured";
  appId: string;
  draft: Draft;
  baseline: Draft;
  revision: number;
};

type RepairSession = {
  kind: "repair";
  appId: string;
  row: InvalidAppResponse["app"];
  text: string;
  baseline: string;
  revision: number;
  error: string | null;
};

type EditorSession = StructuredSession | RepairSession;

const sessionDirty = (session: EditorSession): boolean => session.kind === "structured"
  ? JSON.stringify(session.draft) !== JSON.stringify(session.baseline)
  : session.text !== session.baseline;

export function useAppDraft(appId: string) {
  const query = useApp(appId);
  const saveMutation = useSaveApp(appId);
  const [session, setSession] = useState<EditorSession | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  /**
   * What the issuer held the last time one was configured, so switching the
   * toggle off and back on restores the JWKS URL and claims instead of handing
   * the operator a blank form.
   */
  const lastIssuer = useRef<AuthConfig | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setSession((current) => {
      // A dirty editor owns both its working value and the revision it opened
      // at, even when a background refetch changes validity or revision.
      if (current?.appId === appId && sessionDirty(current)) return current;
      if (query.data.kind === "valid") {
        const draft = toDraft(query.data.app);
        return {
          kind: "structured",
          appId,
          draft,
          baseline: draft,
          revision: query.data.app.revision,
        };
      }
      const text = JSON.stringify(query.data.app.config, null, 2);
      return {
        kind: "repair",
        appId,
        row: query.data.app,
        text,
        baseline: text,
        revision: query.data.app.revision,
        error: query.data.config_error,
      };
    });
  }, [appId, query.data]);

  const activeSession = session?.appId === appId ? session : null;
  const activeDraft = activeSession?.kind === "structured" ? activeSession.draft : null;
  const activeRepair = activeSession?.kind === "repair" ? activeSession : null;
  const dirty = activeSession?.kind === "structured" ? sessionDirty(activeSession) : false;
  const repairDirty = activeSession?.kind === "repair" ? sessionDirty(activeSession) : false;

  useEffect(() => {
    if (activeDraft) lastIssuer.current = authIssuer(activeDraft.config.authentication) ?? null;
  }, [appId, activeSession?.kind, activeSession?.revision]);

  const setDraft = useCallback((update: (current: Draft | null) => Draft | null) => {
    setSession((current) => {
      if (current?.kind !== "structured" || current.appId !== appId) return current;
      const draft = update(current.draft);
      return draft === null ? current : { ...current, draft };
    });
  }, [appId]);

  const update = useCallback((partial: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...partial } : current));
  }, [setDraft]);

  const updateConfig = useCallback((partial: Partial<AppConfigDraft>) => {
    setDraft((current) => current
      ? { ...current, config: { ...current.config, ...partial } }
      : current);
  }, [setDraft]);

  const updateAuthentication = useCallback((authentication: AuthenticationDraft) => {
    updateConfig({ authentication });
  }, [updateConfig]);

  const updateIssuer = useCallback((partial: Partial<AuthConfig>) => {
    setDraft((current) => {
      if (!current) return current;
      const authentication = current.config.authentication;
      // An api_key app has no issuer until the operator enables one. An App
      // Attest app always has one, so a config edited into shape without it
      // starts from the defaults the form is already showing.
      const issuer = authIssuer(authentication)
        ?? (authentication.type === "apple_app_attest" ? emptyIssuer() : undefined);
      if (!issuer) return current;
      return {
        ...current,
        config: {
          ...current.config,
          authentication: withIssuer(authentication, { ...issuer, ...partial }),
        },
      };
    });
  }, [setDraft]);

/**
   * Switches which source identifies this application's end users. `undefined`
   * is only reachable on an api_key app and means it has none, which drops the
   * block rather than blanking it — the saved config then matches an app that
   * never had one. An issuer that was configured is kept in memory, so moving
   * away and back returns the JWKS URL and claims instead of a blank form.
   */
  const setEndUserSource = useCallback((source: EndUserIdentity["source"] | undefined) => {
    setDraft((current) => {
      if (!current) return current;
      const authentication = current.config.authentication;
      const configured = authIssuer(authentication);
      if (configured) lastIssuer.current = configured;
      const next = ((): AuthenticationDraft => {
        if (source === "issuer") {
          return withIssuer(authentication, configured ?? lastIssuer.current ?? emptyIssuer());
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
            per_user: {
              requests: { per_minute: null, per_day: null },
              spending: { monthly_usd: null },
            },
          },
        };
      return { ...current, config: { ...config, authentication: next } };
    });
  }, [setDraft]);

  /** The header name, editable only while a header source is selected. */
  const updateEndUserHeader = useCallback((header: string) => {
    setDraft((current) => {
      if (!current) return current;
      const authentication = current.config.authentication;
      if (authentication.type !== "api_key" || authentication.end_user?.source !== "header") {
        return current;
      }
      return {
        ...current,
        config: {
          ...current.config,
          authentication: { ...authentication, end_user: { source: "header", header } },
        },
      };
    });
  }, [setDraft]);

  const updateProxy = useCallback((partial: Partial<ProxyConfig>) => {
    setDraft((current) => current
      ? { ...current, config: { ...current.config, routing: { ...current.config.routing, ...partial } } }
      : current);
  }, [setDraft]);


  const updateLimits = useCallback((limits: LimitsConfig) => updateConfig({ limits }), [updateConfig]);

  // Endpoints live inside config_json, so they ride the same draft as the rest.
  // An empty map is dropped so apps without endpoints keep their config clean.
  const updateEndpoints = useCallback((endpoints: EndpointsConfig) => {
    setDraft((current) => {
      if (!current) return current;
      const { endpoints: _previous, ...config } = current.config;
      return {
        ...current,
        config: Object.keys(endpoints).length === 0 ? config : { ...config, endpoints },
      };
    });
  }, [setDraft]);

  const reset = useCallback(() => {
    if (!activeSession || activeSession.kind !== "structured") return;
    const restored = activeSession.baseline;
    // Discarding also forgets an issuer that only ever existed in the draft.
    lastIssuer.current = authIssuer(restored.config.authentication) ?? null;
    setSession({ ...activeSession, draft: restored });
  }, [activeSession]);

  const save = useCallback(async () => {
    if (!activeDraft || activeSession?.kind !== "structured") return false;
    const submitted = activeDraft;
    const submittedRevision = activeSession.revision;
    try {
      const saved = await saveMutation.mutateAsync({
        body: asBody(submitted),
        revision: submittedRevision,
      });
      const next = toDraft(saved.app);
      setSession((current) => {
        if (current?.kind !== "structured"
          || current.appId !== appId
          || current.revision !== submittedRevision) return current;
        return {
          ...current,
          draft: JSON.stringify(current.draft) === JSON.stringify(submitted) ? next : current.draft,
          baseline: next,
          revision: saved.app.revision,
        };
      });
      toast.success("Configuration saved", {
        description: "The gateway picks it up within the 60 second config cache TTL.",
      });
      return true;
    } catch (error) {
      toast.error("Save rejected", { description: error instanceof Error ? error.message : "Unknown error" });
      return false;
    }
  }, [activeDraft, activeSession, appId, saveMutation]);

  const updateRepair = useCallback((text: string) => {
    setSession((current) => current?.kind === "repair" && current.appId === appId
      ? { ...current, text }
      : current);
    setRepairError(null);
  }, [appId]);

  const resetRepair = useCallback(() => {
    setSession((current) => current?.kind === "repair" && current.appId === appId
      ? { ...current, text: current.baseline }
      : current);
    setRepairError(null);
  }, [appId]);

  const saveRepair = useCallback(async () => {
    if (!activeRepair) return false;
    const submittedText = activeRepair.text;
    const submittedRevision = activeRepair.revision;
    let raw: unknown;
    try {
      raw = JSON.parse(submittedText) as unknown;
    } catch (error) {
      setRepairError(error instanceof Error ? error.message : "Invalid JSON");
      return false;
    }
    try {
      const config = parseAppConfig(raw);
      const saved = await saveMutation.mutateAsync({
        body: { name: activeRepair.row.name, status: activeRepair.row.status, config },
        revision: submittedRevision,
      });
      const draft = toDraft(saved.app);
      setSession((current) => {
        if (current?.kind !== "repair"
          || current.appId !== appId
          || current.revision !== submittedRevision) return current;
        if (current.text === submittedText) {
          return {
            kind: "structured",
            appId,
            draft,
            baseline: draft,
            revision: saved.app.revision,
          };
        }
        const baseline = JSON.stringify(saved.app.config, null, 2);
        return {
          ...current,
          row: {
            ...saved.app,
            config: Object.fromEntries(Object.entries(saved.app.config)),
          },
          baseline,
          revision: saved.app.revision,
          error: null,
        };
      });
      setRepairError(null);
      toast.success("Configuration repaired", {
        description: "The gateway picks it up within the 60 second config cache TTL.",
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setRepairError(message);
      toast.error("Save rejected", { description: message });
      return false;
    }
  }, [activeRepair, appId, saveMutation]);

  return {
    query,
    draft: activeDraft,
    dirty,
    update,
    updateConfig,
    updateAuthentication,
    updateIssuer,
    setEndUserSource,
    updateEndUserHeader,
    updateProxy,
    updateLimits,
    updateEndpoints,
    reset,
    save,
    repair: activeRepair,
    invalidApp: activeRepair?.row ?? null,
    configError: activeRepair && query.data?.kind === "invalid" && activeRepair.error !== null
      ? query.data.config_error
      : null,
    storedConfigValid: activeRepair !== null
      && (activeRepair.error === null || query.data?.kind === "valid"),
    repairDirty,
    repairError,
    updateRepair,
    resetRepair,
    saveRepair,
    saving: saveMutation.isPending,
  };
}

export type AppDraft = ReturnType<typeof useAppDraft>;
