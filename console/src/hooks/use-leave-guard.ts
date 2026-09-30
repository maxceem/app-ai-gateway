import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

/**
 * Stops the operator walking away from unsaved changes without noticing.
 *
 * Two doors out of a page: a navigation inside the console, which the router
 * can hold open while the page asks, and leaving or reloading the tab, where
 * the browser asks in its own words and only needs telling to. `keeps` names
 * the destinations that do not lose the draft — the other sections of the
 * same app — so moving between them is never interrupted.
 *
 * `dirty` is read through a ref so that a page can clear its draft and
 * navigate in the same breath: the blocker sees the value of the latest
 * render, not the one it was registered with.
 */
export function useLeaveGuard(dirty: boolean, keeps: (pathname: string) => boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirtyRef.current
    && currentLocation.pathname !== nextLocation.pathname
    && !keeps(nextLocation.pathname));

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when this is set; the text itself is ignored.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return blocker;
}
