import { useCallback, useEffect, useReducer } from "react";
import { reduceAppDraft, sessionDirty, type Draft } from "@/lib/app-draft";
import type {
  AppConfigDraft,
  IssuerDraft,
  AuthenticationDraft,
  EndUserIdentity,
  EndpointsConfig,
  LimitsConfig,
  ProxyConfig,
} from "@/lib/config-types";
import { useApp, useSaveApp } from "@/lib/queries";
import type { AppUpsertBody } from "@/lib/types";

/** The shape every tab edits, re-exported under the name they import it by. */
export type { Draft } from "@/lib/app-draft";

const asBody = (draft: Draft): AppUpsertBody => draft;

/**
 * What a save came back with. The hook reports rather than announces: a toast
 * is the page's to raise, so the same save can be driven from a test, or from
 * a screen that says it some other way, without one appearing.
 *
 * `inline` marks a refusal the page has nothing to announce for — there was no
 * draft to save — which a page must not toast.
 */
export type SaveOutcome =
  | { ok: true }
  | { ok: false; message: string; inline?: true };

/**
 * One application, held as the editor's session, with the transitions it can
 * make living in `@/lib/app-draft`.
 *
 * What is left here is everything that needs React or the network: the query
 * whose answer opens a session, and the save, which submits the draft and the
 * revision it was opened at and then hands the reply back to the reducer for
 * the race guard to judge.
 */
export function useAppDraft(appId: string) {
  const query = useApp(appId);
  const saveMutation = useSaveApp(appId);
  const [session, dispatch] = useReducer(reduceAppDraft, null);

  useEffect(() => {
    if (!query.data) return;
    dispatch({ kind: "loaded", appId, response: query.data });
  }, [appId, query.data]);

  const activeSession = session?.appId === appId ? session : null;
  const activeDraft = activeSession?.draft ?? null;
  const dirty = activeSession ? sessionDirty(activeSession) : false;

  const update = useCallback((partial: Partial<Draft>) => {
    dispatch({ kind: "update", appId, partial });
  }, [appId]);

  const updateConfig = useCallback((partial: Partial<AppConfigDraft>) => {
    dispatch({ kind: "updateConfig", appId, partial });
  }, [appId]);

  const updateAuthentication = useCallback((authentication: AuthenticationDraft) => {
    dispatch({ kind: "updateAuthentication", appId, authentication });
  }, [appId]);

  const updateIssuer = useCallback((partial: Partial<IssuerDraft>) => {
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

  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (!activeSession) {
      return { ok: false, message: "There is nothing to save", inline: true };
    }
    const submitted = activeSession.draft;
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
  }, [activeSession, appId, saveMutation]);

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
    saving: saveMutation.isPending,
  };
}

export type AppDraft = ReturnType<typeof useAppDraft>;
