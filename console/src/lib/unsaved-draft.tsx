import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Whether the page being read holds unsaved changes, for the sidebar to say
 * beside the record's name. The page reports it; the rail reads it. Without
 * a provider — a page rendered on its own, as in a test — reporting is a no-op
 * and nothing is shown.
 */
const UnsavedDraft = createContext<{ unsaved: boolean; report: (unsaved: boolean) => void }>({
  unsaved: false,
  report: () => {},
});

export function UnsavedDraftProvider({ children }: { children: ReactNode }) {
  const [unsaved, report] = useState(false);
  return <UnsavedDraft.Provider value={{ unsaved, report }}>{children}</UnsavedDraft.Provider>;
}

export const useUnsavedDraft = () => useContext(UnsavedDraft).unsaved;

/** Reports a page's draft state for as long as the page is open. */
export function useReportUnsaved(dirty: boolean) {
  const { report } = useContext(UnsavedDraft);
  useEffect(() => {
    report(dirty);
    return () => report(false);
  }, [dirty, report]);
}
