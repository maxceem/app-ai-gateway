import { useCallback, useEffect, useReducer, useState } from "react";
import { reduceAppDraft, sessionDirty, type Draft } from "@/lib/app-draft";
import type {
  AppConfigDraft,
  AuthConfig,
  AuthenticationDraft,
  EndUserIdentity,
  EndpointsConfig,
  LimitsConfig,
  ProxyConfig,
} from "@/lib/config-types";
import { useApp, useSaveApp } from "@/lib/queries";
import { parseAppConfig } from "@shared/app-config";
import type { AppUpsertBody } from "@/lib/types";

/** The shape every tab edits, re-exported under the name they import it by. */
export type { Draft } from "@/lib/app-draft";

const asBody = (draft: Draft): AppUpsertBody => draft;

/**
 * What a save came back with. The hook reports rather than announces: a toast
 * is the page's to raise, so the same save can be driven from a test, or from
 * a screen that says it some other way, without one appearing.
 *
 * `inline` marks a rejection the editor is already showing in place — a repair
 * that is not valid JSON — which a page must not also toast.
 */
export type SaveOutcome =
  | { ok: true }
  | { ok: false; message: string; inline?: true };

/**
 * One application, held as the editor's session, with the transitions it can
 * make living in `@/lib/app-draft`.
 *
 * What is left here is everything that needs React or the network: the query
 * whose answer opens a session, and the two saves, each of which submits the
 * value and the revision it was opened at and then hands the reply back to the
 * reducer for the race guard to judge.
 */
export function useAppDraft(appId: string) {
  const query = useApp(appId);
  const saveMutation = useSaveApp(appId);
  const [session, dispatch] = useReducer(reduceAppDraft, null);
  const [repairError, setRepairError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.data) return;
    dispatch({ kind: "loaded", appId, response: query.data });
  }, [appId, query.data]);

  const activeSession = session?.appId === appId ? session : null;
  const activeDraft = activeSession?.kind === "structured" ? activeSession.draft : null;
  const activeRepair = activeSession?.kind === "repair" ? activeSession : null;
  const dirty = activeSession?.kind === "structured" ? sessionDirty(activeSession) : false;
  const repairDirty = activeSession?.kind === "repair" ? sessionDirty(activeSession) : false;

  const update = useCallback((partial: Partial<Draft>) => {
    dispatch({ kind: "update", appId, partial });
  }, [appId]);

  const updateConfig = useCallback((partial: Partial<AppConfigDraft>) => {
    dispatch({ kind: "updateConfig", appId, partial });
  }, [appId]);

  const updateAuthentication = useCallback((authentication: AuthenticationDraft) => {
    dispatch({ kind: "updateAuthentication", appId, authentication });
  }, [appId]);

  const updateIssuer = useCallback((partial: Partial<AuthConfig>) => {
    dispatch({ kind: "updateIssuer", appId, partial });
  }, [appId]);

  const setEndUserSource = useCallback((source: EndUserIdentity["source"] | undefined) => {
    dispatch({ kind: "setEndUserSource", appId, source });
  }, [appId]);

  const updateEndUserHeader = useCallback((header: string) => {
    dispatch({ kind: "updateEndUserHeader", appId, header });
  }, [appId]);

  const updateProxy = useCallback((partial: Partial<ProxyConfig>) => {
    dispatch({ kind: "updateProxy", appId, partial });
  }, [appId]);

  const updateLimits = useCallback((limits: LimitsConfig) => {
    dispatch({ kind: "updateLimits", appId, limits });
  }, [appId]);

  const updateEndpoints = useCallback((endpoints: EndpointsConfig) => {
    dispatch({ kind: "updateEndpoints", appId, endpoints });
  }, [appId]);

  const reset = useCallback(() => {
    dispatch({ kind: "reset", appId });
  }, [appId]);

  const updateRepair = useCallback((text: string) => {
    dispatch({ kind: "updateRepair", appId, text });
    setRepairError(null);
  }, [appId]);

  const resetRepair = useCallback(() => {
    dispatch({ kind: "resetRepair", appId });
    setRepairError(null);
  }, [appId]);

  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (!activeDraft || activeSession?.kind !== "structured") {
      return { ok: false, message: "There is nothing to save", inline: true };
    }
    const submitted = activeDraft;
    const submittedRevision = activeSession.revision;
    try {
      const saved = await saveMutation.mutateAsync({
        body: asBody(submitted),
        revision: submittedRevision,
      });
      dispatch({ kind: "saved", appId, submitted, submittedRevision, app: saved.app });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Unknown error" };
    }
  }, [activeDraft, activeSession, appId, saveMutation]);

  const saveRepair = useCallback(async (): Promise<SaveOutcome> => {
    if (!activeRepair) return { ok: false, message: "There is nothing to repair", inline: true };
    const submittedText = activeRepair.text;
    const submittedRevision = activeRepair.revision;
    let raw: unknown;
    try {
      raw = JSON.parse(submittedText) as unknown;
    } catch (error) {
      // Said in place beside the editor, where the offending text is; a toast
      // would repeat a message the operator is already looking at.
      const message = error instanceof Error ? error.message : "Invalid JSON";
      setRepairError(message);
      return { ok: false, message, inline: true };
    }
    try {
      const config = parseAppConfig(raw);
      const saved = await saveMutation.mutateAsync({
        body: { name: activeRepair.row.name, status: activeRepair.row.status, config },
        revision: submittedRevision,
      });
      dispatch({ kind: "repaired", appId, submittedText, submittedRevision, app: saved.app });
      setRepairError(null);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setRepairError(message);
      return { ok: false, message };
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
