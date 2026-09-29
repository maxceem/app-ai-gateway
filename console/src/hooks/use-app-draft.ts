import { useCallback, useEffect, useMemo, useReducer, type Dispatch } from "react";
import { reduceAppDraft, sessionDirty, type AppDraftAction, type Draft } from "@/lib/app-draft";
import type {
  AppConfigDraft,
  IssuerDraft,
  AuthenticationDraft,
  EndUserIdentity,
  EndpointsConfig,
  LimitsConfig,
  ProxyConfig,
} from "@/lib/config-types";
import { draftIssues } from "@/lib/draft-problems";
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
 * Every edit a form can make to one session, as callbacks that dispatch the
 * reducer's actions for `appId`. Shared by the editor and the creation wizard,
 * so a question asked in both moves the draft the same way in both.
 */
export function useDraftTransitions(appId: string, dispatch: Dispatch<AppDraftAction>) {
  return useMemo(() => ({
    update: (partial: Partial<Draft>) => dispatch({ kind: "update", appId, partial }),
    updateConfig: (partial: Partial<AppConfigDraft>) => dispatch({ kind: "updateConfig", appId, partial }),
    updateAuthentication: (authentication: AuthenticationDraft) =>
      dispatch({ kind: "updateAuthentication", appId, authentication }),
    updateIssuer: (partial: Partial<IssuerDraft>) => dispatch({ kind: "updateIssuer", appId, partial }),
    setEndUserSource: (source: EndUserIdentity["source"]) =>
      dispatch({ kind: "setEndUserSource", appId, source }),
    updateEndUserHeader: (header: string) => dispatch({ kind: "updateEndUserHeader", appId, header }),
    updateProxy: (partial: Partial<ProxyConfig>) => dispatch({ kind: "updateProxy", appId, partial }),
    updateLimits: (limits: LimitsConfig) => dispatch({ kind: "updateLimits", appId, limits }),
    updateEndpoints: (endpoints: EndpointsConfig) => dispatch({ kind: "updateEndpoints", appId, endpoints }),
    reset: () => dispatch({ kind: "reset", appId }),
  }), [appId, dispatch]);
}

export type DraftTransitions = ReturnType<typeof useDraftTransitions>;

/**
 * One application, held as the editor's session, with the transitions it can
 * make living in `@/lib/app-draft`.
 *
 * What is left here is everything that needs React or the network: the query
 * whose answer opens a session, the draft's schema issues — parsed once per
 * change of the draft, for every reader on the page — and the save, which
 * submits the draft and the revision it was opened at and then hands the reply
 * back to the reducer for the race guard to judge.
 */
export function useAppDraft(appId: string) {
  const query = useApp(appId);
  const saveMutation = useSaveApp(appId);
  const [session, dispatch] = useReducer(reduceAppDraft, null);
  const transitions = useDraftTransitions(appId, dispatch);

  useEffect(() => {
    if (!query.data) return;
    dispatch({ kind: "loaded", appId, response: query.data });
  }, [appId, query.data]);

  const activeSession = session?.appId === appId ? session : null;
  const activeDraft = activeSession?.draft ?? null;
  const dirty = activeSession ? sessionDirty(activeSession) : false;
  const issues = useMemo(() => (activeDraft ? draftIssues(activeDraft) : []), [activeDraft]);

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
    issues,
    dirty,
    ...transitions,
    save,
    saving: saveMutation.isPending,
  };
}

export type AppDraft = ReturnType<typeof useAppDraft>;
